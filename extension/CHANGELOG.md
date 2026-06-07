# Change Log

All notable changes to the **RTOS Inspector** extension are documented here.

## [0.12.0] - 2026-06-06

### Added
- **`cast` field for array sections.** Set `"cast": "T"` to read a generic
  `void*` buffer as an array of `T`: the element access becomes
  `((T *)(root))[i]`. Useful for dynamic-array containers that store elements
  behind a `void *data` + `size`. The demo gains a `widgets` dynamic array.

## [0.11.0] - 2026-06-06

### Added
- **Leveled logging** to an *RTOS Inspector* Output channel
  (trace / debug / info / warn / error). Pick the level from the Output panel's
  gear or via "Developer: Set Log Level…". At `trace`, every GDB command and its
  result is logged; `debug` shows section/column/selection activity. A new
  command **"RTOS Inspector: Show Log"** opens the channel.

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
