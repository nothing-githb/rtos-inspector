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
interface SyncCfg {
  threads?: SectionCfg;
  semaphores?: SectionCfg;
}

type Row = Record<string, string>;
interface Section { columnsAll: string[]; hidden: string[]; rows: Row[]; summary: string; kind: string; }
type SectionName = 'threads' | 'semaphores';
interface ColPref { order: string[]; hidden: string[]; }

// ---------------------------------------------------------------------------
// Global durum
// ---------------------------------------------------------------------------
let panel: vscode.WebviewPanel | undefined;
let lastStopped: { session: vscode.DebugSession; threadId: number } | undefined;
let configWatcher: vscode.FileSystemWatcher | undefined;
let extContext: vscode.ExtensionContext | undefined;
let columnPrefs: { threads?: ColPref; semaphores?: ColPref } = {};
const COLPREF_KEY = 'syncwatch.columnPrefs';

// ---------------------------------------------------------------------------
// Aktivasyon
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  columnPrefs = context.workspaceState.get<{ threads?: ColPref; semaphores?: ColPref }>(COLPREF_KEY) ?? {};
  context.subscriptions.push(
    vscode.commands.registerCommand('syncwatch.open', () => {
      openPanel(context);
      if (lastStopped) refresh(lastStopped.session, lastStopped.threadId);
    })
  );

  const types: string[] =
    vscode.workspace.getConfiguration('syncwatch').get('debugTypes') ?? ['cppdbg'];

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
                refresh(session, threadId);
              } else if (msg.event === 'continued') {
                panel?.webview.postMessage({ type: 'running' });
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
      if (e.affectsConfiguration('syncwatch.configPath')) setupConfigWatcher(context);
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
    vscode.workspace.getConfiguration('syncwatch').get('configPath') ?? 'syncwatch.json';
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
    vscode.workspace.getConfiguration('syncwatch').get('configPath') ?? 'syncwatch.json';
  const file = path.join(folder.uri.fsPath, rel);
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text) as SyncCfg;
  } catch {
    vscode.window.showWarningMessage(`SyncWatch: could not read config (${file})`);
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

function threadSummary(rows: Row[]): string {
  const running = rows.filter(r => /run/i.test(r['State'] ?? '')).length;
  return `${rows.length} thread${rows.length === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}`;
}

function semSummary(rows: Row[]): string {
  const contended = rows.filter(r => num(r['Count']) === 0).length;
  const waiting = rows.reduce((a, r) => a + (num(r['Waiting']) > 0 ? 1 : 0), 0);
  const parts = [`${rows.length} semaphore${rows.length === 1 ? '' : 's'}`];
  if (contended) parts.push(`${contended} depleted`);
  if (waiting) parts.push(`${waiting} with waiters`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Sütun tercihleri: kayıtlı sıra/gizli + config alanlarını birleştir
// ---------------------------------------------------------------------------
function effectiveColumns(section: SectionName, allLabels: string[]): { order: string[]; hidden: string[]; active: string[] } {
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
  section: SectionName,
  summaryFn: (rows: Row[]) => string
): Promise<Section> {
  const allLabels = cfg.fields.map(f => f.label);
  const eff = effectiveColumns(section, allLabels);
  const effFields = eff.active
    .map(l => cfg.fields.find(f => f.label === l))
    .filter((f): f is FieldCfg => !!f);
  const rows = await collectSection(session, { ...cfg, fields: effFields }, frameId, cursor);
  return { columnsAll: eff.order, hidden: eff.hidden, rows, summary: summaryFn(rows), kind: section };
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

  const sections: Record<string, Section> = {};
  if (cfg.threads?.fields?.length)
    sections.threads = await buildSection(session, cfg.threads, frameId, '$swt', 'threads', threadSummary);
  if (cfg.semaphores?.fields?.length)
    sections.semaphores = await buildSection(session, cfg.semaphores, frameId, '$sws', 'semaphores', semSummary);

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
    'syncwatch', 'SyncWatch', vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  panel.webview.onDidReceiveMessage(
    (msg: any) => {
      if (msg?.type === 'refresh') { doRefresh(); return; }
      if (msg?.type === 'setColumns' && (msg.section === 'threads' || msg.section === 'semaphores')) {
        columnPrefs[msg.section as SectionName] = {
          order: Array.isArray(msg.order) ? msg.order : [],
          hidden: Array.isArray(msg.hidden) ? msg.hidden : []
        };
        extContext?.workspaceState.update(COLPREF_KEY, columnPrefs);
        // yeni bir sütun aktifleştirildiyse verisini çekmek için yenile (durmuşsa)
        if (msg.refetch) doRefresh();
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
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 4px 6px; border-radius: 5px;
  }
  .cols-item:hover { background: var(--vscode-list-hoverBackground); }
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
    <h1>SyncWatch</h1>
    <span id="status" class="pill">—</span>
    <span id="changes" class="pill chg hidden"></span>
    <span class="grow"></span>
    <span id="ts" class="ts"></span>
    <button id="refresh" class="btn" title="Re-read config and refresh">⟳ Refresh</button>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="threads" id="tab-threads">Threads<span class="badge-count" id="cnt-threads">0</span></button>
    <button class="tab" data-tab="semaphores" id="tab-semaphores">Semaphores<span class="badge-count" id="cnt-semaphores">0</span></button>
  </div>

  <div class="pane" id="pane-threads">
    <div class="cols-bar">
      <button class="btn cols-btn" data-sec="threads" title="Show / hide / reorder columns">▦ Columns</button>
      <div class="cols-menu hidden" id="cols-threads"></div>
    </div>
    <div class="pane-body" id="body-threads">
      <div class="empty">Threads will be listed here when the debug session stops.</div>
    </div>
  </div>
  <div class="pane hidden" id="pane-semaphores">
    <div class="cols-bar">
      <button class="btn cols-btn" data-sec="semaphores" title="Show / hide / reorder columns">▦ Columns</button>
      <div class="cols-menu hidden" id="cols-semaphores"></div>
    </div>
    <div class="pane-body" id="body-semaphores">
      <div class="empty">Semaphore data will appear here.</div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const statusEl = document.getElementById('status');
  const tsEl = document.getElementById('ts');
  let activeTab = 'threads';

  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  }
  document.getElementById('refresh').addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'refresh' });
  });
  function switchTab(name) {
    activeTab = name;
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('active', t.dataset.tab === name);
      if (t.dataset.tab === name) t.classList.remove('haschg');
    }
    for (const p of document.querySelectorAll('.pane'))
      p.classList.toggle('hidden', p.id !== 'pane-' + name);
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

  function cell(kind, col, val) {
    const lc = col.toLowerCase();
    if (kind === 'threads') {
      if (lc.includes('state') || lc.includes('durum'))
        return '<span class="badge ' + stateClass(val) + '">' + esc(val) + '</span>';
      if (lc === 'id') return '<span class="idcol">' + esc(val) + '</span>';
      return '<span class="' + (col==='ID'?'':'') + '">' + esc(val) + '</span>';
    }
    if (kind === 'semaphores') {
      if (lc.includes('discipline'))
        return '<span class="badge disc">' + esc(val) + '</span>';
      if (lc === 'count' && asNum(val) === 0)
        return '<span class="crit">' + esc(val) + '</span>';
      if (lc.includes('wait') && asNum(val) > 0)
        return '<span class="warn">' + esc(val) + '</span>';
      if (lc === 'id') return '<span class="idcol">' + esc(val) + '</span>';
    }
    return esc(val);
  }

  function isMono(kind, col) {
    const lc = col.toLowerCase();
    if (kind === 'threads') return lc.includes('stack') || lc.includes('sp') || lc.includes('name');
    return false;
  }

  // Bölüm verisi + sıralama durumu (panel yenilense de tercih korunur)
  const secState = { threads: null, semaphores: null };

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

  function buildTable(kind, columns, rows, sortCol, sortDir, changed) {
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
      h += '<th class="' + (active ? 'sorted' : '') + '" data-col="' + esc(c) + '" title="Sort by ' + esc(c) + '">' +
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
        if (isMono(kind, c)) classes.push('mono');
        if (isChg) classes.push('changed');
        const clsAttr = classes.length ? ' class="' + classes.join(' ') + '"' : '';
        let inner = cell(kind, c, row[c] ?? '');
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
    const body = document.getElementById('body-' + name);
    if (!st || !st.sec) return;
    const cols = displayCols(st);
    body.innerHTML =
      '<div class="summary">' + esc(st.sec.summary) + '</div>' +
      buildTable(st.sec.kind, cols, st.sec.rows, st.sortCol, st.sortDir, st.changed);
  }

  function buildColsMenu(name) {
    const menu = document.getElementById('cols-' + name);
    const st = secState[name];
    if (!menu) return;
    if (!st) { menu.innerHTML = ''; return; }
    let h = '<div class="cols-title">Columns</div>';
    st.order.forEach((label, i) => {
      const checked = st.hidden.indexOf(label) === -1 ? ' checked' : '';
      h += '<div class="cols-item" data-label="' + esc(label) + '">' +
        '<label><input type="checkbox" data-act="vis"' + checked + '> ' + esc(label) + '</label>' +
        '<span class="cols-move">' +
        '<button data-act="up" title="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button data-act="down" title="Move down"' + (i === st.order.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '</span></div>';
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
    const tab = document.getElementById('tab-' + name);
    const cnt = document.getElementById('cnt-' + name);
    if (!sec) { tab.classList.add('hidden'); secState[name] = null; buildColsMenu(name); return 0; }
    tab.classList.remove('hidden');
    cnt.textContent = sec.rows.length;
    const prev = secState[name];
    const order = Array.isArray(sec.columnsAll) ? sec.columnsAll.slice() : [];
    const hidden = Array.isArray(sec.hidden) ? sec.hidden.slice() : [];
    const cols = order.filter(l => hidden.indexOf(l) === -1);
    const sortCol = prev && prev.sortCol && cols.indexOf(prev.sortCol) !== -1 ? prev.sortCol : null;
    const sortDir = prev && prev.sortDir ? prev.sortDir : 'asc';
    const ch = computeChanges(prev && prev.sec ? prev.sec.rows : null, sec.rows, cols);
    secState[name] = { sec, sortCol, sortDir, changed: ch.map, changeCount: ch.count, order, hidden };
    // değişen ama o an açık olmayan sekmeyi işaretle
    if (ch.count > 0 && name !== activeTab) tab.classList.add('haschg');
    else if (name === activeTab) tab.classList.remove('haschg');
    paint(name);
    buildColsMenu(name);
    return ch.count;
  }

  // Başlık tıklaması → sıralama (event delegation, bir kez kurulur)
  for (const name of ['threads', 'semaphores']) {
    document.getElementById('pane-' + name).addEventListener('click', e => {
      const th = e.target.closest('th[data-col]');
      if (!th) return;
      const st = secState[name];
      if (!st) return;
      const col = th.dataset.col;
      if (st.sortCol === col) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc';
      else { st.sortCol = col; st.sortDir = 'asc'; }
      paint(name);
    });
  }

  // Sütun menüsü: aç/kapa + görünürlük + sıra (bir kez kurulur, container kalıcı)
  for (const name of ['threads', 'semaphores']) {
    const btn = document.querySelector('.cols-btn[data-sec="' + name + '"]');
    const menu = document.getElementById('cols-' + name);
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = menu.classList.contains('hidden');
      // diğer menüleri kapat
      for (const n of ['threads', 'semaphores'])
        document.getElementById('cols-' + n).classList.add('hidden');
      if (willOpen) { buildColsMenu(name); menu.classList.remove('hidden'); }
    });
    menu.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const st = secState[name];
      if (!st) return;
      const label = b.closest('.cols-item').dataset.label;
      const i = st.order.indexOf(label);
      if (b.dataset.act === 'up' && i > 0) {
        const t = st.order[i - 1]; st.order[i - 1] = st.order[i]; st.order[i] = t;
        afterColChange(name, false);
      } else if (b.dataset.act === 'down' && i < st.order.length - 1) {
        const t = st.order[i + 1]; st.order[i + 1] = st.order[i]; st.order[i] = t;
        afterColChange(name, false);
      }
    });
    menu.addEventListener('change', e => {
      const cb = e.target.closest('input[data-act="vis"]');
      if (!cb) return;
      const st = secState[name];
      if (!st) return;
      const label = cb.closest('.cols-item').dataset.label;
      const hi = st.hidden.indexOf(label);
      if (cb.checked) {
        if (hi !== -1) st.hidden.splice(hi, 1);
        afterColChange(name, true);   // gösteriliyor → verisini çek
      } else {
        // son görünen sütunu gizlemeye izin verme
        const visible = st.order.filter(l => st.hidden.indexOf(l) === -1).length;
        if (visible <= 1) { cb.checked = true; return; }
        if (hi === -1) st.hidden.push(label);
        afterColChange(name, false);
      }
    });
  }
  document.addEventListener('click', () => {
    for (const n of ['threads', 'semaphores']) {
      const mm = document.getElementById('cols-' + n);
      if (mm) mm.classList.add('hidden');
    }
  });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'update') {
      statusEl.textContent = 'stopped';
      statusEl.className = 'pill';
      tsEl.textContent = m.ts ? ('updated ' + m.ts) : '';
      const changed = (renderSection('threads', m.sections.threads) || 0) +
                      (renderSection('semaphores', m.sections.semaphores) || 0);
      const chEl = document.getElementById('changes');
      if (changed > 0) {
        chEl.textContent = changed + ' changed';
        chEl.classList.remove('hidden');
      } else {
        chEl.classList.add('hidden');
      }
      // aktif sekme gizlendiyse görünen ilk sekmeye geç
      const at = document.getElementById('tab-' + activeTab);
      if (at.classList.contains('hidden')) {
        const first = document.querySelector('.tab:not(.hidden)');
        if (first) switchTab(first.dataset.tab);
      }
    } else if (m.type === 'running') {
      statusEl.textContent = 'running…';
      statusEl.className = 'pill run';
    }
  });
</script>
</body>
</html>`;
}
