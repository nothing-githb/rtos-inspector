# Debug Inspector

**Visualize your own C/C++ data structures — threads, semaphores, mutexes, queues, linked lists, any struct collection — as live, sortable tables while debugging with GDB. Config-driven and read-only.**

Debug Inspector turns the structures *you* describe into clean, tabbed, sortable tables that refresh every time your GDB (`cppdbg`) session stops. Point it at any global expression — a thread-control-block list, a semaphore pool, a ready/blocked queue, a timer array, an intrusive free-list, or any node list — and it walks that structure and renders it for you, no more manually expanding nodes in the debugger. What appears is driven entirely by a small `debug-inspector.json` file you write, so the extension knows nothing about your types and works with **any** C/C++ codebase: bare-metal, a hobby or commercial RTOS, or plain application code. It is aimed at embedded / RTOS developers inspecting their own kernels, but it is just as useful to any C/C++ developer who wants a live view of a struct collection. It is strictly **read-only** for your program: it never calls functions and never writes your memory — the only `set` commands it issues target dedicated GDB convenience variables (`$ri_*` / `$rg_*`) used as traversal cursors.

![Debug Inspector panel](https://raw.githubusercontent.com/nothing-githb/debug-inspector/master/extension/images/panel.png)

*Representative panel — per-process threads with `State` badges, stack‑usage bars, an `Owner` cross‑reference link, change highlighting, and per‑column number‑base / sort controls.*

## Features

- **Config-driven, zero code changes.** Describe each structure in JSON; the extension assumes no layout and needs no instrumentation in your program.
- **Three traversal modes.** `linked_list` (follow a `next` pointer until NULL), `array` (iterate `count` elements), and `index_list` (a list stored inside an array, linked by a next-*index* field, walking from `head` to `nil`; unused slots are skipped).
- **Arbitrary root expressions.** `root` is passed to GDB verbatim, so anything valid works: `head`, `g_sys.thread_list`, `g_kernel.pools[0]->thread_list`.
- **Live updates.** The panel refreshes on every stop and shows a `running…` badge while the program runs; a status pill reads `stopped` / `running…` / `paused`, plus an `updated <time>` timestamp. The panel **closes automatically when the debug session ends**.
- **Prioritized streaming refresh.** On each stop the **active tab is fetched and shown first**, then the other visible sections stream in **in the background**. **Switching tabs re-prioritizes** — the tab you open jumps the queue and is fetched next — so large workspaces stay responsive. Sections still in the queue (and newly revealed ones) show a **“Loading…”** placeholder until their data arrives, and **each tab shows a spinning ⟳** while its section is still being fetched — so you can watch sections update one by one. The Refresh button reflects the overall state.
- **Sortable columns.** Click a header to sort (numeric/hex columns sort numerically, text alphabetically); click again to toggle direction. The choice persists across stops.
- **Filter & changed-only.** A per-tab filter box narrows rows as you type (focus is preserved); a **Changed** toggle shows only rows that moved since the last stop.
- **Copy out & export.** Copy the (filtered) table as **CSV** or **Markdown** in one click (grouped tables add a leading `Group` column); or **⤓ JSON** in the top bar **exports every section's data to a JSON file** (save dialog).
- **Per-column number base & alignment.** Show any numeric column as **dec / hex / bin** via a click-to-cycle base button in the column header's top-right (`raw`→`bin`→`dec`→`hex`), or set a default in config with a field's `"base"`. Numeric columns right-align with tabular figures, and hovering any cell shows its full value in a tooltip.
- **Sticky header.** The header row stays put while you scroll a long table.
- **Refresh on demand or on change.** A **Refresh** button re-reads the config without restarting the debugger (its icon **spins and reads “Refreshing…”** while a refresh is in progress), and the panel also refreshes automatically when the config file changes on disk (while stopped). A config edit that only changes **presentation** — a column's `base`, a `bar`'s `warn`/`crit` thresholds, a `link`, or `badge` colors — is applied **without re-reading anything from GDB**; only data-affecting edits (`expr`, `root`/`next`/`count`/`cast`/`wrap`, `mode`, `bar.max`, `editable`, `when`, adding/removing fields, …) trigger an actual refresh.
- **Pause / Resume.** Stop auto-refreshing and querying GDB on each stop when you don't need it; Refresh still does a one-shot. Remembered per workspace.
- **Change highlighting.** Cells that changed since the previous stop are amber-highlighted, with the previous value shown faded and struck-through next to the new one. A `N changed` badge shows the total; tabs that changed in the background flag their count.
- **Pick & reorder columns.** Drag a column header (or a row in the **▦ Columns** menu) to reorder — a bold blue insertion line marks the drop target and a drag-preview chip follows the cursor. Right-click a header or use the menu to show/hide. Order and visibility persist per workspace. Hidden columns are **not** read from GDB at all; enabling one fetches **only that column** on the spot (merged into the existing rows — the rest of the panel isn't re-read).
- **Grouping (tree).** Relate sections: render one section, in its own tab, as a
  collapsible tree grouped under a master section (`groupBy` + `${master}`) — e.g.
  every process's semaphores under its process node — all at once, with a
  flat-view toggle.
- **Usage bars.** Render a numeric field as a `used / max · %` bar
  (green → amber → red) with a field's `"bar"` — e.g. per-thread **stack usage**.
- **Cross-reference links.** A field with `"link"` renders as a clickable link to
  another object; clicking jumps to that section and highlights the matching row
  (e.g. a mutex's `Owner` → the owning thread).
- **Conditional fields.** A field with `"when"` shows only when its condition holds
  (else blank) — several on one discriminator give **tagged‑union / variant** rows.
- **Hide columns by default.** Mark a field `"hidden": true` to start it collapsed
  (and unfetched) until you enable it from the ▦ Columns menu.
- **Manage sections (tabs).** Hide/show whole sections from the **▤ Sections** menu
  and reorder by **dragging a tab** (or a row in the menu) — instant (client-side),
  remembered per workspace. Revealing a hidden section fetches **only that section**
  (not the whole panel). A section can also start hidden with `"hidden": true`
  in config.
- **Readable UI.** Recognized columns get automatic styling: a `State` column becomes a colored badge (RUNNING / READY / BLOCKED / WAITING — or your own value→color map via a field's `"badge"`), plus a summary line per tab. Changed cells light up amber.
- **Read-only by default (optional editing).** Debug Inspector only *reads* your data — it never calls functions. A field can opt into editing with `"editable": true`; then right-click → **Edit value…** writes it with GDB `set var`, and **only the edited row is re-read** afterwards (not the whole panel). Right-click any cell also offers **Copy cell** and **Copy row as watch expression** — the latter copies the row's stable element expression (e.g. `(g_mutexes)[5]`, or the master‑qualified path for grouped sections) so you can paste it into VS Code's **Watch** panel (VS Code has no API to add a watch entry directly). A plain‑member (or editable) cell also offers **Add watchpoint (break on change)**, which sets a GDB data watchpoint (`watch <lvalue>`) so the program stops when that field changes — it doesn't write memory. A watched cell is then marked with a gold **★** (and a left accent), its hover tooltip notes the watchpoint, and its menu switches to **★ Remove watchpoint** (runs GDB `delete`). Stars persist across refreshes and clear when the session ends.
- **Leveled, color-coded logging.** A *Debug Inspector* Output channel (rendered with the `log` syntax so timestamps/severities/values are colorized); pick `off` / `info` / `debug`.

## Requirements

- The [C/C++ extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) (`ms-vscode.cpptools`) and a working GDB debug configuration (`type: cppdbg`).
- GDB available on your system.

## Quick start

1. Debug your C/C++ program with `cppdbg` (GDB).
2. Put a `debug-inspector.json` at your workspace root (see the schema below).
3. Run **“Debug Inspector: Open Panel”** from the Command Palette (it opens beside your editor).
4. When you hit a breakpoint the panel fills in; on `continue` it shows `running…`, then refreshes again on the next stop. Each config section gets its own tab.

Run **“Debug Inspector: Show Log”** any time to open the Output channel for diagnostics.

## Configuration

The config file (default `debug-inspector.json`) is a JSON object that is a **map of named sections**. Each key whose value is an object with a string `mode` and an array `fields` is treated as a section; the **JSON key is the tab label** (`threads`, `semaphores`, `pool`, … — any name). Add **one section per data structure**, as many as you like; section order in the file drives tab order. Keys beginning with `//` are skipped, so you can use them for inline comments.

### Schema — every field

| Field     | Modes                       | Meaning |
|-----------|-----------------------------|---------|
| `mode`    | all *(required)*            | `"linked_list"`, `"array"`, or `"index_list"`. |
| `root`    | all *(required)*            | Starting expression in your program's own syntax (head pointer or array). May contain `${master}` (grouping). |
| `next`    | linked_list, index_list     | Field giving the next element — a **pointer** (`cursor->next`) for linked_list, an **index** for index_list. For index_list it may instead be a `${expr}` **template** (like `wrap`) that computes the next index, e.g. `"${expr}.link.idx"`. Used verbatim, so set it (it only falls back to `next` when building a master's clickable/grouped selector). |
| `head`    | index_list                  | Starting **index** expression. May contain `${master}` (grouping). |
| `nil`     | index_list                  | Sentinel index that ends the walk (default `-1`). May contain `${master}` (grouping). |
| `count`   | array                       | Expression yielding the element count (parsed as an integer). May contain `${master}` (grouping). |
| `access`  | array, index_list           | Element-to-field accessor: `"."` (default) or `"->"` for a pointer element. (linked_list is always `->`.) |
| `cast`    | array, index_list           | Cast applied to `root` to reinterpret a generic/`void*` buffer — **written in full** (e.g. `widget_t *`); no `*` is auto-added. |
| `wrap`    | all                         | Template that transforms the **element** before field access; `${expr}` is the element. |
| `label`   | master sections             | Expression evaluated on the master element to title each tree node when another section groups by this one. |
| `groupBy` | grouping sections           | Names a master section; renders this section as a collapsible tree, one group per master element (use `${master}` in `root`/`head`/`count`/`nil`). |
| `hidden`  | all                         | `true` starts this section's tab hidden (until shown from the ▤ Sections menu). Ignored once you change section visibility in the UI. |
| `max`     | all                         | Traversal upper bound / safety guard (default `1024`). |
| `fields`  | all *(required)*            | Ordered list of `{ "label", "expr" }` columns (first column = row identity). `expr` is appended after the element, OR a computed expression via `${expr}` / `${wrapped_expr}` (the element, like `wrap`/`next`) — e.g. `"${expr}->stack_size - ${expr}->stack_used"` for arithmetic across two members. A field may add `"hidden": true` (start collapsed/unfetched), `"base": "dec"\|"hex"\|"bin"` (default number base), `"bar": { "max": "<expr>", "warn": 75, "crit": 90 }` (usage bar), and/or `"link": { "section": "<target>", "match": "<column>" }` (clickable cross-reference), and/or `"when": "<bool expr>"` (conditional field — blank when false; several on one discriminator = variant/tagged‑union), `"editable": true` (right‑click → Edit value writes via GDB `set var`), `"wrap": "<tmpl>"` (transform the field value *after* access — `${expr}` = the accessed value), and/or `"badge": { "<value>": "<color>" }` (value→color badge, overriding the built-in `State` coloring). |

#### Notes on the subtle fields

**`cast` is written in full.** There is no auto-appended `*` — you supply the complete type, so it composes for any target. The base becomes `((cast)(root))` and elements are indexed off it: `"cast": "widget_t *"` over `root: "g_widgets.data"` produces `((widget_t *)(g_widgets.data))[i].field`.

**`wrap` parenthesizes twice and supports a field hop.** The element is parenthesized into the wrap, and then the **wrap output is itself parenthesized** before the field access is appended. So `wrap: "((widget_t *)${expr})"` with element `g_slots[i]` and `access: "->"` yields `(((widget_t *)(g_slots[i])))->field`. The extra outer parens fix precedence, so a deref wrap `"*(${expr})"` correctly becomes `(*(elem)).field` rather than the mis-parsed `*(elem).field`. `wrap` composes **with** `cast`: `cast` is applied to `root` to form the element, then `wrap` wraps that element. You can also **hop through a field before casting** by reaching it inside the wrap — e.g. `wrap: "((widget_t *)(${expr}.data))"` reaches `.data` first, giving `((widget_t *)(g_boxes[i].data))->field`.

**`${master}` substitutes the *processed* element.** In a section that sets
`groupBy`, `${master}` resolves — for each master element — to a type-safe
re-selection of that master row, with the master's own `cast` **and** `wrap`
already applied, substituted (in parentheses) into this section's `root`, `count`,
`head`, and `nil`. No address-taking and no extra cast is required.

**`label` runs on the processed master element.** It titles each tree node in a grouped child. A `char*` rendered as `0x.. "init"` is reduced to just `init`; otherwise the value is used as-is. If the master has no `label`, the group falls back to the master row's first-column key.

### Mode 1 — `linked_list`

Start at a head pointer and follow `next` until NULL (or `max`).

```json
{
  "processes": {
    "mode": "linked_list",
    "root": "g_process_list",
    "next": "next",
    "label": "name",
    "fields": [
      { "label": "PID",  "expr": "pid" },
      { "label": "Name", "expr": "name" }
    ]
  }
}
```

### Mode 2 — `array`

Iterate `count` elements (capped at `max`).

```json
{
  "timers": {
    "mode": "array",
    "root": "g_timers",
    "count": "g_timer_count",
    "access": ".",
    "fields": [
      { "label": "ID",      "expr": "id" },
      { "label": "Name",    "expr": "name" },
      { "label": "Period",  "expr": "period" },
      { "label": "Elapsed", "expr": "elapsed" },
      { "label": "Active",  "expr": "active" }
    ]
  }
}
```

### Mode 3 — `index_list`

A list living inside an array, linked by a next-**index** field. Start at `head`, read `root[idx]`, follow `next` until the index equals `nil`; slots not on the chain are never visited. (Below, the chain is `0 → 2 → 5`; slots 1/3/4 are skipped.)

```json
{
  "pool": {
    "mode": "index_list",
    "root": "g_slot_pool",
    "head": "g_slot_head",
    "next": "next",
    "nil": "-1",
    "access": ".",
    "fields": [
      { "label": "ID",   "expr": "id" },
      { "label": "Name", "expr": "name" },
      { "label": "Next", "expr": "next" }
    ]
  }
}
```

When the next index isn't a plain field, `next` accepts a **`${expr}` template**
(like `wrap`) — e.g. `"next": "${expr}.link.idx"` or a lookup
`"next": "g_succ[${expr}.id]"`. `${expr}` is the **un-wrapped** element — the same
one `wrap` receives, so it means the same thing in both. To reuse a `cast`/`wrap`
instead of rewriting it, use **`${wrapped_expr}`** (the post-`cast`/`wrap`
element): with `wrap: "((node_t *)${expr})"`, write `"next": "${wrapped_expr}->nxt"`.
(The demo's `procSlots` uses `"next": "${expr}.next"`.)

### Grouping / tree (`groupBy` + `${master}`)

Set `groupBy` to a master section's name to render this section in its own tab as a **collapsible tree** showing **all** master elements at once. `${master}` is replaced with each master's processed element. Node titles come from the master's `label` (here, `processes` sets `"label": "name"`). A **Flat view** toggle switches between the tree and one ungrouped table.

```json
{
  "semaphores": {
    "groupBy": "processes",
    "mode": "linked_list",
    "root": "${master}->sem_list",
    "next": "next",
    "fields": [
      { "label": "ID",         "expr": "id" },
      { "label": "Count",      "expr": "count" },
      { "label": "Max",        "expr": "max_count" },
      { "label": "Waiting",    "expr": "waiting" },
      { "label": "Discipline", "expr": "discipline" }
    ]
  }
}
```

Grouping also composes with `index_list` for a per-parent chain — e.g. `"head": "${master}->slot_head"`.

### `void*` cast (`cast`)

Reinterpret a generic buffer as a typed array. Here `g_widgets.data` is a `void*` holding a `widget_t[]`; the generated access is `((widget_t *)(g_widgets.data))[i].field`.

```json
{
  "widgets": {
    "mode": "array",
    "root": "g_widgets.data",
    "count": "g_widgets.size",
    "cast": "widget_t *",
    "access": ".",
    "fields": [
      { "label": "X",     "expr": "x" },
      { "label": "Y",     "expr": "y" },
      { "label": "Label", "expr": "label" }
    ]
  }
}
```

### `wrap` — deref / cast the element

`g_slots` is `void *g_slots[3]`, each element a `widget_t*`. Cast the element inside `wrap`, then use `access: "->"`. Generated: `(((widget_t *)(g_slots[i])))->field`.

```json
{
  "slots": {
    "mode": "array",
    "root": "g_slots",
    "count": "3",
    "wrap": "((widget_t *)${expr})",
    "access": "->",
    "fields": [
      { "label": "X",     "expr": "x" },
      { "label": "Y",     "expr": "y" },
      { "label": "Label", "expr": "label" }
    ]
  }
}
```

### `wrap` — pre-cast field hop

Each slot of `box_t g_boxes[3]` is `{ void *data; int kind }` and `data` holds a `widget_t*`. Reach `.data` **inside** the wrap *before* casting. Generated: `((widget_t *)(g_boxes[i].data))->field`.

```json
{
  "boxes": {
    "mode": "array",
    "root": "g_boxes",
    "count": "3",
    "wrap": "((widget_t *)(${expr}.data))",
    "access": "->",
    "fields": [
      { "label": "X",     "expr": "x" },
      { "label": "Label", "expr": "label" }
    ]
  }
}
```

### Per-column field options (with examples)

Any `fields` entry can carry extra options beyond `label`/`expr`. One example each:

**Computed value** — reference the element with `${expr}` (raw) / `${wrapped_expr}` (after `cast`/`wrap`) for arithmetic, casts, or ternaries:

```json
{ "label": "Free", "expr": "${expr}->stack_size - ${expr}->stack_used" }
```

**Number base** (`base`) — default display base `dec` / `hex` / `bin` (also toggle live from the `10 / 16 / 2` button in the column header):

```json
{ "label": "Handle", "expr": "id", "base": "hex" }
```

**Usage bar** (`bar`) — render the value as a `used / max · %` bar, green → amber (`≥ warn`) → red (`≥ crit`); `max` is a sibling expression or a constant:

```json
{ "label": "Stack", "expr": "stack_used", "bar": { "max": "stack_size", "warn": 75, "crit": 90 } }
```

**Cross-reference link** (`link`) — render the value as a link; clicking jumps to the row in `section` whose `match` column equals it (only when a match exists):

```json
{ "label": "Owner", "expr": "owner", "link": { "section": "threads", "match": "ID" } }
```

**Conditional fields** (`when`) — show a column only when its boolean expression holds; put several on one discriminator for **tagged-union / variant** rows:

```json
{ "label": "Owner",   "expr": "owner",   "when": "locked",            "link": { "section": "threads", "match": "ID" } },
{ "label": "Waiting", "expr": "waiters", "when": "${expr}.locked == 0" }
```

**Editable** (`editable`) — right-click the cell → **Edit value…** writes it back with GDB `set var` (assignable fields only):

```json
{ "label": "Locked", "expr": "locked", "editable": true }
```

**Hidden by default** (`hidden`) — start the column collapsed and **unfetched**; enable it from the **▦ Columns** menu:

```json
{ "label": "Next", "expr": "next", "hidden": true }
```

**Field `wrap`** — transform the value **after** access (`${expr}` = the accessed value), e.g. reinterpret a `void*` member differently per column:

```json
{ "label": "X", "expr": "data", "wrap": "((widget_t *)${expr})->x" }
```

**Badge colors** (`badge`) — map values to colored badges (case‑insensitive exact match), overriding the built‑in `State` coloring. Color names `green` / `blue` / `red` / `amber` / `orange` / `purple` / `cyan` / `gray`, or a `#rrggbb` hex. Works for numeric states too:

```json
{ "label": "State", "expr": "state", "badge": { "RUNNING": "green", "READY": "cyan", "BLOCKED": "red", "WAITING": "amber" } }
```

### Notes on `expr` and rendering

You never declare types or sizes. Whatever `expr` evaluates to is formatted by GDB according to its type: enums render as names (`RUNNING`, `FIFO`), pointers as addresses, integers as numbers. A fixed-size `char` array is shown only up to the first `\0` — the trailing NULs GDB prints (`"abc\000\000"` or `"abc", '\000' <repeats N times>`) are dropped, so you just see `"abc"`. A value GDB **cannot read** — `No symbol …`, `cannot access memory`, `optimized out`, or an evaluation error — is shown as a distinct red **⚠** with the GDB error in its tooltip (and logged to the Output channel). A **NULL pointer** (`0x0`) is shown as a muted `-` (visually separate from an error), and a plain integer `0` is shown as `0`.

## Settings

| Setting                      | Default                | Description |
|------------------------------|------------------------|-------------|
| `debugInspector.configPath`   | `debug-inspector.json`  | Path to the config file. Absolute paths are used as-is (work even with no workspace folder); a relative path is resolved against the workspace root. |
| `debugInspector.logLevel`     | `info`                 | Verbosity of the *Debug Inspector* Output channel: `off` / `info` / `debug`. |
| `debugInspector.debugTypes`   | `["cppdbg"]`           | Debug adapter types the tracker attaches to. Use `cppdbg` for GDB. |

## Logging & troubleshooting

Open the channel with **“Debug Inspector: Show Log”**. It uses VS Code's `log` language id, so the theme color-codes timestamps, severities, and values. Pick the level with `debugInspector.logLevel` (applied live):

- **`off`** — no logging.
- **`info`** *(default)* — general milestones plus warnings/errors: activate, refresh, selection, and GDB access failures.
- **`debug`** — everything `info` shows, plus every prepared GDB access string (`gdb ▸`) and its result (`gdb ◂`), and step-by-step traversal. For an `index_list` you can see how `next` resolves at each hop (e.g. `step N: idx X → next [...] = "v" → idx N`); for a `linked_list`, each `node N` as the cursor advances. This is the fastest way to confirm exactly what expression was sent to GDB when a column shows `-`.

## License

[MIT](LICENSE)
