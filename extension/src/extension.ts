import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------
interface FieldCfg { label: string; expr: string; }
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
  max?: number;
  fields: FieldCfg[];
}
type SyncCfg = Record<string, unknown>;

type Row = Record<string, string>;
interface Group { label: string; key: string; rows: Row[]; }
interface Section {
  name: string; columnsAll: string[]; hidden: string[]; rows: Row[]; summary: string;
  selectable?: boolean;       // master bölüm: satırları tıklanabilir
  selectedKey?: string;       // seçili master satırının anahtarı (ilk kolon değeri)
  needsSelection?: boolean;   // detay bölüm: henüz seçim yok
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
  const d = new Date();
  const t = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  logChannel.appendLine(`[${t}] [${tag.padEnd(5)}] ${msg}`);
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
let paused = false;                         // duraklatılınca durakta otomatik yenileme yapılmaz
const PAUSED_KEY = 'rtosInspector.paused';
let selectedMaster: string | undefined;     // master-detail: seçili master bölüm adı
let selectedKey: string | undefined;        // seçili master satırının anahtarı

// ---------------------------------------------------------------------------
// Aktivasyon
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  columnPrefs = context.workspaceState.get<Record<string, ColPref>>(COLPREF_KEY) ?? {};
  paused = context.workspaceState.get<boolean>(PAUSED_KEY) ?? false;

  logChannel = vscode.window.createOutputChannel('Debug Inspector');
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
                if (!paused) refresh(session, threadId);
              } else if (msg.event === 'continued') {
                log?.trace('debug continued');
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
    if (panel && lastStopped) refresh(lastStopped.session, lastStopped.threadId);
  };
  configWatcher.onDidChange(onChange);
  configWatcher.onDidCreate(onChange);
  context.subscriptions.push(configWatcher);
}

function doRefresh() {
  if (lastStopped) refresh(lastStopped.session, lastStopped.threadId);
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
function cleanValue(raw: string): string {
  let s = (raw ?? '').toString().trim();
  s = s.replace(/\(gdb\)\s*/g, ' ').trim();
  const m = s.match(/\$\d+\s*=\s*([\s\S]*)$/);
  if (m) s = m[1];
  return s.trim();
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
      let elem = `${base}[${i}]`;
      if (cfg.wrap) elem = cfg.wrap.split('${expr}').join('(' + elem + ')');
      const row: Row = {};
      for (const f of cfg.fields) {
        const v = await gdbExec(session, `print ${elem}${access}${f.expr}`, frameId);
        row[f.label] = cleanValue(v);
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
      // eleman: base[idx]; field'a erişmeden ÖNCE wrap ile sarmalanır
      let elem = `${base}[${idx}]`;
      if (cfg.wrap) elem = cfg.wrap.split('${expr}').join('(' + elem + ')');
      const row: Row = {};
      for (const f of cfg.fields) {
        const v = await gdbExec(session, `print ${elem}${access}${f.expr}`, frameId);
        row[f.label] = cleanValue(v);
      }
      rows.push(row);
      const nextExpr = `${elem}${access}${cfg.next}`;
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
      let elem = cursor;
      if (cfg.wrap) elem = cfg.wrap.split('${expr}').join('(' + cursor + ')');
      const row: Row = {};
      for (const f of cfg.fields) {
        const v = await gdbExec(session, `print ${elem}->${f.expr}`, frameId);
        row[f.label] = cleanValue(v);
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
function effectiveColumns(section: string, allLabels: string[]): { order: string[]; hidden: string[]; active: string[] } {
  const pref = columnPrefs[section];
  let order: string[];
  let hidden: string[];
  if (pref && Array.isArray(pref.order) && pref.order.length) {
    order = pref.order.filter(l => allLabels.includes(l));
    for (const l of allLabels) if (!order.includes(l)) order.push(l); // config'e yeni eklenenler sona, görünür
    hidden = (pref.hidden ?? []).filter(l => allLabels.includes(l));
  } else {
    order = allLabels.slice();
    hidden = [];
  }
  const active = order.filter(l => !hidden.includes(l));
  return { order, hidden, active };
}

// Yalnız AKTİF sütunları gdb'den çek (pasif sütunlar için print çalıştırılmaz)
async function buildSection(
  session: vscode.DebugSession,
  cfg: SectionCfg,
  frameId: number | undefined,
  cursor: string,
  name: string
): Promise<Section> {
  const allLabels = cfg.fields.map(f => f.label);
  const eff = effectiveColumns(name, allLabels);
  const effFields = eff.active
    .map(l => cfg.fields.find(f => f.label === l))
    .filter((f): f is FieldCfg => !!f);
  const rows = await collectSection(session, { ...cfg, fields: effFields }, frameId, cursor, name);
  log?.debug(`section "${name}" (${cfg.mode}, root=${cfg.root}): ${rows.length} row(s); active=[${eff.active.join(', ')}]`);
  return { name, columnsAll: eff.order, hidden: eff.hidden, rows, summary: summarize(name, rows) };
}

// ---------------------------------------------------------------------------
// Master-detail: ${selected} yer tutucusu
// ---------------------------------------------------------------------------
function isDetail(cfg: SectionCfg): boolean {
  return typeof cfg.root === 'string' && cfg.root.indexOf('${selected}') !== -1;
}
// Master satırın elemanını yeniden seçen ifade (tip-güvenli, adres/cast gerektirmez)
function selectorExpr(cfg: SectionCfg, index: number): string {
  if (cfg.mode === 'array') return '(' + cfg.root + ')[' + index + ']';
  let e = cfg.root;
  const nx = cfg.next ?? 'next';
  for (let k = 0; k < index; k++) e = e + '->' + nx;   // root(->next)^index
  return e;
}
function substituteSel(expr: string, sel: string): string {
  return expr.split('${selected}').join('(' + sel + ')');
}
// Gruplama (ağaç): ${master} yer tutucusu
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
  const allLabels = scfg.fields.map(f => f.label);
  const eff = effectiveColumns(name, allLabels);
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
      count: scfg.count ? substituteMaster(scfg.count, selExpr) : scfg.count
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
  return { name, columnsAll: eff.order, hidden: eff.hidden, rows: [], summary: `${total} ${name} · ${groups.length} ${scfg.groupBy}`, grouped: true, groups };
}

// ---------------------------------------------------------------------------
// Yenileme
// ---------------------------------------------------------------------------
async function refresh(session: vscode.DebugSession, threadId: number) {
  if (!panel) return;
  const cfg = loadConfig();
  if (!cfg) return;

  let frameId: number | undefined;
  try {
    const st = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
    frameId = st?.stackFrames?.[0]?.id;
  } catch { /* ignore */ }

  const secs = extractSections(cfg);
  const hasDetail = secs.some(s => isDetail(s.cfg));
  log?.info(`refresh: ${secs.length} section(s) [${secs.map(s => s.name).join(', ')}]${hasDetail ? ' (master-detail)' : ''}`);

  // 1. geçiş: master/bağımsız bölümleri (detay/grup olmayan) topla + satır seçim ifadeleri
  const masters: Record<string, { sec: Section; selExprs: string[]; cfg: SectionCfg }> = {};
  for (let i = 0; i < secs.length; i++) {
    const { name, cfg: scfg } = secs[i];
    if (isDetail(scfg) || isGrouped(scfg)) continue;
    const sec = await buildSection(session, scfg, frameId, '$ri_' + i, name);
    if (hasDetail) sec.selectable = true;
    masters[name] = { sec, selExprs: sec.rows.map((_, idx) => selectorExpr(scfg, idx)), cfg: scfg };
  }

  // Seçimi çöz -> ${selected} ifadesi
  let selExpr: string | undefined;
  if (hasDetail) {
    let m = (selectedMaster && masters[selectedMaster]) ? masters[selectedMaster] : undefined;
    if (!m) {
      const firstName = secs.map(s => s.name).find(n => masters[n] && masters[n].sec.rows.length);
      if (firstName) { selectedMaster = firstName; m = masters[firstName]; selectedKey = rowKeyAt(m.sec, 0); }
    }
    if (m && m.sec.rows.length) {
      const fa = firstActiveLabel(m.sec);
      let idx = (fa && selectedKey != null) ? m.sec.rows.findIndex(r => r[fa] === selectedKey) : -1;
      if (idx < 0) { idx = 0; selectedKey = rowKeyAt(m.sec, 0); }
      selExpr = m.selExprs[idx];
      m.sec.selectedKey = selectedKey;
      log?.info(`master selection: ${selectedMaster}[key=${selectedKey}] ⇒ \${selected} = ${selExpr}`);
    }
  }

  // 2. geçiş: config sırasıyla birleştir; detay bölümleri ${selected} yerine konarak topla
  const sections: Section[] = [];
  for (let i = 0; i < secs.length; i++) {
    const { name, cfg: scfg } = secs[i];
    if (isGrouped(scfg)) { sections.push(await buildGrouped(session, frameId, i, name, scfg, masters)); continue; }
    if (!isDetail(scfg)) { sections.push(masters[name].sec); continue; }
    const allLabels = scfg.fields.map(f => f.label);
    const eff = effectiveColumns(name, allLabels);
    if (!selExpr) {
      sections.push({ name, columnsAll: eff.order, hidden: eff.hidden, rows: [], summary: '', needsSelection: true });
      continue;
    }
    const subCfg: SectionCfg = {
      ...scfg,
      root: substituteSel(scfg.root, selExpr),
      count: scfg.count ? substituteSel(scfg.count, selExpr) : scfg.count
    };
    sections.push(await buildSection(session, subCfg, frameId, '$ri_' + i, name));
  }

  panel.webview.postMessage({
    type: 'update',
    sections,
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
    (msg: any) => {
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
        if (!paused && lastStopped) refresh(lastStopped.session, lastStopped.threadId);
      } else if (msg?.type === 'selectMaster' && typeof msg.section === 'string') {
        selectedMaster = msg.section;
        selectedKey = typeof msg.key === 'string' ? msg.key : undefined;
        log?.debug(`webview: selectMaster ${selectedMaster}[key=${selectedKey}]`);
        doRefresh();   // detay bölümleri seçili elemana göre yeniden çek
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

  .cols-bar { position: relative; margin: 12px 2px 0; }
  .cols-menu {
    position: absolute; z-index: 5; margin-top: 4px; min-width: 210px;
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
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.4px; opacity: 0.7;
    cursor: pointer; user-select: none;
  }
  th:hover { opacity: 1; }
  th.sorted { opacity: 1; }
  th.dragging { opacity: 0.4; }
  th.drop-target {
    box-shadow: inset 4px 0 0 #3b9eff;
    background: rgba(59,158,255,0.22) !important;
  }
  th[draggable="true"] { cursor: pointer; }
  .sort-ind { font-size: 10px; opacity: 0.9; }
  tbody tr:nth-child(even) td { background: rgba(128,128,128,0.05); }
  tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
  td.mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; opacity: 0.95; }
  td.idcol { font-weight: 700; opacity: 0.9; }
  tbody tr.selrow td { cursor: pointer; }
  tbody tr.selected td { background: rgba(59,158,255,0.16) !important; }
  tbody tr.selected td:first-child { box-shadow: inset 3px 0 0 #3b9eff; }
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
    <button id="pause" class="btn" title="Pause/resume auto-refresh on each stop">⏸ Pause</button>
    <button id="refresh" class="btn" title="Re-read config and refresh now">⟳ Refresh</button>
  </div>

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
  let currentNames = [];     // ordered section names matching DOM indices
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
      '<button class="tab" data-idx="' + i + '" id="tab-' + i + '">' + esc(cap(n)) +
      '<span class="badge-count" id="cnt-' + i + '">0</span></button>').join('');
    panesEl.innerHTML = names.map((n, i) =>
      '<div class="pane' + (i === 0 ? '' : ' hidden') + '" data-idx="' + i + '" id="pane-' + i + '">' +
        '<div class="cols-bar">' +
          '<button class="btn cols-btn" title="Show / hide / reorder columns">▦ Columns</button>' +
          '<div class="cols-menu hidden" id="cols-' + i + '"></div>' +
        '</div>' +
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
    return /^(\([^)]*\)\s*)?0x0+$/.test(t);   // 0x0, 0x00, "(tcb_t *) 0x0"
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

  function headerCells(columns, sortCol, sortDir) {
    let h = '';
    for (const c of columns) {
      const active = c === sortCol;
      const ind = active ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';
      h += '<th class="' + (active ? 'sorted' : '') + '" data-col="' + esc(c) + '" draggable="true" ' +
        'title="Click: sort  ·  Drag: reorder  ·  Right-click: columns">' +
        esc(c) + '<span class="sort-ind">' + ind + '</span></th>';
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
  function dataRow(columns, row, changed, selectable, selectedKey) {
    const rk = rowKeyOf(row, columns);
    const trCls = [];
    if (selectable) trCls.push('selrow');
    if (selectable && selectedKey != null && rk === selectedKey) trCls.push('selected');
    let h = '<tr data-key="' + esc(rk) + '"' + (trCls.length ? ' class="' + trCls.join(' ') + '"' : '') + '>';
    for (const c of columns) {
      const ck = rk + '\\u0000' + c;
      const isChg = changed && Object.prototype.hasOwnProperty.call(changed, ck);
      const classes = [];
      if (isMono(c)) classes.push('mono');
      if (isChg) classes.push('changed');
      const clsAttr = classes.length ? ' class="' + classes.join(' ') + '"' : '';
      let inner = cell(c, row[c] ?? '');
      if (isChg) {
        const ov = isDash(changed[ck]) ? '-' : changed[ck];
        inner += '<span class="old" title="previous value">' + esc(ov) + '</span>';
      }
      h += '<td' + clsAttr + '>' + inner + '</td>';
    }
    return h + '</tr>';
  }
  function buildTable(columns, rows, sortCol, sortDir, changed, selectable, selectedKey) {
    if (!rows.length) return '<div class="empty">List is empty (root is NULL or count is 0).</div>';
    const data = sortRows(rows, columns, sortCol, sortDir);
    let h = '<table><thead><tr>' + headerCells(columns, sortCol, sortDir) + '</tr></thead><tbody>';
    for (const row of data) h += dataRow(columns, row, changed, selectable, selectedKey);
    return h + '</tbody></table>';
  }
  // groupBy: master düğümleri + altında satırlar (aç/kapa)
  function buildGroupedTable(columns, groups, collapsed, sortCol, sortDir) {
    if (!groups || !groups.length) return '<div class="empty">No groups (master section is empty).</div>';
    let h = '<table><thead><tr>' + headerCells(columns, sortCol, sortDir) + '</tr></thead><tbody>';
    for (const g of groups) {
      const isCol = collapsed.indexOf(g.key) !== -1;
      h += '<tr class="grphdr" data-grp="' + esc(g.key) + '"><td colspan="' + columns.length + '">' +
        '<span class="caret">' + (isCol ? '▸' : '▾') + '</span> ' + esc(g.label) +
        ' <span class="grpcnt">' + g.rows.length + '</span></td></tr>';
      if (!isCol) {
        const data = sortRows(g.rows, columns, sortCol, sortDir);
        for (const row of data) h += dataRow(columns, row, null, false, null);
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
      const hint = st.sec.grouped
        ? 'Master section for "' + esc(name) + '" is empty or missing.'
        : 'Select a row in a master section to populate this table.';
      body.innerHTML = '<div class="empty">' + hint + '</div>';
      return;
    }
    const cols = displayCols(st);
    const summary = '<div class="summary">' + esc(st.sec.summary) + '</div>';
    if (st.sec.grouped) {
      const toggle = '<div class="grp-bar"><button class="btn grp-toggle">' +
        (st.flat ? '⊞ Tree view' : '☰ Flat view') + '</button></div>';
      if (st.flat) {
        const all = [];
        for (const g of st.sec.groups) for (const r of g.rows) all.push(r);
        body.innerHTML = summary + toggle + buildTable(cols, all, st.sortCol, st.sortDir, null, false, null);
      } else {
        body.innerHTML = summary + toggle + buildGroupedTable(cols, st.sec.groups, st.collapsed || [], st.sortCol, st.sortDir);
      }
      return;
    }
    body.innerHTML = summary +
      buildTable(cols, st.sec.rows, st.sortCol, st.sortDir, st.changed, st.sec.selectable, st.sec.selectedKey);
  }

  function buildColsMenu(name) {
    const menu = colsMenuEl(name);
    const st = secState[name];
    if (!menu) return;
    if (!st) { menu.innerHTML = ''; return; }
    let h = '<div class="cols-title">Columns — drag to reorder</div>';
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
    secState[name] = { sec, sortCol, sortDir, changed, changeCount: count, order, hidden, flat, collapsed };
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
    for (const x of panesEl.querySelectorAll('.drop-target')) x.classList.remove('drop-target');
    for (const x of panesEl.querySelectorAll('.drop-row')) x.classList.remove('drop-row');
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
    const colsBtn = e.target.closest('.cols-btn');
    if (colsBtn) {
      e.stopPropagation();
      const name = paneName(e);
      const menu = colsMenuEl(name);
      const willOpen = menu.classList.contains('hidden');
      for (const mm of panesEl.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
      if (willOpen) {
        menu.style.position = ''; menu.style.left = ''; menu.style.top = '';
        buildColsMenu(name);
        menu.classList.remove('hidden');
      }
      return;
    }
    if (e.target.closest('.cols-menu')) { e.stopPropagation(); return; }
    // grup: düz/ağaç görünüm geçişi
    if (e.target.closest('.grp-toggle')) {
      const name = paneName(e); const st = secState[name];
      if (st) { st.flat = !st.flat; paint(name); }
      return;
    }
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
    // master satır seçimi (detay bölümleri günceller)
    const tr = e.target.closest('tbody tr[data-key]');
    if (tr) {
      const name = paneName(e);
      const st = secState[name];
      if (st && st.sec && st.sec.selectable) {
        vscodeApi.postMessage({ type: 'selectMaster', section: name, key: tr.dataset.key });
      }
    }
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
  panesEl.addEventListener('contextmenu', e => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const name = paneName(e);
    if (!secState[name]) return;
    e.preventDefault();
    for (const mm of panesEl.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
    buildColsMenu(name);
    const menu = colsMenuEl(name);
    menu.style.position = 'fixed';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 230) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 40) + 'px';
    menu.classList.remove('hidden');
  });

  document.addEventListener('click', () => {
    for (const mm of panesEl.querySelectorAll('.cols-menu')) mm.classList.add('hidden');
  });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'update') {
      if (!paused) { statusEl.textContent = 'stopped'; statusEl.className = 'pill'; }
      tsEl.textContent = m.ts ? ('updated ' + m.ts) : '';
      const list = Array.isArray(m.sections) ? m.sections : [];
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
