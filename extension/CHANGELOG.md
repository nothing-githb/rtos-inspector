# Change Log

All notable changes to the **Debug Inspector** extension are documented here.

## [0.17.1] - 2026-06-06

### Changed
- Selectable log levels reduced to **off / info / debug**. `info` shows
  milestones plus warnings/errors; `debug` folds in the former trace-level
  per-step traversal detail.

## [0.17.0] - 2026-06-06

### Added
- **`rtosInspector.logLevel` setting** — choose the Output channel verbosity
  (`off`/`error`/`warn`/`info`/`debug`/`trace`) from settings; applied live on
  change. (Replaces reliance on the VS Code log-level gear.)

### Changed
- **More detailed, leveled logging.** At `debug`, each section logs its resolved
  traversal: the element expression and the **next-access** expression
  (`linked_list` → `cursor->next`; `index_list` → `root[idx].next`; `array` →
  element/access). At `trace`, every traversal **step** is logged — for
  `index_list` each hop shows `idx → next [ root[idx].next ] = "v" → idx N`, and
  `linked_list` logs each node's cursor and advance. Stop reasons (NULL / nil /
  cycle / max) are logged too.

## [0.16.0] - 2026-06-06

### Added
- **`index_list` traversal mode.** Walk a list that lives inside an array and is
  linked by an *index* field (not a pointer): start at `head` (an index
  expression), read `root[idx]`, then follow `next` (the next index) until it
  equals `nil` (default `-1`). Unused/empty slots are skipped. Supports
  `access`/`cast`/`wrap` like array mode; a visited-set + `max` guard against
  cycles. The demo gains a `pool` section (chain `0 → 2 → 5`, slots 1/3/4 empty).

## [0.15.1] - 2026-06-06

### Changed
- Cells whose value is **unreadable** (GDB could not access the address / errored)
  or a **NULL pointer** (`0x0`) now display as a muted `-`. A plain integer `0`
  is left as-is (so e.g. `Count = 0` still shows its red highlight). Raw values
  are unchanged underneath, so sorting/summaries/change-detection still work.

## [0.15.0] - 2026-06-06

### Added
- **Grouping (tree view).** A section can set `"groupBy": "<masterSection>"` and
  use `${master}` in its `root` to render — in its **own tab** — as a tree
  grouped under each master element (e.g. semaphores grouped under each process).
  The master's `label` expression titles each node; nodes are collapsible and a
  **Flat view** toggle switches to an ungrouped list. Distinct from master–detail
  (`${selected}`), which drives separate detail tabs from the selected row.

## [0.14.1] - 2026-06-06

### Changed
- Lowercased the publisher id to `halistahasahin` (matches the Marketplace
  publisher; it was uppercase in the manifest).

## [0.14.0] - 2026-06-06

### Changed
- Renamed the display name to **Debug Inspector** (the extension id
  `rtos-inspector`, command/settings namespaces and config file name are
  unchanged).
- New icon: rows with status dots plus a magnifier.

## [0.13.2] - 2026-06-06

### Changed
- `cast` is no longer auto-suffixed with ` *`. Write the cast **in full**
  (e.g. `"cast": "widget_t *"`) → `((cast)(root))[i]`. This avoids a double
  pointer and composes for any type.

## [0.13.1] - 2026-06-06

### Changed
- `wrap` is now a **section** option that wraps the **element** (cast + index, or
  the linked-list node) *before* field access — instead of wrapping the whole
  field expression. This lets a `void*` element be cast first, e.g.
  `"wrap": "((widget_t *)${expr})"` with `"access": "->"` →
  `((widget_t *)(slots[i]))->field`. The demo gains a `void*` pointer-array
  `slots` section. (Supersedes the per-field `wrap` introduced in 0.13.0.)

## [0.13.0] - 2026-06-06

### Added
- **Per-field `wrap` template.** Post-process the generated access expression
  with a `${expr}` placeholder — e.g. `"wrap": "*(${expr})"` dereferences a
  pointer field (`a[5].id` → `*(a[5].id)`). The demo's widgets array gains a
  dereferenced `X*` column.

### Changed
- Logging levels clarified: **`debug`** logs every prepared GDB access string;
  **`trace`** logs each result; GDB access failures are logged as **warnings**
  (visible at `info`, which otherwise shows only milestones and errors).

## [0.12.1] - 2026-06-06

### Changed
- `rtosInspector.configPath` now accepts an **absolute path** (used as-is, and
  works even with no workspace folder open); relative paths still resolve against
  the workspace root. The file watcher follows the absolute path too.

## [0.12.0] - 2026-06-06

### Added
- **`cast` field for array sections.** Set `"cast": "T"` to read a generic
  `void*` buffer as an array of `T`: the element access becomes
  `((T *)(root))[i]`. Useful for dynamic-array containers that store elements
  behind a `void *data` + `size`. The demo gains a `widgets` dynamic array.

## [0.11.0] - 2026-06-06

### Added
- **Leveled logging** to an *Debug Inspector* Output channel
  (trace / debug / info / warn / error). Pick the level from the Output panel's
  gear or via "Developer: Set Log Level…". At `trace`, every GDB command and its
  result is logged; `debug` shows section/column/selection activity. A new
  command **"Debug Inspector: Show Log"** opens the channel.

## [0.10.0] - 2026-06-06

### Added
- **Master–detail sections.** A section whose `root` contains `${selected}`
  becomes a *detail* table. Clicking a row in a master section resolves
  `${selected}` to that element and re-fetches the detail sections — e.g. click a
  process to see *its* thread / semaphore / mutex lists. The first master row is
  auto-selected; the selected row is highlighted.

### Other
- The bundled demo is now process-based: two processes, each with its own
  thread/semaphore/mutex lists, plus an independent timer array — to showcase
  master–detail.

## [0.9.2] - 2026-06-06

### Changed
- While dragging a column (header or Columns-menu row), a clear blue **preview
  chip** with the column name now follows the cursor, replacing the browser's
  faint default drag image.

## [0.9.1] - 2026-06-06

### Changed
- Change highlighting now shows the **previous value faded (struck-through)**
  next to the new value, instead of a ▲/▼ direction arrow.

## [0.9.0] - 2026-06-06

### Added
- **Pause / Resume** toolbar button. When paused, the panel no longer
  auto-refreshes (or queries GDB) on each stop — useful when you don't need it
  always on. The **Refresh** button still does a one-shot update, and the choice
  persists per workspace.

### Changed
- Drag-to-reorder drop indicators are now a bolder **blue** line with a light
  blue tint (both column headers and the Columns menu), so the drop position is
  much clearer.

## [0.8.0] - 2026-06-06

### Changed
- **Clearer column reordering.** Dragging a column header now shows a blue
  insertion line on the target column so you can see where it will land. In the
  ▦ Columns menu, rows are draggable (with a ⠿ grip) and show a drop line while
  dragging — the up/down arrow buttons were removed in favor of drag-to-reorder.

## [0.7.0] - 2026-06-06

### Changed
- **Any number of sections.** The config is now a map of named sections; each
  becomes its own dynamically-generated tab/table — `threads`, `semaphores`,
  `mutexes`, `queues`, or any name you choose. Column styling is applied by
  column name, so it works for any structure. (Previously limited to two fixed
  `threads`/`semaphores` sections.)

### Other
- The bundled `test-workspace` example gains a third structure (a mutex list) to
  demonstrate multiple sections.

## [0.6.0] - 2026-06-06

### Added
- **Drag-and-drop column reorder.** Drag a column header to move it (the ↑/↓
  menu buttons remain for keyboard/discoverability).
- **Right-click a column header** to open the columns menu at the cursor for
  quick show/hide.

## [0.5.0] - 2026-06-06

### Added
- **Column show/hide and reorder.** A "▦ Columns" menu per tab lets you toggle
  which columns are visible and move them up/down. Preferences persist per
  workspace.

### Changed
- **Hidden columns are no longer fetched from GDB.** Only visible columns issue
  `print` commands; enabling a column fetches its data on the spot (when stopped).

## [0.4.0] - 2026-06-06

### Added
- **Change highlighting.** When the panel refreshes at a new stop, cells whose
  value changed since the previous stop are highlighted (amber), numeric values
  get a ▲/▼ direction arrow, a "N changed" badge appears in the toolbar, and a
  tab that changed while not focused gets its count badge highlighted. Rows are
  matched by their first column (e.g. ID).

## [0.3.0] - 2026-06-05

### Added
- **Refresh** button in the panel toolbar that re-reads `rtos-inspector.json` and
  re-collects the data without continuing/restarting the debugger.
- Automatic refresh when the config file changes on disk (file watcher bound to
  the resolved `rtosInspector.configPath`), while the debugger is stopped.

## [0.2.0] - 2026-06-05

### Added
- Click a column header to sort the table by that column; click again to toggle
  ascending/descending. Numeric and hex values sort numerically, text sorts
  alphabetically. The active column shows a ▲/▼ indicator and the sort choice
  is preserved across debugger stops.

## [0.1.0] - 2026-06-05

### Added
- Initial public release.
- Config-driven (`rtos-inspector.json`) inspection of custom thread and semaphore
  structures during GDB (`cppdbg`) debugging.
- Two traversal modes: `linked_list` (head pointer + `next` field) and `array`
  (`count` elements, with `.`/`->` element access).
- Arbitrary `root` expressions (e.g. `g_kernel.pools[0]->thread_list`).
- Tabbed Webview panel with colored state badges, depleted/waiter highlighting,
  and per-tab summaries.
- Live refresh on debugger `stopped`/`continued` events.
- Settings: `rtosInspector.configPath`, `rtosInspector.debugTypes`.
