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
  badge?: Record<string, string>;  // değer -> renk rozet eşlemesi (case-insensitive tam eşleşme); renk adı (green/blue/red/amber/purple/cyan/gray) veya #rrggbb. Verilirse built-in State/Discipline heuristic'i yerine bu kullanılır.
}
interface SectionCfg {
  mode: 'linked_list' | 'array' | 'index_list' | 'tree';
  root: string;
  children?: string[];   // tree: çocuk pointer alan adları (örn ["left","right"]); varsayılan ["left","right"]
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
  badges?: Record<string, Record<string, string>>;   // kolon -> değer->renk rozet eşlemesi
  needsSelection?: boolean;   // gruplu bölüm: master bölüm boş/bulunamadı
  grouped?: boolean;          // groupBy ile ağaç olarak gruplanmış
  groups?: Group[];           // her master elemanı için bir grup
  kind?: 'linked' | 'array' | 'index' | 'tree';   // graph view: zincir (next) / ızgara (array) / hiyerarşi (tree) yerleşimi
}
interface ColPref { order: string[]; hidden: string[]; }

// ---------------------------------------------------------------------------
// Global durum
// ---------------------------------------------------------------------------
let panel: vscode.WebviewPanel | undefined;
let lastStopped: { session: vscode.DebugSession; threadId: number; frameId?: number } | undefined;
let printSetupFor: vscode.DebugSession | undefined;   // #3: kompakt print ayarları bu oturumda yapıldı mı
// Output: config-driven seviyeli logger (debugInspector.logLevel)
// Seçilebilir seviyeler: off / info / debug. trace -> debug tier, warn/error -> info tier.
const LOG_LEVELS: Record<string, number> = { debug: 20, trace: 20, info: 30, warn: 30, error: 30, off: 100 };
let logChannel: vscode.OutputChannel | undefined;
let logThreshold = LOG_LEVELS.info;
function readLogLevel(): number {
  const v = String(vscode.workspace.getConfiguration('debugInspector').get('logLevel') ?? 'info').toLowerCase();
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
const COLPREF_KEY = 'debugInspector.columnPrefs';
let sectionPrefs: { order: string[]; hidden: string[]; touched?: boolean } = { order: [], hidden: [] };  // sekme sırası + gizli sekmeler; touched=kullanıcı seçim yaptı (config hidden artık yoksayılır)
const SECPREF_KEY = 'debugInspector.sectionPrefs';
let paused = false;                         // duraklatılınca durakta otomatik yenileme yapılmaz
const PAUSED_KEY = 'debugInspector.paused';

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
  log.info(`Debug Inspector activated (log level: ${vscode.workspace.getConfiguration('debugInspector').get('logLevel') ?? 'info'})`);

  context.subscriptions.push(
    vscode.commands.registerCommand('debugInspector.open', () => {
      log.debug('command: open panel');
      openPanel(context);
      if (lastStopped) refresh(lastStopped.session, lastStopped.threadId);
    }),
    vscode.commands.registerCommand('debugInspector.showLog', () => log.show())
  );

  const types: string[] =
    vscode.workspace.getConfiguration('debugInspector').get('debugTypes') ?? ['cppdbg'];

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

  // Debug oturumu bittiğinde paneli kapat (izlenen oturum sona erince stale veri/spinner kalmasın)
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(s => {
      if (!panel) return;
      const tracked = lastStopped?.session;
      if (tracked && tracked !== s) return;   // bizim izlediğimiz oturum değil -> dokunma
      log?.info('debug session terminated → closing panel');
      lastStopped = undefined; printSetupFor = undefined; watchpoints = {}; cancelRefresh();
      panel.dispose();   // onDidDispose -> panel = undefined
    })
  );

  // config dosyası değişince (debugger durmuşsa ve panel açıksa) otomatik yenile
  setupConfigWatcher(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('debugInspector.configPath')) setupConfigWatcher(context);
      if (e.affectsConfiguration('debugInspector.logLevel')) {
        logThreshold = readLogLevel();
        log.info(`log level changed: ${vscode.workspace.getConfiguration('debugInspector').get('logLevel') ?? 'info'}`);
      }
    })
  );
}

export function deactivate() {}

// configPath ayarına göre config dosyasını izle; değişince paneli tazele
function setupConfigWatcher(context: vscode.ExtensionContext) {
  configWatcher?.dispose();
  const rel: string =
    vscode.workspace.getConfiguration('debugInspector').get('configPath') ?? 'debug-inspector.json';
  let pattern: vscode.RelativePattern;
  if (path.isAbsolute(rel)) {
    pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(rel)), path.basename(rel));
  } else {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    pattern = new vscode.RelativePattern(folder, rel);
  }
  configWatcher = vscode.workspace.createFileSystemWatcher(pattern);
  configWatcher.onDidChange(onConfigChange);
  configWatcher.onDidCreate(onConfigChange);
  context.subscriptions.push(configWatcher);
}

// Config kaydedildiğinde: VERİYİ etkileyen bir şey değiştiyse yeniden çek; yalnız SUNUM (base/bar eşiği/link/badge)
// değiştiyse GDB'ye hiç gitme — istemci-tarafı yeniden çiz. "Her zaman her şeyi çekme" optimizasyonu.
function onConfigChange() {
  if (!panel || !lastStopped) return;
  const cfg = loadConfig();
  if (!cfg) { doRefresh(); return; }   // okunamadı/şema bozuk -> güvenli tam yenile
  const secs = extractSections(cfg);
  const fp = fingerprintOf(secs, resolveLayout(secs));
  if (fp !== lastFingerprint) {
    log?.info('config change: data-affecting → refetch');
    doRefresh();   // veri/sıra/gizli/alan değişti -> normal (öncelikli streaming) yenile (lastFingerprint'i günceller)
    return;
  }
  // yalnız sunum değişmiş: GDB yok, her bölümün base/bar/link/badge'ini istemciye gönder
  log?.info('config change: presentation-only → no GDB refetch');
  for (const { name, cfg: scfg } of secs) {
    panel.webview.postMessage({
      type: 'presentationUpdate', section: name,
      bases: fieldBases(scfg.fields), bars: fieldBars(scfg.fields),
      links: fieldLinks(scfg.fields), badges: fieldBadges(scfg.fields)
    });
  }
}

// --- debounce + iptal: hızlı arka arkaya istekler (config kaydı, hızlı adımlama)
// tek bir refresh'e indirgenir; çalışan refresh yeni istek gelince geçersiz olur ve
// en güncel state ile bir kez daha koşulur (önceki refresh'ler iptal/atlanır) ---
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let pendingRefresh = false;
let refreshGen = 0;                 // her istek artar; refresh bunu izleyip eskiyi iptal eder
const REFRESH_DEBOUNCE_MS = 140;
let activeTab: string | undefined;  // webview'in o anki aktif sekmesi -> refresh önce onu çeker, sekme değişince öncelik değişir
let watchpoints: Record<string, number> = {};   // izlenen l-value ifadesi -> GDB watchpoint no (★ işareti + kaldırma için)
let wpCounter = 0;                               // her watchpoint'e benzersiz convenience var ($di_wp<N>) için sayaç
function sendWatchpoints() { panel?.webview.postMessage({ type: 'watchpoints', exprs: Object.keys(watchpoints) }); }
// GDB watchpoint numarasını 'info watchpoints'tan bul (cppdbg 'watch' çıktısında numarayı her zaman echo'lamaz).
// Önce 'What' sütunu expr ile eşleşen satır; yoksa en yüksek numara (en son eklenen).
async function findWatchNum(session: vscode.DebugSession, frameId: number | undefined, expr: string): Promise<number> {
  const out = (await gdbExec(session, 'info watchpoints', frameId)).toString();
  let best = NaN;
  for (const ln of out.split(/\r?\n/)) {
    const m = ln.match(/^\s*(\d+)\s+.*watchpoint/i);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (ln.includes(expr)) return num;
    best = num;
  }
  return best;
}

// GDB işlem MUTEX'i: refresh / refreshTarget / refreshRow asla İÇ İÇE çalışmasın.
// (Hepsi $ri_*/$rg_* convenience cursor'larını paylaşıyor; eşzamanlı akarlarsa biri diğerinin
//  cursor'unu ezer -> $cursor->next hatalı/NULL okur -> geçici ⚠ hücreler. Serileştirme bunu önler.)
let gdbChain: Promise<unknown> = Promise.resolve();
async function gdbAcquire(): Promise<() => void> {
  let release: () => void = () => {};
  const next = new Promise<void>(r => { release = r; });
  const prev = gdbChain;
  gdbChain = next;
  await prev;        // önceki işlem bitene kadar bekle
  return release;
}

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
      const rel = await gdbAcquire();   // hedefli işlemlerle iç içe geçmesin
      try { await refresh(lastStopped.session, lastStopped.threadId, refreshGen); }
      finally { rel(); }
    } while (pendingRefresh && !!lastStopped);
  } finally {
    refreshing = false;
  }
}

// Hedefli yenileme: tek bölüm (section reveal) veya tek kolon (column show) — tüm paneli yeniden çekmeden.
// label verilirse SADECE o field çekilir ve mevcut satırlara merge edilir; verilmezse tüm bölüm (aktif kolonlarıyla) kurulur.
async function refreshTarget(section: string, label?: string) {
  if (!panel || !lastStopped) return;   // durmuş değilse veri yok; sonraki durakta dolar
  const session = lastStopped.session;
  const frameId = lastStopped.frameId;
  const cfg = loadConfig(); if (!cfg) return;
  const secs = extractSections(cfg);
  const idx = secs.findIndex(s => s.name === section);
  if (idx < 0) return;
  const scfg = secs[idx].cfg;
  const rel = await gdbAcquire();   // refresh / diğer hedefli işlemlerle iç içe geçmesin (cursor çakışması -> ⚠)
  try {

  // grouped bölüm için master'ı kur (sadece bu bölüm + master fetch edilir, diğer bölümlere dokunulmaz)
  let masters: Record<string, { sec: Section; selExprs: string[]; cfg: SectionCfg }> = {};
  if (isGrouped(scfg)) {
    const mName = scfg.groupBy as string;
    const mIdx = secs.findIndex(s => s.name === mName);
    if (mIdx < 0) return;
    const mSec = await buildSection(session, secs[mIdx].cfg, frameId, '$ri_' + mIdx, mName);
    masters[mName] = { sec: mSec, selExprs: mSec.rows.map((_, k) => selectorExpr(secs[mIdx].cfg, k)), cfg: secs[mIdx].cfg };
  }
  const ts = new Date().toLocaleTimeString();

  if (label) {
    // TEK KOLON: yalnız bu field'ı çek -> satır sırasıyla merge için gönder
    const oneField = scfg.fields.find(f => f.label === label);
    if (!oneField) return;
    const subCfg: SectionCfg = { ...scfg, fields: [oneField] };
    let rows: Row[];
    if (isGrouped(scfg)) {
      const g = await buildGrouped(session, frameId, idx, section, subCfg, masters);
      rows = (g.groups || []).reduce<Row[]>((a, gr) => a.concat(gr.rows), []);
    } else {
      rows = await collectSection(session, subCfg, frameId, '$ri_' + idx, section);
    }
    log?.debug(`refreshTarget: column "${section}.${label}" -> ${rows.length} value(s)`);
    panel.webview.postMessage({ type: 'patchColumn', section, label, rows, ts });
  } else {
    // TEK BÖLÜM: tüm aktif kolonlarıyla yeniden kur
    const sec = isGrouped(scfg)
      ? await buildGrouped(session, frameId, idx, section, scfg, masters)
      : await buildSection(session, scfg, frameId, '$ri_' + idx, section);
    log?.debug(`refreshTarget: section "${section}" rebuilt`);
    panel.webview.postMessage({ type: 'patchSection', section, sec, ts });
  }
  } finally { rel(); }
}

// Edit value sonrası: SADECE düzenlenen satırı yeniden çek (tüm bölüm/panel değil).
// array: ((cast)root)[i] (O(1)); linked_list: root(->next)^i (tek print, zincir GDB içinde). index_list/grouped -> bölüm yenile (fallback).
async function refreshRow(section: string, rowIndex: number | null) {
  if (!panel || !lastStopped) return;
  const cfg = loadConfig(); if (!cfg) return;
  const node = extractSections(cfg).find(s => s.name === section);
  if (!node) return;
  const scfg = node.cfg;
  if (rowIndex == null || rowIndex < 0 || isGrouped(scfg) || scfg.mode === 'index_list') { refreshTarget(section); return; }
  const rel = await gdbAcquire();   // tekil satır fetch'i de refresh / diğer işlemlerle iç içe geçmesin
  try {
  const session = lastStopped.session;
  const frameId = lastStopped.frameId;
  const eff = effectiveColumns(section, scfg.fields);
  const effFields = eff.active.map(l => scfg.fields.find(f => f.label === l)).filter((f): f is FieldCfg => !!f);
  let rawElem: string, access: string;
  if (scfg.mode === 'array') {
    const base = scfg.cast ? `((${scfg.cast})(${scfg.root}))` : `(${scfg.root})`;
    rawElem = `${base}[${rowIndex}]`;
    access = scfg.access ?? '.';
  } else {   // linked_list: root->next->...->next (rowIndex kez)
    let e = scfg.root; const nx = scfg.next ?? 'next';
    for (let k = 0; k < rowIndex; k++) e = e + '->' + nx;
    rawElem = e; access = '->';
  }
  const elem = scfg.wrap ? '(' + scfg.wrap.split('${expr}').join('(' + rawElem + ')') + ')' : rawElem;
  const row = await collectRowFields(session, effFields, frameId, rawElem, elem, access);
  log?.debug(`refreshRow: ${section}[${rowIndex}] -> ${Object.keys(row).filter(k => k.indexOf('__') !== 0).length} field(s)`);
  panel.webview.postMessage({ type: 'patchRow', section, rowIndex, row });
  } finally { rel(); }
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
    // #7: log kapalıysa (off) her sonuçta regex temizleme + hata-tespiti yapma (sıcak yol)
    if (logThreshold < LOG_LEVELS.off) {
      const clean = out.replace(/\s+/g, ' ').trim();
      log.debug(`gdb ▸ ${command}`);                 // hazırlanan erişim string'i
      log.trace(`gdb ◂ ${clean}`);                   // sonuç
      if (/no symbol|cannot|not (defined|available)|incomplete|error/i.test(clean))
        log.warn(`gdb access failed: ${command}  ⇒  ${clean}`);
    }
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

// --- #5 per-element batch: bir elemanı TEK 'print' ile çekip alanları parse et ---
// Düz üye yolu mu? (sadece ad/iç-içe ad: "id", "link.idx"; ${expr}/cast/operatör/[i] DEĞİL)
function isPlainExpr(expr: string): boolean {
  return /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test((expr ?? '').trim());
}
// GDB struct çıktısını derinlik/tırnak-duyarlı, üst-düzey virgülle böl
function splitTopLevel(s: string): string[] {
  const parts: string[] = []; let depth = 0, q = '', buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      buf += c;
      // kapanış tırnağı: önündeki ardışık \ TEK ise escape'li (kapanmaz), ÇİFT/0 ise gerçekten kapanır
      // ("C:\\" gibi ters-bölü ile biten string'ler doğru kapansın — trimCString ile aynı kaçış kuralı)
      if (c === q) { let n = 0; for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++; if (n % 2 === 0) q = ''; }
      continue;
    }
    if (c === '"' || c === "'") { q = c; buf += c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; buf += c; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; buf += c; continue; }
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim() !== '') parts.push(buf);
  return parts;
}
// "{a = 1, name = 0x.. \"x\", tag = \"ab\\000\", sub = {b = 2}}" -> { a:"1", name:'0x.. "x"', ... }
// (char dizisi gibi virgül içeren değerler, 'ad =' ile başlamayan parçalar öncekine eklenerek korunur)
function parseStruct(blob: string): Record<string, string> | null {
  if (!blob) return null;
  const a = blob.indexOf('{'); const b = blob.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return null;
  const parts = splitTopLevel(blob.slice(a + 1, b));
  const map: Record<string, string> = {}; let last: string | null = null;
  for (const p of parts) {
    const m = p.match(/^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/);
    if (m) { map[m[1]] = m[2].trim(); last = m[1]; }
    else if (last) { map[last] += ',' + p; }   // virgüllü değerin devamı (char dizisi/<repeats>)
  }
  return map;
}
// parse edilmiş üst-düzey haritadan nokta'lı yolu çöz (iç-içe struct'a iner)
function structMember(map: Record<string, string> | null, path: string): string | undefined {
  if (!map) return undefined;
  const keys = path.split('.');
  let v: string | undefined = map[keys[0]];
  for (let i = 1; i < keys.length && v !== undefined; i++) {
    const nm = parseStruct(v); if (!nm) return undefined; v = nm[keys[i]];
  }
  return v;
}

// Bir satırın alanlarını topla. #5: >=2 düz-üye alan varsa elemanı TEK 'print' ile çekip
// parse eder (eşleşmezse alan-alan fallback). when/wrap/bar/${expr}/computed alanlar her zaman alan-alan.
async function collectRowFields(
  session: vscode.DebugSession, fields: FieldCfg[], frameId: number | undefined,
  rawElem: string, wrapElem: string, access: string,
  editRaw: string = rawElem, editWrap: string = wrapElem   // __edit__ l-value için KARARLI eleman (linked'de cursor değil root->next^i)
): Promise<Row> {
  const row: Row = {};
  row['__el__'] = editWrap;   // satırın KARARLI eleman ifadesi -> "watch ifadesi olarak kopyala" (tüm modlarda geçerli)
  let parsed: Record<string, string> | null = null;
  const plainCount = fields.filter(f => isPlainExpr(f.expr) && !f.wrap).length;
  if (plainCount >= 2) {
    const blobExpr = access === '->' ? `*(${wrapElem})` : `(${wrapElem})`;
    parsed = parseStruct((await gdbExec(session, `print ${blobExpr}`, frameId)).toString());
  }
  for (const f of fields) {
    if (f.when && !condTrue(cleanValue(await gdbExec(session, `print ${resolveFieldExpr(f.when, rawElem, wrapElem, access)}`, frameId)))) { row[f.label] = ''; continue; }
    let accExpr = resolveFieldExpr(f.expr, rawElem, wrapElem, access);
    if (f.wrap) accExpr = f.wrap.split('${expr}').join('(' + accExpr + ')');
    let val: string | undefined;
    if (parsed && !f.wrap && isPlainExpr(f.expr)) {
      const m = structMember(parsed, f.expr);
      if (m !== undefined) val = cleanValue(m);                 // batch'ten
    }
    if (val === undefined) val = cleanValue(await gdbExec(session, `print ${accExpr}`, frameId));   // fallback
    row[f.label] = val;
    if (f.editable) {
      // __edit__ KARARLI eleman üzerinden (geçici cursor değil) -> set var gerçek alanı değiştirir
      let editExpr = resolveFieldExpr(f.expr, editRaw, editWrap, access);
      if (f.wrap) editExpr = f.wrap.split('${expr}').join('(' + editExpr + ')');
      row['__edit__' + f.label] = editExpr;
    }
    // __lv__ = düz üye alanının KARARLI l-value'su (watchpoint hedefi: 'watch <lvalue>'). Sadece düz üye (computed/wrap değil).
    if (isPlainExpr(f.expr) && !f.wrap) row['__lv__' + f.label] = resolveFieldExpr(f.expr, editRaw, editWrap, access);
    if (f.bar) {
      const mx = barMaxExpr(f);
      if (mx) row['__bar__' + f.label] = /^\d+$/.test(mx) ? mx : cleanValue(await gdbExec(session, `print ${resolveFieldExpr(mx, rawElem, wrapElem, access)}`, frameId));
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// configPath mutlaksa doğrudan; göreliyse workspace köküne göre çözülür
function configFilePath(): string | undefined {
  const rel: string =
    vscode.workspace.getConfiguration('debugInspector').get('configPath') ?? 'debug-inspector.json';
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
  name: string = '',
  isStale?: () => boolean   // iptal kancası: continue/yeni durak gelince satır döngüsünü erken bırak (çalışan hedefe print atma)
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
      if (isStale && isStale()) break;   // continue/yeni durak -> çalışan hedefe print atma, erken bırak
      // eleman: ((cast*)root)[i]; field'a erişmeden ÖNCE wrap ile sarmalanır
      const elemRaw = `${base}[${i}]`;
      const elem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + elemRaw + ')') + ')' : elemRaw; // (wrap)<access>field
      rows.push(await collectRowFields(session, cfg.fields, frameId, elemRaw, elem, access));
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
      if (isStale && isStale()) { reason = 'stale (resumed/superseded)'; break; }
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
      rows.push(await collectRowFields(session, cfg.fields, frameId, elemRaw, elem, access));
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
  } else if (cfg.mode === 'tree') {
    // ağaç: kök + çocuk pointer alanları (varsayılan left/right) — BFS; her satır __parent__ (flat index) taşır.
    const childFields = (Array.isArray(cfg.children) && cfg.children.length) ? cfg.children : ['left', 'right'];
    const queue: { expr: string; parent: number }[] = [{ expr: cfg.root, parent: -1 }];
    const seen: Record<string, boolean> = {};   // adres -> döngü koruması
    let reason = 'end';
    log.debug(`tree "${name}": root=${cfg.root}, children=[${childFields.join(', ')}], access="->"`);
    while (queue.length) {
      if (isStale && isStale()) { reason = 'stale (resumed/superseded)'; break; }
      if (rows.length >= max) { reason = `max bound (${max})`; break; }
      const node = queue.shift()!;
      const curRaw = cleanValue(await gdbExec(session, `print ${node.expr}`, frameId));
      // NULL veya OKUNAMAZ (hatalı/eksik child alanı, dangling pointer) -> alt-ağacı sonlandır (sahte satır + sonsuz fan-out olmasın)
      if (isNull(curRaw) || /^<<error|no symbol|cannot access memory|<error reading|there is no member|value (has been )?optimized out/i.test(curRaw)) continue;
      const am = curRaw.match(/0x[0-9a-fA-F]+/);
      const key = am ? am[0] : node.expr;
      if (key !== '0x0' && seen[key]) continue;   // aynı düğüm tekrar -> döngü, atla
      seen[key] = true;
      // elemana erişmeden ÖNCE wrap; kararlı yol ifadesi (root->left->right...) edit/watch için
      const elem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + node.expr + ')') + ')' : node.expr;
      const myIdx = rows.length;
      const row = await collectRowFields(session, cfg.fields, frameId, node.expr, elem, '->', node.expr, elem);
      row['__parent__'] = node.parent < 0 ? '' : String(node.parent);
      rows.push(row);
      for (const cf of childFields) queue.push({ expr: `${node.expr}->${cf}`, parent: myIdx });
      log.trace(`tree "${name}" node ${myIdx} (parent ${node.parent}): ${node.expr} = ${curRaw}`);
    }
    log.debug(`tree "${name}": ${rows.length} node(s); stopped: ${reason}`);
  } else {
    log.debug(`linked_list "${name}": root=${cfg.root}, advance via cursor->${cfg.next}, access="->"`);
    let guard = 0;
    let reason = 'end';
    const nx = cfg.next ?? 'next';
    const needStable = true;   // kararlı zincir (root->next^i): edit l-value VE 'watch ifadesi kopyala' için her satırda gerekli
    // #2: cursor=root + ilk değer (null-check) TEK çağrıda; düğüm başına ayrı 'print cursor' turu yok
    let cur = cleanValue(await gdbExec(session, `print ${cursor} = ${cfg.root}`, frameId));
    while (true) {
      if (isStale && isStale()) { reason = 'stale (resumed/superseded)'; break; }
      if (guard++ >= max) { reason = `max bound (${max})`; break; }
      if (isNull(cur)) { reason = 'reached NULL'; break; }
      // node (cursor); field'a erişmeden ÖNCE wrap ile sarmalanır
      const elem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + cursor + ')') + ')' : cursor; // (wrap)->field
      // KARARLI eleman (cursor'a bağlı değil): root(->next)^index — edit sonrası set var doğru alana yazsın
      let sRaw = cursor, sElem = elem;
      if (needStable) {
        sRaw = cfg.root; for (let k = 0; k < rows.length; k++) sRaw = sRaw + '->' + nx;
        sElem = cfg.wrap ? '(' + cfg.wrap.split('${expr}').join('(' + sRaw + ')') + ')' : sRaw;
      }
      rows.push(await collectRowFields(session, cfg.fields, frameId, cursor, elem, '->', sRaw, sElem));
      log.trace(`linked_list "${name}" node ${guard - 1}: cursor=${cur} → advance via ${cursor}->${cfg.next}`);
      // #2: advance + sonraki değeri (null-check) TEK çağrıda — eski 'set' + ayrı 'print cursor' yerine
      cur = cleanValue(await gdbExec(session, `print ${cursor} = ${cursor}->${cfg.next}`, frameId));
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
// Kolon -> değer->renk rozet eşlemesi (field.badge verilmişse)
function fieldBadges(fields: FieldCfg[]): Record<string, Record<string, string>> {
  const m: Record<string, Record<string, string>> = {};
  for (const f of fields) if (f.badge && typeof f.badge === 'object') m[f.label] = f.badge;
  return m;
}

// Yalnız AKTİF sütunları gdb'den çek (pasif sütunlar için print çalıştırılmaz)
async function buildSection(
  session: vscode.DebugSession,
  cfg: SectionCfg,
  frameId: number | undefined,
  cursor: string,
  name: string,
  isStale?: () => boolean
): Promise<Section> {
  const eff = effectiveColumns(name, cfg.fields);
  const effFields = eff.active
    .map(l => cfg.fields.find(f => f.label === l))
    .filter((f): f is FieldCfg => !!f);
  const rows = await collectSection(session, { ...cfg, fields: effFields }, frameId, cursor, name, isStale);
  log?.debug(`section "${name}" (${cfg.mode}, root=${cfg.root}): ${rows.length} row(s); active=[${eff.active.join(', ')}]`);
  const kind: 'linked' | 'array' | 'index' | 'tree' = cfg.mode === 'array' ? 'array' : cfg.mode === 'index_list' ? 'index' : cfg.mode === 'tree' ? 'tree' : 'linked';
  return { name, columnsAll: eff.order, hidden: eff.hidden, rows, summary: summarize(name, rows), bases: fieldBases(cfg.fields), bars: fieldBars(cfg.fields), links: fieldLinks(cfg.fields), badges: fieldBadges(cfg.fields), kind };
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
  masters: Record<string, { sec: Section; selExprs: string[]; cfg: SectionCfg }>,
  isStale?: () => boolean
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
    if (isStale && isStale()) break;   // continue/yeni durak -> grupları çekmeyi bırak
    const selExpr = m.selExprs[mi];
    const subCfg: SectionCfg = {
      ...scfg,
      fields: effFields,
      root: substituteMaster(scfg.root, selExpr),
      count: scfg.count ? substituteMaster(scfg.count, selExpr) : scfg.count,
      head: scfg.head ? substituteMaster(scfg.head, selExpr) : scfg.head,
      nil: scfg.nil ? substituteMaster(scfg.nil, selExpr) : scfg.nil
    };
    const rows = await collectSection(session, subCfg, frameId, '$rg_' + i + '_' + mi, name, isStale);
    const key = rowKeyAt(m.sec, mi) ?? String(mi);
    const label = m.cfg.label
      ? nodeLabel(cleanValue(await gdbExec(session, `print (${selExpr})${masterAcc}${m.cfg.label}`, frameId)))
      : key;
    groups.push({ label, key, rows });
  }
  const total = groups.reduce((a, g) => a + g.rows.length, 0);
  log?.debug(`grouped "${name}" by ${scfg.groupBy}: ${groups.length} group(s), ${total} row(s)`);
  return { name, columnsAll: eff.order, hidden: eff.hidden, rows: [], summary: `${total} ${name} · ${groups.length} ${scfg.groupBy}`, grouped: true, groups, bases: fieldBases(scfg.fields), bars: fieldBars(scfg.fields), links: fieldLinks(scfg.fields), badges: fieldBadges(scfg.fields) };
}

// ---------------------------------------------------------------------------
// Yenileme
// ---------------------------------------------------------------------------
// Bir bölümün VERİYİ etkileyen imzası (GDB'den ne çekildiğini belirleyen alanlar).
// HARİÇ (yalnız sunum, GDB gerektirmez): base, bar.warn/crit, link, badge.
function dataSig(cfg: SectionCfg): string {
  const barMax = (b: any) => (b == null ? null : (typeof b === 'object' ? b.max : b));
  return JSON.stringify({
    mode: cfg.mode, root: cfg.root, next: cfg.next, head: cfg.head, nil: cfg.nil,
    count: cfg.count, access: cfg.access, cast: cfg.cast, wrap: cfg.wrap,
    groupBy: cfg.groupBy, max: cfg.max, label: cfg.label,
    fields: (cfg.fields || []).map(f => ({ l: f.label, e: f.expr, w: f.wrap, wn: f.when, bm: barMax(f.bar), ed: !!f.editable, h: !!f.hidden }))
  });
}
// sekme sırası + etkin gizli küme (refresh ile aynı kurallar)
function resolveLayout(secs: { name: string; cfg: SectionCfg }[]) {
  const allNames = secs.map(s => s.name);
  const order = (sectionPrefs.order || []).filter(n => allNames.includes(n));
  for (const n of allNames) if (!order.includes(n)) order.push(n);
  const configHidden = secs.filter(s => s.cfg.hidden).map(s => s.name);
  const hiddenNames = sectionPrefs.touched ? (sectionPrefs.hidden || []) : configHidden;
  const hiddenSet = new Set(hiddenNames.filter(n => allNames.includes(n)));
  return { order, hiddenSet, visible: order.filter(n => !hiddenSet.has(n)) };
}
// VERİ parmak izi: sıra + gizli küme + her bölümün dataSig'i. Değişmezse config'te yalnız sunum değişmiş demektir.
function fingerprintOf(secs: { name: string; cfg: SectionCfg }[], lay: { order: string[]; hiddenSet: Set<string> }): string {
  return JSON.stringify({ o: lay.order, h: [...lay.hiddenSet].sort(), s: secs.map(x => [x.name, dataSig(x.cfg)]) });
}
let lastFingerprint = '';

async function refresh(session: vscode.DebugSession, threadId: number, gen?: number) {
  if (!panel) return;
  const stale = () => gen !== undefined && gen !== refreshGen;   // daha yeni istek geldiyse bu refresh iptal
  const cfg = loadConfig();
  if (!cfg) return;

  // #7: frameId'yi durak başına BİR KEZ çek, lastStopped'ta cache'le (config/edit/manual yenilemelerde stackTrace turu yok)
  const sameStop = lastStopped && lastStopped.session === session && lastStopped.threadId === threadId;
  let frameId: number | undefined = sameStop ? lastStopped!.frameId : undefined;
  if (frameId === undefined) {
    try {
      const st = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
      frameId = st?.stackFrames?.[0]?.id;
    } catch { /* ignore */ }
    if (sameStop) lastStopped!.frameId = frameId;
  }

  // #3: oturum başına BİR KEZ kompakt/güvenli print ayarları (tutarlı tek-satır çıktı + büyük değerlerde hata yok)
  if (printSetupFor !== session) {
    printSetupFor = session;
    await gdbExec(session, 'set print pretty off', frameId);
    await gdbExec(session, 'set max-value-size unlimited', frameId);
  }

  const secs = extractSections(cfg);
  const byName: Record<string, { name: string; cfg: SectionCfg; i: number }> = {};
  secs.forEach((s, i) => { byName[s.name] = { name: s.name, cfg: s.cfg, i }; });
  const lay = resolveLayout(secs);
  const order = lay.order, hiddenSet = lay.hiddenSet, visible = lay.visible;
  lastFingerprint = fingerprintOf(secs, lay);   // sonraki config değişimini "veri mi sunum mu" diye karşılaştırmak için taban
  const ts = new Date().toLocaleTimeString();
  log?.info(`refresh: ${secs.length} section(s); visible=[${visible.join(', ')}] active=${activeTab ?? '-'}`);

  // iskeleti hazırla (ts + layout + kaldırılanları temizle); bölümler aşağıda ÖNCELİKLİ akışla gelir
  panel.webview.postMessage({ type: 'beginUpdate', order, visible, hiddenSections: order.filter(n => hiddenSet.has(n)), ts });
  sendWatchpoints();   // webview izlenen hücreleri ★ ile işaretlesin (yenileme sonrası da korunur)

  // master cache (grouped bölümlerin bağımlılığı); görünür bir master kurulunca hemen gönderilir
  const masters: Record<string, { sec: Section; selExprs: string[]; cfg: SectionCfg }> = {};
  const built = new Set<string>();
  const sendSec = (name: string, sec: Section) => { built.add(name); panel?.webview.postMessage({ type: 'patchSection', section: name, sec, ts }); };
  const ensureMaster = async (mName: string): Promise<void> => {
    if (masters[mName]) return;
    const mm = byName[mName]; if (!mm) return;
    const msec = await buildSection(session, mm.cfg, frameId, '$ri_' + mm.i, mName, stale);
    masters[mName] = { sec: msec, selExprs: msec.rows.map((_, idx) => selectorExpr(mm.cfg, idx)), cfg: mm.cfg };
    if (visible.includes(mName) && !built.has(mName)) sendSec(mName, msec);   // master aynı zamanda görünür sekme -> hemen göster
  };

  // ÖNCELİKLİ KUYRUK: aktif sekme önce, sonra kalanlar (config sırası). Sekme değişirse (activeTab) sıradaki öncelik değişir.
  const remaining = () => visible.filter(n => !built.has(n));
  let rem: string[];
  while ((rem = remaining()).length) {
    if (stale()) return;   // daha yeni durak/istek -> bu (eski) akışı bırak
    const next = (activeTab && rem.includes(activeTab)) ? activeTab : rem[0];
    const node = byName[next];
    let sec: Section;
    if (isGrouped(node.cfg)) {
      await ensureMaster(node.cfg.groupBy as string);
      if (stale()) return;
      sec = await buildGrouped(session, frameId, node.i, next, node.cfg, masters, stale);
    } else if (masters[next]) {
      sec = masters[next].sec;   // başka bir grouped bölüm için zaten kurulmuş
    } else {
      sec = await buildSection(session, node.cfg, frameId, '$ri_' + node.i, next, stale);
      masters[next] = { sec, selExprs: sec.rows.map((_, idx) => selectorExpr(node.cfg, idx)), cfg: node.cfg };
    }
    if (stale()) return;
    if (!built.has(next)) sendSec(next, sec);
  }
  if (stale()) return;
  panel.webview.postMessage({ type: 'endUpdate', ts });   // akış bitti -> webview aktif sekmeyi son kez boyar (çapraz-link çözülür)
}

// ---------------------------------------------------------------------------
// Webview
// ---------------------------------------------------------------------------
function openPanel(context: vscode.ExtensionContext) {
  if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
  panel = vscode.window.createWebviewPanel(
    'debugInspector', 'Debug Inspector', vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  panel.webview.onDidReceiveMessage(
    async (msg: any) => {
      if (msg?.type === 'refresh') { log?.debug('webview: manual refresh'); doRefresh(); return; }
      if (msg?.type === 'activeTab') { if (typeof msg.section === 'string') activeTab = msg.section; return; }
      if (msg?.type === 'setColumns' && typeof msg.section === 'string' && msg.section) {
        log?.debug(`webview: setColumns ${msg.section} hidden=[${(msg.hidden || []).join(', ')}] refetch=${!!msg.refetch}`);
        columnPrefs[msg.section] = {
          order: Array.isArray(msg.order) ? msg.order : [],
          hidden: Array.isArray(msg.hidden) ? msg.hidden : []
        };
        extContext?.workspaceState.update(COLPREF_KEY, columnPrefs);
        // yeni bir sütun aktifleştirildiyse SADECE o field'ı çek (bilinmiyorsa o bölümü), tüm paneli değil
        if (msg.refetch) {
          if (typeof msg.shown === 'string' && msg.shown) refreshTarget(msg.section, msg.shown);
          else refreshTarget(msg.section);
        }
      } else if (msg?.type === 'setPaused') {
        paused = !!msg.paused;
        log?.info(`webview: ${paused ? 'paused' : 'resumed'}`);
        extContext?.workspaceState.update(PAUSED_KEY, paused);
        if (!paused && lastStopped) doRefresh();
      } else if (msg?.type === 'copy' && typeof msg.text === 'string') {
        vscode.env.clipboard.writeText(msg.text);
        log?.debug(`webview: copied ${msg.text.length} chars to clipboard`);
      } else if (msg?.type === 'watchpoint' && typeof msg.expr === 'string' && msg.expr) {
        // GDB veri-watchpoint'i: değer değişince program durur (bellek YAZMAZ; sadece break davranışı). Opt-in (sağ-tık).
        if (!lastStopped) { vscode.window.showWarningMessage('Debug Inspector: debugger not stopped — cannot set a watchpoint.'); return; }
        if (watchpoints[msg.expr] !== undefined) { sendWatchpoints(); return; }   // zaten izleniyor
        const sess = lastStopped.session, fid = lastStopped.frameId;
        // ADRES-YAKALAMA: ifadenin adresini bir convenience var'a al, sonra 'watch *$w'. Sabit adres izlenir,
        // erişim yolundaki pointer'lar izlenmez -> deref'li (->) ifade bile TEK HW register harcar (hardware, hızlı).
        wpCounter++;
        const wv = '$di_wp' + wpCounter;
        const addrRes = (await gdbExec(sess, `print ${wv} = &(${msg.expr})`, fid)).toString().replace(/\s+/g, ' ').trim();
        // adres alınamazsa (bitfield/register/optimize) ifadeyi doğrudan izle (fallback)
        const target = /no symbol|cannot|invalid|bit-?field|<<error/i.test(addrRes) ? msg.expr : ('*' + wv);
        // ek güvenlik: HW limiti aşılırsa (varsayılan 2) software'e düş -> 'continue' "too many" ile patlamasın
        const hwLimit = Number(vscode.workspace.getConfiguration('debugInspector').get('maxHardwareWatchpoints') ?? 2);
        const useSoftware = Object.keys(watchpoints).length >= hwLimit;
        if (useSoftware) await gdbExec(sess, 'set can-use-hw-watchpoints 0', fid);
        const res = (await gdbExec(sess, `watch ${target}`, fid)).toString().replace(/\s+/g, ' ').trim();
        if (useSoftware) await gdbExec(sess, 'set can-use-hw-watchpoints 1', fid);
        log?.info(`watchpoint: watch ${target} [${msg.expr}] (${useSoftware ? 'software' : 'hardware'})  ⇒  ${res || 'ok'}`);
        if (/no symbol|cannot|invalid|<<error/i.test(res)) {
          vscode.window.showErrorMessage(`Debug Inspector: watchpoint failed — ${res}`);
        } else {
          // HATA YOKSA izlenmiş işaretle (★) — numara parse'ına bağlı DEĞİL (cppdbg numarayı echo'lamayabilir).
          const m = res.match(/[Ww]atchpoint (\d+):/);
          let n = m ? parseInt(m[1], 10) : await findWatchNum(sess, fid, target);
          watchpoints[msg.expr] = Number.isFinite(n) ? n : -1;   // -1: numara bulunamadı ama izleniyor
          sendWatchpoints();
          vscode.window.showInformationMessage(`Debug Inspector: watchpoint set on ${msg.expr}${Number.isFinite(n) ? ' (#' + n + ')' : ''}${useSoftware ? ' (software — beyond the hardware limit)' : ''} — program stops when it changes.`);
        }
      } else if (msg?.type === 'unwatchpoint' && typeof msg.expr === 'string' && msg.expr) {
        // watchpoint'i kaldır (GDB 'delete <no>'); numara bilinmiyorsa info watchpoints'tan bul
        let n = watchpoints[msg.expr];
        if (lastStopped && (n === undefined || !Number.isFinite(n) || n < 0)) n = await findWatchNum(lastStopped.session, lastStopped.frameId, msg.expr);
        if (lastStopped && Number.isFinite(n) && n >= 0) await gdbExec(lastStopped.session, `delete ${n}`, lastStopped.frameId);
        delete watchpoints[msg.expr];
        sendWatchpoints();
        log?.info(`watchpoint removed: ${msg.expr} (#${n})`);
        vscode.window.showInformationMessage(`Debug Inspector: watchpoint removed — ${msg.expr}`);
      } else if (msg?.type === 'copyWatch' && typeof msg.text === 'string' && msg.text) {
        // VS Code'da watch ifadesi EKLEMEK için public API yok -> panoya kopyala, kullanıcı Watch'a yapıştırır
        vscode.env.clipboard.writeText(msg.text);
        log?.info(`watch expr copied: ${msg.text}`);
        vscode.window.showInformationMessage(`Watch expression copied — paste it into the Watch panel (Add Expression): ${msg.text}`);
      } else if (msg?.type === 'setSections') {
        sectionPrefs = {
          order: Array.isArray(msg.order) ? msg.order : [],
          hidden: Array.isArray(msg.hidden) ? msg.hidden : [],
          touched: true   // kullanıcı seçim yaptı: bundan sonra config "hidden" yoksayılır
        };
        log?.debug(`webview: setSections order=[${sectionPrefs.order.join(', ')}] hidden=[${sectionPrefs.hidden.join(', ')}] reveal=${msg.reveal || '-'}`);
        extContext?.workspaceState.update(SECPREF_KEY, sectionPrefs);
        // reorder/hide tamamen istemci-tarafı (GDB yok); SADECE gösterilen bölümü çek (tüm paneli değil)
        if (msg.reveal) refreshTarget(msg.reveal);
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
        const frameId = lastStopped.frameId;   // durakta cache'li; ekstra stackTrace turu yok
        const res = (await gdbExec(lastStopped.session, `set var ${msg.expr} = ${val}`, frameId)).toString().replace(/\s+/g, ' ').trim();
        log?.info(`edit: set var ${msg.expr} = ${val}  ⇒  ${res || 'ok'}`);
        const errored = /no symbol|cannot|lvalue|error|invalid|<<error/i.test(res);
        if (errored) {
          vscode.window.showErrorMessage(`Debug Inspector: edit failed — ${res}`);
        } else if (msg.section && typeof msg.rowIndex === 'number' && typeof msg.label === 'string') {
          // ANINDA geri-bildirim: girilen değeri hücreye hemen yaz (re-fetch arka planda doğrular + bağımlı hücreleri yeniler)
          panel?.webview.postMessage({ type: 'patchRow', section: msg.section, rowIndex: msg.rowIndex, row: { [msg.label]: String(val) } });
        }
        // SADECE düzenlenen satırı yeniden çek (tüm paneli değil); bilinmiyorsa eski davranışa düş
        if (typeof msg.section === 'string' && msg.section) refreshRow(msg.section, typeof msg.rowIndex === 'number' ? msg.rowIndex : null);
        else doRefresh();
      } else if (msg?.type === 'export' && typeof msg.json === 'string') {
        // tüm görünür bölümlerin verisini JSON dosyasına dışa aktar
        const folder = vscode.workspace.workspaceFolders?.[0];
        const def = folder ? vscode.Uri.joinPath(folder.uri, 'debug-inspector-export.json') : vscode.Uri.file('debug-inspector-export.json');
        const uri = await vscode.window.showSaveDialog({ defaultUri: def, filters: { JSON: ['json'] }, saveLabel: 'Export' });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.json, 'utf8'));
        log?.info(`exported sections to ${uri.fsPath} (${msg.json.length} chars)`);
        vscode.window.showInformationMessage(`Debug Inspector: exported to ${uri.fsPath}`);
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
  .dash.err { opacity: 0.9; color: var(--vscode-errorForeground, #e74c3c); cursor: help; }
  .wp-star { color: #f1c40f; margin-right: 4px; font-size: 11px; }
  td[data-wp] { box-shadow: inset 2px 0 0 #f1c40f; }
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
  .empty.loading { font-style: italic; animation: di-pulse 1.2s ease-in-out infinite; }
  @keyframes di-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 0.7; } }
  @keyframes di-spin { to { transform: rotate(360deg); } }
  .btn.busy { opacity: 0.75; }
  .btn .ricon { display: inline-block; }
  .btn.busy .ricon { animation: di-spin 0.8s linear infinite; }
  .tab.updating::after { content: '⟳'; display: inline-block; margin-left: 5px; opacity: 0.7; font-size: 11px; animation: di-spin 0.8s linear infinite; }

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

  /* ---- Graph view (Phase 1) ---- */
  .gv-wrap { position: relative; margin-top: 4px; }
  .gv-svg {
    width: 100%; height: 70vh; min-height: 340px; display: block;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    border-radius: 10px; cursor: grab; user-select: none;
  }
  .gv-svg.panning { cursor: grabbing; }
  .gnode { cursor: grab; transition: opacity 0.12s; }
  .gnode.gv-dragging { cursor: grabbing; }
  .gnode.gv-dragging .card { stroke: var(--vscode-focusBorder, #3b9eff); stroke-width: 2; }
  .gnode .card {
    fill: var(--vscode-editorWidget-background, rgba(128,128,128,0.10));
    stroke: var(--vscode-panel-border, rgba(128,128,128,0.4)); stroke-width: 1;
    transition: stroke 0.12s;
  }
  .gnode:hover .card, .gnode.sel .card { stroke: var(--vscode-focusBorder, #3b9eff); }
  .gnode.sel .card { stroke-width: 2; }
  .gnode.gv-group .card { fill: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.18)); }
  .gnode .gtitle { fill: var(--vscode-foreground); font-size: 12.5px; font-weight: 600; }
  .gnode .gsub { fill: var(--vscode-descriptionForeground, #8a8a8a); font-size: 10.5px; }
  .gnode .flab { fill: var(--vscode-descriptionForeground, #8a8a8a); font-size: 10.5px; }
  .gnode .fval { fill: var(--vscode-foreground); font-size: 10.5px; }
  .gnode.dim { opacity: 0.16; }
  .gedge { fill: none; stroke: #7d8590; stroke-width: 1.5; transition: opacity 0.12s, stroke 0.12s, stroke-width 0.12s; }
  .gedge.dim { opacity: 0.1; }
  .gedge.ehl { stroke: #3b9eff; stroke-width: 2.5; }
  .gedge.link { stroke: #b07cc6; stroke-dasharray: 5 4; }
  .gedge.link.ehl { stroke: #c79fda; stroke-width: 2.5; }
  .gnode.gv-ghost .card { fill: rgba(176,124,198,0.10); stroke: #b07cc6; stroke-dasharray: 4 3; }
  .gnode.gv-ghost:hover .card, .gnode.gv-ghost.sel .card { stroke: #c79fda; stroke-dasharray: none; }
  .ghdr { fill: var(--vscode-descriptionForeground, #8a8a8a); font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }
  .gbarbg { fill: rgba(128,128,128,0.24); }
  .gpct { fill: var(--vscode-descriptionForeground, #8a8a8a); font-size: 9.5px; }
  .gv-detail {
    position: absolute; top: 12px; right: 12px; width: 232px; max-height: calc(100% - 28px); overflow: auto;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
    border-radius: 9px; padding: 11px 13px; font-size: 12px; display: none;
    box-shadow: 0 4px 18px rgba(0,0,0,0.4);
  }
  .gv-detail h3 { margin: 0 0 7px; font-size: 13px; padding-right: 14px; word-break: break-all; }
  .gv-detail .grow2 { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; color: var(--vscode-descriptionForeground, #8a8a8a); }
  .gv-detail .grow2 b { color: var(--vscode-foreground); font-weight: 500; word-break: break-all; text-align: right; }
  .gv-detail .close { position: absolute; top: 7px; right: 10px; cursor: pointer; opacity: 0.6; }
  .gv-detail .close:hover { opacity: 1; }
  .gv-banner { font-size: 11px; opacity: 0.7; margin: 6px 2px; }
  .gv-empty { opacity: 0.55; padding: 28px 4px; font-size: 13px; }

  /* ---- Graph Phase 3: search / minimap / level-of-detail ---- */
  .gv-search {
    flex: 0 0 150px; font-family: inherit; font-size: 12px; padding: 3px 9px; border-radius: 6px;
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
    background: var(--vscode-input-background, transparent);
    color: var(--vscode-input-foreground, var(--vscode-foreground));
  }
  .gv-search::placeholder { color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.7)); }
  .gv-srch-n { font-size: 11px; opacity: 0.7; min-width: 26px; }
  .gnode.gv-hit .card { stroke: #f1c40f; stroke-width: 2; }
  .gnode.gv-fade { opacity: 0.12; }
  .gedge.gv-fade { opacity: 0.06; }
  .gnode.gv-cur .card { stroke: #f39c12; stroke-width: 3; filter: drop-shadow(0 0 5px rgba(241,196,15,0.7)); }
  .gnode.gv-blink .card { animation: gvblink 1.6s ease-out; }
  @keyframes gvblink { 0%,30%,60% { stroke: #3b9eff; stroke-width: 4; } 15%,45%,100% { stroke: #3b9eff; stroke-width: 1; } }
  .gv-mini {
    position: absolute; left: 12px; bottom: 12px; width: 180px; height: 120px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    border-radius: 6px; box-shadow: 0 2px 12px rgba(0,0,0,0.45); cursor: pointer; opacity: 0.94; overflow: hidden;
  }
  .gv-mini.hidden { display: none; }
  .gv-mini .mnode { opacity: 0.8; }
  .gv-mini .mnode.gm-hit { fill: #f1c40f; opacity: 1; }
  .gv-mini .gv-vp { fill: rgba(59,158,255,0.16); stroke: #3b9eff; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .gv-wrap.lod-far .gnode .gtitle, .gv-wrap.lod-far .gnode .gsub, .gv-wrap.lod-far .gnode .gpct,
  .gv-wrap.lod-far .gnode .flab, .gv-wrap.lod-far .gnode .fval,
  .gv-wrap.lod-far .gnode .gbarbg, .gv-wrap.lod-far .gnode .gbarfill, .gv-wrap.lod-far .gnode circle { display: none; }
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
    <button id="export-btn" class="btn" title="Export all sections' data as JSON">⤓ JSON</button>
    <button id="pause" class="btn" title="Pause/resume auto-refresh on each stop">⏸ Pause</button>
    <button id="refresh" class="btn" title="Re-read config and refresh now"><span class="ricon">⟳</span> <span class="rlabel">Refresh</span></button>
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
  let watchedExprs = new Set();   // watchpoint kurulu l-value ifadeleri (★ + menüde Add/Remove)
  let hiddenSections = [];   // gizli sekme adları (Sections menüsünden açılabilir)
  let sectionOrder = [];     // TEK interleaved sıra (görünür+gizli), gerçek konumda
  let activeName = null;

  let refreshFallback = null;
  function setRefreshing(on) {
    const b = document.getElementById('refresh');
    if (!b) return;
    b.classList.toggle('busy', !!on);
    const lbl = b.querySelector('.rlabel');
    if (lbl) lbl.textContent = on ? 'Refreshing…' : 'Refresh';
  }
  document.getElementById('refresh').addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'refresh' });
    setRefreshing(true);   // anında görsel geri-bildirim (beginUpdate gelene kadar)
    if (refreshFallback) clearTimeout(refreshFallback);
    refreshFallback = setTimeout(() => setRefreshing(false), 4000);   // durmuş değil / akış gelmezse temizle
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
    notifyActive();   // uzantı o anki aktif sekmeyi bilsin (öncelik için)
  }

  function applyActive() {
    for (const t of tabsEl.querySelectorAll('.tab'))
      t.classList.toggle('active', currentNames[+t.dataset.idx] === activeName);
    for (const p of panesEl.querySelectorAll('.pane'))
      p.classList.toggle('hidden', currentNames[+p.dataset.idx] !== activeName);
  }

  function notifyActive() { if (activeName) vscodeApi.postMessage({ type: 'activeTab', section: activeName }); }
  function switchTab(name) {
    activeName = name;
    const t = tabElOf(name);
    if (t) t.classList.remove('haschg');
    applyActive();
    if (secState[name] && secState[name].sec) paint(name);   // taze boya: çapraz-link eşleşmesi + sıralama korunur
    notifyActive();   // uzantı sıradaki öncelik için bu sekmeyi öne alsın
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
    const tst = secState[targetSec];
    if (tst && tst.view === 'graph' && typeof tst._focusNode === 'function') tst._focusNode(matchCol, value);   // graph hedefi: node'a merkezlen + blink (tablo satırı yerine)
    else highlightRow(targetSec, matchCol, value);
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
  // config-driven rozet: değer -> renk (field.badge)
  var BADGE_COLORS = { green:'#2ecc71', blue:'#3498db', red:'#e74c3c', amber:'#f1c40f', yellow:'#f1c40f', orange:'#e67e22', purple:'#b07cc6', cyan:'#1abc9c', gray:'#9aa0a6', grey:'#9aa0a6' };
  function badgeHex(name) {
    if (!name) return null;
    var k = String(name).toLowerCase();
    if (BADGE_COLORS[k]) return BADGE_COLORS[k];
    return /^#[0-9a-fA-F]{6}$/.test(name) ? name : null;
  }
  function matchBadge(map, val) {
    if (!map) return null;
    var v = String(val).trim().toLowerCase();
    for (var k in map) { if (String(k).trim().toLowerCase() === v) return map[k]; }
    return null;
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
    // erişilemeyen/HATA -> kırmızı ⚠ (tooltip'te temiz mesaj); NULL/0x0 -> sade '-' (ayrı görünür)
    if (isUnreadable(val)) {
      const msg = String(val).replace(/^<<error:\\s*/, '').replace(/>>$/, '').trim() || 'unreadable';
      return '<span class="dash err" title="' + esc(msg) + '">⚠</span>';
    }
    if (isNullPtr(val)) return '<span class="dash" title="' + esc(val) + '">-</span>';
    const lc = String(col).toLowerCase();
    if (lc.includes('state') || lc.includes('durum'))
      return '<span class="badge ' + stateClass(val) + '">' + esc(val) + '</span>';
    if (lc.includes('discipline'))
      return '<span class="badge disc">' + esc(val) + '</span>';
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
  // Bu bölümün GİDEN (kendi link alanları) VEYA GELEN (başka bölüm buna link veriyor) linki var mı
  function sectionHasLinks(secObj) {
    if (secObj.links && Object.keys(secObj.links).length) return true;
    var nm = secObj.name;
    for (var k in secState) { var os = secState[k]; if (os && os.sec && os.sec.links) { for (var c in os.sec.links) if (os.sec.links[c].section === nm) return true; } }
    return false;
  }
  // --- araç çubuğu (filtre / changed-only / kopya); sayı tabanı artık per-kolon (▦ Columns) ---
  function toolbarHtml(st) {
    let h = '<div class="tbl-bar">';
    if (st.view === 'graph') {
      h += '<button class="btn view-toggle" title="Switch back to the table view">▤ Table</button>';
      h += '<button class="btn graph-fit" title="Fit the graph to the view">⤢ Fit</button>';
      if (sectionHasLinks(st.sec)) h += '<button class="btn links-toggle' + ((st.gv && st.gv.links) ? ' on' : '') + '" title="Show cross-section relationship links (purple) — outgoing and incoming">⇄ Links</button>';
      h += '<input class="gv-search" type="text" placeholder="Find — text or field>=3" value="' + esc((st.gv && st.gv.q) || '') + '" title="Find nodes by text, or a field test like count>=3 / state=running (operators > >= < <= = !=). Enter / Shift+Enter to cycle, Esc to clear">';
      h += '<span class="gv-srch-n"></span>';
      h += '<span class="grow"></span>';
      h += '<button class="btn map-toggle' + ((st.gv && st.gv.mini) ? ' on' : '') + '" title="Show / hide the minimap">◉ Map</button>';
      h += '<button class="btn cols-btn" title="Show / hide / reorder the fields shown on cards">▦ Fields</button>';
      h += '</div>';
      return h;
    }
    h += '<input class="tbl-filter" type="text" placeholder="Filter — text or PID>=3" value="' + esc(st.filter || '') + '" title="Filter rows by text, or a field test like PID>=3 / state=running (operators > >= < <= = !=); combine several">';
    if (st.sec.grouped) h += '<button class="btn grp-toggle">' + (st.flat ? '⊞ Tree' : '☰ Flat') + '</button>';
    else if (st.changeCount > 0) h += '<button class="btn chg-only' + (st.changedOnly ? ' on' : '') + '" title="Show only changed rows">Δ Changed</button>';
    h += '<span class="grow"></span>';
    h += '<button class="btn view-toggle" title="Show this section as a node graph">◉ Graph</button>';
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
    const tb = body.querySelector('tbody'); if (!tb) return;
    // filtre artık düz metin + ALAN PREDİKATLARI (PID>=3, state=running ...) — graph aramasıyla aynı kurallar
    const pq = parseSearch(st.filter || '');
    const chgOnly = st.changedOnly && !st.sec.grouped && st.changeCount > 0;
    const active = pq.active || chgOnly;                 // herhangi bir gizleme kriteri var mı
    const cols = displayCols(st);
    const allRows = st.sec.grouped ? st.sec.groups.reduce((a, g) => a.concat(g.rows), []) : st.sec.rows;
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
      if (pq.active) {
        const txt = tr.textContent.toLowerCase();
        for (let i = 0; i < pq.plain.length && show; i++) if (txt.indexOf(pq.plain[i]) === -1) show = false;   // düz terimler: satır metni
        if (show && pq.preds.length) {   // predikatlar: satırın alan değerinde (data-ri -> kaynak satır)
          const ri = (tr.dataset.ri != null && tr.dataset.ri !== '') ? +tr.dataset.ri : -1;
          const node = { cols: cols, row: (ri >= 0 && allRows[ri]) ? allRows[ri] : {} };
          for (let j = 0; j < pq.preds.length && show; j++) if (!predOk(node, pq.preds[j])) show = false;
        }
      }
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
  // link yalnız HEDEFTE eşleşen satır varsa bağlansın (0 / eşleşmeyen değer -> düz metin)
  function linkHasTarget(lk, value) {
    const st = secState[lk.section];
    if (!st || !st.sec) return false;
    const vis = st.order ? st.order.filter(l => st.hidden.indexOf(l) === -1) : [];
    const mc = lk.match || vis[0];
    if (!mc) return false;
    const rows = st.sec.grouped
      ? (st.sec.groups || []).reduce((a, g) => a.concat(g.rows || []), [])
      : (st.sec.rows || []);
    return rows.some(r => String(r[mc]) === String(value));
  }
  function dataRow(columns, row, changed, opts, ri) {
    opts = opts || {};
    const numCols = opts.numCols || {};
    const colBase = opts.colBase || {};
    const bars = opts.bars || {};
    const links = opts.links || {};
    const badges = opts.badges || {};
    const sortCol = opts.sortCol;
    const rk = rowKeyOf(row, columns);
    let h = '<tr' + (ri != null ? ' data-ri="' + ri + '"' : '') + (row['__el__'] ? ' data-el="' + esc(row['__el__']) + '"' : '') + '>';   // data-ri=kaynak satır; data-el=watch ifadesi (kararlı eleman)
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
      let inner;
      if (lk && raw !== '' && !isDash(raw) && linkHasTarget(lk, raw)) {
        inner = '<a class="xref" data-sec="' + esc(lk.section) + '" data-match="' + esc(lk.match || '') + '" data-val="' + esc(raw) + '">' + esc(disp) + '</a>';
      } else {
        const bhex = (!isDash(raw)) ? badgeHex(matchBadge(badges[c], raw)) : null;   // config-driven rozet
        inner = bhex
          ? '<span class="badge" style="background:' + bhex + '30;color:' + bhex + '">' + esc(disp) + '</span>'
          : cell(c, disp);
      }
      if (isChg) {
        const ov = isDash(changed[ck]) ? '-' : changed[ck];
        inner += '<span class="old" title="previous value">' + esc(ov) + '</span>';
      }
      const ed = row['__edit__' + c];
      const lv = (row['__lv__' + c] != null) ? row['__lv__' + c] : ed;   // watchpoint hedefi (düz üye l-value, ya da editable)
      const editAttr = (ed != null) ? ' data-edit="' + esc(ed) + '" data-col="' + esc(c) + '"' : '';
      const lvAttr = (lv != null) ? ' data-lv="' + esc(lv) + '"' : '';
      const watched = (lv != null && watchedExprs.has(lv));
      const star = watched ? '<span class="wp-star" title="watchpoint set — break on change">★</span>' : '';
      // hover (tooltip): izlenen hücrede watchpoint olduğunu da belirt
      const ttl = esc(raw) + (watched ? ' — ★ watchpoint set (break on change)' : '');
      h += '<td' + clsAttr + editAttr + lvAttr + (watched ? ' data-wp="1"' : '') + ' title="' + ttl + '">' + star + inner + '</td>';
    }
    return h + '</tr>';
  }
  function buildTable(columns, rows, sortCol, sortDir, changed, opts) {
    if (!rows.length) return '<div class="empty">List is empty (root is NULL or count is 0).</div>';
    // kaynak index'i koru (sıralama görüntüyü değiştirir; data-ri kaynak satıra işaret etmeli)
    let idx = rows.map((_, i) => i);
    if (sortCol && columns.indexOf(sortCol) !== -1)
      idx = idx.slice().sort((a, b) => { const c = compareVals(rows[a][sortCol] ?? '', rows[b][sortCol] ?? ''); return sortDir === 'desc' ? -c : c; });
    let h = '<table><thead><tr>' + headerCells(columns, sortCol, sortDir, opts && opts.numCols, opts && opts.colBase, opts && opts.bars) + '</tr></thead><tbody>';
    for (const i of idx) h += dataRow(columns, rows[i], changed, opts, i);
    return h + '</tbody></table>';
  }
  // groupBy: master düğümleri + altında satırlar (aç/kapa)
  function buildGroupedTable(columns, groups, collapsed, sortCol, sortDir, opts) {
    if (!groups || !groups.length) return '<div class="empty">No groups (master section is empty).</div>';
    let h = '<table><thead><tr>' + headerCells(columns, sortCol, sortDir, opts && opts.numCols, opts && opts.colBase, opts && opts.bars) + '</tr></thead><tbody>';
    let base = 0;   // flat kaynak index ofseti (patchRow gruplar arası düzleştirmeyle aynı sıra)
    for (const g of groups) {
      const isCol = collapsed.indexOf(g.key) !== -1;
      h += '<tr class="grphdr" data-grp="' + esc(g.key) + '"><td colspan="' + columns.length + '">' +
        '<span class="caret">' + (isCol ? '▸' : '▾') + '</span> ' + esc(g.label) +
        ' <span class="grpcnt">' + g.rows.length + '</span></td></tr>';
      if (!isCol) {
        let gi = g.rows.map((_, j) => j);
        if (sortCol && columns.indexOf(sortCol) !== -1)
          gi = gi.slice().sort((a, b) => { const c = compareVals(g.rows[a][sortCol] ?? '', g.rows[b][sortCol] ?? ''); return sortDir === 'desc' ? -c : c; });
        for (const j of gi) h += dataRow(columns, g.rows[j], null, opts, base + j);   // data-ri = flat kaynak index
      }
      base += g.rows.length;   // çökük gruplarda da say -> patchRow düzleştirmesiyle tutarlı
    }
    return h + '</tbody></table>';
  }

  // Görünen sütunlar = kullanıcı sırasındaki - gizlenenler
  function displayCols(st) {
    return st.order.filter(l => st.hidden.indexOf(l) === -1);
  }

  // ===== Graph view (Phase 1: tek section) — linked/index zinciri · grouped ağaç · array ızgara =====
  var GVW = 196, GVH = 62, GVGY = 18, GVGX = 64, GVPAD = 22, GVGROUPW = 188, GVGROUPH = 40, GRAPH_MAX = 1000;
  // tek kaynaktan st.gv başlatma (sc/tx/ty pan-zoom; sel seçim; pos sürükle konumları; q arama; hi geçerli eşleşme; mini minimap)
  function gvInit() { return { sc: 1, tx: 0, ty: 0, sel: null, needFit: true, pos: {}, q: '', hi: -1, mini: true }; }
  function shortVal(v) { var s = String(v == null ? '' : v); var m = s.match(/"([^"]*)"/); return m ? m[1] : s; }
  function stateHex(sc) { return sc === 's-run' ? '#2ecc71' : sc === 's-ready' ? '#3498db' : sc === 's-block' ? '#e74c3c' : sc === 's-wait' ? '#f1c40f' : null; }
  // Düğüm rengi: önce 'state/durum' kolonu, sonra config-driven rozet eşleşmesi
  function nodeColor(row, cols, badges) {
    for (var i = 0; i < cols.length; i++) {
      var lc = String(cols[i]).toLowerCase();
      if (lc.indexOf('state') !== -1 || lc.indexOf('durum') !== -1) { var h = stateHex(stateClass(row[cols[i]])); if (h) return h; }
    }
    for (var j = 0; j < cols.length; j++) { var bh = badgeHex(matchBadge(badges && badges[cols[j]], row[cols[j]])); if (bh) return bh; }
    return null;
  }
  // Sürükle-konum kalıcılık anahtarı: KARARLI satır kimliği (ilk kolon değeri — değişiklik-vurgusuyla aynı),
  // konumsal index değil -> liste yeniden sıralanınca taşınan konum doğru satırı izler (id'ye değil veriye bağlı)
  function posKeyOf(r, cols, fallback) { var k = rowKeyOf(r, cols); return k !== '' ? k : fallback; }
  // Arama sorgusu: düz metin (substring AND) + ALAN PREDİKATLARI "field OP value" (OP: > >= < <= = == !=).
  function parseSearch(q) {
    var preds = [], plain = [];
    var re = /([A-Za-z_][\\w]*)\\s*(>=|<=|!=|==|=|>|<)\\s*("[^"]*"|[^\\s]+)/g;
    var rest = String(q || '').replace(re, function (_, f, op, v) {
      preds.push({ f: f.toLowerCase(), op: op === '==' ? '=' : op, v: v.replace(/^"|"$/g, '') });
      return ' ';
    });
    rest.trim().toLowerCase().split(/\\s+/).forEach(function (t) { if (t) plain.push(t); });
    return { preds: preds, plain: plain, active: !!(preds.length || plain.length) };
  }
  function fieldVal(n, fname) {   // düğümün alan değeri (yalnız data düğümünde; case-insensitive kolon adı)
    if (!n.cols || !n.row) return null;
    for (var i = 0; i < n.cols.length; i++) if (String(n.cols[i]).toLowerCase() === fname) return n.row[n.cols[i]];
    return null;
  }
  function predOk(n, p) {
    var raw = fieldVal(n, p.f); if (raw == null) return false;
    if (p.op === '>' || p.op === '>=' || p.op === '<' || p.op === '<=') {   // sayısal karşılaştırma
      var a = toIntVal(raw), b = toIntVal(p.v);
      if (a === null) a = parseFloat(raw); if (b === null) b = parseFloat(p.v);
      if (isNaN(a) || isNaN(b)) return false;
      return p.op === '>' ? a > b : p.op === '>=' ? a >= b : p.op === '<' ? a < b : a <= b;
    }
    var na = toIntVal(raw), nb = toIntVal(p.v);   // = / != : sayısalsa sayı, değilse case-insensitive metin eşitliği
    var eq = (na !== null && nb !== null) ? (na === nb) : (String(raw).trim().toLowerCase() === String(p.v).trim().toLowerCase());
    return p.op === '!=' ? !eq : eq;
  }
  function nodeMatch(n, pq) {   // tüm düz terimler (corpus'ta) VE tüm predikatlar tutmalı (AND)
    if (!pq.active) return false;
    for (var i = 0; i < pq.plain.length; i++) if ((n._s || '').indexOf(pq.plain[i]) === -1) return false;
    for (var j = 0; j < pq.preds.length; j++) if (!predOk(n, pq.preds[j])) return false;
    return true;
  }
  // Bölüm verisinden düğüm + kenar modeli (konumlar grafik koordinatında)
  function graphModel(st) {
    var sec = st.sec, cols = displayCols(st);
    var nodes = [], edges = [], capped = false;
    var CARDH = Math.max(46, 26 + Math.max(0, cols.length - 1) * 16);   // kart yüksekliği: TÜM görünür alanlar gösterilsin (section başına tek-tip)
    if (sec.grouped) {
      // her grup bir BLOK (üstte etiket, altında üyeler mini-ızgarada); bloklar ~kare bir IZGARAYA paketlenir
      // (tek sırada yan yana değil) -> çok grupta dengeli/kompakt görünüm. ncols ≈ sqrt(grup sayısı).
      var GAPX = 44, GAPY = 34;
      var blocks = (sec.groups || []).map(function (g, gi) {
        var rws = g.rows || [];
        var gper = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(rws.length || 1))));
        var laneRows = Math.max(1, Math.ceil(rws.length / gper));
        return { g: g, gi: gi, rws: rws, gper: gper, bw: gper * (GVW + GVGX) - GVGX, bh: GVGROUPH + GVGY + laneRows * (CARDH + GVGY) };
      });
      var ncols = Math.max(1, Math.ceil(Math.sqrt(blocks.length)));
      var col = 0, curX = GVPAD, curY = GVPAD + 22, rowMaxH = 0;
      blocks.forEach(function (b) {
        if (nodes.length >= GRAPH_MAX) { capped = true; return; }   // cap başlıkları da kapsasın -> üyesiz dangling grup kartı + cap aşımı olmasın
        if (col >= ncols) { col = 0; curX = GVPAD; curY += rowMaxH + GAPY; rowMaxH = 0; }
        var bx = curX, by = curY, gkey = (b.g.key != null ? b.g.key : b.gi);
        var gnode = { id: 'g' + b.gi, group: true, label: b.g.label, count: b.rws.length, pkey: 'g:' + gkey, x: bx + (b.bw - GVGROUPW) / 2, y: by, w: GVGROUPW, h: GVGROUPH, members: [] };
        nodes.push(gnode);
        var memTop = by + GVGROUPH + GVGY;
        b.rws.forEach(function (r, ri) {
          if (nodes.length >= GRAPH_MAX) { capped = true; return; }
          var cc = ri % b.gper, rr = Math.floor(ri / b.gper), mid = 'm' + b.gi + '_' + ri;
          nodes.push({ id: mid, row: r, pkey: 'm:' + gkey + ':' + posKeyOf(r, cols, String(ri)), x: bx + cc * (GVW + GVGX), y: memTop + rr * (CARDH + GVGY), w: GVW, h: CARDH, cols: cols });
          gnode.members.push(mid);   // grup başlığı sürüklenince blok bütün taşınsın (#2)
          edges.push({ from: 'g' + b.gi, to: mid, type: 'grouped' });
        });
        curX += b.bw + GAPX; rowMaxH = Math.max(rowMaxH, b.bh); col++;
      });
    } else if (sec.kind === 'tree') {
      // hiyerarşik ağaç: kök üstte, çocuklar altta; x = alt-ağaç ortası (tidy), y = derinlik
      var trows = sec.rows || [];
      var par = trows.map(function (r) { var p = r['__parent__']; return (p == null || p === '') ? -1 : (+p); });
      var children = {}; par.forEach(function (p, i) { if (p >= 0) (children[p] || (children[p] = [])).push(i); });
      var depth = trows.map(function (r, i) { var d = 0, p = par[i], g = 0; while (p >= 0 && g++ < trows.length) { d++; p = par[p]; } return d; });
      var COLW = GVW + GVGX, ROWH = CARDH + GVGY + 22, xpos = [], leafN = 0;
      var place = function (i) {
        var ch = children[i] || [];
        if (!ch.length) { xpos[i] = leafN * COLW; leafN++; }
        else { ch.forEach(place); xpos[i] = (xpos[ch[0]] + xpos[ch[ch.length - 1]]) / 2; }
      };
      trows.forEach(function (r, i) { if (par[i] < 0) place(i); });
      trows.forEach(function (r, i) {
        if (nodes.length >= GRAPH_MAX) { capped = true; return; }
        nodes.push({ id: 'n' + i, row: r, pkey: posKeyOf(r, cols, 'n' + i), x: GVPAD + (xpos[i] || 0), y: GVPAD + 22 + depth[i] * ROWH, w: GVW, h: CARDH, cols: cols });
        if (par[i] >= 0) edges.push({ from: 'n' + par[i], to: 'n' + i, type: 'next' });   // ebeveyn -> çocuk (dikey)
      });
    } else if (sec.kind === 'linked' || sec.kind === 'index') {
      // serpentine (yılankavi) ızgara: tek uzun sütun yerine satırlara sarar, tek sıralar ters yönde -> komşular hep bitişik
      var lrows = sec.rows || [];
      var lper = Math.max(1, Math.min(6, Math.round(Math.sqrt(lrows.length * 1.3))));
      lrows.forEach(function (r, ri) {
        if (nodes.length >= GRAPH_MAX) { capped = true; return; }
        var col = ri % lper, rowN = Math.floor(ri / lper);
        var visCol = (rowN % 2 === 0) ? col : (lper - 1 - col);
        nodes.push({ id: 'n' + ri, row: r, pkey: posKeyOf(r, cols, 'n' + ri), x: GVPAD + visCol * (GVW + GVGX), y: GVPAD + 22 + rowN * (CARDH + GVGY + 14), w: GVW, h: CARDH, cols: cols });
        if (ri > 0) edges.push({ from: 'n' + (ri - 1), to: 'n' + ri, type: 'next' });
      });
    } else {   // array: ızgara, kenar yok
      var arows = sec.rows || [];
      var per = arows.length <= 16 ? 4 : Math.max(4, Math.min(6, Math.round(Math.sqrt(arows.length * 1.3))));
      arows.forEach(function (r, ri) {
        if (nodes.length >= GRAPH_MAX) { capped = true; return; }
        var cxn = ri % per, cyn = Math.floor(ri / per);
        nodes.push({ id: 'n' + ri, row: r, pkey: posKeyOf(r, cols, 'n' + ri), x: GVPAD + cxn * (GVW + GVGX), y: GVPAD + 22 + cyn * (CARDH + GVGY), w: GVW, h: CARDH, cols: cols });
      });
    }
    // Phase 2: cross-section LINKS (mor) — yalnız "⇄ Links" açıkken. Kaynak düğümlerden hedef satırın
    // (dedupe edilmiş) "ghost" düğümüne mor kesik kenar. linkHasTarget tablo xref'iyle BİREBİR aynı kuralı kullanır.
    var GHOST_MAX = 200, LINK_EDGE_MAX = 600, linkCapped = false;
    if (st.gv && st.gv.links) {   // ⇄ Links açık: GİDEN (bu bölümün link alanları) + GELEN (bu bölümü hedefleyen diğerleri)
      var src = nodes.slice();   // ghost'ları eklemeden ÖNCEki gerçek düğümler
      var ghostByKey = {}, ghosts = [], edgeSeen = {}, linkEdges = 0;
      var addGhost = function (gid, props, srcY) {
        if (!ghostByKey[gid]) {
          if (ghosts.length >= GHOST_MAX) { linkCapped = true; return null; }
          var gh = { id: gid, ghost: true, pkey: gid, w: Math.round(GVW * 0.74), h: 44, srcY: srcY };
          for (var k in props) gh[k] = props[k];
          ghostByKey[gid] = gh; ghosts.push(gh);
        }
        return ghostByKey[gid];
      };
      var addEdge = function (from, to) {
        var ek = from + '|' + to; if (edgeSeen[ek]) return; edgeSeen[ek] = 1;   // aynı çift -> tek kenar
        if (linkEdges < LINK_EDGE_MAX) { edges.push({ from: from, to: to, type: 'link' }); linkEdges++; } else linkCapped = true;
      };
      // GİDEN: bu bölümün link alanları -> diğer bölümdeki hedef satır (ghost sağ oluğa)
      if (sec.links && Object.keys(sec.links).length) src.forEach(function (n) {
        if (!n.row || !n.cols) return;
        n.cols.forEach(function (c) {
          var lk = sec.links[c]; if (!lk) return;
          var raw = n.row[c]; if (raw == null || raw === '' || isDash(raw)) return;
          if (!linkHasTarget(lk, raw)) return;            // hedefte eşleşen satır yoksa kenar yok (tablo xref ile aynı)
          var tst = secState[lk.section]; if (!tst) return;
          var tvis = tst.order.filter(function (l) { return tst.hidden.indexOf(l) === -1; });
          var mc = lk.match || tvis[0], val = String(raw), gid = 'x:' + lk.section + ':' + mc + ':' + val;
          if (!addGhost(gid, { tsec: lk.section, mc: mc, val: val }, n.y)) return;
          n.hasLink = true; addEdge(n.id, gid);
        });
      });
      // GELEN: diğer görünür bölümlerden BU bölüme işaret eden linkler (ghost = o kaynak satır; ok bana doğru)
      var myByCol = {};
      var myNodeBy = function (mc, v) {
        if (!myByCol[mc]) { var m = {}; src.forEach(function (n) { if (n.row && n.row[mc] != null) m[String(n.row[mc])] = n; }); myByCol[mc] = m; }
        return myByCol[mc][String(v)];
      };
      Object.keys(secState).forEach(function (osec) {
        if (osec === sec.name) return;
        var ost = secState[osec]; if (!ost || !ost.sec || !ost.sec.links) return;
        var ovis = ost.order.filter(function (l) { return ost.hidden.indexOf(l) === -1; });
        var orows = ost.sec.grouped ? (ost.sec.groups || []).reduce(function (a, g) { return a.concat(g.rows || []); }, []) : (ost.sec.rows || []);
        Object.keys(ost.sec.links).forEach(function (oc) {
          var lk = ost.sec.links[oc]; if (lk.section !== sec.name) return;
          var mc = lk.match || cols[0], srcCol = ovis[0] || (ost.order && ost.order[0]) || oc;   // tüm kolonlar gizliyse fallback (undefined gid çakışması olmasın)
          orows.forEach(function (orow) {
            var v = orow[oc]; if (v == null || v === '' || isDash(v)) return;
            var myNode = myNodeBy(mc, v); if (!myNode) return;   // bu değer benim hangi düğümüme işaret ediyor
            var sval = String(srcCol && orow[srcCol] != null ? orow[srcCol] : v), gid = 'xi:' + osec + ':' + srcCol + ':' + sval;
            if (!addGhost(gid, { tsec: osec, mc: srcCol, val: sval, incoming: true }, myNode.y)) return;
            myNode.hasLink = true; addEdge(gid, myNode.id);   // ghost(kaynak) -> benim düğümüm
          });
        });
      });
      // ghost'ları sağ "hedefler" oluğuna yerleştir: hedef bölüme göre kümele, kaynak-y'ye göre sırala (az kesişme)
      // ghost'ları sağ oluğa koy ama her birini bağlı olduğu düğümün Y'sine HİZALA (hepsi tepeye yığılmasın);
      // çakışmayı aşağı iterek çöz -> kısa, çoğunlukla yatay kenarlar (kaynağına yakın)
      var gx0 = 0; nodes.forEach(function (n) { if (n.x + n.w > gx0) gx0 = n.x + n.w; });
      ghosts.sort(function (a, b) { return a.srcY - b.srcY; });
      var lastGy = -1e9;
      ghosts.forEach(function (gh) {
        gh.x = gx0 + GVGX;
        var y = Math.max(GVPAD + 22, gh.srcY);
        if (y < lastGy + gh.h + 12) y = lastGy + gh.h + 12;
        gh.y = y; lastGy = y; nodes.push(gh);
      });
    }
    // kullanıcının sürükleyip taşıdığı düğüm konumları (kalıcı) otomatik yerleşimi ezsin (kararlı pkey ile)
    var saved = st.gv && st.gv.pos;
    if (saved) nodes.forEach(function (n) { var p = saved[n.pkey]; if (p) { n.x = p.x; n.y = p.y; } });
    // arama metni (_s, küçük harf) + index (_i, minimap/DOM eşlemesi için) önceden hesaplanır
    nodes.forEach(function (n, i) {
      n._i = i;
      if (n.group) n._s = String(shortVal(n.label)).toLowerCase();
      else if (n.ghost) n._s = (n.val + ' ' + n.tsec).toLowerCase();
      else { var parts = []; (n.cols || []).forEach(function (c) { parts.push(c); parts.push(shortVal(n.row[c])); }); n._s = parts.join(' ').toLowerCase(); }
    });
    var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    // TAM sınırlayıcı kutu (min+max) -> içerik her yöne (negatif dahil) genişleyebilir; nesne kalmayınca küçülür
    var bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
    nodes.forEach(function (n) { if (n.x < bx0) bx0 = n.x; if (n.y < by0) by0 = n.y; if (n.x + n.w > bx1) bx1 = n.x + n.w; if (n.y + n.h > by1) by1 = n.y + n.h; });
    if (!nodes.length) { bx0 = 0; by0 = 0; bx1 = GVPAD; by1 = GVPAD; }
    bx0 -= GVPAD; by0 -= GVPAD; bx1 += GVPAD; by1 += GVPAD;
    return { nodes: nodes, edges: edges, byId: byId, capped: capped, linkCapped: linkCapped, bx0: bx0, by0: by0, bx1: bx1, by1: by1, cw: bx1 - bx0, ch: by1 - by0 };
  }
  function edgePath(a, b, type) {
    if (type === 'grouped') {
      // grup -> üye: üyenin SOL oluğundaki (gutter) dikey raydan dik-köşeli gir -> hiçbir kartı kesmez
      var sx = a.x + a.w / 2, sy = a.y + a.h;          // grup alt-orta
      var bx = b.x, my = b.y + b.h / 2;                // üye sol-orta
      var gx = Math.max(6, bx - GVGX / 2);             // üye sütununun sol oluğundaki dikey ray
      var d1 = gx >= sx ? 1 : -1, d2 = my >= sy ? 1 : -1;
      var r = Math.min(8, Math.abs(my - sy) / 2, Math.abs(gx - sx) / 2) || 0;
      return 'M' + sx + ',' + sy +
        ' L' + (gx - d1 * r) + ',' + sy +
        ' Q' + gx + ',' + sy + ' ' + gx + ',' + (sy + d2 * r) +
        ' L' + gx + ',' + (my - d2 * r) +
        ' Q' + gx + ',' + my + ' ' + (gx + r) + ',' + my +
        ' L' + bx + ',' + my;
    }
    if (type === 'next') {
      // aynı satırdaki serpentine komşular -> yatay S; sarma (farklı satır) -> dikey alt-üst S
      if (Math.abs(a.y - b.y) < a.h) {
        var ax = a.x < b.x ? a.x + a.w : a.x, bx2 = a.x < b.x ? b.x : b.x + b.w;
        var ay = a.y + a.h / 2, by = b.y + b.h / 2, hmx = (ax + bx2) / 2;
        return 'M' + ax + ',' + ay + ' C' + hmx + ',' + ay + ' ' + hmx + ',' + by + ' ' + bx2 + ',' + by;
      }
      var x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, vmy = (y1 + y2) / 2;
      return 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + vmy + ' ' + x2 + ',' + vmy + ' ' + x2 + ',' + y2;
    }
    // 'link' (cross-section) ve varsayılan: kaynak sağ-orta -> hedef sol-orta yatay S
    var X1 = a.x + a.w, Y1 = a.y + a.h / 2, X2 = b.x, Y2 = b.y + b.h / 2, gmx = (X1 + X2) / 2;
    return 'M' + X1 + ',' + Y1 + ' C' + gmx + ',' + Y1 + ' ' + gmx + ',' + Y2 + ' ' + X2 + ',' + Y2;
  }
  function nodeSvg(n, badges, bars) {
    if (n.group) {
      return '<g class="gnode gv-group" data-id="' + esc(n.id) + '" transform="translate(' + n.x + ',' + n.y + ')">' +
        '<rect class="card" width="' + n.w + '" height="' + n.h + '" rx="8"></rect>' +
        '<text class="gtitle" x="12" y="' + (n.h / 2 + 4) + '">' + esc(shortVal(n.label)) + '</text>' +
        '<text class="gsub" x="' + (n.w - 12) + '" y="' + (n.h / 2 + 4) + '" text-anchor="end">' + n.count + '</text>' +
        '</g>';
    }
    if (n.ghost) {   // cross-section link hedefi (kompakt mor kart; tıkla -> hedef sekmeye git)
      var gsv = '<g class="gnode gv-ghost" data-id="' + esc(n.id) + '" data-sec="' + esc(n.tsec) + '" data-match="' + esc(n.mc) + '" data-val="' + esc(n.val) + '" transform="translate(' + n.x + ',' + n.y + ')">';
      gsv += '<rect class="card" width="' + n.w + '" height="' + n.h + '" rx="8"></rect>';
      gsv += '<rect x="0" y="0" width="4" height="' + n.h + '" rx="2" fill="#b07cc6"></rect>';
      gsv += '<text class="gtitle" x="14" y="18">' + esc(shortVal(n.val)) + ' ↗</text>';
      gsv += '<text class="gsub" x="14" y="34">' + esc(cap(n.tsec)) + '</text>';
      return gsv + '</g>';
    }
    var row = n.row, cols = n.cols, color = nodeColor(row, cols, badges);
    var title = cols.length ? shortVal(row[cols[0]]) : '';
    var elAttr = row['__el__'] ? ' data-el="' + esc(row['__el__']) + '"' : '';   // #1: sağ tık -> watch ifadesi kopyala
    var s = '<g class="gnode" data-id="' + esc(n.id) + '" data-search="' + esc(n._s || '') + '"' + elAttr + ' transform="translate(' + n.x + ',' + n.y + ')">';
    s += '<rect class="card" width="' + n.w + '" height="' + n.h + '" rx="8"></rect>';
    if (color) s += '<rect x="0" y="0" width="4" height="' + n.h + '" rx="2" fill="' + color + '"></rect>';
    s += '<text class="gtitle" x="14" y="18">' + esc(title) + '</text>';
    if (color) s += '<circle cx="' + (n.w - 14) + '" cy="14" r="5" fill="' + color + '"></circle>';
    if (n.hasLink) s += '<circle cx="' + (n.w - 26) + '" cy="14" r="3" fill="#b07cc6"></circle>';   // dışa/içe link var işareti
    // #4: TÜM görünür alanlar (cols.slice(1)) ayrı satırlarda; bar kolonu mini-çubuk
    var fy = 34;
    cols.slice(1).forEach(function (c) {
      s += '<text class="flab" x="14" y="' + fy + '">' + esc(c) + '</text>';
      if (bars[c]) {
        var used = toIntVal(row[c]), mxv = toIntVal(row['__bar__' + c]);
        if (used !== null && mxv !== null && mxv > 0) {
          var pct = Math.max(0, Math.min(1, used / mxv)), bx2 = 76, bw = n.w - bx2 - 38;
          var bc = (pct * 100) >= bars[c].crit ? '#e74c3c' : ((pct * 100) >= bars[c].warn ? '#f1c40f' : '#2ecc71');
          s += '<rect class="gbarbg" x="' + bx2 + '" y="' + (fy - 8) + '" width="' + bw + '" height="7" rx="3.5"></rect>';
          s += '<rect class="gbarfill" x="' + bx2 + '" y="' + (fy - 8) + '" width="' + (bw * pct).toFixed(1) + '" height="7" rx="3.5" fill="' + bc + '"></rect>';
          s += '<text class="gpct" x="' + (n.w - 12) + '" y="' + (fy - 1) + '" text-anchor="end">' + Math.round(pct * 100) + '%</text>';
        } else {
          s += '<text class="fval" x="' + (n.w - 12) + '" y="' + fy + '" text-anchor="end">' + esc(shortVal(row[c])) + '</text>';
        }
      } else {
        s += '<text class="fval" x="' + (n.w - 12) + '" y="' + fy + '" text-anchor="end">' + esc(shortVal(row[c])) + '</text>';
      }
      fy += 16;
    });
    return s + '</g>';
  }
  function renderGraph(name) {
    var st = secState[name], body = bodyEl(name); if (!st || !st.sec || !body) return;
    var idx = idxOf(name);
    var model = graphModel(st);
    var badges = st.sec.badges || {}, bars = st.sec.bars || {};
    var tbar = toolbarHtml(st);
    var summary = '<div class="summary">' + esc(st.sec.summary || '') + '</div>';
    if (!model.nodes.length) { body.innerHTML = summary + tbar + '<div class="gv-empty">Nothing to graph (list is empty).</div>'; return; }
    var defs = '<defs><marker id="gar' + idx + '" markerWidth="9" markerHeight="9" refX="7.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7d8590"></path></marker>' +
      '<marker id="garl' + idx + '" markerWidth="9" markerHeight="9" refX="7.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#b07cc6"></path></marker></defs>';
    var eg = ''; model.edges.forEach(function (ed) { var a = model.byId[ed.from], b = model.byId[ed.to]; if (!a || !b) return; eg += '<path class="gedge ' + ed.type + '" data-f="' + esc(ed.from) + '" data-t="' + esc(ed.to) + '" d="' + edgePath(a, b, ed.type) + '" marker-end="url(#' + (ed.type === 'link' ? 'garl' : 'gar') + idx + ')"></path>'; });
    var ng = '', mini = '';
    model.nodes.forEach(function (n) {
      ng += nodeSvg(n, badges, bars);
      var mcol = n.ghost ? '#b07cc6' : n.group ? '#5a5a5a' : (nodeColor(n.row, n.cols, badges) || '#7d8590');
      mini += '<rect class="mnode" x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" fill="' + mcol + '"></rect>';
    });
    var total = st.sec.grouped ? (st.sec.groups || []).reduce(function (a, g) { return a + (g.rows || []).length; }, 0) : (st.sec.rows || []).length;
    var bannerTxt = model.capped ? ('Showing first ' + GRAPH_MAX + ' of ' + total + ' nodes — narrow the data or use the table view for the full set.') : '';
    if (model.linkCapped) bannerTxt += (bannerTxt ? ' · ' : '') + 'Some links hidden — turn off ⇄ Links or use the table.';
    var banner = bannerTxt ? ('<div class="gv-banner">' + bannerTxt + '</div>') : '';
    var miniHidden = (st.gv && st.gv.mini === false) ? ' hidden' : '';
    body.innerHTML = summary + tbar + banner +
      '<div class="gv-wrap" id="gwrap-' + idx + '">' +
      '<svg class="gv-svg" id="gsvg-' + idx + '"><g id="gvp-' + idx + '">' + defs + '<g class="gv-edges">' + eg + '</g><g class="gv-nodes">' + ng + '</g></g></svg>' +
      '<div class="gv-detail" id="gdet-' + idx + '"><span class="close" id="gdc-' + idx + '">✕</span><h3 id="gdt-' + idx + '"></h3><div id="gdb-' + idx + '"></div></div>' +
      '<svg class="gv-mini' + miniHidden + '" id="gmini-' + idx + '"><g id="gmg-' + idx + '">' + mini + '<rect class="gv-vp" id="gvpr-' + idx + '"></rect></g></svg>' +
      '</div>';
    wireGraph(name, model, idx);
  }
  function wireGraph(name, model, idx) {
    var st = secState[name];
    var svg = document.getElementById('gsvg-' + idx), vp = document.getElementById('gvp-' + idx), det = document.getElementById('gdet-' + idx);
    if (!svg || !vp) return;
    st.gv = st.gv || gvInit();
    st.gv.pos = st.gv.pos || {};
    if (st.gv.q == null) st.gv.q = '';
    if (st.gv.hi == null) st.gv.hi = -1;
    if (st.gv.mini == null) st.gv.mini = true;
    var nd = null, suppressClick = false;   // nd = sürüklenen düğüm; suppressClick = sürükleme sonrası tıklamayı yut
    var nodeEls = vp.querySelectorAll('.gnode');   // cache (per-tuş arama + minimap eşlemesi index ile)
    var edgeEls = vp.querySelectorAll('.gedge');
    var gwrap = document.getElementById('gwrap-' + idx);
    var miniSvg = document.getElementById('gmini-' + idx), mg = document.getElementById('gmg-' + idx), vpR = document.getElementById('gvpr-' + idx);
    var miniRects = mg ? mg.querySelectorAll('.mnode') : null;
    var pbody = bodyEl(name);
    var sBox = pbody ? pbody.querySelector('.gv-search') : null, sN = pbody ? pbody.querySelector('.gv-srch-n') : null;
    var MMW = 180, MMH = 120, mscale = 1, hits = [];
    function setMiniScale() {   // bbox'u (negatif dahil) minimap kutusuna sığdıran ölçek + kaydırma (bounds değişince güncellenir)
      var ms = Math.min(MMW / model.cw, MMH / model.ch); if (!isFinite(ms) || ms <= 0) ms = 1;
      mscale = ms; if (mg) mg.setAttribute('transform', 'translate(' + (-model.bx0 * ms) + ',' + (-model.by0 * ms) + ') scale(' + ms + ')');
    }
    setMiniScale();
    function syncMini() {   // minimap viewport dikdörtgeni (graf koordinatında; gmg ölçeği küçültür)
      if (!vpR) return;
      var sw = svg.clientWidth || model.cw, sh = svg.clientHeight || model.ch;
      vpR.setAttribute('x', -st.gv.tx / st.gv.sc); vpR.setAttribute('y', -st.gv.ty / st.gv.sc);
      vpR.setAttribute('width', Math.max(0, sw / st.gv.sc)); vpR.setAttribute('height', Math.max(0, sh / st.gv.sc));
    }
    function nudgeMiniNode(n) { if (!miniRects || !n) return; var mr = miniRects[n._i]; if (mr) { mr.setAttribute('x', n.x); mr.setAttribute('y', n.y); } }
    function centerPoint(gx, gy, useSc) {
      var sw = svg.clientWidth || model.cw, sh = svg.clientHeight || model.ch;
      if (useSc) st.gv.sc = useSc;
      st.gv.tx = sw / 2 - gx * st.gv.sc; st.gv.ty = sh / 2 - gy * st.gv.sc; apply();
    }
    function centerOn(n) { if (n) centerPoint(n.x + n.w / 2, n.y + n.h / 2, Math.max(0.8, Math.min(1.4, st.gv.sc))); }
    function markCur() {
      if (!nodeEls || !nodeEls.forEach) return;
      nodeEls.forEach(function (el) { el.classList.remove('gv-cur'); });
      if (st.gv.hi >= 0 && hits[st.gv.hi] != null && nodeEls[hits[st.gv.hi]]) nodeEls[hits[st.gv.hi]].classList.add('gv-cur');
    }
    function applySearch() {   // düz metin (substring AND) + alan predikatları; vurgula (gv-hit) / soluklaştır (gv-fade) / minimap heatmap (gm-hit)
      var pq = parseSearch(st.gv.q), active = pq.active;
      if (active) {   // arama başlarken önceki seçim/hover .dim/.ehl katmanını temizle (yoksa hit'ler %16 soluk kalır)
        if (nodeEls && nodeEls.forEach) nodeEls.forEach(function (g) { g.classList.remove('dim'); });
        if (edgeEls && edgeEls.forEach) edgeEls.forEach(function (p) { p.classList.remove('dim'); p.classList.remove('ehl'); });
      }
      hits = []; var hitIds = {};
      if (nodeEls && nodeEls.forEach) nodeEls.forEach(function (el, i) {
        var n = model.nodes[i]; var on = !!(n && nodeMatch(n, pq));
        if (on) { hits.push(i); hitIds[n.id] = 1; }
        el.classList.toggle('gv-hit', on); el.classList.toggle('gv-fade', active && !on);
      });
      if (miniRects && miniRects.forEach) miniRects.forEach(function (mr, i) { var n = model.nodes[i]; mr.classList.toggle('gm-hit', !!(n && hitIds[n.id])); });
      // kenar-fade: model index'i yerine DOM data-f/data-t ile (renderGraph bir kenarı atlasa bile index kaymaz)
      if (edgeEls && edgeEls.forEach) edgeEls.forEach(function (p) { var on = !!(hitIds[p.getAttribute('data-f')] && hitIds[p.getAttribute('data-t')]); p.classList.toggle('gv-fade', active && !on); });
      if (gwrap) gwrap.classList.toggle('searching', active);
      if (st.gv.hi >= hits.length) st.gv.hi = -1;
      if (sN) sN.textContent = !active ? '' : (!hits.length ? '0' : ((st.gv.hi >= 0 ? (st.gv.hi + 1) + ' / ' : '') + hits.length));
      markCur();
      if (!active && st.gv.sel && model.byId[st.gv.sel]) focus(st.gv.sel);   // arama temizlendi + seçim duruyor -> seçim spotlight'ını geri uygula
    }
    function cycle(d) {   // Enter / Shift+Enter: sıradaki/önceki eşleşmeye merkezle
      if (!hits.length) return;
      st.gv.hi = st.gv.hi < 0 ? (d > 0 ? 0 : hits.length - 1) : (st.gv.hi + d + hits.length) % hits.length;
      markCur(); centerOn(model.nodes[hits[st.gv.hi]]);
      if (sN) sN.textContent = (st.gv.hi + 1) + ' / ' + hits.length;
    }
    function redrawEdges(movedId) {
      if (!edgeEls || !edgeEls.forEach) return;   // DOM-shim: boş NodeList -> güvenli no-op
      edgeEls.forEach(function (p) {
        var f = p.getAttribute('data-f'), t = p.getAttribute('data-t');
        if (f !== movedId && t !== movedId) return;
        var a = model.byId[f], b = model.byId[t]; if (!a || !b) return;
        p.setAttribute('d', edgePath(a, b, p.classList.contains('grouped') ? 'grouped' : p.classList.contains('link') ? 'link' : 'next'));
      });
    }
    function recomputeBounds() {   // sürükleme sonrası TAM bbox (her yöne); nesne çekilince küçülür
      var bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
      model.nodes.forEach(function (n) { if (n.x < bx0) bx0 = n.x; if (n.y < by0) by0 = n.y; if (n.x + n.w > bx1) bx1 = n.x + n.w; if (n.y + n.h > by1) by1 = n.y + n.h; });
      if (!model.nodes.length) { bx0 = 0; by0 = 0; bx1 = GVPAD; by1 = GVPAD; }
      bx0 -= GVPAD; by0 -= GVPAD; bx1 += GVPAD; by1 += GVPAD;
      model.bx0 = bx0; model.by0 = by0; model.bx1 = bx1; model.by1 = by1; model.cw = bx1 - bx0; model.ch = by1 - by0;
    }
    function apply() {
      vp.setAttribute('transform', 'translate(' + st.gv.tx + ',' + st.gv.ty + ') scale(' + st.gv.sc + ')');
      if (gwrap) gwrap.classList.toggle('lod-far', st.gv.sc < 0.45);   // çok uzakta: kart metnini gizle (büyük graf perf)
      syncMini();
    }
    function fit() {
      var sw = svg.clientWidth, sh = svg.clientHeight;
      if (!sw || !sh) { st.gv.needFit = true; apply(); return; }
      var s = Math.min(sw / model.cw, sh / model.ch, 1); if (!isFinite(s) || s <= 0) s = 1;
      st.gv.sc = s;
      st.gv.tx = (sw - model.cw * s) / 2 - model.bx0 * s;   // bbox'u yatay ortala (negatif origin dahil)
      st.gv.ty = 10 - model.by0 * s;                        // üstten ~10px
      st.gv.needFit = false; apply();
    }
    if (st.gv.needFit) fit(); else apply();
    function neighbors(id) { var ns = {}; ns[id] = 1; model.edges.forEach(function (e) { if (e.from === id || e.to === id) { ns[e.from] = 1; ns[e.to] = 1; } }); return ns; }
    function focus(id) {
      var ns = neighbors(id);
      if (st.gv.q) {   // arama aktif: hit/fade spotlight'ı bozma, sadece komşu kenarları vurgula
        vp.querySelectorAll('.gedge').forEach(function (p) { var on = ns[p.getAttribute('data-f')] && ns[p.getAttribute('data-t')] && (p.getAttribute('data-f') === id || p.getAttribute('data-t') === id); p.classList.toggle('ehl', !!on); });
        return;
      }
      vp.querySelectorAll('.gnode').forEach(function (g) { g.classList.toggle('dim', !ns[g.getAttribute('data-id')]); });
      vp.querySelectorAll('.gedge').forEach(function (p) { var on = ns[p.getAttribute('data-f')] && ns[p.getAttribute('data-t')] && (p.getAttribute('data-f') === id || p.getAttribute('data-t') === id); p.classList.toggle('dim', !on); p.classList.toggle('ehl', !!on); });
    }
    function clearFocus() {
      if (st.gv.q) { vp.querySelectorAll('.gedge').forEach(function (p) { p.classList.remove('ehl'); }); return; }
      vp.querySelectorAll('.gnode').forEach(function (g) { g.classList.remove('dim'); }); vp.querySelectorAll('.gedge').forEach(function (p) { p.classList.remove('dim'); p.classList.remove('ehl'); });
    }
    function detailFor(id) {
      var n = model.byId[id]; if (!n) return;
      if (n.ghost) {   // ghost'ta n.row/n.cols yok -> ayrı detay; tıklarsa gotoXref zaten hedefe götürür
        document.getElementById('gdt-' + idx).textContent = shortVal(n.val);
        document.getElementById('gdb-' + idx).innerHTML = '<div class="grow2"><span>' + (n.incoming ? 'linked from' : 'links to') + '</span><b>' + esc(cap(n.tsec)) + '</b></div><div class="grow2"><span>' + esc(n.mc) + '</span><b>' + esc(n.val) + '</b></div>';
        det.style.display = 'block';
        return;
      }
      var t = n.group ? shortVal(n.label) : (n.cols.length ? shortVal(n.row[n.cols[0]]) : id);
      document.getElementById('gdt-' + idx).textContent = t;
      var html;
      if (n.group) html = '<div class="grow2"><span>members</span><b>' + n.count + '</b></div><div class="grow2"><span>group</span><b>' + esc(cap(name)) + '</b></div>';
      else html = n.cols.map(function (c) { return '<div class="grow2"><span>' + esc(c) + '</span><b>' + esc(shortVal(n.row[c])) + '</b></div>'; }).join('');
      document.getElementById('gdb-' + idx).innerHTML = html;
      det.style.display = 'block';
    }
    function selectNode(id) { st.gv.sel = id; vp.querySelectorAll('.gnode').forEach(function (g) { g.classList.toggle('sel', g.getAttribute('data-id') === id); }); focus(id); detailFor(id); }
    vp.addEventListener('mouseover', function (e) { var g = e.target.closest('.gnode'); if (g && !st.gv.sel) focus(g.getAttribute('data-id')); });
    vp.addEventListener('mouseout', function () { if (!st.gv.sel) clearFocus(); });
    vp.addEventListener('click', function (e) {
      if (suppressClick) { suppressClick = false; return; }
      var g = e.target.closest('.gnode'); if (!g) return; e.stopPropagation();
      var gid = g.getAttribute('data-id'), gn = model.byId[gid];
      if (gn && gn.ghost) { gotoXref(gn.tsec, gn.mc, gn.val); return; }   // ghost -> gerçek hedef sekme+satır
      selectNode(gid);
    });
    var dc = document.getElementById('gdc-' + idx);
    if (dc) dc.addEventListener('click', function (e) { e.stopPropagation(); st.gv.sel = null; det.style.display = 'none'; clearFocus(); vp.querySelectorAll('.gnode.sel').forEach(function (g) { g.classList.remove('sel'); }); });
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var f = e.deltaY < 0 ? 1.1 : 1 / 1.1, ns = Math.min(3, Math.max(0.25, st.gv.sc * f));
      var r = svg.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      st.gv.tx = px - (px - st.gv.tx) * (ns / st.gv.sc); st.gv.ty = py - (py - st.gv.ty) * (ns / st.gv.sc); st.gv.sc = ns; apply();
    }, { passive: false });
    var dragging = false, lx = 0, ly = 0;
    svg.addEventListener('mousedown', function (e) {
      suppressClick = false;   // önceki etkileşimden kalan bastırmayı temizle
      var g = e.target.closest ? e.target.closest('.gnode') : null;
      if (g) {   // DÜĞÜM sürükle (arka plan pan'i değil); grup başlığıysa BLOK bütün (#2)
        var id = g.getAttribute('data-id'), n = model.byId[id]; if (!n) return;
        e.stopPropagation();
        var items = [{ n: n, el: g, ox: n.x, oy: n.y }];
        if (n.group && n.members) n.members.forEach(function (mid) { var m = model.byId[mid], el = m ? (nodeEls && nodeEls[m._i]) : null; if (m && el) items.push({ n: m, el: el, ox: m.x, oy: m.y }); });
        nd = { id: id, g: g, sx: e.clientX, sy: e.clientY, moved: false, items: items };
        g.classList.add('gv-dragging');
        return;
      }
      dragging = true; lx = e.clientX; ly = e.clientY; svg.classList.add('panning');
    });
    svg.addEventListener('mousemove', function (e) {
      if (nd) {   // düğüm(ler) sürükleniyor: tek delta tüm öğelere -> blok bütün; HER YÖNE (negatif/sol-üst dahil), clamp yok
        if (!nd.moved && (Math.abs(e.clientX - nd.sx) + Math.abs(e.clientY - nd.sy)) > 3) nd.moved = true;
        if (!nd.moved) return;
        var dx = (e.clientX - nd.sx) / st.gv.sc, dy = (e.clientY - nd.sy) / st.gv.sc;
        nd.items.forEach(function (it) {
          it.n.x = it.ox + dx; it.n.y = it.oy + dy;
          if (it.el) it.el.setAttribute('transform', 'translate(' + it.n.x + ',' + it.n.y + ')');
          redrawEdges(it.n.id); nudgeMiniNode(it.n);
        });
        return;
      }
      if (!dragging) return; st.gv.tx += e.clientX - lx; st.gv.ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply();
    });
    function endPan() {
      if (nd) {
        if (nd.moved) {
          nd.items.forEach(function (it) { st.gv.pos[it.n.pkey] = { x: it.n.x, y: it.n.y }; });   // tüm taşınanları KARARLI pkey ile sakla
          suppressClick = true; recomputeBounds(); setMiniScale(); syncMini();
        }
        nd.g.classList.remove('gv-dragging'); nd = null;
      }
      dragging = false; svg.classList.remove('panning');
    }
    svg.addEventListener('mouseup', endPan); svg.addEventListener('mouseleave', endPan);
    // arama kutusu: anlık eşleşme; Enter/Shift+Enter eşleşmeler arası gez; Esc temizle
    if (sBox) {
      sBox.addEventListener('input', function () { st.gv.q = sBox.value; st.gv.hi = -1; applySearch(); });
      sBox.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); st.gv.q = ''; st.gv.hi = -1; sBox.value = ''; applySearch(); sBox.blur(); }
      });
    }
    // minimap: tıkla/sürükle -> ana görünümü o noktaya merkezle
    if (miniSvg) {
      var mpan = false;
      var miniTo = function (e) { var r = miniSvg.getBoundingClientRect(); centerPoint((e.clientX - r.left) / mscale + model.bx0, (e.clientY - r.top) / mscale + model.by0, st.gv.sc); };
      miniSvg.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); mpan = true; miniTo(e); });
      miniSvg.addEventListener('mousemove', function (e) { if (mpan) miniTo(e); });
      var mEnd = function () { mpan = false; };
      miniSvg.addEventListener('mouseup', mEnd); miniSvg.addEventListener('mouseleave', mEnd);
    }
    st._fit = fit;
    // cross-section link tıklamasında (gotoXref) bu graf'ta hedef düğüme merkezlen + blink (tablo satırı yerine)
    st._focusNode = function (matchCol, value) {
      // eşleşme değerini TÜM satırdan çöz (match kolonu hedefte GİZLİ olsa bile row onu taşır); yoksa ilk görünür kolon
      function rowVal(row, col) {
        if (row[col] != null) return row[col];
        var lc = String(col).toLowerCase();
        for (var k in row) if (k.charAt(0) !== '_' && String(k).toLowerCase() === lc) return row[k];
        return null;
      }
      var target = null;
      for (var i = 0; i < model.nodes.length; i++) {
        var nn = model.nodes[i]; if (nn.ghost || nn.group || !nn.row || !nn.cols) continue;
        var rv = matchCol ? rowVal(nn.row, matchCol) : nn.row[nn.cols[0]];
        if (rv != null && String(rv) === String(value)) { target = nn; break; }
      }
      if (!target) return;
      centerOn(target);
      var el = nodeEls && nodeEls[target._i];
      if (el) { el.classList.remove('gv-blink'); setTimeout(function () { el.classList.add('gv-blink'); }, 20); setTimeout(function () { el.classList.remove('gv-blink'); }, 1700); }
    };
    if (st.gv.sel && model.byId[st.gv.sel]) selectNode(st.gv.sel); else st.gv.sel = st.gv.sel && model.byId[st.gv.sel] ? st.gv.sel : null;
    if (st.gv.q) { if (sBox) sBox.value = st.gv.q; applySearch(); } else syncMini();   // refresh sonrası arama/minimap durumunu geri uygula
  }

  // henüz verisi gelmemiş (streaming sırasında sırada bekleyen / yeni gösterilen) bölüm için yer tutucu
  function paintLoading(name) {
    const body = bodyEl(name);
    if (body) body.innerHTML = '<div class="empty loading">Loading…</div>';
    const cnt = cntElOf(name);
    if (cnt) cnt.textContent = '…';
  }
  function hasData(name) { const st = secState[name]; return !!(st && st.sec); }
  function paint(name) {
    const st = secState[name];
    const body = bodyEl(name);
    if (!st || !st.sec || !body) return;
    if (st.sec.needsSelection) {
      body.innerHTML = '<div class="empty">Master section for "' + esc(name) + '" is empty or missing.</div>';
      return;
    }
    if (st.view === 'graph') { renderGraph(name); return; }
    const cols = displayCols(st);
    const grouped = st.sec.grouped;
    const allRows = grouped ? st.sec.groups.reduce((a, g) => a.concat(g.rows), []) : st.sec.rows;
    const numCols = numericCols(cols, allRows);
    st.numCols = numCols;   // ▦ Columns menüsü per-kolon base düğmesi için kullanır
    const opts = { numCols: numCols, colBase: st.colBase || {}, bars: st.sec.bars || {}, links: st.sec.links || {}, badges: st.sec.badges || {}, sortCol: st.sortCol };
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

  function afterColChange(name, refetch, shownLabel) {
    const st = secState[name];
    paint(name);
    buildColsMenu(name);
    vscodeApi.postMessage({
      type: 'setColumns', section: name,
      order: st.order.slice(), hidden: st.hidden.slice(), refetch: !!refetch,
      shown: shownLabel || null
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
    // graph view: görünüm modu (table/graph) ve pan/zoom durumu (gv) yenilemeler arası korunur
    const view = (prev && prev.view) ? prev.view : 'table';
    const gv = (prev && prev.gv) ? prev.gv : null;
    secState[name] = { sec, sortCol, sortDir, changed, changeCount: count, order, hidden, flat, collapsed, filter, changedOnly, colBase, view, gv };
    const cnt = cntElOf(name);
    if (cnt) cnt.textContent = sec.grouped ? (sec.groups || []).reduce((a, g) => a + g.rows.length, 0) : sec.rows.length;
    const tab = tabElOf(name);
    if (tab) {
      if (count > 0 && name !== activeName) tab.classList.add('haschg');
      else if (name === activeName) tab.classList.remove('haschg');
    }
    // paint() burada DEĞİL: önce tüm bölümlerin secState'i dolsun ki link eşleşme
    // kontrolü (linkHasTarget) diğer bölümlerin verisini görebilsin (sıra bağımsız).
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
    const cw = e.target.closest('.cell-watch');
    if (cw) { vscodeApi.postMessage({ type: 'copyWatch', text: cw.dataset.el || '' }); for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return; }
    const sg = e.target.closest('.show-graph');
    if (sg) {   // tablo satırı -> graph görünümüne geç + o satırın düğümüne merkezlen
      const nm = sg.dataset.section; const stg = secState[nm];
      if (stg && stg.sec) {
        stg.view = 'graph'; if (!stg.gv) stg.gv = gvInit();
        paint(nm);
        const cols = displayCols(stg);
        const allRows = stg.sec.grouped ? stg.sec.groups.reduce((a, g) => a.concat(g.rows), []) : stg.sec.rows;
        const ri = (sg.dataset.ri != null && sg.dataset.ri !== '') ? +sg.dataset.ri : -1;
        const row = (ri >= 0 && allRows[ri]) ? allRows[ri] : null;
        if (row && cols.length && typeof stg._focusNode === 'function') stg._focusNode(cols[0], row[cols[0]]);
      }
      for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return;
    }
    const wp = e.target.closest('.cell-wp');
    if (wp) { vscodeApi.postMessage({ type: 'watchpoint', expr: wp.dataset.lv || '' }); for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return; }
    const uwp = e.target.closest('.cell-unwp');
    if (uwp) { vscodeApi.postMessage({ type: 'unwatchpoint', expr: uwp.dataset.lv || '' }); for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return; }
    const ce = e.target.closest('.cell-edit');
    if (ce) {
      const riAttr = ce.dataset.ri;
      vscodeApi.postMessage({ type: 'editValue', expr: ce.dataset.edit, current: ce.dataset.cur || '', section: ce.dataset.section || null, rowIndex: (riAttr != null && riAttr !== '') ? +riAttr : null, label: ce.dataset.col || null });
      for (const mm of document.querySelectorAll('.cols-menu')) mm.classList.add('hidden'); e.stopPropagation(); return;
    }
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
    // tablo <-> graph görünüm geçişi
    if (e.target.closest('.view-toggle')) {
      const name = paneName(e); const st = secState[name];
      if (st) { st.view = st.view === 'graph' ? 'table' : 'graph'; if (st.view === 'graph' && !st.gv) st.gv = gvInit(); paint(name); }
      return;
    }
    // graph: görünüme sığdır
    if (e.target.closest('.graph-fit')) {
      const name = paneName(e); const st = secState[name];
      if (st && typeof st._fit === 'function') st._fit();
      return;
    }
    // graph: cross-section link katmanını aç/kapa (Phase 2)
    if (e.target.closest('.links-toggle')) {
      const name = paneName(e); const st = secState[name];
      if (st) { if (!st.gv) st.gv = gvInit(); st.gv.links = !st.gv.links; paint(name); }
      return;
    }
    // graph: minimap'i aç/kapa (Phase 3) — yeniden çizmeden, sadece CSS
    if (e.target.closest('.map-toggle')) {
      const name = paneName(e); const st = secState[name]; const mb = e.target.closest('.map-toggle');
      if (st) { if (!st.gv) st.gv = gvInit(); st.gv.mini = !st.gv.mini; mb.classList.toggle('on', st.gv.mini); const bd = bodyEl(name); const mn = bd && bd.querySelector('.gv-mini'); if (mn) mn.classList.toggle('hidden', !st.gv.mini); }
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
      afterColChange(name, true, label);   // sadece bu kolonun verisi çekilsin
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
    const gnode = e.target.closest('.gnode');
    if (gnode) {   // #1 graph düğümü sağ tık: satırı watch ifadesi olarak kopyala (VS Code Watch'a yapıştır)
      e.preventDefault();
      if (gnode.dataset.el) popMenu(name, e, '<div class="cm-item cell-watch" data-el="' + esc(gnode.dataset.el) + '">Copy row as watch expression</div>');
      return;
    }
    const td = e.target.closest('tbody td');
    if (td && !td.querySelector('.bar')) {   // veri hücresi: kopya (+ düzenlenebilirse edit)
      e.preventDefault();
      const txt = (td.textContent || '').trim();
      let h = '<div class="cm-item cell-copy" data-text="' + esc(txt) + '">Copy cell</div>';
      const trEl = td.closest('tr');
      if (trEl && trEl.dataset.ri != null && trEl.dataset.ri !== '')   // bu satırı GRAPH görünümünde göster + o düğüme merkezlen
        h += '<div class="cm-item show-graph" data-section="' + esc(name) + '" data-ri="' + esc(trEl.dataset.ri) + '">Show in graph</div>';
      if (trEl && trEl.dataset.el)   // satırın kararlı eleman ifadesini watch için kopyala (VS Code Watch'a yapıştır)
        h += '<div class="cm-item cell-watch" data-el="' + esc(trEl.dataset.el) + '">Copy row as watch expression</div>';
      if (td.dataset.lv) {   // bu hücrenin alanına GDB watchpoint'i (değer değişince durdurur)
        if (watchedExprs.has(td.dataset.lv))
          h += '<div class="cm-item cell-unwp" data-lv="' + esc(td.dataset.lv) + '">Remove watchpoint</div>';
        else
          h += '<div class="cm-item cell-wp" data-lv="' + esc(td.dataset.lv) + '">Add watchpoint (break on change)</div>';
      }
      if (td.dataset.edit) {
        const tr = td.closest('tr');
        const ri = (tr && tr.dataset.ri != null) ? tr.dataset.ri : '';
        h += '<div class="cm-item cell-edit" data-edit="' + esc(td.dataset.edit) + '" data-cur="' + esc(td.getAttribute('title') || '') + '" data-section="' + esc(name) + '" data-ri="' + esc(ri) + '" data-col="' + esc(td.dataset.col || '') + '">Edit value…</div>';
      }
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
  // refresh sırasında sekme "güncelleniyor" spinner'ı (verisi gelince temizlenir)
  function setTabUpdating(name, on) { const t = tabElOf(name); if (t) t.classList.toggle('updating', !!on); }
  function clearAllUpdating() { for (const n of currentNames) setTabUpdating(n, false); }
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
    for (const name of vis) {
      if (secState[name] && secState[name].sec) {
        paint(name); buildColsMenu(name); setTabCount(name);
        const st = secState[name]; const tab = tabElOf(name);
        if (tab) { if (st.changeCount > 0 && name !== activeName) tab.classList.add('haschg'); else tab.classList.remove('haschg'); }
      } else {
        paintLoading(name);   // yeni gösterilen / verisi henüz gelmemiş bölüm
      }
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

  // --- Export: tüm görünür bölümlerin verisini JSON olarak dışa aktar ---
  function buildExport() {
    const out = {};
    for (const name of currentNames) {
      const st = secState[name]; if (!st || !st.sec) continue;
      const cols = (st.order || []).filter(l => st.hidden.indexOf(l) === -1);
      const rowObj = r => { const o = {}; for (const c of cols) o[c] = (r[c] !== undefined && r[c] !== '' ? r[c] : null); return o; };
      if (st.sec.grouped) {
        out[name] = (st.sec.groups || []).map(g => ({ group: g.label, rows: (g.rows || []).map(rowObj) }));
      } else {
        out[name] = (st.sec.rows || []).map(rowObj);
      }
    }
    return JSON.stringify(out, null, 2);
  }
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) exportBtn.addEventListener('click', e => {
    e.stopPropagation();
    vscodeApi.postMessage({ type: 'export', json: buildExport() });
  });
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
      for (const s of list) changed += (renderSection(s.name, s) || 0);   // 1) tüm secState dolsun
      for (const s of list) { paint(s.name); buildColsMenu(s.name); }       // 2) sonra çiz (link eşleşme kontrolü için)
      const chEl = document.getElementById('changes');
      if (changed > 0) { chEl.textContent = changed + ' changed'; chEl.classList.remove('hidden'); }
      else chEl.classList.add('hidden');
    } else if (m.type === 'watchpoints') {
      watchedExprs = new Set(Array.isArray(m.exprs) ? m.exprs : []);   // izlenen l-value'lar -> ★ + menü Add/Remove
      for (const n of currentNames) if (secState[n] && secState[n].sec) paint(n);
    } else if (m.type === 'running') {
      if (!paused) { statusEl.textContent = 'running…'; statusEl.className = 'pill run'; }
      setRefreshing(false); clearAllUpdating(); if (refreshFallback) { clearTimeout(refreshFallback); refreshFallback = null; }   // iptal edilen refresh'in spinner'larını da temizle
    } else if (m.type === 'beginUpdate') {
      // durak başı iskelet: ts + layout + kaldırılanları temizle. Bölümler 'patchSection' ile ÖNCELİKLİ akar.
      setRefreshing(true); if (refreshFallback) { clearTimeout(refreshFallback); refreshFallback = null; }   // yenileme başladı -> düğme döner
      if (!paused) { statusEl.textContent = 'stopped'; statusEl.className = 'pill'; }
      tsEl.textContent = m.ts ? ('updated ' + m.ts) : '';
      const vis = Array.isArray(m.visible) ? m.visible : [];
      hiddenSections = Array.isArray(m.hiddenSections) ? m.hiddenSections : [];
      sectionOrder = Array.isArray(m.order) ? m.order.slice() : vis.concat(hiddenSections);
      ensureLayout(vis);
      for (const k of Object.keys(secState)) if (vis.indexOf(k) === -1) delete secState[k];
      // henüz çekilmemiş (verisi olmayan) görünür bölümler "Loading…" göstersin (streaming kuyruğunda bekleyenler)
      for (const n of vis) if (!hasData(n)) paintLoading(n);
      // her görünür sekme "güncelleniyor" işaretlensin (verisi gelene kadar spinner); eski veri görünür kalır
      for (const n of vis) setTabUpdating(n, true);
    } else if (m.type === 'endUpdate') {
      // akış bitti: aktif sekmeyi son kez boya (çapraz-link hedefleri artık yüklü) + rozet
      if (activeName && secState[activeName] && secState[activeName].sec) { paint(activeName); buildColsMenu(activeName); }
      recomputeChanged();
      clearAllUpdating();   // tüm sekme spinner'larını temizle
      setRefreshing(false); if (refreshFallback) { clearTimeout(refreshFallback); refreshFallback = null; }   // yenileme bitti
      if (m.ts) tsEl.textContent = 'updated ' + m.ts;
    } else if (m.type === 'patchSection') {
      // tek bölüm: durak akışındaki bir bölüm VEYA hedefli reveal -> bu sekme dolar/çizilir
      if (m.sec) { renderSection(m.section, m.sec); paint(m.section); buildColsMenu(m.section); recomputeChanged(); }
      setTabUpdating(m.section, false);   // bu sekme güncellendi -> spinner dursun
      if (m.ts) tsEl.textContent = 'updated ' + m.ts;
    } else if (m.type === 'presentationUpdate') {
      // config'te yalnız sunum değişti (base/bar eşiği/link/badge) -> GDB'siz: mevcut satırları koru, yeniden çiz
      const st = secState[m.section];
      if (st && st.sec) {
        if (m.bars) st.sec.bars = m.bars;
        if (m.links) st.sec.links = m.links;
        if (m.badges) st.sec.badges = m.badges;
        if (m.bases) { st.sec.bases = m.bases; st.colBase = st.colBase || {}; for (const k in m.bases) st.colBase[k] = m.bases[k]; }
        paint(m.section); buildColsMenu(m.section);
      }
    } else if (m.type === 'patchRow') {
      // edit value: yeni alan(lar)ı o satıra yaz, bölümü (istemci-tarafı) yeniden boya. grouped'da flat index ile düzleştir.
      const st = secState[m.section];
      if (st && st.sec && m.row && typeof m.rowIndex === 'number') {
        const tr = st.sec.grouped ? (st.sec.groups || []).reduce((a, g) => a.concat(g.rows || []), []) : (st.sec.rows || []);
        if (tr[m.rowIndex]) { Object.assign(tr[m.rowIndex], m.row); paint(m.section); }
      }
    } else if (m.type === 'patchColumn') {
      // tek kolon hedefli güncelleme (column show): yeni field'ı mevcut satırlara merge et
      const st = secState[m.section];
      if (st && st.sec) {
        const tr = st.sec.grouped ? (st.sec.groups || []).reduce((a, g) => a.concat(g.rows || []), []) : (st.sec.rows || []);
        const pr = Array.isArray(m.rows) ? m.rows : [];
        if (tr.length !== pr.length) {
          vscodeApi.postMessage({ type: 'refresh' });   // hizalama bozuk -> güvenli tam yenile
        } else {
          for (let k = 0; k < tr.length; k++) {
            const src = pr[k]; if (!src) continue;
            tr[k][m.label] = src[m.label];
            if (src['__bar__' + m.label] !== undefined) tr[k]['__bar__' + m.label] = src['__bar__' + m.label];
            if (src['__edit__' + m.label] !== undefined) tr[k]['__edit__' + m.label] = src['__edit__' + m.label];
          }
          paint(m.section); buildColsMenu(m.section);
          if (m.ts) tsEl.textContent = 'updated ' + m.ts;
        }
      }
    }
  });
</script>
</body>
</html>`;
}
