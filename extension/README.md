# Debug Inspector

**Visualize your own C/C++ data structures — threads, semaphores, mutexes, queues, linked lists, any struct collection — as live, sortable tables while debugging with GDB. Config-driven and read-only.**

Debug Inspector turns the structures *you* describe into clean, tabbed, sortable tables that refresh every time your GDB (`cppdbg`) session stops. Point it at any global expression — a thread-control-block list, a semaphore pool, a ready/blocked queue, a timer array, an intrusive free-list, or any node list — and it walks that structure and renders it for you, no more manually expanding nodes in the debugger. What appears is driven entirely by a small `rtos-inspector.json` file you write, so the extension knows nothing about your types and works with **any** C/C++ codebase: bare-metal, a hobby or commercial RTOS, or plain application code. It is aimed at embedded / RTOS developers inspecting their own kernels, but it is just as useful to any C/C++ developer who wants a live view of a struct collection. It is strictly **read-only** for your program: it never calls functions and never writes your memory — the only `set` commands it issues target dedicated GDB convenience variables (`$ri_*` / `$rg_*`) used as traversal cursors.

## Features

- **Config-driven, zero code changes.** Describe each structure in JSON; the extension assumes no layout and needs no instrumentation in your program.
- **Three traversal modes.** `linked_list` (follow a `next` pointer until NULL), `array` (iterate `count` elements), and `index_list` (a list stored inside an array, linked by a next-*index* field, walking from `head` to `nil`; unused slots are skipped).
- **Arbitrary root expressions.** `root` is passed to GDB verbatim, so anything valid works: `head`, `g_sys.thread_list`, `g_kernel.pools[0]->thread_list`.
- **Live updates.** The panel refreshes on every stop and shows a `running…` badge while the program runs; a status pill reads `stopped` / `running…` / `paused`, plus an `updated <time>` timestamp.
- **Sortable columns.** Click a header to sort (numeric/hex columns sort numerically, text alphabetically); click again to toggle direction. The choice persists across stops.
- **Refresh on demand or on change.** A **Refresh** button re-reads the config without restarting the debugger, and the panel also refreshes automatically when the config file changes on disk (while stopped).
- **Pause / Resume.** Stop auto-refreshing and querying GDB on each stop when you don't need it; Refresh still does a one-shot. Remembered per workspace.
- **Change highlighting.** Cells that changed since the previous stop are amber-highlighted, with the previous value shown faded and struck-through next to the new one. A `N changed` badge shows the total; tabs that changed in the background flag their count.
- **Pick & reorder columns.** Drag a column header (or a row in the **▦ Columns** menu) to reorder — a bold blue insertion line marks the drop target and a drag-preview chip follows the cursor. Right-click a header or use the menu to show/hide. Order and visibility persist per workspace. Hidden columns are **not** read from GDB at all; enabling one fetches its data on the spot.
- **Master–detail.** A section whose `root`/`head`/`count` contains `${selected}` becomes a detail table; click a row in a master section (e.g. a process) to populate it with that element's lists. The first master row is auto-selected.
- **Grouping (tree).** Or keep a section in its own tab and render it as a collapsible tree grouped under a master (`groupBy` + `${master}`), with a flat-view toggle.
- **Readable UI.** Recognized columns get automatic styling: a `State` column becomes a colored badge (RUNNING / READY / BLOCKED / WAITING), a `Count` of `0` is flagged red, `Waiting > 0` amber, plus a summary line per tab.
- **Read-only & safe.** Debug Inspector only *reads* your data — it never calls functions or writes your program's memory, so program state is never disturbed.
- **Leveled, color-coded logging.** A *Debug Inspector* Output channel (rendered with the `log` syntax so timestamps/severities/values are colorized); pick `off` / `info` / `debug`.

## Requirements

- The [C/C++ extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) (`ms-vscode.cpptools`) and a working GDB debug configuration (`type: cppdbg`).
- GDB available on your system.

## Quick start

1. Debug your C/C++ program with `cppdbg` (GDB).
2. Put a `rtos-inspector.json` at your workspace root (see the schema below).
3. Run **“Debug Inspector: Open Panel”** from the Command Palette (it opens beside your editor).
4. When you hit a breakpoint the panel fills in; on `continue` it shows `running…`, then refreshes again on the next stop. Each config section gets its own tab.

Run **“Debug Inspector: Show Log”** any time to open the Output channel for diagnostics.

## Configuration

The config file (default `rtos-inspector.json`) is a JSON object that is a **map of named sections**. Each key whose value is an object with a string `mode` and an array `fields` is treated as a section; the **JSON key is the tab label** (`threads`, `semaphores`, `pool`, … — any name). Add **one section per data structure**, as many as you like; section order in the file drives tab order. Keys beginning with `//` are skipped, so you can use them for inline comments.

### Schema — every field

| Field     | Modes                       | Meaning |
|-----------|-----------------------------|---------|
| `mode`    | all *(required)*            | `"linked_list"`, `"array"`, or `"index_list"`. |
| `root`    | all *(required)*            | Starting expression in your program's own syntax (head pointer or array). May contain `${selected}` / `${master}`. |
| `next`    | linked_list, index_list     | Field giving the next element — a **pointer** (`cursor->next`) for linked_list, an **index** for index_list. Used verbatim, so set it (it only falls back to `next` when building a master's clickable/grouped selector). |
| `head`    | index_list                  | Starting **index** expression. May contain `${selected}` / `${master}`. |
| `nil`     | index_list                  | Sentinel index that ends the walk (default `-1`). May contain `${selected}` / `${master}`. |
| `count`   | array                       | Expression yielding the element count (parsed as an integer). May contain `${selected}` / `${master}`. |
| `access`  | array, index_list           | Element-to-field accessor: `"."` (default) or `"->"` for a pointer element. (linked_list is always `->`.) |
| `cast`    | array, index_list           | Cast applied to `root` to reinterpret a generic/`void*` buffer — **written in full** (e.g. `widget_t *`); no `*` is auto-added. |
| `wrap`    | all                         | Template that transforms the **element** before field access; `${expr}` is the element. |
| `label`   | master sections             | Expression evaluated on the master element to title each tree node when another section groups by this one. |
| `groupBy` | grouping sections           | Names a master section; renders this section as a collapsible tree, one group per master element (use `${master}` in `root`/`head`/`count`/`nil`). |
| `max`     | all                         | Traversal upper bound / safety guard (default `1024`). |
| `fields`  | all *(required)*            | Ordered list of `{ "label", "expr" }` columns. The first column is the row's identity/key. |

#### Notes on the subtle fields

**`cast` is written in full.** There is no auto-appended `*` — you supply the complete type, so it composes for any target. The base becomes `((cast)(root))` and elements are indexed off it: `"cast": "widget_t *"` over `root: "g_widgets.data"` produces `((widget_t *)(g_widgets.data))[i].field`.

**`wrap` parenthesizes twice and supports a field hop.** The element is parenthesized into the wrap, and then the **wrap output is itself parenthesized** before the field access is appended. So `wrap: "((widget_t *)${expr})"` with element `g_slots[i]` and `access: "->"` yields `(((widget_t *)(g_slots[i])))->field`. The extra outer parens fix precedence, so a deref wrap `"*(${expr})"` correctly becomes `(*(elem)).field` rather than the mis-parsed `*(elem).field`. `wrap` composes **with** `cast`: `cast` is applied to `root` to form the element, then `wrap` wraps that element. You can also **hop through a field before casting** by reaching it inside the wrap — e.g. `wrap: "((widget_t *)(${expr}.data))"` reaches `.data` first, giving `((widget_t *)(g_boxes[i].data))->field`.

**`${selected}` / `${master}` substitute the *processed* element.** Both placeholders resolve to a type-safe re-selection of the master row — with the master's own `cast` **and** `wrap` already applied — substituted (in parentheses) into the target section's `root`, `count`, `head`, and `nil`. No address-taking and no extra cast is required. `${selected}` drives master–detail (the row you click); `${master}` drives grouping (every master element at once).

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

### Master–detail (`${selected}`)

Put `${selected}` in a section's `root` (or `head` / `count`) to make it a *detail* table that follows the row you click in a master section. The first master row is auto-selected; the selected row is highlighted. Detail sections are separate tabs that repopulate on each click.

```json
{
  "processes": {
    "mode": "linked_list", "root": "g_process_list", "next": "next",
    "fields": [
      { "label": "PID",  "expr": "pid" },
      { "label": "Name", "expr": "name" }
    ]
  },
  "threads": {
    "mode": "linked_list", "root": "${selected}->thread_list", "next": "next",
    "fields": [
      { "label": "ID",       "expr": "id" },
      { "label": "Name",     "expr": "name" },
      { "label": "State",    "expr": "state" },
      { "label": "Priority", "expr": "prio" }
    ]
  }
}
```

Clicking a `processes` row fills `threads` with that process's thread list. A `mutexes` detail is the same shape with `root: "${selected}->mutex_list"`.

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

### Notes on `expr` and rendering

You never declare types or sizes. Whatever `expr` evaluates to is formatted by GDB according to its type: enums render as names (`RUNNING`, `FIFO`), pointers as addresses, integers as numbers. A value GDB cannot read (an inaccessible address, an error such as `optimized out`) or a NULL pointer (`0x0`) is shown as a muted `-`; a plain integer `0` is shown as `0` (and keeps styling such as a red `Count`).

## Settings

| Setting                      | Default                | Description |
|------------------------------|------------------------|-------------|
| `rtosInspector.configPath`   | `rtos-inspector.json`  | Path to the config file. Absolute paths are used as-is (work even with no workspace folder); a relative path is resolved against the workspace root. |
| `rtosInspector.logLevel`     | `info`                 | Verbosity of the *Debug Inspector* Output channel: `off` / `info` / `debug`. |
| `rtosInspector.debugTypes`   | `["cppdbg"]`           | Debug adapter types the tracker attaches to. Use `cppdbg` for GDB. |

## Logging & troubleshooting

Open the channel with **“Debug Inspector: Show Log”**. It uses VS Code's `log` language id, so the theme color-codes timestamps, severities, and values. Pick the level with `rtosInspector.logLevel` (applied live):

- **`off`** — no logging.
- **`info`** *(default)* — general milestones plus warnings/errors: activate, refresh, selection, and GDB access failures.
- **`debug`** — everything `info` shows, plus every prepared GDB access string (`gdb ▸`) and its result (`gdb ◂`), and step-by-step traversal. For an `index_list` you can see how `next` resolves at each hop (e.g. `step N: idx X → next [...] = "v" → idx N`); for a `linked_list`, each `node N` as the cursor advances. This is the fastest way to confirm exactly what expression was sent to GDB when a column shows `-`.

## License

[MIT](LICENSE)
