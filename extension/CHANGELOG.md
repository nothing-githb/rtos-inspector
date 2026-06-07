# Change Log

All notable changes to the **Debug Inspector** extension are documented here.

## [0.22.2] - 2026-06-06

### Changed
- The header base picker is now a **single click-to-cycle** button showing the
  current base (`#` raw / `10` / `16` / `2`); each click advances raw → dec → hex
  → bin → raw — instead of three separate `10 / 16 / 2` options.

## [0.22.1] - 2026-06-06

### Changed
- The per-column number base is now chosen from a **`10 / 16 / 2`** selector in
  the **column header's top-right** (dec / hex / bin; the active one is
  highlighted, click it again to reset to raw) — instead of a button in the ▦
  Columns menu. Quicker and visible at a glance.

## [0.22.0] - 2026-06-06

### Changed
- **Number base is now per-column** (was a single per-tab toggle). Cycle any
  numeric column through **dec → hex → bin → raw** from the ▦ Columns menu (the
  header shows a small base tag), and set a default in config with a field's
  **`"base": "dec"|"hex"|"bin"`**. **Binary** is new. The demo's `widgets` shows
  `X` in hex and `Y` in binary.

## [0.21.0] - 2026-06-06

### Removed
- **Master-detail (`${selected}`).** Relate sections with **grouping**
  (`groupBy` + `${master}`) instead — it shows every parent (and its children) at
  once in one tab, with no row to click. The `${selected}` placeholder,
  click-to-select, and the `selectMaster` plumbing were removed.

### Added
- A field may set **`"hidden": true`** to start collapsed and **unfetched**
  (enable it later from the ▦ Columns menu). Applied only when there is no saved
  column preference for that section.

### Changed
- Example config drops the `${selected}` `threads`/`mutexes` tabs; the demo `pool`
  gains a default-hidden `Next` column.

## [0.20.2] - 2026-06-06

### Fixed
- **Panel rendered nothing (blank, no data).** The table-toolbar code added in
  0.20.0 contained regex/string literals whose backslash escapes were stripped by
  the webview's HTML *template literal*: `/[",\n]/` and the `'\n'` joins in the
  CSV/Markdown copy became an invalid regex / unterminated string, so the entire
  webview script failed to compile and nothing rendered. Escaped them
  (`\\n`, `\\d`, `\\s`, `\\(` …) and also repaired the silently-degraded
  `isNumStr` / `isNullPtr` / whitespace regexes. Verified by compiling and
  executing the webview against mock data.

### Changed
- Example config no longer uses `${selected}` master-detail; all relationships
  use grouping (`groupBy` + `${master}`), so every section populates on each stop
  without clicking a row.

## [0.20.1] - 2026-06-06

### Fixed
- Reverted two 0.20.0 CSS changes that could distort the panel layout: the
  per-cell `max-width`/ellipsis and the document-level sticky first column. The
  filter box, changed-only toggle, number-base toggle, Copy CSV/MD, numeric
  right-alignment, and full-value cell tooltips are unchanged. (A robust frozen
  first column will return later via a dedicated scroll container.)

## [0.20.0] - 2026-06-06

### Added
- **Per-tab table toolbar:**
  - **Filter box** — live-filter rows by text across visible columns; focus is
    preserved while typing, and grouped tabs hide groups that become empty.
  - **Changed-only** toggle — show only rows that changed since the last stop.
  - **Number base** toggle — render numeric/hex columns as raw → decimal → hex.
  - **Copy CSV / Copy Markdown** — copy the (filtered) table to the clipboard
    (grouped tables include a leading `Group` column).
- **Frozen first column** on horizontal scroll (the header already stuck on
  vertical scroll).
- Numeric/hex columns are **right-aligned** with tabular figures; long cells are
  ellipsized with the **full value shown in a tooltip**.

## [0.19.3] - 2026-06-06

### Changed
- Fixed-size `char` arrays are now shown only up to the first `\0`. GDB renders
  the whole buffer (`"abc\000\000"` or `"abc", '\000' <repeats N times>`); the
  trailing NULs / repeat counts are dropped, and an all-NUL array shows as `""`.
  Applied at read time, so sorting/summaries/change-detection see the clean
  string. The demo's `pool` gains a `Tag` (`char[8]`) column.

## [0.19.2] - 2026-06-06

### Added
- New **`${wrapped_expr}`** placeholder for the `index_list` `next` template — the
  element **after** `cast`/`wrap` (vs `${expr}`, the un-wrapped element). Lets the
  `next` template reuse the wrap-cast without rewriting it, e.g. with
  `wrap: "((node_t *)${expr})"` you can write `"next": "${wrapped_expr}->nxt"`.

## [0.19.1] - 2026-06-06

### Changed
- In the `index_list` `next` template, `${expr}` now resolves to the
  **un-wrapped** element — the same `${expr}` that `wrap` receives — so the
  placeholder means the same thing in both places. (Previously `next`'s `${expr}`
  was the post-`wrap` element.)

## [0.19.0] - 2026-06-06

### Added
- **`index_list` `next` accepts a `${expr}` template** (like `wrap`). When `next`
  contains `${expr}` (the element), the next index is computed from that template
  instead of the default `element<access>next` — enabling non-suffix next-index
  expressions such as `"${expr}.link.idx"` or a lookup `"g_succ[${expr}.id]"`.
  Backward compatible (plain field names work unchanged). The demo's `procSlots`
  now uses `"next": "${expr}.next"`.

## [0.18.4] - 2026-06-06

### Other
- Reworked both READMEs (root + Marketplace) to be more detailed yet clearer and
  more scannable: a complete config-schema table, a per-mode walkthrough,
  master–detail vs. grouping, `cast`/`wrap`/field-hop and placeholder semantics,
  a settings table, and a logging/troubleshooting guide. Documentation only;
  every claim verified against the source.

## [0.18.3] - 2026-06-06

### Other
- Documented and demoed a **pre-cast field hop**: when each array slot is a
  `{ void *data; }` wrapper, reach the data field inside `wrap` before casting —
  `"wrap": "((widget_t *)(${expr}.data))"` → `((widget_t *)(box[i].data))->field`.
  The demo gains a `boxes` section. (No engine change — `wrap` already supports
  this.)

## [0.18.2] - 2026-06-06

### Fixed
- The `wrap` output is now wrapped in parentheses before the field access is
  appended (`(wrap)<access>field`). This prevents operator-precedence mis-parsing
  for a `wrap` that dereferences — e.g. `"wrap": "*(${expr})"` now yields
  `(*(elem)).field` instead of `*(elem).field` (which C parses as
  `*((elem).field)`).

## [0.18.1] - 2026-06-06

### Fixed
- When substituting `${master}` / `${selected}`, the value is now the master's
  **fully-processed element** — its `cast` and `wrap` applied — matching how the
  master reads its own fields. Previously the raw `(root)[i]` / `root->next` was
  used, so a master stored behind a `void*` (needing a `cast`/`wrap`) produced
  invalid child expressions.

## [0.18.0] - 2026-06-06

### Added
- `${master}` (grouping) and `${selected}` (master–detail) placeholders now
  resolve in a section's **`head`**, `count`, and `nil` too — not just `root`. An
  `index_list` can therefore start its walk at a per-parent head, e.g.
  `"head": "${master}->slot_head"`. Master–detail detection also triggers when
  `${selected}` appears only in `head`/`count`. The demo gains a grouped
  `procSlots` index-list (each process walks its own chain via
  `${master}->slot_head`).

## [0.17.2] - 2026-06-06

### Changed
- The Output channel is now rendered with VS Code's built-in **`log`** syntax, so
  timestamps, severities (`INFO`/`DEBUG`/`WARN`/`ERROR`), and quoted values are
  **color-coded** by the theme. Lines are formatted as
  `YYYY-MM-DD HH:MM:SS.mmm [LEVEL] message`.

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
