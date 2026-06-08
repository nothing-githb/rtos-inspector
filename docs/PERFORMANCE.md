# Debug Inspector — Performance Study (large environment, real measurements)

This document reports **real, measured** results for the GDB data‑fetch path of the
Debug Inspector extension on a deliberately **large** synthetic environment, plus a
ranked catalog of what can be done to speed it up. Numbers are reproducible (see
[Reproduction](#reproduction)).

> **One‑line takeaway:** the cost is dominated by the **number of GDB round‑trips**,
> not by GDB's compute. Today the extension issues **one `print` per field per row**
> (`rows × fields` serialized round‑trips). Fetching **one whole element** (`print *elem`)
> or **one whole array** (`print arr[0]@count`) per call collapses that to `rows` or
> `~1` calls — **5–10× faster in raw GDB time, and far more over the live debug
> adapter** — while client‑side parsing of the bigger blob costs ~2 ms.

---

## Environment

| | |
|---|---|
| OS | Windows 10 Enterprise (x64) |
| GDB | GNU gdb (Cygwin 15.2‑1) 15.2 |
| Cygwin | 3.6.9 |
| Node (bench driver) | v24.16.0 |
| Test program | `big.c` — `node_t { int id,a,b,c,d,e,f,g,h,k; void *p; struct node *next; }` |
| Size | **N = 2000 rows**, **10 scalar fields** each; also a **2000‑node linked list** via `->next` |
| Build | `gcc -g -O0` |

The struct has 10 scalar fields + a `void*` + a `next` pointer — representative of an
RTOS TCB / object table. Values vary per row (`id=i`, `a=2i+1`, …) so GDB never
collapses output with `<repeats>`.

---

## What dominates the cost

`collectSection()` issues, per call, one
`session.customRequest('evaluate', { expression: '-exec print <expr>', context:'repl' })`
and parses the `$N = VALUE` console text. Per section:

| mode | GDB calls per refresh |
|---|---|
| `array` | `1` (count) `+ rows × (fields + barFields)` |
| `index_list` | `1` (head) `+ rows × (fields + barFields + 1 next)` |
| `linked_list` | `1` (set cursor) `+ rows × (1 null‑check + fields + barFields + 1 advance)` |
| `grouped` | the above **× master‑row count** (+1 label/group) |

Every call is a full **VS Code ⇄ cppdbg adapter ⇄ GDB** request/response. Latency
scales with **round‑trip count**, so the lever is *fetch more per call*.

---

## Benchmark methodology

Two complementary measurements, each isolating a different layer:

1. **GDB‑intrinsic (batch).** Run identical `print` commands from a `gdb --batch -x`
   script; time the whole run with a high‑resolution clock; **subtract a baseline**
   (reach the breakpoint, no prints) to isolate the print cost. 5 trials, report the
   **minimum**. Output discarded (`/dev/null`) to measure command processing, not
   terminal I/O. This is a **lower bound** — a batch script lets GDB read all commands
   at once, so it *understates* the per‑call serialization the extension pays.

2. **Serialized round‑trip (GDB/MI).** Drive one GDB process in `--interpreter=mi2`
   and send commands **one at a time, awaiting each `^done` before the next** — the
   same serialized request/response the extension's `await gdbExec(...)` imposes.
   This excludes the VS Code⇄adapter IPC, so it is still **below** the real cost, but
   above the batch number.

Both run on the **same stopped state** at `inspect_point`.

---

## Results

### A. Fetch strategy — GDB‑intrinsic (batch, min of 5, baseline = 1204 ms subtracted)

| strategy | GDB calls | print‑cost | µs / call | speedup vs per‑field |
|---|--:|--:|--:|--:|
| **array, per field** `print g_big[i].x` | 20,000 | **2596 ms** | 130 | 1.0× (baseline) |
| **array, per element** `print g_big[i]` | 2,000 | **508 ms** | 254 | **5.1×** |
| **array, whole** `print g_big` | 1 | **244 ms** | — | **10.6×** |
| **list, per field** (cursor + 10 fields + advance) | 24,001 | **2392 ms** | 100 | 1.0× (baseline) |
| **list, per element** `print *cursor` + advance | 4,001 | **636 ms** | 159 | **3.8×** |

- **Per‑element** (`print *elem` → all 10 fields in one call) is **5.1× faster**
  (array) / **3.8× faster** (list) than per‑field, in raw GDB time alone.
- **Whole‑array** (`print g_big`) is **10.6× faster** and is a **single** call — over
  the live adapter (where each call also crosses IPC) this is the difference between
  ~20,000 round‑trips and **1**.

### B. Serialized round‑trip latency (GDB/MI, one‑at‑a‑time)

| call shape | latency / call |
|---|--:|
| 1 scalar field (`g_big[i].id`) | **0.17 ms** |
| whole element (`g_big[i]`, 10 fields) | **0.30 ms** |

So one `print *elem` (0.30 ms, 10 fields) replaces ten `print field` (10 × 0.17 =
1.7 ms) — **~5.7× cheaper per row**, matching the batch result. Modeled over the big
environment (2000 rows × 10 fields):

| | calls | modeled time |
|---|--:|--:|
| per field | 20,000 | **~3450 ms** |
| per element | 2,000 | **~597 ms** |

*(The MI whole‑array figure is intentionally omitted — the MI driver didn't raise
`max-value-size`, so that single measurement errored; the corrected whole‑array cost
is the batch 244 ms in §A. See §C.)*

### C. Whole‑array: blob size, parse cost, and the `max-value-size` gotcha

Fetching the whole array returns **one big string** that must be parsed client‑side:

| metric | value |
|---|--:|
| `print g_big` output size | **340,581 bytes** (2000 elements) |
| client‑side parse (brace tokenizer, Node) | **2.03 ms** |

Parsing 340 KB takes ~2 ms — **negligible** next to the thousands of round‑trips it
replaces.

> ⚠ **Gotcha (real finding):** by default `print g_big` **fails** with
> `value requires 112000 bytes, which is more than max-value-size`. GDB caps a single
> value at 64 KB. The whole‑array strategy therefore **requires**
> `set max-value-size unlimited` (and `set print elements unlimited`,
> `set print repeats unlimited` so it isn't truncated/run‑length‑collapsed). Very
> large arrays should be fetched in **chunks** (`print arr[k]@chunk`).

### Call‑count model (the transport‑independent headline)

For a section of **R** rows × **F** fields:

| approach | calls | applies to |
|---|---|---|
| current (per field) | `R × F` (+overhead) | all modes |
| per element (`print *elem`) | `R` (list: `+R` advance unless made stateless) | all modes |
| whole array (`print base[0]@count`) | **`~1`** | `array`, contiguous `index_list` |

Because adapter latency is ~linear in call count, the **call‑count ratio is the
honest speedup ceiling**: `R×F → R → ~1`.

### Real‑world amplification (DAP / cppdbg)

The measured numbers are **lower bounds**. In the live extension each `print` is a
`customRequest('evaluate', context:'repl')` that (a) crosses VS Code⇄adapter IPC and
(b) is routed by MIEngine through an **exclusive `CommandLock`** — so calls
**serialize inside the adapter regardless** (this is why naively `Promise.all`‑ing the
current `-exec` calls buys ~nothing). Net: real per‑call overhead **> MI (0.17 ms) >
batch‑intrinsic (0.13 ms)**, so reducing the **count** of calls is even more impactful
in production than the raw‑GDB table shows.

---

## Optimization catalog (ranked by impact ÷ effort)

> Researched and cross‑checked across four independent streams (GDB MI, DAP/cppdbg,
> algorithmic, parsing) and reconciled against the source.

### Quick wins (low effort, low risk — do first)

1. **Debounce `stopped` events + stop‑generation token.** ✅ **Implemented in
   0.30.0.** The stop / config‑watch / manual / edit paths now route through a
   ~140 ms‑debounced `doRefresh()` with an in‑flight guard + a `refreshGen`
   counter: rapid bursts collapse to one, refreshes never overlap, and a newer
   request aborts the older one between sections so only the latest completes.
   **Multiplicative across all modes; zero feature risk.**
2. **Make the linked‑list walk stateless.** Drop the per‑node `set $cursor` (advance) +
   `print $cursor` (null‑check) — read the node and its `next`/NULL from the *same*
   result and chase the parsed pointer. Removes **~2 round‑trips per node** (~3× fewer
   calls on lists). Keep `isNull()`/cycle‑guard semantics.
3. **Cache `frameId` per stop** instead of a `stackTrace` round‑trip every refresh.
4. **Gate `gdbExec`'s `.replace(/\s+/g,' ')`** behind the log level (it runs on every
   value even when logging is off). Pure CPU win on large tables.

### Structural (bigger, highest ceiling — pick the batching primary per mode)

5. **Per‑element / whole‑array batch fetch** (this study's headline). For `array` /
   contiguous `index_list`: `print ((cast)root)[0]@count` → **~1 call/section**. For
   `linked_list` / non‑contiguous: `print *elem` → **1 call/row**. Then parse the
   `{field = val, …}` blob client‑side (≈2 ms for 340 KB). **Measured 5–10×** in raw
   GDB; far more over the adapter. Prereqs: `set max-value-size/print elements/print
   repeats unlimited` (one‑time per refresh; **do *not* `set print address off`** —
   `isNull()` needs the `0x0` text). Keep the per‑field path as an **always‑on
   fallback** for `${expr}`/`${wrapped_expr}` arithmetic, `cast`/`wrap`, and `bar.max`
   (these have no single child to read from a blob).
6. **`variablesReference` + `variables` request.** Evaluate the element to a handle,
   then one `variables` request returns **all declared fields structured** (no string
   parsing). Robust where it works on cppdbg; same fallback caveat as #5. Choose #5
   **or** #6 as the array primary — not both — to avoid maintaining two parsers.
7. **Lazy per‑tab fetch.** Build only the **active** section on stop (+ its grouping
   masters); fetch others on tab‑switch with a per‑stop cache. ~`1/N` calls per stop
   for N‑tab dashboards.
8. **Concurrency‑limited reads** — *only* on a shared‑lock path (after #5/#6 move reads
   off `-exec`); pointless on the current exclusive‑lock `-exec` channel.

### Avoid (won't help and/or breaks features)

- ❌ `Promise.all` over the **current** `-exec` calls — they serialize in the adapter.
- ❌ `set print address off` — breaks `isNull()` NULL detection.
- ❌ Replacing the per‑field path **entirely** with batch parsing — `${expr}` arithmetic,
  `cast`/`wrap`, and `bar.max` must keep their own evaluate.
- ❌ Diff/skip that **reuses cached field values** when root+count are unchanged —
  structures mutate in place ⇒ stale data (unacceptable for a debug inspector).
- ❌ Raw memory read + client‑side struct decode, and MI `-var-*`/`-stack-list-*` — high
  brittleness and/or need an MI transport the extension doesn't have.

---

## Recommended roadmap

1. **Now (safe, big):** debounce + stop‑generation (#1), stateless list walk (#2),
   frameId cache (#3), log‑gate the regex (#4). Independent of parsing.
2. **Next (highest ceiling):** per‑element / whole‑array batching (#5) with one‑time
   compacting print settings and an always‑on per‑field fallback — validated on real
   configs (cast/wrap/computed columns) and gated so a parse error falls back.
3. **For many‑tab dashboards:** lazy per‑tab fetch (#7).

---

## Reproduction

Harness lives under `.tools/perf/` (local, not committed — it hard‑codes this
machine's toolchain paths). To reproduce anywhere:

1. **Program** — `big.c`: an array `g_big[2000]` of a 10‑scalar‑field struct (+`void*`,
   `+next`), linked head‑to‑tail; a `void inspect_point(void)` breakpoint target;
   varying field values. Build `gcc -g -O0 -o big.exe big.c`.
2. **Strategy command files** (one `.gdb` each), all prefixed with
   `set pagination off / confirm off / print pretty off / print elements unlimited /
   print repeats unlimited / max-value-size unlimited`, then `break inspect_point`,
   `run`:
   - *baseline*: `print 1`
   - *array per‑field*: `print g_big[i].<field>` for every i, field (20,000 lines)
   - *array per‑element*: `print g_big[i]` for every i (2,000)
   - *array whole*: `print g_big` (1)
   - *list per‑field*: `set $c=g_list` then per node `print $c` + 10× `print $c-><f>` +
     `set $c=$c->next`
   - *list per‑element*: `set $c=g_list` then per node `print *$c` + `set $c=$c->next`
3. **Time** each: `gdb --batch -nx -x FILE big.exe >/dev/null 2>&1`, 5 trials, take the
   minimum, subtract the baseline minimum.
4. **Serialized latency**: drive `gdb --interpreter=mi2` over a pipe, sending
   `-data-evaluate-expression` one at a time and awaiting each `^done`; divide total by
   call count.
5. **Parse cost**: capture `print g_big` to a file and time a brace/quote‑aware
   tokenizer over it.

All figures above are the **minimum of 5 trials** on the environment in the table.
