# RTOS Inspector

**Visualize your own C/C++ data structures as live tables while debugging with GDB.**

When your GDB (`cppdbg`) session stops, RTOS Inspector walks the data structures
*you* describe — linked lists and arrays of structs such as thread control
blocks, semaphores, mutexes, ready/blocked queues, timers, free-lists, or any
node list — and renders them as clean, sortable tables in a tabbed panel.

What gets shown is driven entirely by a `rtos-inspector.json` file you write, so
the extension knows nothing about your types and works with any C/C++ codebase —
bare-metal, a hobby or commercial RTOS, or plain application code. Aimed at
embedded / RTOS developers, but handy for any structures you'd otherwise expand
by hand in the debugger.

## Features

- **Config-driven.** Point RTOS Inspector at any global expression; it does not
  assume any layout. No code changes to your program.
- **Two traversal modes.**
  - `linked_list` — start at a head pointer, follow a `next` field until NULL.
  - `array` — iterate `count` elements of an array.
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
  highlighted (with ▲/▼ for numeric deltas), a "N changed" badge shows the total,
  and tabs that changed in the background flag their count.
- **Pick & reorder columns.** Drag a column header to reorder (a blue line shows
  where it lands), or drag the rows in the "▦ Columns" menu; right-click a header
  or use the menu to show/hide. Order and visibility are saved per workspace.
  Hidden columns are **not** read from GDB at all — enabling one fetches its data
  on the spot.
- **Read-only & safe.** RTOS Inspector only *reads* globals — it never calls
  functions, so your program state is never disturbed.
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
3. Run **“RTOS Inspector: Open Panel”** from the Command Palette.
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
| `mode`   | `"linked_list"` or `"array"` |
| `root`   | Starting expression (any valid C expression) |
| `next`   | *(linked_list)* the field pointing to the next node |
| `count`  | *(array)* expression yielding the element count |
| `access` | *(array)* element field access: `"."` (default) or `"->"` (pointer array) |
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

### Notes on `expr`

You don't declare types or sizes. Whatever `expr` evaluates to is formatted by
GDB according to its type: enums render as names (`RUNNING`, `FIFO`), pointers
as addresses, integers as numbers.

## Extension settings

| Setting                | Default            | Description |
|------------------------|--------------------|-------------|
| `rtosInspector.configPath` | `rtos-inspector.json`   | Path to the config file, relative to the workspace root. |
| `rtosInspector.debugTypes` | `["cppdbg"]`       | Debug adapter types the tracker attaches to. |

## How it works

RTOS Inspector registers a debug adapter tracker for the configured debug types and
listens for `stopped`/`continued` events. On stop, it grabs the top stack frame
and issues `-exec print …` commands through the debug adapter's `evaluate`
request, cleaning GDB's `$N =` / prompt noise from the output. Linked lists are
walked with a GDB convenience variable; arrays are indexed up to `count`.

## License

[MIT](LICENSE)
