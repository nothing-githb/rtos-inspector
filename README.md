# RTOS Inspector

**Visualize your own C/C++ data structures as live tables while debugging with GDB.**

RTOS Inspector turns the in-memory data structures of *your* program — linked
lists and arrays of structs such as thread control blocks, semaphores, mutexes,
ready/blocked queues, timers, memory free-lists, or any node list — into clean,
sortable tables in a VS Code panel, refreshed every time the debugger stops.

You describe what to walk in a small JSON file (`rtos-inspector.json`); the
extension knows nothing about your types, so it works with any C/C++ codebase —
bare-metal, a hobby or commercial RTOS, or plain application code. It is aimed at
embedded / RTOS developers but useful for any structures you'd otherwise expand
by hand in the debugger.

> Repository: https://github.com/nothing-githb/rtos-inspector

## Typical uses

- Inspect an RTOS scheduler's **thread / TCB** list, **semaphore** / **mutex**
  tables, or ready / blocked queues.
- Walk any **linked list** or **array of structs** in plain C/C++ code.
- **Drill from a parent into its children** — click a process to see its own
  threads / semaphores / mutexes.
- Watch values **change between stops** — state transitions, counters, refcounts.

## Features

- **Config-driven & generic.** Point it at any global expression; no assumptions
  about your layout and no changes to your program.
- **One tab per structure.** Add as many named sections as you have data
  structures — each becomes its own table, with tabs generated dynamically.
- **Master–detail.** Give a section's `root` a `${selected}` placeholder and it
  becomes a detail table; click a row in a master section (e.g. a process) to
  populate it with *that* element's lists (its threads / semaphores / mutexes).
- **Two traversal modes:** `linked_list` (head pointer + `next` field) and
  `array` (`count` elements, with `.` / `->` element access).
- **Arbitrary root expressions** — anything valid in GDB, e.g.
  `g_kernel.pools[0]->thread_list`.
- **Live updates** on every stop, with a "running…" badge while the program runs.
- **Sortable columns** (numeric/hex sort numerically, text alphabetically).
- **Change highlighting** — values that changed since the previous stop are
  flagged, with the previous value shown faded (struck-through) next to the new
  one, plus an "N changed" badge.
- **Pick & reorder columns** — drag a header (with a drop indicator) or drag the
  rows in the "▦ Columns" menu to reorder; right-click a header / use the menu to
  show-hide. Saved per workspace. **Hidden columns are not read from GDB at
  all**; enabling one fetches its data on the spot.
- **Refresh on demand or on change** — a Refresh button re-reads the config, and
  the panel auto-refreshes when `rtos-inspector.json` changes on disk.
- **Pause when you don't need it** — a Pause/Resume toggle stops the
  auto-refresh-on-stop (and GDB queries); Refresh still works on demand. The
  choice is remembered per workspace.
- **Read-only & safe** — only *reads* globals; never calls functions, so program
  state is never disturbed.
- **Leveled logs** — an *RTOS Inspector* Output channel logs at
  trace/debug/info/warn/error; at `trace` every GDB query and result is shown.

## Requirements

- The [C/C++ extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)
  (`ms-vscode.cpptools`) and a working GDB debug configuration (`type: cppdbg`).
- GDB available on your system.

## Install

- **From a packaged build:** `code --install-extension dist/rtos-inspector-<version>.vsix`
  (or in VS Code: Extensions → ⋯ → *Install from VSIX…*).
- **From the Marketplace:** search for the extension once it is published.

## Quick start

1. Debug your C/C++ program with `cppdbg` (GDB).
2. Put a `rtos-inspector.json` at your workspace root (see the schema below).
3. Run **“RTOS Inspector: Open Panel”** from the Command Palette.
4. When you hit a breakpoint the panel fills in; on `continue` it shows
   "running…" and refreshes again on the next stop.

## Configuration

Add **one section per data structure** — each becomes its own dynamically
generated, sortable table / tab, and you can add **as many as you like**. The
section's JSON key is its tab label (`threads`, `semaphores`, `mutexes`,
`queues`, … — any name). Each section uses the same fields:

| Field    | Meaning |
|----------|---------|
| `mode`   | `"linked_list"` or `"array"` |
| `root`   | Starting expression (any valid C expression) |
| `next`   | *(linked_list)* the field pointing to the next node |
| `count`  | *(array)* expression yielding the element count |
| `access` | *(array)* element field access: `"."` (default) or `"->"` |
| `cast`   | *(array)* element type for a generic `void*` buffer → `((cast *)(root))[i]` |
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

> The same mechanism fits any struct collection — point a section at a mutex
> list, a ready queue, or a memory free-list (`linked_list` or `array` mode) and
> label the columns with any GDB expressions.

### Master–detail (linked sections)

To drill from a parent into its children, put a `${selected}` placeholder in a
section's `root`. That section becomes a *detail* table; clicking a row in a
master section resolves `${selected}` to the clicked element and re-fetches the
details. For a process list whose processes each own their own sub-lists:

```json
{
  "processes": {
    "mode": "linked_list", "root": "g_process_list", "next": "next",
    "fields": [ { "label": "PID", "expr": "pid" }, { "label": "Name", "expr": "name" } ]
  },
  "threads": {
    "mode": "linked_list", "root": "${selected}->thread_list", "next": "next",
    "fields": [ { "label": "ID", "expr": "id" }, { "label": "State", "expr": "state" } ]
  },
  "mutexes": {
    "mode": "linked_list", "root": "${selected}->mutex_list", "next": "next",
    "fields": [ { "label": "ID", "expr": "id" }, { "label": "Owner", "expr": "owner" } ]
  }
}
```

Click a process row and the `threads` and `mutexes` tables show *that* process's
lists. The first master row is selected automatically. Array detail sections may
also use `${selected}` in `count` (e.g. `"count": "${selected}->n"`).

### Generic `void*` arrays

If a container stores its elements behind a `void *` buffer (a dynamic array),
give the element type with `cast` so the buffer can be indexed:

```json
{
  "widgets": {
    "mode": "array",
    "root": "g_widgets.data",
    "count": "g_widgets.size",
    "cast": "widget_t",
    "access": ".",
    "fields": [ { "label": "X", "expr": "x" }, { "label": "Label", "expr": "label" } ]
  }
}
```

This reads each element as `((widget_t *)(g_widgets.data))[i]`. `count` is any
expression for the element count (e.g. `used / sizeof(T)`); the row count shown
in the summary is that size. For a buffer of *pointers*, set `cast` to the
pointer type and `access` to `"->"`.

### Settings

| Setting                | Default          | Description |
|------------------------|------------------|-------------|
| `rtosInspector.configPath` | `rtos-inspector.json` | Config file path, relative to the workspace root. |
| `rtosInspector.debugTypes` | `["cppdbg"]`     | Debug adapter types the tracker attaches to. |

## How it works

RTOS Inspector registers a debug adapter tracker for the configured debug types and
listens for `stopped`/`continued` events. On stop it grabs the top stack frame
and issues `-exec print …` commands through the debug adapter's `evaluate`
request, cleaning GDB's `$N =` / prompt noise from the output. Linked lists are
walked with a GDB convenience variable; arrays are indexed up to `count`. Only
the currently visible columns are fetched.

## Project layout

```
extension/        the extension source (compiled & packaged)
  src/extension.ts
test-workspace/   a small C example + .vscode templates for trying it
dist/             packaged .vsix builds
```

## Build from source

```bash
cd extension
npm install
npm run compile          # tsc -> out/extension.js
npx @vscode/vsce package # produces a .vsix
```

For live development, open `extension/` in VS Code and press **F5** to launch an
Extension Development Host.

## Try the example

Open `test-workspace/` as a folder. It contains `threads_demo.c` — a tiny demo
with **two processes**, each owning its own thread / semaphore / mutex lists,
plus an independent timer array. The matching `rtos-inspector.json` wires this as
**master–detail**: a `processes` tab plus `threads`/`semaphores`/`mutexes` detail
tabs (via `${selected}`) and a standalone `timers` array tab — click a process
row to drill into its lists. The `.vscode/{launch,tasks}.example.json` templates
(copy to `launch.json`/`tasks.json` and set your toolchain path) include Cygwin
GDB tips in comments.

## Troubleshooting

Open **View → Output → "RTOS Inspector"** (or run **"RTOS Inspector: Show Log"**)
to see what the extension is doing. Raise the level with the gear icon or
**"Developer: Set Log Level…"**: `debug` shows per-section row counts, the chosen
columns and the resolved `${selected}` expression; `trace` logs every GDB command
and its result — handy when a column is empty or a `root` doesn't resolve.

## License

[MIT](extension/LICENSE)
