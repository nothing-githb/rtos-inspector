import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------
interface FieldCfg {
  label: string; expr: string; hidden?: boolean; base?: string;   // hidden: başlangıçta gizli; base: "dec"|"hex"|"bin"
  bar?: string | { max?: string; warn?: number; crit?: number };  // kullanım çubuğu: expr=used, bar.max=toplam (eleman-ifadesi veya sabit), warn/crit eşikleri (%)
  link?: { section: string; match?: string };  // çapraz-referans: değeri hedef bölümün 'match' kolonuyla eşleştir; tıklayınca oraya git (match yoksa hedefin ilk kolonu)
  when?: string;  // koşullu alan: eleman üzerinde GDB bool ifadesi; yanlışsa hücre boş kalır (değer çekilmez). ${expr}/${wrapped_expr} kullanılabilir. Variant/tagged-union: aynı discriminator'a bağlı birkaç 'when'li alan.
  editable?: boolean;  // sağ-tık 'Edit value' ile düzenlenebilir (GDB 'set var' ile debuggee'ye YAZAR). Sadece atanabilir (L-value) ifadeler; aksi halde GDB hata verir.
  wrap?: string;  // alana ERİŞTİKTEN SONRA değeri dönüştür; ${expr} = erişilen alan değeri. Örn expr "data" + wrap "((widget_t *)${expr})->x" -> ((widget_t *)(elem.data))->x. Sonuç hücreye yazılır.
}
interface SectionCfg {
  mode: 'linked_list' | 'array' | 'index_list';
  root: string;
  next?: string;      // linked_list: sonraki node pointer alanı | index_list: sonraki index alanı
  head?: string;      // index_list: başlangıç index ifadesi
  nil?: string;       // index_list: gezinmeyi bitiren index (varsayılan "-1")
  count?: string;     // array
  access?: string;    // array/index_list eleman erişimi: "." (default) veya "->"
  cast?: string;      // array: void*/generic buffer'a cast (tam yaz, örn "widget_t *") -> ((cast)(root))[i]
  wrap?: string;      // elemanı field'a erişmeden ÖNCE sarmala; ${expr}=eleman. Örn "((T*)${expr})" -> ((T*)(elem))->field
  label?: string;     // (master) ağaç düğüm başlığı için ifade; groupBy hedefi bunu kullanır
  groupBy?: string;   // bu bölümü adı verilen master bölüme göre ağaç olarak grupla; root'ta ${master}
  hidden?: boolean;   // bölüm (sekme) başlangıçta gizli (kullanıcı Sections menüsünde seçim yapana kadar)
  max?: number;
  fields: FieldCfg[];
}
type SyncCfg = Record<string, unknown>;

type Row = Record<string, string>;
interface Group { label: string; key: string; rows: Row[]; }
interface Section {
  name: string; columnsAll: string[]; hidden: string[]; rows: Row[]; summary: string;
  bases?: Record<string, string>;   // kolon -> config sayı tabanı (dec/hex/bin)
  bars?: Record<string, { warn: number; crit: number }>;   // kolon -> kullanım çubuğu eşikleri (max değeri row['__bar__'+kolon]'da)
  links?: Record<string, { section: string; match?: string }>;   // kolon -> çapraz-referans hedefi (section + match kolonu)
  needsSelection?: boolean;   // gruplu bölüm: master bölüm boş/bulunamadı
  grouped?: boolean;          // groupBy ile ağaç olarak gruplanmış
  groups?: Group[];           // her master elemanı için bir grup
}
interface ColPref { order: string[]; hidden: string[]; }

// ---------------------------------------------------------------------------
// Global durum
// ---------------------------------------------------------------------------
let panel: vscode.WebviewPanel | undefined;
let lastStopped: { session: vscode.DebugSession; threadId: number } | undefined;
// Output: config-driven seviyeli logger (rtosInspector.logLevel)
// Seçilebilir seviyeler: off / info / debug. trace -> debug tier, warn/error -> info tier.
const LOG_LEVELS: Record<string, number> = { debug: 20, trace: 20, info: 30, warn: 30, error: 30, off: 100 };
let logChannel: vscode.OutputChannel | undefined;
let logThreshold = LOG_LEVELS.info;
function readLogLevel(): number {
  const v = String(vscode.workspace.getConfiguration('rtosInspector').get('logLevel') ?? 'info').toLowerCase();
  return LOG_LEVELS[v] ?? LOG_LEVELS.info;
}
function emit(sev: number, tag: string, msg: string) {
  if (!logChannel || sev < logThreshold) return;
  // 'log' dili gramerinin renklendirebilmesi için: ISO tarih-saat + BÜYÜK seviye
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  logChannel.appendLine(`${stamp} [${tag.toUpperCase().padEnd(5)}] ${msg}`);
}
const log = {
  trace: (m: string) => emit(LOG_LEVELS.trace, 'trace', m),
  debug: (m: string) => emit(LOG_LEVELS.debug, 'debug', m),
  info:  (m: string) => emit(LOG_LEVELS.info, 'info', m),
  warn:  (m: string) => emit(LOG_LEVELS.warn, 'warn', m),
  error: (m: string) => emit(LOG_LEVELS.error, 'error', m),
  show:  () => logChannel?.show()
};
let configWatcher: vscode.FileSystemWatcher | undefined;
let extContext: vscode.ExtensionContext | undefined;
let columnPrefs: Record<string, ColPref> = {};
const COLPREF_KEY = 'rtosInspector.columnPrefs';
let sectionPrefs: { order: string[]; hidden: string[]; touched?: boolean } = { order: [], hidden: [] };  // sekme sırası + gizli sekmeler; touched=kullanıcı seçim yaptı (config hidden artık yoksayılır)
const SECPREF_KEY = 'rtosInspector.sectionPrefs';
let paused = false;                         // duraklatılınca durakta otomatik yenileme yapılmaz
const PAUSED_KEY = 'rtosInspector.paused';

// ---------------------------------------------------------------------------
// Aktivasyon
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  columnPrefs = context.workspaceState.get<Record<string, ColPref>>(COLPREF_KEY) ?? {};
  sectionPrefs = context.workspaceState.get<{ order: string[]; hidden: string[]; touched?: boolean }>(SECPREF_KEY) ?? { order: [], hidden: [] };
  paused = context.workspaceState.get<boolean>(PAUSED_KEY) ?? false;

  logChannel = vscode.window.createOutputChannel('Debug Inspector', 'log'); // 'log' dili = renkli
  logThreshold = readLogLevel();
  context.subscriptions.push(logChannel);
  log.info(`Debug Inspector activated (log level: ${vscode.workspace.getConfiguration('rtosInspector').get('logLevel') ?? 'info'})`);

  context.subscriptions.push(
    vscode.commands.registerCommand('rtosInspector.open', () => {
      log.debug('command: open panel');
      openPanel(context);
      if (lastStopped) refresh(lastStopped.session, lastStopped.threadId);
    }),
    vscode.commands.registerCommand('rtosInspector.showLog', () => log.show())
  );

  const types: string[] =
    vscode.workspace.getConfiguration('rtosInspector').get('debugTypes') ?? ['cppdbg'];

  for (const type of types) {
    context.subscriptions.push(
      vscode.debug.registerDebugAdapterTrackerFactory(type, {
        createDebugAdapterTracker(session) {
          return {
            onDidSendMessage(msg: any) {
              if (msg.type !== 'event') return;
              if (msg.event === 'stopped') {
                const threadId = msg.body?.threadId ?? 0;
                lastStopped = { session, threadId };
                log?.debug(`debug stopped (thread ${threadId})${paused ? ' [paused — skipping refresh]' : ''}`);
                if (!paused) doRefresh();   // debounced + iptal: hızlı adımlamada önceki refresh'ler atlanır
              } else if (msg.event === 'continued') {
                log?.trace('debug continued');
                cancelRefresh();            // çalışmaya devam etti: bekleyen refresh'i iptal et (durmuşken çekemeyiz)
                if (!paused) panel?.webview.postMessage({ type: 'running' });
              }
            }
          };
        }
      })
    );
  }

  // config dosyası değişince (debugger durmuşsa ve panel açıksa) otomatik yenile
  setupConfigWatcher(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('rtosInspector.configPath')) setupConfigWatcher(context);
      if (e.affectsConfiguration('rtosInspector.logLevel')) {
        logThreshold = readLogLevel();
        log.info(`log level changed: ${vscode.workspace.getConfiguration('rtosInspector').get('logLevel') ?? 'info'}`);
      }
    })
  );
}

export function deactivate() {}

// configPath ayarına göre config dosyasını izle; değişince paneli tazele
function setupConfigWatcher(context: vscode.ExtensionContext) {
  configWatcher?.dispose();
  const rel: string =
    vscode.workspace.getConfiguration('rtosInspector').get('configPath') ?? 'rtos-inspector.json';
  let pattern: vscode.RelativePattern;
  if (path.isAbsolute(rel)) {
    pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(rel)), path.basename(rel));
  } else {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    pattern = new vscode.RelativePattern(folder, rel);
  }
  configWatcher = vscode.workspace.createFileSystemWatcher(pattern);
  const onChange = () => {
    if (panel && lastStopped) doRefresh();   // çok sayıda kayıt -> debounce ile tek (en son) refresh
  };
  configWatcher.onDidChange(onChange);
  configWatcher.onDidCreate(onChange);
  context.subscriptions.push(configWatcher);
}

// --- debounce + iptal: hızlı arka arkaya istekler (config kaydı, hızlı adımlama)
// tek bir refresh'e indirgenir; çalışan refresh yeni istek gelince geçersiz olur ve
// en güncel state ile bir kez daha koşulur (önceki refresh'ler iptal/atlanır) ---
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let pendingRefresh = false;
let refreshGen = 0;                 // her istek artar; refresh bunu izleyip eskiyi iptal eder
const REFRESH_DEBOUNCE_MS = 140;

function doRefresh() {
  refreshGen++;                     // bekleyen/çalışan refresh'i geçersiz kıl
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = undefined; void runRefresh(); }, REFRESH_DEBOUNCE_MS);
}
function cancelRefresh() {          // program devam edince: planlanan refresh'i iptal et + çalışanı geçersiz kıl
  refreshGen++;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
}
async function runRefresh() {
  if (refreshing) { pendingRefresh = true; return; }   // zaten çalışıyor -> bitince en günceliyle bir kez daha
  if (!panel || !lastStopped) return;
  refreshing = true;
  try {
    do {
      pendingRefresh = false;
      await refresh(lastStopped.session, lastStopped.threadId, refreshGen);
    } while (pendingRefresh && !!lastStopped);
  } finally {
    refreshing = false;
  }
}

// ---------------------------------------------------------------------------
// GDB ile konuşma
// ---------------------------------------------------------------------------
async function gdbExec(
  session: vscode.DebugSession,
  command: string,
  frameId?: number
): Promise<string> {
  try {
    const resp = await session.customRequest('evaluate', {
      expression: `-exec ${command}`,
      context: 'repl',
      frameId
    });
    const out = (resp?.result ?? '').toString();
    const clean = out.replace(/\s+/g, ' ').trim();
    log?.debug(`gdb ▸ ${command}`);                 // hazırlanan erişim string'i
    log?.trace(`gdb ◂ ${clean}`);                   // sonuç
    if (/no symbol|cannot|not (defined|available)|incomplete|error/i.test(clean))
      log?.warn(`gdb access failed: ${command}  ⇒  ${clean}`);
    return out;
  } catch (e: any) {
    log?.warn(`gdb access error: ${command}  ⇒  ${e?.message ?? e}`);
    return `<<error: ${e?.message ?? e}>>`;
  }
}

// "$N = VALUE" -> "VALUE"; "(gdb) " prompt gürültüsüne de dayanıklı
// Sabit boyutlu char dizileri: GDB sondaki NUL'lari da basar ("abc\000\000" veya
// "abc", '\000' <repeats N times>). Sadece ilk \000'a kadarini goster, gerisini at.
function trimCString(s: string): string {
  const t = s.trim();
  if (/^'\\000'(\s*<repeats\s+\d+\s+times>)?$/.test(t)) return '""';        // tamamen NUL -> bos
  const m = t.match(/^"((?:[^"\\]|\\.)*)"/);                                 // bastaki tirnakli string
  if (m) {
    const nul = m[1].indexOf('\\000');
    if (nul !== -1) return '"' + m[1].slice(0, nul) + '"';                   // ilk NUL'da kes
    if (t.length > m[0].length) return m[0];                                 // tirnak sonrasi <repeats>/NUL'lari at
  }
  return s;
}

function cleanValue(raw: string): string {
  let s = (raw ?? '').toString().trim();
  s = s.replace(/\(gdb\)\s*/g, ' ').trim();
  const m = s.match(/\$\d+\s*=\s*([\s\S]*)$/);
  if (m) s = m[1];
  return trimCString(s.trim());
}

function isNull(v: string): boolean {
  return v === '' || /\b0x0\b/.test(v);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// configPath mutlaksa doğrudan; göreliyse workspace köküne göre çözülür
function configFilePath(): string | undefined {
  const rel: string =
    vscode.workspace.getConfiguration('rtosInspector').get('configPath') ?? 'rtos-inspector.json';
  if (path.isAbsolute(rel)) return rel;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return path.join(folder.uri.fsPath, rel);
}

function loadConfig(): SyncCfg | undefined {
  const file = configFilePath();
  if (!file) return undefined;
  try {
    const text = fs.readFileSync(file, 'utf8');
    log?.debug(`config loaded: ${file}`);
    return JSON.parse(text) as SyncCfg;
  } catch (e: any) {
    log?.warn(`could not read/parse config: ${file} — ${e?.message ?? e}`);
    vscode.window.showWarningMessage(`Debug Inspector: could not read config (${file})`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Bir bölümü (thread / semaphore) topla — config-driven, generic
// ---------------------------------------------------------------------------
async function collectSection(
  session: vscode.DebugSession,
  cfg: SectionCfg,
  frameId: number | undefined,
  cursor: string,
  name: string = ''
): Promise<Row[]> {
  const rows: Row[] = [];
  const max = cfg.max ?? 1024;

  if (cfg.mode === 'array') {
    const access = cfg.access ?? '.';
    // cast verilirse void*/generic buffer cast edilir (cast'i tam yaz, örn "widget_t *"): ((cast)(root))[i]
    const base = cfg.cast ? `((${cfg.cast})(${cfg.root}))` : `(${cfg.root})`;
    const countRaw = await gdbExec(session, `print ${cfg.count}`, frameId);
    const count = parseInt(cleanValue(countRaw), 10) || 0;
    log.debug(`array "${name}": count(${cfg.count})="${cleanValue(countRaw)}" → ${count}; element = ${base}[i]${access}<field>, access="${access}"`);
    for (let i = 0; i < Math.min(count, max); i++) {
      // eleman: ((cast*)root)[i]; field'a erişmeden ÖNCE wrap ile sarmalanır
      const elemRaw = `${base}[${i}]`;
      const elem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + elemRaw + ')') + ')' : elemRaw; // (wrap)<access>field
      const row: Row = {};
      for (const f of cfg.fields) {
        if (f.when && !condTrue(cleanValue(await gdbExec(session, `print ${resolveFieldExpr(f.when, elemRaw, elem, access)}`, frameId)))) { row[f.label] = ''; continue; }
        let accExpr = resolveFieldExpr(f.expr, elemRaw, elem, access);
        if (f.wrap) accExpr = f.wrap.split('${expr}').join('(' + accExpr + ')');   // alana eriştikten SONRA sarmala
        const v = await gdbExec(session, `print ${accExpr}`, frameId);
        row[f.label] = cleanValue(v);
        if (f.editable) row['__edit__' + f.label] = accExpr;
        if (f.bar) {
          const mx = barMaxExpr(f);
          if (mx) row['__bar__' + f.label] = /^\d+$/.test(mx) ? mx : cleanValue(await gdbExec(session, `print ${resolveFieldExpr(mx, elemRaw, elem, access)}`, frameId));
        }
      }
      rows.push(row);
    }
  } else if (cfg.mode === 'index_list') {
    // Dizi içinde index ile bağlı liste: head index'inden başla, next alanı sonraki index'i verir
    const access = cfg.access ?? '.';
    const base = cfg.cast ? `((${cfg.cast})(${cfg.root}))` : `(${cfg.root})`;
    const toI = (s: string): number => {
      const t = (s ?? '').trim();
      if (!t) return NaN;
      const n = Number(t);
      if (Number.isFinite(n)) return n;
      const m = t.match(/-?\d+/);
      return m ? parseInt(m[0], 10) : NaN;
    };
    const nilNum = toI(cfg.nil ?? '-1');
    const headRaw = cleanValue(await gdbExec(session, `print ${cfg.head}`, frameId));
    let idx = toI(headRaw);
    log.debug(`index_list "${name}": head(${cfg.head})="${headRaw}" → idx ${idx}; element = ${base}[idx], next via ${base}[idx]${access}${cfg.next}, nil=${nilNum}`);
    const seen: Record<number, boolean> = {};
    let guard = 0;
    let reason = 'end';
    while (true) {
      if (guard++ >= max) { reason = `max bound (${max})`; break; }
      if (!Number.isFinite(idx)) { reason = 'non-numeric index'; break; }
      if (idx === nilNum) { reason = `reached nil (${nilNum})`; break; }
      if (seen[idx]) { reason = `cycle (idx ${idx} already visited)`; break; }
      seen[idx] = true;
      const fromIdx = idx;
      // ham eleman: ${expr} HEM wrap HEM next şablonunda AYNI bunu görür
      const elemRaw = `${base}[${idx}]`;
      // field'a erişmeden ÖNCE wrap ile sarmalanır (çıktı parantezlenir: (wrap)<access>field)
      const elem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + elemRaw + ')') + ')' : elemRaw;
      const row: Row = {};
      for (const f of cfg.fields) {
        if (f.when && !condTrue(cleanValue(await gdbExec(session, `print ${resolveFieldExpr(f.when, elemRaw, elem, access)}`, frameId)))) { row[f.label] = ''; continue; }
        let accExpr = resolveFieldExpr(f.expr, elemRaw, elem, access);
        if (f.wrap) accExpr = f.wrap.split('${expr}').join('(' + accExpr + ')');   // alana eriştikten SONRA sarmala
        const v = await gdbExec(session, `print ${accExpr}`, frameId);
        row[f.label] = cleanValue(v);
        if (f.editable) row['__edit__' + f.label] = accExpr;
        if (f.bar) {
          const mx = barMaxExpr(f);
          if (mx) row['__bar__' + f.label] = /^\d+$/.test(mx) ? mx : cleanValue(await gdbExec(session, `print ${resolveFieldExpr(mx, elemRaw, elem, access)}`, frameId));
        }
      }
      rows.push(row);
      // next şablonu: ${expr}=ham eleman (wrap ile aynı), ${wrapped_expr}=wrap/cast'li eleman; yoksa elem<access>next
      const hasTpl = cfg.next && (cfg.next.indexOf('${expr}') !== -1 || cfg.next.indexOf('${wrapped_expr}') !== -1);
      const nextExpr = hasTpl
        ? cfg.next.split('${wrapped_expr}').join('(' + elem + ')').split('${expr}').join('(' + elemRaw + ')')
        : `${elem}${access}${cfg.next}`;
      const nxRaw = cleanValue(await gdbExec(session, `print ${nextExpr}`, frameId));
      idx = toI(nxRaw);
      log.trace(`index_list "${name}" step ${guard - 1}: idx ${fromIdx} → next [ ${nextExpr} ] = "${nxRaw}" → idx ${idx}`);
    }
    log.debug(`index_list "${name}": ${rows.length} row(s); stopped: ${reason}`);
  } else {
    log.debug(`linked_list "${name}": root=${cfg.root}, advance via cursor->${cfg.next}, access="->"`);
    await gdbExec(session, `set ${cursor} = ${cfg.root}`, frameId);
    let guard = 0;
    let reason = 'end';
    while (true) {
      if (guard++ >= max) { reason = `max bound (${max})`; break; }
      const cur = cleanValue(await gdbExec(session, `print ${cursor}`, frameId));
      if (isNull(cur)) { reason = 'reached NULL'; break; }
      // node (cursor); field'a erişmeden ÖNCE wrap ile sarmalanır
      const elem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + cursor + ')') + ')' : cursor; // (wrap)->field
      const row: Row = {};
      for (const f of cfg.fields) {
        if (f.when && !condTrue(cleanValue(await gdbExec(session, `print ${resolveFieldExpr(f.when, cursor, elem, '->')}`, frameId)))) { row[f.label] = ''; continue; }
        let accExpr = resolveFieldExpr(f.expr, cursor, elem, '->');
        if (f.wrap) accExpr = f.wrap.split('${expr}').join('(' + accExpr + ')');   // alana eriştikten SONRA sarmala
        const v = await gdbExec(session, `print ${accExpr}`, frameId);
        row[f.label] = cleanValue(v);
        if (f.editable) row['__edit__' + f.label] = accExpr;
        if (f.bar) {
          const mx = barMaxExpr(f);
          if (mx) row['__bar__' + f.label] = /^\d+$/.test(mx) ? mx : cleanValue(await gdbExec(session, `print ${resolveFieldExpr(mx, cursor, elem, '->')}`, frameId));
        }
      }
      rows.push(row);
      log.trace(`linked_list "${name}" node ${guard - 1}: cursor=${cur} → advance via ${cursor}->${cfg.next}`);
      await gdbExec(session, `set ${cursor} = ${cursor}->${cfg.next}`, frameId);
    }
    log.debug(`linked_list "${name}": ${rows.length} row(s); stopped: ${reason}`);
  }
  return rows;
}

function num(v: string): number {
  const m = (v ?? '').match(/-?\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}

// Generic özet: satır sayısı + (varsa) State/Count/Waiting kolonlarından çıkarımlar
function summarize(name: string, rows: Row[]): string {
  const parts = [`${rows.length} ${name}`];
  const cols = rows.length ? Object.keys(rows[0]) : [];
  if (cols.indexOf('State') !== -1) {
    const running = rows.filter(r => /run/i.test(r['State'] ?? '')).length;
    if (running) parts.push(`${running} running`);
  }
  if (cols.indexOf('Count') !== -1) {
    const depleted = rows.filter(r => num(r['Count']) === 0).length;
    if (depleted) parts.push(`${depleted} depleted`);
  }
  if (cols.indexOf('Waiting') !== -1) {
    const waiters = rows.filter(r => num(r['Waiting']) > 0).length;
    if (waiters) parts.push(`${waiters} with waiters`);
  }
  return parts.join(' · ');
}

// Config'teki bölümleri (sıra korunarak) çıkar; yorum/anahtar dışı girdileri atla
function extractSections(cfg: SyncCfg): Array<{ name: string; cfg: SectionCfg }> {
  const out: Array<{ name: string; cfg: SectionCfg }> = [];
  if (!cfg || typeof cfg !== 'object') return out;
  for (const key of Object.keys(cfg)) {
    if (key.startsWith('//')) continue; // yorum anahtarlarını atla
    const v = (cfg as any)[key];
    if (v && typeof v === 'object' && Array.isArray(v.fields) && typeof v.mode === 'string') {
      out.push({ name: key, cfg: v as SectionCfg });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sütun tercihleri: kayıtlı sıra/gizli + config alanlarını birleştir
// ---------------------------------------------------------------------------
function effectiveColumns(section: string, fields: FieldCfg[]): { order: string[]; hidden: string[]; active: string[] } {
  const allLabels = fields.map(f => f.label);
  const pref = columnPrefs[section];
  let order: string[];
  let hidden: string[];
  if (pref && Array.isArray(pref.order) && pref.order.length) {
    order = pref.order.filter(l => allLabels.includes(l));
    for (const l of allLabels) if (!order.includes(l)) order.push(l); // config'e yeni eklenenler sona, görünür
    hidden = (pref.hidden ?? []).filter(l => allLabels.includes(l));
  } else {
    order = allLabels.slice();
    hidden = fields.filter(f => f.hidden).map(f => f.label);   // config: "hidden": true olan alanlar başlangıçta gizli
  }
  const active = order.filter(l => !hidden.includes(l));
  return { order, hidden, active };
}

// Kolon -> config sayı tabanı (dec/hex/bin); field.base verilmişse
function fieldBases(fields: FieldCfg[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const f of fields) if (f.base) m[f.label] = f.base;
  return m;
}
// Kullanım çubuğu: max ifadesi + eşikler
function barMaxExpr(f: FieldCfg): string {
  if (!f.bar) return '';
  return (typeof f.bar === 'string' ? f.bar : (f.bar.max ?? '')) || '';
}
// Alan/bar ifadesini GDB print ifadesine çevir. ${expr}=ham eleman, ${wrapped_expr}=wrap/cast'li eleman
// (wrap/next ile AYNI semantik) -> elemanı birden çok kez referanslayan aritmetik (örn stack_top - stack_base) mümkün.
// Yer tutucu yoksa varsayılan: (wrap'li eleman)<access><ifade>.
function resolveFieldExpr(expr: string, rawElem: string, wrappedElem: string, access: string): string {
  if (expr.indexOf('${expr}') !== -1 || expr.indexOf('${wrapped_expr}') !== -1) {
    return expr.split('${wrapped_expr}').join('(' + wrappedElem + ')').split('${expr}').join('(' + rawElem + ')');
  }
  return `${wrappedElem}${access}${expr}`;
}
// koşullu alan (field.when) sonucu doğru mu? boş/0/false/NULL -> false
function condTrue(s: string): boolean {
  const t = (s ?? '').trim();
  if (t === '' || t === '0' || /^false$/i.test(t)) return false;
  if (/^(\([^)]*\)\s*)?0x0+$/.test(t)) return false;
  return true;
}
function fieldBars(fields: FieldCfg[]): Record<string, { warn: number; crit: number }> {
  const m: Record<string, { warn: number; crit: number }> = {};
  for (const f of fields) if (f.bar) {
    const o = typeof f.bar === 'string' ? {} : f.bar;
    m[f.label] = { warn: typeof o.warn === 'number' ? o.warn : 75, crit: typeof o.crit === 'number' ? o.crit : 90 };
  }
  return m;
}
// Kolon -> çapraz-referans hedefi (field.link verilmişse)
function fieldLinks(fields: FieldCfg[]): Record<string, { section: string; match?: string }> {
  const m: Record<string, { section: string; match?: string }> = {};
  for (const f of fields) if (f.link && f.link.section) m[f.label] = { section: f.link.section, match: f.link.match };
  return m;
}

// Yalnız AKTİF sütunları gdb'den çek (pasif sütunlar için print çalıştırılmaz)
async function buildSection(
  session: vscode.DebugSession,
  cfg: SectionCfg,
  frameId: number | undefined,
  cursor: string,
  name: string
): Promise<Section> {
  const eff = effectiveColumns(name, cfg.fields);
  const effFields = eff.active
    .map(l => cfg.fields.find(f => f.label === l))
    .filter((f): f is FieldCfg => !!f);
  const rows = await collectSection(session, { ...cfg, fields: effFields }, frameId, cursor, name);
  log?.debug(`section "${name}" (${cfg.mode}, root=${cfg.root}): ${rows.length} row(s); active=[${eff.active.join(', ')}]`);
  return { name, columnsAll: eff.order, hidden: eff.hidden, rows, summary: summarize(name, rows), bases: fieldBases(cfg.fields), bars: fieldBars(cfg.fields), links: fieldLinks(cfg.fields) };
}

// ---------------------------------------------------------------------------
// Gruplama (ağaç): ${master} yer tutucusu + master elemanı seçici
// ---------------------------------------------------------------------------
// Master satırın elemanını yeniden seçen ifade (tip-güvenli, adres/cast gerektirmez)
function selectorExpr(cfg: SectionCfg, index: number): string {
  // collectSection'daki eleman üretimiyle birebir: cast + wrap DAHİL işlenmiş eleman
  let elem: string;
  if (cfg.mode === 'array') {
    const base = cfg.cast ? `((${cfg.cast})(${cfg.root}))` : `(${cfg.root})`;
    elem = `${base}[${index}]`;
  } else {
    let e = cfg.root;
    const nx = cfg.next ?? 'next';
    for (let k = 0; k < index; k++) e = e + '->' + nx;   // root(->next)^index
    elem = e;
  }
  if (cfg.wrap) elem = cfg.wrap.split('${expr}').join('(' + elem + ')');
  return elem;
}
function isGrouped(cfg: SectionCfg): boolean {
  return typeof cfg.groupBy === 'string' && cfg.groupBy.length > 0;
}
function substituteMaster(expr: string, sel: string): string {
  return expr.split('${master}').join('(' + sel + ')');
}
// '0x.. "init"' -> 'init'; aksi halde olduğu gibi (ağaç düğüm başlığı)
function nodeLabel(v: string): string {
  const m = v.match(/"([^"]*)"/);
  return m ? m[1] : v;
}
function firstActiveLabel(sec: Section): string | undefined {
  return sec.columnsAll.find(l => sec.hidden.indexOf(l) === -1);
}
function rowKeyAt(sec: Section, idx: number): string | undefined {
  const fa = firstActiveLabel(sec);
  return fa ? sec.rows[idx]?.[fa] : undefined;
}

// groupBy: her master elemanı için bir grup; root'taki ${master} o elemana çözülür
async function buildGrouped(
  session: vscode.DebugSession,
  frameId: number | undefined,
  i: number,
  name: string,
  scfg: SectionCfg,
  masters: Record<string, { sec: Section; selExprs: string[]; cfg: SectionCfg }>
): Promise<Section> {
  const eff = effectiveColumns(name, scfg.fields);
  const effFields = eff.active
    .map(l => scfg.fields.find(f => f.label === l))
    .filter((f): f is FieldCfg => !!f);
  const m = masters[scfg.groupBy as string];
  if (!m || !m.sec.rows.length) {
    log?.warn(`grouped "${name}": master "${scfg.groupBy}" not found or empty`);
    return { name, columnsAll: eff.order, hidden: eff.hidden, rows: [], summary: '', grouped: true, groups: [], needsSelection: true };
  }
  const masterAcc = m.cfg.mode === 'array' ? (m.cfg.access ?? '.') : '->';
  const groups: Group[] = [];
  for (let mi = 0; mi < m.sec.rows.length; mi++) {
    const selExpr = m.selExprs[mi];
    const subCfg: SectionCfg = {
      ...scfg,
      fields: effFields,
      root: substituteMaster(scfg.root, selExpr),
      count: scfg.count ? substituteMaster(scfg.count, selExpr) : scfg.count,
      head: scfg.head ? substituteMaster(scfg.head, selExpr) : scfg.head,
      nil: scfg.nil ? substituteMaster(scfg.nil, selExpr) : scfg.nil
    };
    const rows = await collectSection(session, subCfg, frameId, '$rg_' + i + '_' + mi, name);
    const key = rowKeyAt(m.sec, mi) ?? String(mi);
    const label = m.cfg.label
      ? nodeLabel(cleanValue(await gdbExec(session, `print (${selExpr})${masterAcc}${m.cfg.label}`, frameId)))
      : key;
    groups.push({ label, key, rows });
  }
  const total = groups.reduce((a, g) => a + g.rows.length, 0);
  log?.debug(`grouped "${name}" by ${scfg.groupBy}: ${groups.length} group(s), ${total} row(s)`);
  return { name, columnsAll: eff.order, hidden: eff.hidden, rows: [], summary: `${total} ${name} · ${groups.length} ${scfg.groupBy}`, grouped: true, groups, bases: fieldBases(scfg.fields), bars: fieldBars(scfg.fields), links: fieldLinks(scfg.fields) };
}

// ---------------------------------------------------------------------------
// Yenileme
// ---------------------------------------------------------------------------
async function refresh(session: vscode.DebugSession, threadId: number, gen?: number) {
  if (!panel) return;
  const stale = () => gen !== undefined && gen !== refreshGen;   // daha yeni istek geldiyse bu refresh iptal
  const cfg = loadConfig();
  if (!cfg) return;

  let frameId: number | undefined;
  try {
    const st = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
    frameId = st?.stackFrames?.[0]?.id;
  } catch { /* ignore */ }

  const secs = extractSections(cfg);
  const allNames = secs.map(s => s.name);
  // sekme sırası (sectionPrefs.order) + yeni eklenenler sona; gizli sekmeler
  const order = (sectionPrefs.order || []).filter(n => allNames.includes(n));
  for (const n of allNames) if (!order.includes(n)) order.push(n);
  // gizli sekmeler: kullanıcı Sections menüsünde seçim yaptıysa (touched) onun listesi; yoksa config "hidden":true
  const configHidden = secs.filter(s => s.cfg.hidden).map(s => s.name);
  const hiddenNames = sectionPrefs.touched ? (sectionPrefs.hidden || []) : configHidden;
  const hiddenSet = new Set(hiddenNames.filter(n => allNames.includes(n)));
  // gruplama hedefi olan master'lar gizli olsa bile toplanmalı
  const masterTargets = new Set(secs.filter(s => isGrouped(s.cfg)).map(s => s.cfg.groupBy));
  log?.info(`refresh: ${secs.length} section(s); visible=[${order.filter(n => !hiddenSet.has(n)).join(', ')}] hidden=[${[...hiddenSet].join(', ')}]`);

  // 1. geçiş: gruplanmayan (bağımsız/master) bölümleri topla (gizli + master-hedefi olmayanları atla)
  const masters: Record<string, { sec: Section; selExprs: string[]; cfg: SectionCfg }> = {};
  for (let i = 0; i < secs.length; i++) {
    if (stale()) return;   // bölümler arası iptal: daha yeni refresh isteği var
    const { name, cfg: scfg } = secs[i];
    if (isGrouped(scfg)) continue;
    if (hiddenSet.has(name) && !masterTargets.has(name)) continue;   // gizli & gruplama hedefi değil -> çekme
    const sec = await buildSection(session, scfg, frameId, '$ri_' + i, name);
    masters[name] = { sec, selExprs: sec.rows.map((_, idx) => selectorExpr(scfg, idx)), cfg: scfg };
  }

  // 2. geçiş: görünür bölümleri kur (gizli olanları atla)
  const built: Record<string, Section> = {};
  for (let i = 0; i < secs.length; i++) {
    if (stale()) return;
    const { name, cfg: scfg } = secs[i];
    if (hiddenSet.has(name)) continue;
    built[name] = isGrouped(scfg) ? await buildGrouped(session, frameId, i, name, scfg, masters) : masters[name].sec;
  }
  if (stale()) return;   // son anda daha yeni istek geldiyse bu (eski) sonucu gönderme
  const sections = order.filter(n => !hiddenSet.has(n)).map(n => built[n]).filter(Boolean);

  panel.webview.postMessage({
    type: 'update',
    sections,
    hiddenSections: order.filter(n => hiddenSet.has(n)),
    order,   // TEK interleaved sıra (görünür+gizli) -> webview istemci-tarafı reorder/hide için
    ts: new Date().toLocaleTimeString()
  });
}

// ---------------------------------------------------------------------------
// Webview
// ---------------------------------------------------------------------------
function openPanel(context: vscode.ExtensionContext) {
  if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
  panel = vscode.window.createWebviewPanel(
    'rtosInspector', 'Debug Inspector', vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  panel.webview.onDidReceiveMessage(
    async (msg: any) => {
      if (msg?.type === 'refresh') { log?.debug('webview: manual refresh'); doRefresh(); return; }
      if (msg?.type === 'setColumns' && typeof msg.section === 'string' && msg.section) {
        log?.debug(`webview: setColumns ${msg.section} hidden=[${(msg.hidden || []).join(', ')}] refetch=${!!msg.refetch}`);
        columnPrefs[msg.section] = {
          order: Array.isArray(msg.order) ? msg.order : [],
          hidden: Array.isArray(msg.hidden) ? msg.hidden : []
        };
        extContext?.workspaceState.update(COLPREF_KEY, columnPrefs);
        // yeni bir sütun aktifleştirildiyse verisini çekmek için yenile (durmuşsa)
        if (msg.refetch) doRefresh();
      } else if (msg?.type === 'setPaused') {
        paused = !!msg.paused;
        log?.info(`webview: ${paused ? 'paused' : 'resumed'}`);
        extContext?.workspaceState.update(PAUSED_KEY, paused);
        if (!paused && lastStopped) doRefresh();
      } else if (msg?.type === 'copy' && typeof msg.text === 'string') {
        vscode.env.clipboard.writeText(msg.text);
        log?.debug(`webview: copied ${msg.text.length} chars to clipboard`);
      } else if (msg?.type === 'setSections') {
        sectionPrefs = {
          order: Array.isArray(msg.order) ? msg.order : [],
          hidden: Array.isArray(msg.hidden) ? msg.hidden : [],
          touched: true   // kullanıcı seçim yaptı: bundan sonra config "hidden" yoksayılır
        };
        log?.debug(`webview: setSections order=[${sectionPrefs.order.join(', ')}] hidden=[${sectionPrefs.hidden.join(', ')}] reveal=${msg.reveal || '-'}`);
        extContext?.workspaceState.update(SECPREF_KEY, sectionPrefs);
        // reorder/hide tamamen istemci-tarafı (GDB yok); SADECE gizli bir bölüm gösterilince yeniden çek
        if (msg.reveal) doRefresh();
      } else if (msg?.type === 'editValue' && typeof msg.expr === 'string' && msg.expr) {
        // sağ-tık 'Edit value' -> GDB 'set var' ile debuggee'ye YAZ (yalnız editable alanlar)
        if (!lastStopped) { vscode.window.showWarningMessage('Debug Inspector: debugger not stopped — cannot edit.'); return; }
        const cur = typeof msg.current === 'string' ? msg.current : '';
        const val = await vscode.window.showInputBox({
          title: 'Debug Inspector — edit value (writes to the program!)',
          prompt: `set var ${msg.expr} =`,
          value: cur
        });
        if (val === undefined || val === '') return;   // iptal
        let frameId: number | undefined;
        try {
          const stk = await lastStopped.session.customRequest('stackTrace', { threadId: lastStopped.threadId, startFrame: 0, levels: 1 });
          frameId = stk?.stackFrames?.[0]?.id;
        } catch { /* global ifadeler için frame gerekmez */ }
        const res = (await gdbExec(lastStopped.session, `set var ${msg.expr} = ${val}`, frameId)).toString().replace(/\s+/g, ' ').trim();
        log?.info(`edit: set var ${msg.expr} = ${val}  ⇒  ${res || 'ok'}`);
        if (/no symbol|cannot|lvalue|error|invalid|<<error/i.test(res)) {
          vscode.window.showErrorMessage(`Debug Inspector: edit failed — ${res}`);
        }
        doRefresh();
      }
    },
    null,
    context.subscriptions
  );
  panel.webview.html = getHtml();
}

function getHtml(): string {
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 0;
  }
  .topbar {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
  }
  .topbar h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: 0.2px; }
  .grow { flex: 1; }
  .pill {
    font-size: 11px; padding: 3px 10px; border-radius: 999px; font-weight: 600;
    background: rgba(46,204,113,0.18); color: #2ecc71;
  }
  .pill.run { background: rgba(241,196,15,0.20); color: #f1c40f; }
  .pill.paused { background: rgba(120,120,128,0.28); color: var(--vscode-foreground); opacity: 0.85; }
  .ts { font-size: 11px; opacity: 0.6; }
  .btn {
    appearance: none; cursor: pointer; font-family: inherit; font-size: 11px;
    padding: 4px 10px; border-radius: 6px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  }
  .btn:hover { background: var(--vscode-list-hoverBackground); }

  .cols-menu {
    position: fixed; z-index: 50; min-width: 210px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(128,128,128,0.3)));
    border-radius: 8px; padding: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  }
  .cols-menu.hidden { display: none; }
  .cols-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.55; padding: 2px 6px 6px; }
  .cols-item {
    display: flex; align-items: center; justify-content: flex-start;
    gap: 8px; padding: 5px 6px; border-radius: 5px;
  }
  .cols-item:hover { background: var(--vscode-list-hoverBackground); }
  .cols-item[draggable="true"] { cursor: grab; }
  .cols-item.row-dragging { opacity: 0.4; }
  .cols-item.drop-row {
    box-shadow: inset 0 3px 0 #3b9eff;
    background: rgba(59,158,255,0.22);
  }
  .cols-grip { opacity: 0.45; font-size: 12px; cursor: grab; user-select: none; }
  .cm-item { padding: 6px 12px; cursor: pointer; border-radius: 5px; white-space: nowrap; font-size: 12px; }
  .cm-item:hover { background: var(--vscode-list-hoverBackground); }
  .cols-item label { display: flex; align-items: center; gap: 7px; cursor: pointer; font-size: 12.5px; }
  .cols-move button {
    appearance: none; cursor: pointer; border: none; background: transparent;
    color: var(--vscode-foreground); font-size: 12px; padding: 2px 6px; border-radius: 4px;
  }
  .cols-move button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .cols-move button:disabled { opacity: 0.3; cursor: default; }

  .tabs { display: flex; gap: 4px; padding: 10px 12px 0; }
  .tab {
    appearance: none; border: none; cursor: pointer;
    font-family: inherit; font-size: 12.5px; font-weight: 600;
    padding: 7px 14px; border-radius: 8px 8px 0 0;
    color: var(--vscode-foreground); opacity: 0.6;
    background: transparent; border-bottom: 2px solid transparent;
  }
  .tab .badge-count {
    font-size: 11px; opacity: 0.8; margin-left: 6px;
    padding: 0 6px; border-radius: 999px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .tab.active {
    opacity: 1;
    background: var(--vscode-list-hoverBackground);
    border-bottom: 2px solid var(--vscode-focusBorder, #3498db);
  }
  .tab.hidden { display: none; }
  .tab.drop-target { box-shadow: inset 0 -3px 0 #3b9eff; background: rgba(59,158,255,0.18); }

  .pane { padding: 0 16px 20px; }
  .pane.hidden { display: none; }
  .summary { font-size: 12px; opacity: 0.7; margin: 12px 2px 10px; }

  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td {
    text-align: left; padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
    white-space: nowrap;
  }
  th {
    position: sticky; top: 0; z-index: 1;
    background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.16));
    color: var(--vscode-foreground);
    font-size: 11.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; opacity: 1;
    border-bottom: 2px solid var(--vscode-focusBorder, #3b9eff);
    cursor: pointer; user-select: none;
  }
  th:hover { background: var(--vscode-list-hoverBackground); }
  th.sorted { background: rgba(59,158,255,0.22); color: var(--vscode-foreground); }
  tbody td.sortcol { background: rgba(59,158,255,0.07); }
  th.dragging { opacity: 0.4; }
  th.drop-target {
    box-shadow: inset 4px 0 0 #3b9eff;
    background: rgba(59,158,255,0.22) !important;
  }
  th[draggable="true"] { cursor: pointer; }
  .sort-ind { font-size: 11px; margin-left: 4px; color: #3b9eff; font-weight: 700; }
  tbody tr:nth-child(even) td { background: rgba(128,128,128,0.05); }
  tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; opacity: 0.95; }
  td.idcol { font-weight: 700; opacity: 0.9; }
  .dash { opacity: 0.4; }
  .grp-bar { margin: 10px 2px 6px; }
  .grp-toggle { font-size: 11px; }
  tr.grphdr td {
    background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.13)) !important;
    font-weight: 700; font-size: 12px; cursor: pointer;
  }
  tr.grphdr td:hover { background: var(--vscode-list-hoverBackground) !important; }
  tr.grphdr .caret { display: inline-block; width: 12px; opacity: 0.8; }
  .grpcnt {
    font-size: 11px; opacity: 0.85; margin-left: 6px; padding: 0 6px; border-radius: 999px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-weight: 600;
  }

  /* per-tab tablo araç çubuğu: filtre / changed-only / sayı tabanı / kopya */
  .tbl-bar { display: flex; align-items: center; gap: 6px; margin: 10px 2px 8px; flex-wrap: wrap; }
  .tbl-filter {
    flex: 0 0 210px; font-family: inherit; font-size: 12px; padding: 4px 9px; border-radius: 6px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    background: var(--vscode-input-background, transparent);
    color: var(--vscode-input-foreground, var(--vscode-foreground));
  }
  .tbl-filter::placeholder { color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.7)); }
  .btn.on { background: rgba(59,158,255,0.22); border-color: #3b9eff; color: var(--vscode-foreground); }

  /* sayısal kolonlar sağa hizalı + tabular figürler (tam değer her hücrede title'da) */
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  /* başlık sağ üstü: per-kolon sayı tabanı düğmesi (tıkla: raw→10→16→2) */
  .hb {
    float: right; margin-left: 8px; cursor: pointer; padding: 0 4px; border-radius: 3px;
    font-size: 9px; font-weight: 700; opacity: 0.5;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .hb:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .hb.on { opacity: 1; background: rgba(59,158,255,0.28); color: var(--vscode-foreground); }

  /* kullanım çubuğu (stack/progress) */
  .bar { position: relative; min-width: 120px; height: 16px; border-radius: 4px;
    background: rgba(128,128,128,0.18); overflow: hidden; }
  .barfill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; }
  .barfill.bok   { background: rgba(46,204,113,0.55); }
  .barfill.bwarn { background: rgba(241,196,15,0.6); }
  .barfill.bcrit { background: rgba(231,76,60,0.65); }
  .barlbl { position: relative; z-index: 1; display: block; text-align: center; font-size: 11px;
    line-height: 16px; font-variant-numeric: tabular-nums; white-space: nowrap; }

  /* çapraz-referans link + hedef satır vurgusu */
  .xref { color: var(--vscode-textLink-foreground, #3b9eff); cursor: pointer; text-decoration: none; }
  .xref:hover { text-decoration: underline; }
  @keyframes rowflash { from { background: rgba(59,158,255,0.55); } to { background: transparent; } }
  tbody tr.rowflash td { animation: rowflash 1.6s ease-out; }

  .badge { font-size: 11px; padding: 2px 9px; border-radius: 5px; font-weight: 600; display: inline-block; }
  .s-run   { background: rgba(46,204,113,0.18); color: #2ecc71; }
  .s-ready { background: rgba(52,152,219,0.18); color: #3498db; }
  .s-block { background: rgba(231,76,60,0.18);  color: #e74c3c; }
  .s-wait  { background: rgba(241,196,15,0.20); color: #f1c40f; }
  .disc    { background: rgba(155,89,182,0.18); color: #b07cc6; }
  .warn { color: #f1c40f; font-weight: 700; }
  .crit { color: #e74c3c; font-weight: 700; }

  .empty { opacity: 0.55; padding: 28px 4px; font-size: 13px; }

  .pill.chg { background: rgba(241,196,15,0.20); color: #f1c40f; }
  td.changed {
    background: rgba(241,196,15,0.16) !important;
    box-shadow: inset 2px 0 0 #f1c40f;
  }
  .old { opacity: 0.45; font-size: 11px; margin-left: 7px; text-decoration: line-through; }
  .drag-ghost {
    position: fixed; top: -1000px; left: -1000px; pointer-events: none;
    background: #3b9eff; color: #fff; font-size: 12px; font-weight: 700;
    padding: 5px 11px; border-radius: 6px; box-shadow: 0 3px 10px rgba(0,0,0,0.35);
    white-space: nowrap;
  }
  .tab.haschg .badge-count { background: #f1c40f; color: #1e1e1e; }
</style>
</head>
<body>
  <div class="topbar">
    <h1>Debug Inspector</h1>
    <span id="status" class="pill">—</span>
    <span id="changes" class="pill chg hidden"></span>
    <span class="grow"></span>
    <span id="ts" class="ts"></span>
    <button id="sections-btn" class="btn" title="Show / hide sections (tabs)">▤ Sections</button>
    <button id="pause" class="btn" title="Pause/resume auto-refresh on each stop">⏸ Pause</button>
    <button id="refresh" class="btn" title="Re-read config and refresh now">⟳ Refresh</button>
  </div>
  <div class="cols-menu hidden" id="sections-menu"></div>

  <div class="tabs" id="tabs"></div>
  <div id="panes">
    <div class="empty" style="padding: 28px 18px;">Sections from your config appear here when the debugger stops.</div>
  </div>

<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const statusEl = document.getElementById('status');
  const tsEl = document.getElementById('ts');
  const tabsEl = document.getElementById('tabs');
  const panesEl = document.getElementById('panes');

  const secState = {};       // name -> {sec, sortCol, sortDir, changed, changeCount, order, hidden}
  let currentNames = [];     // görünür sekme adları (DOM index'leriyle eşleşir)
  let hiddenSections = [];   // gizli sekme adları (Sections menüsünden açılabilir)
  let sectionOrder = [];     // TEK interleaved sıra (görünür+gizli), gerçek konumda
  let activeName = null;

  document.getElementById('refresh').addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'refresh' });
  });

  let paused = ${paused};
  const pauseBtn = document.getElementById('pause');
  function updatePauseUI() {
    pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
    pauseBtn.title = paused ? 'Resume auto-refresh on each stop' : 'Pause auto-refresh on each stop';
    if (paused) { statusEl.textContent = 'paused'; statusEl.className = 'pill paused'; }
  }
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    vscodeApi.postMessage({ type: 'setPaused', paused: paused });
    if (!paused) { statusEl.textContent = '—'; statusEl.className = 'pill'; }
    updatePauseUI();
  });
  updatePauseUI();

  function cap(s) { s = String(s); return s.length ? s[0].toUpperCase() + s.slice(1) : s; }
  function idxOf(name) { return currentNames.indexOf(name); }
  function bodyEl(name) { const i = idxOf(name); return i < 0 ? null : document.getElementById('body-' + i); }
  function colsMenuEl(name) { const i = idxOf(name); return i < 0 ? null : document.getElementById('cols-' + i); }
  function tabElOf(name) { const i = idxOf(name); return i < 0 ? null : document.getElementById('tab-' + i); }
  function cntElOf(name) { const i = idxOf(name); return i < 0 ? null : document.getElementById('cnt-' + i); }

  function ensureLayout(names) {
    if (JSON.stringify(names) === JSON.stringify(currentNames)) return;
    currentNames = names.slice();
    if (!names.length) {
      tabsEl.innerHTML = '';
      panesEl.innerHTML = '<div class="empty" style="padding:28px 18px;">No sections found in the config.</div>';
      activeName = null;
      return;
    }
    tabsEl.innerHTML = names.map((n, i) =>
      '<button class="tab" data-idx="' + i + '" id="tab-' + i + '" draggable="true" title="Click: switch  ·  Drag: reorder">' + esc(cap(n)) +
      '<span class="badge-count" id="cnt-' + i + '">0</span></button>').join('');
    panesEl.innerHTML = names.map((n, i) =>
      '<div class="pane' + (i === 0 ? '' : ' hidden') + '" data-idx="' + i + '" id="pane-' + i + '">' +
        '<div class="cols-menu hidden" id="cols-' + i + '"></div>' +
        '<div class="pane-body" id="body-' + i + '"></div>' +
      '</div>').join('');
    if (idxOf(activeName) === -1) activeName = names[0];
    applyActive();
  }

  function applyActive() {
    for (const t of tabsEl.querySelectorAll('.tab'))
      t.classList.toggle('active', currentNames[+t.dataset.idx] === activeName);
    for (const p of panesEl.querySelectorAll('.pane'))
      p.classList.toggle('hidden', currentNames[+p.dataset.idx] !== activeName);
  }

  function switchTab(name) {
    activeName = name;
    const t = tabElOf(name);
    if (t) t.classList.remove('haschg');
    applyActive();
  }

  // çapraz-referans: hedef bölüme git ve 'match' kolonu 'value' olan satırı vurgula
  function gotoXref(targetSec, matchCol, value) {
    if (!targetSec) return;
    if (currentNames.indexOf(targetSec) === -1) {
      // hedef gizli: göster (veri async gelir; bu turda vurgulanamaz)
      if (sectionOrder.indexOf(targetSec) !== -1) {
        hiddenSections = hiddenSections.filter(x => x !== targetSec);
        buildSectionsMenu(); sendSections(targetSec);
      }
      return;
    }
    const st = secState[targetSec];
    if (st && st.sec) {
      const vis = st.order.filter(l => st.hidden.indexOf(l) === -1);
      if (!matchCol) matchCol = vis[0];
      // gruplu ağaçta: eşleşen satırın grubunu (kapalıysa) aç ki DOM'da render olsun
      if (st.sec.grouped && !st.flat) {
        for (const g of (st.sec.groups || [])) {
          if ((g.rows || []).some(r => String(r[matchCol]) === String(value))) {
            const ci = (st.collapsed || []).indexOf(g.key);
            if (ci !== -1) { st.collapsed.splice(ci, 1); paint(targetSec); }
            break;
          }
        }
      }
    }
    switchTab(targetSec);
    highlightRow(targetSec, matchCol, value);
  }
  function highlightRow(targetSec, matchCol, value) {
    const body = bodyEl(targetSec); const st = secState[targetSec];
    if (!body || !st) return;
    const vis = st.order.filter(l => st.hidden.indexOf(l) === -1);
    let idx = matchCol ? vis.indexOf(matchCol) : 0; if (idx < 0) idx = 0;
    const tbl = body.querySelector('table'); if (!tbl) return;
    for (const tr of tbl.querySelectorAll('tbody tr')) {
      if (tr.classList.contains('grphdr')) continue;
      const cell = tr.children[idx];
      if (cell && (cell.getAttribute('title') === String(value) || cell.textContent.trim() === String(value))) {
        if (tr.scrollIntoView) tr.scrollIntoView({ block: 'center' });
        tr.classList.add('rowflash');
        setTimeout(() => tr.classList.remove('rowflash'), 1600);
        return true;
      }
    }
    return false;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  }
  function stateClass(v) {
    const s = String(v).toLowerCase();
    if (s.includes('run'))   return 's-run';
    if (s.includes('ready')) return 's-ready';
    if (s.includes('block')) return 's-block';
    if (s.includes('wait'))  return 's-wait';
    return '';
  }
  function asNum(v){ const m=String(v).match(/-?\\d+/); return m?parseInt(m[0],10):NaN; }

  // Erişilemeyen (gdb hata/erişim yok) veya NULL pointer (0x0) -> "-"
  function isUnreadable(v) {
    const s = v == null ? '' : String(v);
    return /^<<error/i.test(s) || /cannot access memory|no symbol|optimized out|<error reading/i.test(s);
  }
  function isNullPtr(v) {
    const t = (v == null ? '' : String(v)).trim();
    return /^(\\([^)]*\\)\\s*)?0x0+$/.test(t);   // 0x0, 0x00, "(tcb_t *) 0x0"
  }
  function isDash(v) { return isUnreadable(v) || isNullPtr(v); }

  // Stiller artık bölüm türüne değil, KOLON ADINA göre uygulanır (generic)
  function cell(col, val) {
    if (isDash(val)) return '<span class="dash" title="' + esc(val) + '">-</span>';
    const lc = String(col).toLowerCase();
    if (lc.includes('state') || lc.includes('durum'))
      return '<span class="badge ' + stateClass(val) + '">' + esc(val) + '</span>';
    if (lc.includes('discipline'))
      return '<span class="badge disc">' + esc(val) + '</span>';
    if (lc === 'count' && asNum(val) === 0)
      return '<span class="crit">' + esc(val) + '</span>';
    if (lc.includes('wait') && asNum(val) > 0)
      return '<span class="warn">' + esc(val) + '</span>';
    if (lc === 'id') return '<span class="idcol">' + esc(val) + '</span>';
    return esc(val);
  }

  function isMono(col) {
    const lc = String(col).toLowerCase();
    return lc.includes('stack') || lc.includes('sp') || lc.includes('name') ||
           lc.includes('addr') || lc.includes('ptr');
  }

  function parseNum(v) {
    const s = String(v).trim();
    if (/^[-+]?0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (/^[-+]?\\d+(\\.\\d+)?$/.test(s)) return parseFloat(s);
    return NaN;
  }
  function compareVals(a, b) {
    const na = parseNum(a), nb = parseNum(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  // Satır kimliği = ilk kolonun değeri (genelde ID). Değişen hücreleri bulur.
  function rowKeyOf(row, columns) {
    return columns.length ? String(row[columns[0]] ?? '') : '';
  }
  function computeChanges(prevRows, newRows, columns) {
    const map = {};
    let count = 0;
    if (!prevRows) return { map, count };
    const prevByKey = {};
    for (const r of prevRows) prevByKey[rowKeyOf(r, columns)] = r;
    for (const r of newRows) {
      const p = prevByKey[rowKeyOf(r, columns)];
      if (!p) continue; // yeni satır: vurgulama
      for (const c of columns) {
        const nv = String(r[c] ?? ''), pv = String(p[c] ?? '');
        if (nv !== pv) {
          map[rowKeyOf(r, columns) + '\\u0000' + c] = pv;  // eski değeri sakla
          count++;
        }
      }
    }
    return { map, count };
  }

  // --- sayısal kolon algısı + hex/dec biçimleme ---
  function isNumStr(v) { const t = String(v).trim(); return /^-?\\d+$/.test(t) || /^0x[0-9a-fA-F]+$/.test(t); }
  function toIntVal(v) { const t = String(v).trim(); if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16); if (/^-?\\d+$/.test(t)) return parseInt(t, 10); return null; }
  function fmtNum(v, base) {
    if (!base || base === 'raw') return v;
    const n = toIntVal(v); if (n === null) return v;
    if (base === 'hex') return (n < 0 ? '-0x' + (-n).toString(16) : '0x' + n.toString(16));
    if (base === 'bin') return (n < 0 ? '-0b' + (-n).toString(2) : '0b' + n.toString(2));
    return String(n); // dec
  }
  function nextBase(b) { return b === 'raw' ? 'bin' : b === 'bin' ? 'dec' : b === 'dec' ? 'hex' : 'raw'; }   // raw → 2 → 10 → 16 → raw
  function baseLbl(b) { return (b === 'dec' || b === 'hex' || b === 'bin') ? b : 'raw'; }
  function numericCols(columns, rows) {
    const set = {};
    for (const c of columns) {
      let n = 0, tot = 0;
      for (const r of rows) { const v = r[c]; if (v == null || v === '' || isDash(v)) continue; tot++; if (isNumStr(v)) n++; }
      if (tot > 0 && n / tot >= 0.6) set[c] = true;
    }
    return set;
  }
  // --- araç çubuğu (filtre / changed-only / kopya); sayı tabanı artık per-kolon (▦ Columns) ---
  function toolbarHtml(st) {
    let h = '<div class="tbl-bar">';
    h += '<input class="tbl-filter" type="text" placeholder="Filter rows…" value="' + esc(st.filter || '') + '">';
    if (st.sec.grouped) h += '<button class="btn grp-toggle">' + (st.flat ? '⊞ Tree' : '☰ Flat') + '</button>';
    else if (st.changeCount > 0) h += '<button class="btn chg-only' + (st.changedOnly ? ' on' : '') + '" title="Show only changed rows">Δ Changed</button>';
    h += '<span class="grow"></span>';
    h += '<button class="btn cols-btn" title="Show / hide / reorder columns">▦ Columns</button>';
    h += '<button class="btn copy-csv" title="Copy table as CSV">⧉ CSV</button>';
    h += '<button class="btn copy-md" title="Copy table as Markdown">⧉ MD</button>';
    h += '</div>';
    return h;
  }
  // filtre + changed-only'i DOM'da gizleyerek uygula (yeniden çizim yok -> input odağı korunur)
  function applyFilter(name) {
    const st = secState[name]; const body = bodyEl(name);
    if (!st || !body) return;
    const f = (st.filter || '').trim().toLowerCase();
    const tb = body.querySelector('tbody'); if (!tb) return;
    const chgOnly = st.changedOnly && !st.sec.grouped && st.changeCount > 0;
    const active = !!f || chgOnly;                       // herhangi bir gizleme kriteri var mı
    const collapsed = st.collapsed || [];
    let grp = null, grpVisible = false, grpKey = null;
    // grup başlığını yalnız FİLTRE/changed-only ile (tüm satırları elenince) gizle;
    // collapse ile satırları gizlenen grubun başlığı her zaman görünür kalmalı (tekrar açılabilsin)
    const finalize = () => {
      if (grp) grp.style.display = (!active || grpVisible || collapsed.indexOf(grpKey) !== -1) ? '' : 'none';
    };
    for (const tr of tb.children) {
      if (tr.classList.contains('grphdr')) { finalize(); grp = tr; grpKey = tr.dataset.grp; grpVisible = false; continue; }
      let show = true;
      if (f && tr.textContent.toLowerCase().indexOf(f) === -1) show = false;
      if (show && chgOnly && !tr.querySelector('td.changed')) show = false;
      tr.style.display = show ? '' : 'none';
      if (show) grpVisible = true;
    }
    finalize();
  }
  function flashBtn(b) { const t = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = t; }, 1200); }
  // görünen satırlardan CSV/Markdown üret -> panoya kopyala (extension)
  function copyTable(name, fmt) {
    const st = secState[name]; const body = bodyEl(name);
    const tbl = body && body.querySelector('table'); if (!tbl) return;
    const heads = [].map.call(tbl.querySelectorAll('thead th'), th => th.textContent.replace(/[▲▼]/g, '').trim());
    const grouped = st.sec.grouped && !st.flat;
    const out = []; let grp = '';
    for (const tr of tbl.querySelectorAll('tbody tr')) {
      if (tr.style.display === 'none') continue;
      if (tr.classList.contains('grphdr')) { grp = tr.textContent.replace(/[▾▸]/g, '').replace(/\\s+\\d+\\s*$/, '').trim(); continue; }
      const cells = [].map.call(tr.children, td => { const c = td.cloneNode(true); for (const o of c.querySelectorAll('.old')) o.remove(); return c.textContent.replace(/\\s+/g, ' ').trim(); });
      out.push(grouped ? [grp].concat(cells) : cells);
    }
    const cols = grouped ? ['Group'].concat(heads) : heads;
    let text;
    if (fmt === 'csv') {
      const q = s => /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      text = [cols].concat(out).map(r => r.map(q).join(',')).join('\\n');
    } else {
      text = '| ' + cols.join(' | ') + ' |\\n| ' + cols.map(() => '---').join(' | ') + ' |\\n' +
        out.map(r => '| ' + r.join(' | ') + ' |').join('\\n');
    }
    vscodeApi.postMessage({ type: 'copy', text: text });
  }

  function headerCells(columns, sortCol, sortDir, numCols, colBase, bars) {
    numCols = numCols || {}; colBase = colBase || {}; bars = bars || {};
    let h = '';
    for (const c of columns) {
      const isNum = numCols[c] && !bars[c];   // bar kolonlarında base/sağa-hizalama yok
      const active = c === sortCol;
      const ind = active ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';
      const cls = ((active ? 'sorted' : '') + (isNum ? ' num' : '')).trim();
      const b = colBase[c] || 'raw';
      const ctrl = isNum
        ? '<span class="hb' + (b !== 'raw' ? ' on' : '') + '" data-col="' + esc(c) + '" title="Number base — click to cycle: raw → bin(2) → dec(10) → hex(16)">' + baseLbl(b) + '</span>'
        : '';
      h += '<th class="' + cls + '" data-col="' + esc(c) + '" draggable="true" ' +
        'title="Click: sort  ·  Drag: reorder  ·  Right-click: columns">' +
        ctrl + esc(c) + '<span class="sort-ind">' + ind + '</span></th>';
    }
    return h;
  }
  function sortRows(rows, columns, sortCol, sortDir) {
    if (sortCol && columns.indexOf(sortCol) !== -1) {
      return rows.slice().sort((r1, r2) => {
        const c = compareVals(r1[sortCol] ?? '', r2[sortCol] ?? '');
        return sortDir === 'desc' ? -c : c;
      });
    }
    return rows;
  }
  function barCell(used, mx, meta) {
    if (used === null || mx === null || mx <= 0) return esc(used === null ? '-' : String(used));
    const pct = Math.max(0, Math.min(100, used / mx * 100));
    const cls = pct >= meta.crit ? 'bcrit' : (pct >= meta.warn ? 'bwarn' : 'bok');
    const lbl = used + ' / ' + mx + ' · ' + pct.toFixed(0) + '%';
    return '<div class="bar"><div class="barfill ' + cls + '" style="width:' + pct.toFixed(1) + '%"></div><span class="barlbl">' + esc(lbl) + '</span></div>';
  }
  function dataRow(columns, row, changed, opts) {
    opts = opts || {};
    const numCols = opts.numCols || {};
    const colBase = opts.colBase || {};
    const bars = opts.bars || {};
    const links = opts.links || {};
    const sortCol = opts.sortCol;
    const rk = rowKeyOf(row, columns);
    let h = '<tr>';
    for (const c of columns) {
      const ck = rk + '\\u0000' + c;
      const isChg = changed && Object.prototype.hasOwnProperty.call(changed, ck);
      const isSort = c === sortCol;
      const raw = row[c] ?? '';
      if (bars[c]) {   // kullanım çubuğu
        const inner = barCell(toIntVal(raw), toIntVal(row['__bar__' + c]), bars[c]);
        const bc = ((isChg ? 'changed ' : '') + (isSort ? 'sortcol' : '')).trim();
        h += '<td' + (bc ? ' class="' + bc + '"' : '') + ' title="' + esc(raw + ' / ' + (row['__bar__' + c] || '?')) + '">' + inner + '</td>';
        continue;
      }
      const b = colBase[c] || 'raw';
      const disp = (b !== 'raw' && !isDash(raw) && toIntVal(raw) !== null) ? fmtNum(raw, b) : raw;
      const classes = [];
      if (isMono(c)) classes.push('mono');
      if (numCols[c]) classes.push('num');
      if (isChg) classes.push('changed');
      if (isSort) classes.push('sortcol');
      const clsAttr = classes.length ? ' class="' + classes.join(' ') + '"' : '';
      const lk = links[c];
      let inner = (lk && raw !== '' && !isDash(raw))
        ? '<a class="xref" data-sec="' + esc(lk.section) + '" data-match="' + esc(lk.match || '') + '" data-val="' + esc(raw) + '">' + esc(disp) + '</a>'
        : cell(c, disp);
      if (isChg) {
        const ov = isDash(changed[ck]) ? '-' : changed[ck];
        inner += '<span class="old" title="previous value">' + esc(ov) + '</span>';
      }
      const ed = row['__edit__' + c];
      const editAttr = (ed != null) ? ' data-edit="' + esc(ed) + '"' : '';
      h += '<td' + clsAttr + editAttr + ' title="' + esc(raw) + '">' + inner + '</td>';
    }
    return h + '</tr>';
  }
  function buildTable(columns, rows, sortCol, sortDir, changed, opts) {
    if (!rows.length) return '<div class="empty">List is empty (root is NULL or count is 0).</div>';
    const data = sortRows(rows, columns, sortCol, sortDir);
    let h = '<table><thead><tr>' + headerCells(columns, sortCol, sortDir, opts && opts.numCols, opts && opts.colBase, opts && opts.bars) + '</tr></thead><tbody>';
    for (const row of data) h += dataRow(columns, row, changed, opts);
    return h + '</tbody></table>';
  }
  // groupBy: master düğümleri + altında satırlar (aç/kapa)
  function buildGroupedTable(columns, groups, collapsed, sortCol, sortDir, opts) {
    if (!groups || !groups.length) return '<div class="empty">No groups (master section is empty).</div>';
    let h = '<table><thead><tr>' + headerCells(columns, sortCol, sortDir, opts && opts.numCols, opts && opts.colBase, opts && opts.bars) + '</tr></thead><tbody>';
    for (const g of groups) {
      const isCol = collapsed.indexOf(g.key) !== -1;
      h += '<tr class="grphdr" data-grp="' + esc(g.key) + '"><td colspan="' + columns.length + '">' +
        '<span class="caret">' + (isCol ? '▸' : '▾') + '</span> ' + esc(g.label) +
        ' <span class="grpcnt">' + g.rows.length + '</span></td></tr>';
      if (!isCol) {
        const data = sortRows(g.rows, columns, sortCol, sortDir);
        for (const row of data) h += dataRow(columns, row, null, opts);
      }
    }
    return h + '</tbody></table>';
  }

  // Görünen sütunlar = kullanıcı sırasındaki - gizlenenler
  function displayCols(st) {
    return st.order.filter(l => st.hidden.indexOf(l) === -1);
  }

  function paint(name) {
    const st = secState[name];
    const body = bodyEl(name);
    if (!st || !st.sec || !body) return;
    if (st.sec.needsSelection) {
      body.innerHTML = '<div class="empty">Master section for "' + esc(name) + '" is empty or missing.</div>';
      return;
    }
    const cols = displayCols(st);
    const grouped = st.sec.grouped;
    const allRows = grouped ? st.sec.groups.reduce((a, g) => a.concat(g.rows), []) : st.sec.rows;
    const numCols = numericCols(cols, allRows);
    st.numCols = numCols;   // ▦ Columns menüsü per-kolon base düğmesi için kullanır
    const opts = { numCols: numCols, colBase: st.colBase || {}, bars: st.sec.bars || {}, links: st.sec.links || {}, sortCol: st.sortCol };
    const summary = '<div class="summary">' + esc(st.sec.summary) + '</div>';
    const bar = toolbarHtml(st);
    let table;
    if (grouped && !st.flat) {
      table = buildGroupedTable(cols, st.sec.groups, st.collapsed || [], st.sortCol, st.sortDir, opts);
    } else if (grouped && st.flat) {
      table = buildTable(cols, allRows, st.sortCol, st.sortDir, null, opts);
    } else {
      table = buildTable(cols, st.sec.rows, st.sortCol, st.sortDir, st.changed, opts);
    }
    body.innerHTML = summary + bar + table;
    applyFilter(name);   // korunan filtre/changed-only'i taze DOM'a uygula
  }

  function buildColsMenu(name) {
    const menu = colsMenuEl(name);
    const st = secState[name];
    if (!menu) return;
    if (!st) { menu.innerHTML = ''; return; }
    let h = '<div class="cols-title">Columns — drag to reorder, toggle visibility</div>';
    st.order.forEach(label => {
      const checked = st.hidden.indexOf(label) === -1 ? ' checked' : '';
      h += '<div class="cols-item" data-label="' + esc(label) + '" draggable="true">' +
        '<span class="cols-grip" title="Drag to reorder">⠿</span>' +
        '<label><input type="checkbox" data-act="vis"' + checked + '> ' + esc(label) + '</label>' +
        '</div>';
    });
    menu.innerHTML = h;
  }

  function afterColChange(name, refetch) {
    const st = secState[name];
    paint(name);
    buildColsMenu(name);
    vscodeApi.postMessage({
      type: 'setColumns', section: name,
      order: st.order.slice(), hidden: st.hidden.slice(), refetch: !!refetch
    });
  }

  function renderSection(name, sec) {
    const prev = secState[name];
    const order = Array.isArray(sec.columnsAll) ? sec.columnsAll.slice() : [];
    const hidden = Array.isArray(sec.hidden) ? sec.hidden.slice() : [];
    const cols = order.filter(l => hidden.indexOf(l) === -1);
    const sortCol = prev && prev.sortCol && cols.indexOf(prev.sortCol) !== -1 ? prev.sortCol : null;
    const sortDir = prev && prev.sortDir ? prev.sortDir : 'asc';
    let changed = {}, count = 0;
    if (!sec.grouped) {
      const ch = computeChanges(prev && prev.sec ? prev.sec.rows : null, sec.rows, cols);
      changed = ch.map; count = ch.count;
    }
    const flat = !!(prev && prev.flat);
    const collapsed = (prev && prev.collapsed) ? prev.collapsed : [];
    const filter = (prev && prev.filter) ? prev.filter : '';
    const changedOnly = !!(prev && prev.changedOnly);
    // per-kolon sayı tabanı: kullanıcının önceki seçimi korunur, config (sec.bases) ilk kez doldurur
    const colBase = (prev && prev.colBase) ? prev.colBase : {};
    if (sec.bases) for (const k in sec.bases) if (!(k in colBase)) colBase[k] = sec.bases[k];
    secState[name] = { sec, sortCol, sortDir, changed, changeCount: count, order, hidden, flat, collapsed, filter, changedOnly, colBase };
    const cnt = cntElOf(name);
    if (cnt) cnt.textContent = sec.grouped ? (sec.groups || []).reduce((a, g) => a + g.rows.length, 0) : sec.rows.length;
    const tab = tabElOf(name);
    if (tab) {
      if (count > 0 && name !== activeName) tab.classList.add('haschg');
      else if (name === activeName) tab.classList.remove('haschg');
    }
    paint(name);
    buildColsMenu(name);
    return count;
  }

  // Sekme tıklaması (delegasyon — container kalıcı, sekmeler dinamik)
  tabsEl.addEventListener('click', e => {
    const t = e.target.closest('.tab[data-idx]');
    if (t) switchTab(currentNames[+t.dataset.idx]);
  });

  function paneName(e) {
    const pane = e.target.closest('.pane[data-idx]');
    return pane ? currentNames[+pane.dataset.idx] : null;
  }

  // Tüm pane etkileşimleri #panes üzerinde delegasyonla (dinamik pane'ler için)
  let dragCol = null, dragName = null, suppressClick = false;
  let menuDragLabel = null, menuDragName = null, dragGhost = null;
  function clearDropMarks() {
    for (const x of document.querySelectorAll('.drop-target')) x.classList.remove('drop-target');
    for (const x of document.querySelectorAll('.drop-row')) x.classList.remove('drop-row');
  }
  // Sürüklenen öğenin imleci takip eden net önizlemesi (çip)
  function setGhost(e, label) {
    const g = document.createElement('div');
    g.className = 'drag-ghost';
    g.textContent = label;
    document.body.appendChild(g);
    if (e.dataTransfer && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(g, 12, 14);
    dragGhost = g;
  }
  function clearGhost() {
    if (dragGhost) { dragGhost.remove(); dragGhost = null; }
  }

  panesEl.addEventListener('click', e => {
    // çapraz-referans linki: hedef nesneye git
    const xref = e.target.closest('.xref');
    if (xref) { e.preventDefault(); e.stopPropagation(); gotoXref(xref.dataset.sec, xref.dataset.match, xref.dataset.val); return; }
    // hücre bağlam menüsü: kopya / düzenle
    const cc = e.target.closest('.cell-copy');
    if (cc) { vscodeApi.postMessage({ type: 'copy', text: cc.dataset.text || '' }); for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return; }
    const ce = e.target.closest('.cell-edit');
    if (ce) { vscodeApi.postMessage({ type: 'editValue', expr: ce.dataset.edit, current: ce.dataset.cur || '' }); for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return; }
    const colsBtn = e.target.closest('.cols-btn');
    if (colsBtn) {
      e.stopPropagation();
      const name = paneName(e);
      const menu = colsMenuEl(name);
      const willOpen = menu.classList.contains('hidden');
      for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
      if (willOpen) {
        buildColsMenu(name);
        const r = colsBtn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 240)) + 'px';
        menu.style.top = (r.bottom + 4) + 'px';
        menu.classList.remove('hidden');
      }
      return;
    }
    if (e.target.closest('.cols-menu')) { e.stopPropagation(); return; }
    // başlık sağ üstü taban seçici (10/16/2) — th-sort'tan ÖNCE
    const hb = e.target.closest('.hb');
    if (hb) {
      const name = paneName(e); const st = secState[name];
      if (st) { st.colBase = st.colBase || {}; const l = hb.dataset.col;
        st.colBase[l] = nextBase(st.colBase[l] || 'raw');   // raw -> dec -> hex -> bin -> raw
        paint(name); }
      e.stopPropagation();
      return;
    }
    // grup: düz/ağaç görünüm geçişi
    if (e.target.closest('.grp-toggle')) {
      const name = paneName(e); const st = secState[name];
      if (st) { st.flat = !st.flat; paint(name); }
      return;
    }
    // araç çubuğu: changed-only / sayı tabanı / kopya
    const chgBtn = e.target.closest('.chg-only');
    if (chgBtn) { const name = paneName(e); const st = secState[name]; if (st) { st.changedOnly = !st.changedOnly; chgBtn.classList.toggle('on', st.changedOnly); applyFilter(name); } return; }
    const csvBtn = e.target.closest('.copy-csv');
    if (csvBtn) { copyTable(paneName(e), 'csv'); flashBtn(csvBtn); return; }
    const mdBtn = e.target.closest('.copy-md');
    if (mdBtn) { copyTable(paneName(e), 'md'); flashBtn(mdBtn); return; }
    // grup başlığı: aç/kapa
    const grphdr = e.target.closest('tr.grphdr');
    if (grphdr) {
      const name = paneName(e); const st = secState[name];
      if (st) {
        st.collapsed = st.collapsed || [];
        const k = grphdr.dataset.grp; const ix = st.collapsed.indexOf(k);
        if (ix === -1) st.collapsed.push(k); else st.collapsed.splice(ix, 1);
        paint(name);
      }
      return;
    }
    const th = e.target.closest('th[data-col]');
    if (th) {
      if (suppressClick) { suppressClick = false; return; }
      const name = paneName(e);
      const st = secState[name];
      if (!st) return;
      const col = th.dataset.col;
      if (st.sortCol === col) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
      else { st.sortCol = col; st.sortDir = 'asc'; }
      paint(name);
      return;
    }
  });

  // filtre kutusu: yalnız DOM'da gizle (yeniden çizim yok -> odak korunur)
  panesEl.addEventListener('input', e => {
    const inp = e.target.closest('.tbl-filter');
    if (!inp) return;
    const name = paneName(e); const st = secState[name];
    if (!st) return;
    st.filter = inp.value;
    applyFilter(name);
  });

  panesEl.addEventListener('change', e => {
    const cb = e.target.closest('.cols-menu input[data-act="vis"]');
    if (!cb) return;
    const name = paneName(e);
    const st = secState[name];
    if (!st) return;
    const label = cb.closest('.cols-item').dataset.label;
    const hi = st.hidden.indexOf(label);
    if (cb.checked) {
      if (hi !== -1) st.hidden.splice(hi, 1);
      afterColChange(name, true);
    } else {
      const visible = st.order.filter(l => st.hidden.indexOf(l) === -1).length;
      if (visible <= 1) { cb.checked = true; return; }
      if (hi === -1) st.hidden.push(label);
      afterColChange(name, false);
    }
  });

  panesEl.addEventListener('dragstart', e => {
    const item = e.target.closest('.cols-item');
    if (item) {
      menuDragName = paneName(e);
      menuDragLabel = item.dataset.label;
      item.classList.add('row-dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', menuDragLabel); }
      setGhost(e, menuDragLabel);
      return;
    }
    if (e.target.closest('.hb')) { e.preventDefault(); return; }   // taban seçicide sürükleme başlatma
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    suppressClick = false;
    dragName = paneName(e);
    dragCol = th.dataset.col;
    th.classList.add('dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragCol); }
    setGhost(e, dragCol);
  });
  panesEl.addEventListener('dragover', e => {
    if (menuDragLabel !== null) {
      const item = e.target.closest('.cols-item');
      if (!item) return;
      e.preventDefault();
      clearDropMarks();
      item.classList.add('drop-row');
      return;
    }
    if (dragCol !== null) {
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      th.classList.add('drop-target');
    }
  });
  panesEl.addEventListener('drop', e => {
    if (menuDragLabel !== null) {
      e.preventDefault();
      const item = e.target.closest('.cols-item');
      const name = menuDragName;
      const st = secState[name];
      if (st && item) {
        const target = item.dataset.label;
        if (target !== menuDragLabel) {
          const from = st.order.indexOf(menuDragLabel), to = st.order.indexOf(target);
          if (from !== -1 && to !== -1) { st.order.splice(from, 1); st.order.splice(to, 0, menuDragLabel); afterColChange(name, false); }
        }
      }
      clearDropMarks();
      menuDragLabel = null; menuDragName = null;
      return;
    }
    if (dragCol !== null) {
      e.preventDefault();
      const th = e.target.closest('th[data-col]');
      const name = paneName(e);
      const st = secState[name];
      if (st && th && name === dragName) {
        const target = th.dataset.col;
        if (target !== dragCol) {
          const from = st.order.indexOf(dragCol), to = st.order.indexOf(target);
          if (from !== -1 && to !== -1) { st.order.splice(from, 1); st.order.splice(to, 0, dragCol); afterColChange(name, false); }
        }
      }
      clearDropMarks();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 60);
      dragCol = null; dragName = null;
    }
  });
  panesEl.addEventListener('dragend', () => {
    for (const x of panesEl.querySelectorAll('.dragging')) x.classList.remove('dragging');
    for (const x of panesEl.querySelectorAll('.row-dragging')) x.classList.remove('row-dragging');
    clearDropMarks();
    clearGhost();
    dragCol = null; dragName = null; menuDragLabel = null; menuDragName = null;
  });
  function popMenu(name, e, html) {
    for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
    const menu = colsMenuEl(name); if (!menu) return;
    menu.innerHTML = html;
    menu.style.position = 'fixed';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 230) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 40) + 'px';
    menu.classList.remove('hidden');
  }
  panesEl.addEventListener('contextmenu', e => {
    const name = paneName(e);
    if (!name || !secState[name]) return;
    const th = e.target.closest('th[data-col]');
    if (th) {   // başlık: kolon menüsü
      e.preventDefault();
      for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
      buildColsMenu(name);
      const menu = colsMenuEl(name);
      menu.style.position = 'fixed';
      menu.style.left = Math.min(e.clientX, window.innerWidth - 230) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - 40) + 'px';
      menu.classList.remove('hidden');
      return;
    }
    const td = e.target.closest('tbody td');
    if (td && !td.querySelector('.bar')) {   // veri hücresi: kopya (+ düzenlenebilirse edit)
      e.preventDefault();
      const txt = (td.textContent || '').trim();
      let h = '<div class="cm-item cell-copy" data-text="' + esc(txt) + '">Copy cell</div>';
      if (td.dataset.edit) h += '<div class="cm-item cell-edit" data-edit="' + esc(td.dataset.edit) + '" data-cur="' + esc(td.getAttribute('title') || '') + '">Edit value…</div>';
      popMenu(name, e, h);
    }
  });

  document.addEventListener('click', () => {
    for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
  });

  // --- Sections (tabs): istemci-tarafı gizle/sırala (columns modeli) + menü/sekme sürükle ---
  // sectionOrder = TEK interleaved liste (görünür+gizli, gerçek sırada). reveal: gizliyi gösterirken yeniden çek.
  const secMenu = document.getElementById('sections-menu');
  const secBtn = document.getElementById('sections-btn');
  function sendSections(reveal) {
    vscodeApi.postMessage({ type: 'setSections', order: sectionOrder.slice(), hidden: hiddenSections.slice(), reveal: reveal || null });
  }
  function visibleFromOrder() { return sectionOrder.filter(n => hiddenSections.indexOf(n) === -1); }
  // saf yardımcı: order içinde fromName'i toName'in (sürükleme-öncesi) yerine taşı (columns ile aynı semantik)
  function computeReorder(order, fromName, toName) {
    const o = order.slice(); const f = o.indexOf(fromName), t = o.indexOf(toName);
    if (f === -1 || t === -1 || f === t) return o;
    o.splice(f, 1); o.splice(t, 0, fromName); return o;
  }
  function neighborVisible(name) {
    const vis = visibleFromOrder(); if (!vis.length) return null;
    const oi = sectionOrder.indexOf(name);
    let best = vis[0], bestd = Infinity;
    for (const v of vis) { const d = Math.abs(sectionOrder.indexOf(v) - oi); if (d < bestd) { bestd = d; best = v; } }
    return best;
  }
  // skeleton'ı yeni sırada yeniden kur, her bölümü secState ÖNBELLEĞİNDEN yeniden paint et (GDB YOK)
  function setTabCount(name) {
    const st = secState[name]; const cnt = cntElOf(name);
    if (st && st.sec && cnt) cnt.textContent = st.sec.grouped ? (st.sec.groups || []).reduce((a, g) => a + g.rows.length, 0) : st.sec.rows.length;
  }
  // "N changed" rozetini SADECE görünür (açık) bölümlerin değişiklik sayısından hesapla
  function recomputeChanged() {
    let total = 0;
    for (const name of currentNames) { const st = secState[name]; if (st) total += (st.changeCount || 0); }
    const chEl = document.getElementById('changes');
    if (!chEl) return;
    if (total > 0) { chEl.textContent = total + ' changed'; chEl.classList.remove('hidden'); }
    else chEl.classList.add('hidden');
  }
  function applySectionLayout() {
    const vis = visibleFromOrder();
    currentNames = [];                 // ensureLayout erken-dönüşünü kır -> her zaman yeniden kur
    ensureLayout(vis);                 // tabs/panes iskeleti + currentNames + applyActive
    // iskelet yeniden kurulduğu için sekme sayaç/haschg sıfırlanır; secState önbelleğinden geri yaz
    for (const name of vis) if (secState[name] && secState[name].sec) {
      paint(name); buildColsMenu(name); setTabCount(name);
      const st = secState[name]; const tab = tabElOf(name);
      if (tab) { if (st.changeCount > 0 && name !== activeName) tab.classList.add('haschg'); else tab.classList.remove('haschg'); }
    }
    recomputeChanged();   // gizlenen bölümün değişiklikleri toplamdan düşsün
  }
  function buildSectionsMenu() {
    let h = '<div class="cols-title">Sections — drag to reorder, toggle visibility</div>';
    if (!sectionOrder.length) h += '<div class="cols-item">—</div>';
    sectionOrder.forEach(n => {
      const checked = hiddenSections.indexOf(n) === -1 ? ' checked' : '';
      h += '<div class="cols-item" data-sec="' + esc(n) + '" draggable="true">' +
        '<span class="cols-grip" title="Drag to reorder">⠿</span>' +
        '<label><input type="checkbox" data-act="secvis"' + checked + '> ' + esc(cap(n)) + '</label></div>';
    });
    secMenu.innerHTML = h;
  }
  secBtn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = secMenu.classList.contains('hidden');
    for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
    if (willOpen) {
      buildSectionsMenu();
      const r = secBtn.getBoundingClientRect();
      secMenu.style.position = 'fixed';
      secMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 240)) + 'px';
      secMenu.style.top = (r.bottom + 4) + 'px';
      secMenu.classList.remove('hidden');
    }
  });
  secMenu.addEventListener('click', e => e.stopPropagation());
  secMenu.addEventListener('change', e => {
    const cb = e.target.closest('input[data-act="secvis"]');
    if (!cb) return;
    const n = cb.closest('.cols-item').dataset.sec;
    if (cb.checked) {
      // GÖSTER: gizli bölümün verisi yok (gizliyken çekilmez) -> reveal ile tazele
      hiddenSections = hiddenSections.filter(x => x !== n);
      buildSectionsMenu();
      sendSections(n);
    } else {
      // GİZLE: en az 1 görünür kalmalı; istemci-tarafı (GDB yok)
      if (visibleFromOrder().length <= 1) { cb.checked = true; return; }
      if (hiddenSections.indexOf(n) === -1) hiddenSections.push(n);
      if (activeName === n) activeName = neighborVisible(n);
      buildSectionsMenu();
      applySectionLayout();
      sendSections(null);
    }
  });
  // Sections menüsü satır sürükle-sırala (columns menüsü gibi: grip + drop-row)
  let menuDragSec = null;
  secMenu.addEventListener('dragstart', e => {
    const item = e.target.closest('.cols-item[data-sec]'); if (!item) return;
    menuDragSec = item.dataset.sec;
    item.classList.add('row-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', menuDragSec); }
    setGhost(e, cap(menuDragSec));
  });
  secMenu.addEventListener('dragover', e => {
    if (menuDragSec == null) return;
    const item = e.target.closest('.cols-item[data-sec]'); if (!item) return;
    e.preventDefault(); clearDropMarks(); item.classList.add('drop-row');
  });
  secMenu.addEventListener('drop', e => {
    if (menuDragSec == null) return;
    const item = e.target.closest('.cols-item[data-sec]');
    if (item) {
      e.preventDefault();
      const target = item.dataset.sec;
      if (target !== menuDragSec) {
        sectionOrder = computeReorder(sectionOrder, menuDragSec, target);
        buildSectionsMenu(); applySectionLayout(); sendSections(null);
      }
    }
    menuDragSec = null; clearDropMarks();
  });
  secMenu.addEventListener('dragend', () => {
    menuDragSec = null; clearGhost(); clearDropMarks();
    for (const x of secMenu.querySelectorAll('.row-dragging')) x.classList.remove('row-dragging');
  });
  // sekme sürükle-sırala (sectionOrder üzerinde, istemci-tarafı)
  let tabDrag = null;
  tabsEl.addEventListener('dragstart', e => {
    const t = e.target.closest('.tab[data-idx]'); if (!t) return;
    tabDrag = currentNames[+t.dataset.idx];
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', tabDrag); }
    setGhost(e, cap(tabDrag));
  });
  tabsEl.addEventListener('dragover', e => {
    if (tabDrag == null) return;
    const t = e.target.closest('.tab[data-idx]'); if (!t) return;
    e.preventDefault();
    for (const x of tabsEl.querySelectorAll('.tab')) x.classList.remove('drop-target');
    t.classList.add('drop-target');
  });
  tabsEl.addEventListener('drop', e => {
    if (tabDrag == null) return;
    const t = e.target.closest('.tab[data-idx]'); if (!t) { tabDrag = null; return; }
    e.preventDefault();
    const target = currentNames[+t.dataset.idx];
    if (target && target !== tabDrag) {
      sectionOrder = computeReorder(sectionOrder, tabDrag, target);
      applySectionLayout(); sendSections(null);
    }
    tabDrag = null;
    for (const x of tabsEl.querySelectorAll('.tab')) x.classList.remove('drop-target');
  });
  tabsEl.addEventListener('dragend', () => {
    tabDrag = null; clearGhost();
    for (const x of tabsEl.querySelectorAll('.tab')) x.classList.remove('drop-target');
  });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'update') {
      if (!paused) { statusEl.textContent = 'stopped'; statusEl.className = 'pill'; }
      tsEl.textContent = m.ts ? ('updated ' + m.ts) : '';
      const list = Array.isArray(m.sections) ? m.sections : [];
      hiddenSections = Array.isArray(m.hiddenSections) ? m.hiddenSections : [];
      sectionOrder = Array.isArray(m.order) ? m.order.slice() : list.map(s => s.name).concat(hiddenSections);
      ensureLayout(list.map(s => s.name));
      for (const k of Object.keys(secState))
        if (list.findIndex(s => s.name === k) === -1) delete secState[k];
      let changed = 0;
      for (const s of list) changed += (renderSection(s.name, s) || 0);
      const chEl = document.getElementById('changes');
      if (changed > 0) { chEl.textContent = changed + ' changed'; chEl.classList.remove('hidden'); }
      else chEl.classList.add('hidden');
    } else if (m.type === 'running') {
      if (!paused) { statusEl.textContent = 'running…'; statusEl.className = 'pill run'; }
    }
  });
</script>
</body>
</html>`;
}
