import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------
interface FieldCfg { label: string; expr: string; }
interface SectionCfg {
  mode: 'linked_list' | 'array';
  root: string;
  next?: string;      // linked_list
  count?: string;     // array
  access?: string;    // array eleman erişimi: "." (default) veya "->"
  max?: number;
  fields: FieldCfg[];
}
type SyncCfg = Record<string, unknown>;

type Row = Record<string, string>;
interface Section { name: string; columnsAll: string[]; hidden: string[]; rows: Row[]; summary: string; }
interface ColPref { order: string[]; hidden: string[]; }

// ---------------------------------------------------------------------------
// Global durum
// ---------------------------------------------------------------------------
let panel: vscode.WebviewPanel | undefined;
let lastStopped: { session: vscode.DebugSession; threadId: number } | undefined;
let configWatcher: vscode.FileSystemWatcher | undefined;
let extContext: vscode.ExtensionContext | undefined;
let columnPrefs: Record<string, ColPref> = {};
const COLPREF_KEY = 'rtosInspector.columnPrefs';
let paused = false;                         // duraklatılınca durakta otomatik yenileme yapılmaz
const PAUSED_KEY = 'rtosInspector.paused';

// ---------------------------------------------------------------------------
// Aktivasyon
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  columnPrefs = context.workspaceState.get<Record<string, ColPref>>(COLPREF_KEY) ?? {};
  paused = context.workspaceState.get<boolean>(PAUSED_KEY) ?? false;
  context.subscriptions.push(
    vscode.commands.registerCommand('rtosInspector.open', () => {
      openPanel(context);
      if (lastStopped) refresh(lastStopped.session, lastStopped.threadId);
    })
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
                if (!paused) refresh(session, threadId);
              } else if (msg.event === 'continued') {
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
    })
  );
}

export function deactivate() {}

// configPath ayarına göre config dosyasını izle; değişince paneli tazele
function setupConfigWatcher(context: vscode.ExtensionContext) {
  configWatcher?.dispose();
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const rel: string =
    vscode.workspace.getConfiguration('rtosInspector').get('configPath') ?? 'rtos-inspector.json';
  configWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, rel)
  );
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
    return (resp?.result ?? '').toString();
  } catch (e: any) {
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
function loadConfig(): SyncCfg | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const rel: string =
    vscode.workspace.getConfiguration('rtosInspector').get('configPath') ?? 'rtos-inspector.json';
  const file = path.join(folder.uri.fsPath, rel);
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text) as SyncCfg;
  } catch {
    vscode.window.showWarningMessage(`RTOS Inspector: could not read config (${file})`);
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
  cursor: string
): Promise<Row[]> {
  const rows: Row[] = [];
  const max = cfg.max ?? 1024;

  if (cfg.mode === 'array') {
    const access = cfg.access ?? '.';
    const countRaw = await gdbExec(session, `print ${cfg.count}`, frameId);
    const count = parseInt(cleanValue(countRaw), 10) || 0;
    for (let i = 0; i < Math.min(count, max); i++) {
      const row: Row = {};
      for (const f of cfg.fields) {
        const v = await gdbExec(session, `print (${cfg.root})[${i}]${access}${f.expr}`, frameId);
        row[f.label] = cleanValue(v);
      }
      rows.push(row);
    }
  } else {
    await gdbExec(session, `set ${cursor} = ${cfg.root}`, frameId);
    let guard = 0;
    while (guard++ < max) {
      const cur = cleanValue(await gdbExec(session, `print ${cursor}`, frameId));
      if (isNull(cur)) break;
      const row: Row = {};
      for (const f of cfg.fields) {
        const v = await gdbExec(session, `print ${cursor}->${f.expr}`, frameId);
        row[f.label] = cleanValue(v);
      }
      rows.push(row);
      await gdbExec(session, `set ${cursor} = ${cursor}->${cfg.next}`, frameId);
    }
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
  const rows = await collectSection(session, { ...cfg, fields: effFields }, frameId, cursor);
  return { name, columnsAll: eff.order, hidden: eff.hidden, rows, summary: summarize(name, rows) };
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
  const sections: Section[] = [];
  for (let i = 0; i < secs.length; i++) {
    sections.push(await buildSection(session, secs[i].cfg, frameId, '$ri_' + i, secs[i].name));
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
    'rtosInspector', 'RTOS Inspector', vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  panel.webview.onDidReceiveMessage(
    (msg: any) => {
      if (msg?.type === 'refresh') { doRefresh(); return; }
      if (msg?.type === 'setColumns' && typeof msg.section === 'string' && msg.section) {
        columnPrefs[msg.section] = {
          order: Array.isArray(msg.order) ? msg.order : [],
          hidden: Array.isArray(msg.hidden) ? msg.hidden : []
        };
        extContext?.workspaceState.update(COLPREF_KEY, columnPrefs);
        // yeni bir sütun aktifleştirildiyse verisini çekmek için yenile (durmuşsa)
        if (msg.refetch) doRefresh();
      } else if (msg?.type === 'setPaused') {
        paused = !!msg.paused;
        extContext?.workspaceState.update(PAUSED_KEY, paused);
        if (!paused && lastStopped) refresh(lastStopped.session, lastStopped.threadId);
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
  .delta { font-size: 10px; margin-left: 5px; font-weight: 700; }
  .delta.up { color: #2ecc71; }
  .delta.down { color: #e74c3c; }
  .tab.haschg .badge-count { background: #f1c40f; color: #1e1e1e; }
</style>
</head>
<body>
  <div class="topbar">
    <h1>RTOS Inspector</h1>
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

  // Stiller artık bölüm türüne değil, KOLON ADINA göre uygulanır (generic)
  function cell(col, val) {
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
          const na = parseNum(nv), pa = parseNum(pv);
          let dir = '';
          if (!isNaN(na) && !isNaN(pa)) dir = na > pa ? 'up' : (na < pa ? 'down' : '');
          map[rowKeyOf(r, columns) + '\\u0000' + c] = dir;
          count++;
        }
      }
    }
    return { map, count };
  }

  function buildTable(columns, rows, sortCol, sortDir, changed) {
    if (!rows.length) return '<div class="empty">List is empty (root is NULL or count is 0).</div>';
    let data = rows;
    if (sortCol && columns.indexOf(sortCol) !== -1) {
      data = rows.slice().sort((r1, r2) => {
        const c = compareVals(r1[sortCol] ?? '', r2[sortCol] ?? '');
        return sortDir === 'desc' ? -c : c;
      });
    }
    let h = '<table><thead><tr>';
    for (const c of columns) {
      const active = c === sortCol;
      const ind = active ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';
      h += '<th class="' + (active ? 'sorted' : '') + '" data-col="' + esc(c) + '" draggable="true" ' +
        'title="Click: sort  ·  Drag: reorder  ·  Right-click: columns">' +
        esc(c) + '<span class="sort-ind">' + ind + '</span></th>';
    }
    h += '</tr></thead><tbody>';
    for (const row of data) {
      const rk = rowKeyOf(row, columns);
      h += '<tr>';
      for (const c of columns) {
        const ck = rk + '\\u0000' + c;
        const isChg = changed && Object.prototype.hasOwnProperty.call(changed, ck);
        const classes = [];
        if (isMono(c)) classes.push('mono');
        if (isChg) classes.push('changed');
        const clsAttr = classes.length ? ' class="' + classes.join(' ') + '"' : '';
        let inner = cell(c, row[c] ?? '');
        if (isChg) {
          const dir = changed[ck];
          const arrow = dir === 'up' ? '▲' : (dir === 'down' ? '▼' : '');
          if (arrow) inner += '<span class="delta ' + dir + '">' + arrow + '</span>';
        }
        h += '<td' + clsAttr + '>' + inner + '</td>';
      }
      h += '</tr>';
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
    const cols = displayCols(st);
    body.innerHTML =
      '<div class="summary">' + esc(st.sec.summary) + '</div>' +
      buildTable(cols, st.sec.rows, st.sortCol, st.sortDir, st.changed);
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
    const ch = computeChanges(prev && prev.sec ? prev.sec.rows : null, sec.rows, cols);
    secState[name] = { sec, sortCol, sortDir, changed: ch.map, changeCount: ch.count, order, hidden };
    const cnt = cntElOf(name);
    if (cnt) cnt.textContent = sec.rows.length;
    const tab = tabElOf(name);
    if (tab) {
      if (ch.count > 0 && name !== activeName) tab.classList.add('haschg');
      else if (name === activeName) tab.classList.remove('haschg');
    }
    paint(name);
    buildColsMenu(name);
    return ch.count;
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
  let menuDragLabel = null, menuDragName = null;
  function clearDropMarks() {
    for (const x of panesEl.querySelectorAll('.drop-target')) x.classList.remove('drop-target');
    for (const x of panesEl.querySelectorAll('.drop-row')) x.classList.remove('drop-row');
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
      return;
    }
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    suppressClick = false;
    dragName = paneName(e);
    dragCol = th.dataset.col;
    th.classList.add('dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragCol); }
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
