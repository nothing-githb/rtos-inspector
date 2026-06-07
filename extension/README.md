# Debug Inspector

**Visualize your own C/C++ data structures as live tables while debugging with GDB.**

When your GDB (`cppdbg`) session stops, Debug Inspector walks the data structures
*you* describe — linked lists and arrays of structs such as thread control
blocks, semaphores, mutexes, ready/blocked queues, timers, free-lists, or any
node list — and renders them as clean, sortable tables in a tabbed panel.

What gets shown is driven entirely by a `rtos-inspector.json` file you write, so
the extension knows nothing about your types and works with any C/C++ codebase —
bare-metal, a hobby or commercial RTOS, or plain application code. Aimed at
embedded / RTOS developers, but handy for any structures you'd otherwise expand
by hand in the debugger.

## Features

- **Config-driven.** Point Debug Inspector at any global expression; it does not
  assume any layout. No code changes to your program.
- **Three traversal modes.**
  - `linked_list` — start at a head pointer, follow a `next` field until NULL.
  - `array` — iterate `count` elements of an array.
  - `index_list` — a list stored in an array, linked by a *next-index* field
    (start at `head`, follow `next` until `nil`); empty slots are skipped.
- **Arbitrary root expressions.** `root` is passed to GDB verbatim, so anything
  valid works: `head`, `g_sys.thread_list`, `g_kernel.pools[0]->thread_list`.
- **Live updates.** The panel refreshes every time execution stops and shows a
  "running…" badge while the program runs.
- **Sortable columns.** Click any column header to sort (numeric/hex columns
  sort numerically, text alphabetically); the choice persists across stops.
- **Refresh on demand or on change.** A **Refresh** button re-reads
  `rtos-inspector.json` without restarting the debugger, and the panel also refreshes
  automatically when the config file changes on disk (while stopped).
- **Pause / Resume.** Stop auto-refreshing (and querying GDB) on each stop when
  you don't need it; Refresh still works on demand. Remembered per workspace.
- **Change highlighting.** Values that changed since the previous stop are
  highlighted, with the previous value shown faded (struck-through) next to the
  new one; a "N changed" badge shows the total, and tabs that changed in the
  background flag their count.
- **Pick & reorder columns.** Drag a column header to reorder (a blue line shows
  where it lands), or drag the rows in the "▦ Columns" menu; right-click a header
  or use the menu to show/hide. Order and visibility are saved per workspace.
  Hidden columns are **not** read from GDB at all — enabling one fetches its data
  on the spot.
- **Master–detail.** A section whose `root` contains `${selected}` becomes a
  detail table; click a row in a master section (e.g. a process) to populate it
  with that element's lists. The first master row is auto-selected.
- **Grouping (tree).** Or keep a section in its own tab and show it as a
  collapsible tree grouped under a master (`groupBy` + `${master}`), with a
  flat-view toggle.
- **Read-only & safe.** Debug Inspector only *reads* globals — it never calls
  functions, so your program state is never disturbed.
- **Leveled, color-coded logging.** An *Debug Inspector* Output channel (rendered
  with the `log` syntax, so timestamps/severities/values are colorized) — pick the
  level with the **`rtosInspector.logLevel`** setting: `off` / `info` / `debug`.
  `info` shows milestones plus warnings/errors; `debug` logs every GDB access
  string + result and each traversal step (e.g. how `next` is resolved at each
  hop). Run "Debug Inspector: Show Log" to open it.
- **Readable UI.** Recognized columns get automatic styling: a `State` column
  becomes a colored badge (RUNNING / READY / BLOCKED / WAITING), a `Count` of `0`
  is flagged red and `Waiting > 0` amber, with a summary line per tab.

## Requirements

- The [C/C++ extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)
  (`ms-vscode.cpptools`) and a working GDB debug configuration (`type: cppdbg`).
- GDB available on your system.

## Usage

1. Debug your C/C++ program with `cppdbg` (GDB).
2. Put a `rtos-inspector.json` at your workspace root (see the schema below).
3. Run **“Debug Inspector: Open Panel”** from the Command Palette.
4. When you hit a breakpoint the panel fills in; on `continue` it shows
   "running…", and it refreshes again on the next stop. Each config section gets
   its own tab at the top.

## Configuration schema

Add **one section per data structure** — each becomes its own dynamically
generated, sortable table / tab, and you can add **as many as you like**. The
section's JSON key is its tab label (`threads`, `semaphores`, `mutexes`, … — any
name). Each section uses the same fields:

| Field    | Meaning |
|----------|---------|
| `mode`   | `"linked_list"`, `"array"`, or `"index_list"` |
| `root`   | Starting expression — the head pointer / the array |
| `next`   | *(linked_list)* next-node pointer field · *(index_list)* next-**index** field |
| `head`   | *(index_list)* starting index expression |
| `nil`    | *(index_list)* index that ends the walk (default `-1`) |
| `count`  | *(array)* expression yielding the element count |
| `access` | *(array)* element field access: `"."` (default) or `"->"` (pointer array) |
| `cast`   | *(array)* cast for a generic `void*` buffer — write it in full (e.g. `widget_t *`) → `((cast)(root))[i]` |
| `wrap`   | wrap the **element** before field access; `${expr}` = the element → `wrap(elem)<access>field` |
| `label`  | *(master)* expression titling each tree node when another section groups by this one |
| `groupBy`| render as a tree grouped under the named master section; use `${master}` in `root` |
| `max`    | Safety upper bound (default `1024`) |
| `fields` | List of `{ "label", "expr" }` → the columns to display |

### Example `rtos-inspector.json`

```json
{
  "threads": {
    "mode": "linked_list",
    "root": "g_kernel.pools[0]->thread_list",
    "next": "next",
    "fields": [
      { "label": "ID",          "expr": "id" },
      { "label": "Name",        "expr": "name" },
      { "label": "State",       "expr": "state" },
      { "label": "Priority",    "expr": "prio" },
      { "label": "Stack Start", "expr": "stack_base" },
      { "label": "Stack Size",  "expr": "stack_size" }
    ]
  },
  "semaphores": {
    "mode": "linked_list",
    "root": "g_kernel.pools[0]->sem_list",
    "next": "next",
    "fields": [
      { "label": "ID",         "expr": "id" },
      { "label": "Count",      "expr": "count" },
      { "label": "Max",        "expr": "max_count" },
      { "label": "Waiting",    "expr": "waiting" },
      { "label": "Discipline", "expr": "discipline" }
    ]
  },
  "mutexes": {
    "mode": "linked_list",
    "root": "g_kernel.pools[0]->mutex_list",
    "next": "next",
    "fields": [
      { "label": "ID",      "expr": "id" },
      { "label": "Name",    "expr": "name" },
      { "label": "Owner",   "expr": "owner" },
      { "label": "Locked",  "expr": "locked" }
    ]
  }
}
```

An `array`-mode example:

```json
{
  "threads": {
    "mode": "array",
    "root": "g_threads",
    "count": "g_thread_count",
    "access": ".",
    "fields": [
      { "label": "ID",   "expr": "id" },
      { "label": "Name", "expr": "name" }
    ]
  }
}
```

> Add a section for **any** struct collection — a mutex list, a ready queue, a
> free-list, etc. — in either mode; each gets its own tab. Column labels and
> expressions are entirely up to you.

### Master–detail

Put `${selected}` in a section's `root` to make it a *detail* table that follows
the row you click in a master section. For example, a `processes` master with
`threads`/`mutexes` details:

```json
{
  "processes": { "mode": "linked_list", "root": "g_process_list", "next": "next",
    "fields": [ { "label": "PID", "expr": "pid" }, { "label": "Name", "expr": "name" } ] },
  "threads":   { "mode": "linked_list", "root": "${selected}->thread_list", "next": "next",
    "fields": [ { "label": "ID", "expr": "id" }, { "label": "State", "expr": "state" } ] }
}
```

Clicking a process row fills `threads` with that process's thread list.
`${selected}` may appear in `root`, `count`, `head`, or `nil` — e.g. an
`index_list` detail with `"head": "${selected}->free_head"`. (For grouping, the
same applies to `${master}`.)

A `void*` dynamic-array example (give the element type with `cast`):

```json
{
  "widgets": {
    "mode": "array",
    "root": "g_widgets.data",
    "count": "g_widgets.size",
    "cast": "widget_t *",
    "access": ".",
    "fields": [ { "label": "X", "expr": "x" }, { "label": "Label", "expr": "label" } ]
  }
}
```

Each element is read as `((widget_t *)(g_widgets.data))[i]`. Write the cast in
full (the `*` is yours, not auto-added), so it composes for any type.

An `index_list` example — a list inside an array, linked by a next-**index**
field (slots may be empty):

```json
{
  "pool": {
    "mode": "index_list",
    "root": "g_slot_pool",
    "head": "g_slot_head",
    "next": "next",
    "nil": "-1",
    "access": ".",
    "fields": [ { "label": "ID", "expr": "id" }, { "label": "Name", "expr": "name" } ]
  }
}
```

Starts at `head`, reads `root[idx]`, follows `next` until it equals `nil`;
empty slots are skipped. `cast`/`wrap`/`access` work as in `array` mode.

### Notes on `expr`

You don't declare types or sizes. Whatever `expr` evaluates to is formatted by
GDB according to its type: enums render as names (`RUNNING`, `FIFO`), pointers
as addresses, integers as numbers.

A section can set `wrap` to transform each **element** before its fields are read
(`${expr}` is the element). For an array of pointers behind a `void*`, use
`"wrap": "((widget_t *)${expr})"` with `"access": "->"` → each element is read as
`((widget_t *)(slots[i]))->field`. The wrap output is parenthesized before the
field access, so a deref wrap like `*(${expr})` composes correctly
(`(*(elem)).field`).

A value GDB cannot read (an inaccessible address, an error) or a NULL pointer
(`0x0`) is shown as a muted `-`. A plain integer `0` is shown as `0`.

## Extension settings

| Setting                | Default            | Description |
|------------------------|--------------------|-------------|
| `rtosInspector.configPath` | `rtos-inspector.json`   | Config file path: absolute, or relative to the workspace root. |
| `rtosInspector.logLevel`   | `info`             | Output channel verbosity: `off` / `info` / `debug`. |
| `rtosInspector.debugTypes` | `["cppdbg"]`       | Debug adapter types the tracker attaches to. |

## How it works

Debug Inspector registers a debug adapter tracker for the configured debug types and
listens for `stopped`/`continued` events. On stop, it grabs the top stack frame
and issues `-exec print …` commands through the debug adapter's `evaluate`
request, cleaning GDB's `$N =` / prompt noise from the output. Linked lists are
walked with a GDB convenience variable; arrays are indexed up to `count`.

## License

[MIT](LICENSE)
