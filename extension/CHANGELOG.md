# Change Log

All notable changes to the **SyncWatch** extension are documented here.

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
- **Refresh** button in the panel toolbar that re-reads `syncwatch.json` and
  re-collects the data without continuing/restarting the debugger.
- Automatic refresh when the config file changes on disk (file watcher bound to
  the resolved `syncwatch.configPath`), while the debugger is stopped.

## [0.2.0] - 2026-06-05

### Added
- Click a column header to sort the table by that column; click again to toggle
  ascending/descending. Numeric and hex values sort numerically, text sorts
  alphabetically. The active column shows a ▲/▼ indicator and the sort choice
  is preserved across debugger stops.

## [0.1.0] - 2026-06-05

### Added
- Initial public release.
- Config-driven (`syncwatch.json`) inspection of custom thread and semaphore
  structures during GDB (`cppdbg`) debugging.
- Two traversal modes: `linked_list` (head pointer + `next` field) and `array`
  (`count` elements, with `.`/`->` element access).
- Arbitrary `root` expressions (e.g. `g_kernel.pools[0]->thread_list`).
- Tabbed Webview panel with colored state badges, depleted/waiter highlighting,
  and per-tab summaries.
- Live refresh on debugger `stopped`/`continued` events.
- Settings: `syncwatch.configPath`, `syncwatch.debugTypes`.
