# Sandbox Speed Plan

Why Office Assistant edits feel slow on the sandbox side, and the order in which
we fix it. Findings are from 2026-09-22: production logs read on Synapse-Sandbox
(nothing changed there) and local benchmarks of the real runner and file server.

- Measure before and after every step → [Measuring](#measuring)
- The steps → [Round 1: config](#round-1-config-only) ·
  [Round 2: caching](#round-2-caching) · [Later rounds](#later-rounds)

---

## What the time is

A reply from the Office Assistant is 7–18 steps. Each step is a model turn
(3.5–5 s) plus one sandbox call. Model time is about two thirds of the total and
is out of scope here; this plan is about the sandbox third.

Production baseline (`scripts/perf/overhead.py`, 49 calls):

| | median | p90 |
|---|---|---|
| Code wall time (includes NsJail spawn) | 0.26 s | 4.4 s |
| **Overhead, lone call** | **1.8 s** | 2.8 s |
| **Overhead, 3 calls started together** | **3.2 s** | 3.7 s |

The overhead is round trips to object storage before the code runs, most of
them in series. Every trip goes runner → egress gateway → file server → MinIO.

| Phase, lone call with 65 files | local | +10 ms per storage trip |
|---|---|---|
| `.dirkeep` listing: one `statObject` per object, serially (`service/src/file-server.ts:661-671`, called from `api/src/job.ts:972`) | 27 ms | **845 ms** |
| Input downloads: 3 storage calls per file, 8 files at a time (`file-server.ts:486-541`, `job.ts:1011-1022`) | 37 ms | **390 ms** |
| NsJail spawn, setup gate, workspace, output walk, cleanup | ~20 ms | ~25 ms |

Under concurrency the time grows only when storage is capacity-bound, which is
what production shows (1.8 s → 3.2 s).

Ruled out by measurement: file bytes (65 files in ~50 ms), `DEBUG` logging
(4%), per-job UIDs (no effect), LibreOffice profile reuse (~50 ms), NsJail
spawn (12 ms).

Most of those trips fetch **skill files**: ~60–70 read-only files per call,
identical on every call until the skill is edited. Every edit bumps the skill
version and LibreChat re-uploads its files under new ids, so an id never points
at changed content. That makes them safe to cache by id.

---

## Measuring

Run the same measurement before and after each round.

**Production (read-only):**

```bash
docker logs --since 6h api            > api.log 2>&1
docker logs --since 6h service-worker > worker.log 2>&1
python3 scripts/perf/overhead.py api.log worker.log
```

Compare `overhead, lone` and `overhead, N started together`. Take windows with
similar traffic, at least 30 calls each.

**Local A/B:** `scripts/perf/README.md` builds the real runner and file server in
Docker, adds storage latency with `tc netem`, and times scenarios b (lone),
c (3 concurrent) and d (8 concurrent). Run it on `main` and on the change.

**By hand:** the same prompt and document three times ("change the title, add a
two-column table, render it") and time each reply. This is what users feel.

**Before any deploy**, tag the running images so rollback is one command:

```bash
for i in sandbox-runner api service-worker file_server; do
  docker tag code-interpreter-$i code-interpreter-$i:pre-perf
done
```

---

## Round 1: config only

No rebuild. Restart the affected containers.

| # | Change | Where | Why | Expected |
|---|---|---|---|---|
| 1.1 | `OTHER_CONCURRENCY=6`, `PYTHON_CONCURRENCY=2` | `.env` → restart `service-worker`, `api` | Office jobs are `bash` and run on the *other* queue, which has 4 slots. Keep the total at `SANDBOX_MAX_CONCURRENT_JOBS=8` | Less queueing when several users edit at once. No change for a lone call |
| 1.2 | `SANDBOX_UPLOAD_CONCURRENCY=16`, and add it to the `sandbox-runner` environment in `docker-compose.yaml` | `.env`, compose | The launcher already forwards it into the VM. Compose does not pass it yet | Small; only calls that write files |
| 1.3 | `SANDBOX_LOG_LEVEL=INFO` | `.env` | Optional: less noise, not speed | ~0 |

> **Do not change `LAUNCHER_VCPUS` on the live runner.** On 2026-09-22,
> `LAUNCHER_VCPUS=6` booted the microVM (`Booting microVM: vcpus=6`) but the
> guest never started: no entrypoint output, ~110% CPU, health stuck at
> `starting` for 4+ minutes, and code execution was down until it was reverted
> to 4. The cause is unknown. The launcher passes the value to
> `krun_set_vm_config` unchecked (`launcher/src/main.rs:555`). Test any new
> vCPU count on a spare runner container before it goes live.

**What Round 1 cannot do.** `SANDBOX_PRIME_CONCURRENCY` and
`SANDBOX_INPUT_CACHE_*` look like config, but the launcher passes only an
allowlist of variables into the microVM (`launcher/src/main.rs:407`) and they
are not on it. Set in `.env`, they are silently ignored. They move to Round 2.

**Pass:** the concurrent-call overhead drops; the lone-call number stays about
the same.

---

## Round 2: caching

One runner image and one file-server image. Every new behaviour sits behind a
flag that defaults to off, so rollback is an env change.

### 2.1 Let the settings reach the VM — implemented

- `SANDBOX_PRIME_CONCURRENCY`, `SANDBOX_PULL_THROUGH_CACHE`,
  `SANDBOX_INPUT_CACHE_DIR`, `SANDBOX_INPUT_CACHE_MAX_BYTES` and
  `SANDBOX_MARKER_CACHE_TTL_SECONDS` are now in `ALLOW_EXACT`
  (`launcher/src/main.rs`), and the guest-env test asserts they pass through.
- `docker-compose.yaml` forwards all of them (plus
  `SANDBOX_UPLOAD_CONCURRENCY`) to `sandbox-runner`; `.env.example` documents
  them.
- Operators then set `SANDBOX_PRIME_CONCURRENCY=32`.
- Expected: ~0.2–0.3 s per call before any caching.

### 2.2 Pull-through skill cache on the runner — implemented

The runner already reads a local input cache before downloading
(`fetchInputObject`, `api/src/job.ts`; `openCachedInput`,
`api/src/session-inputs.ts`). Only the Lambda backend filled it, so here it was
always empty.

- **Change.** After a `read_only` input is downloaded, its bytes are copied
  into that cache under the same key (`storeCachedInputFile` in
  `api/src/session-inputs.ts`, called from `Job.populateInputCache`). Later
  executions resolve the ref locally; priming, naming, hashing and read-only
  protection are untouched, because a hit is presented as the same `Response` a
  fetch would have produced.
- **Scope.** Read-only objects only, so a file the user can edit is never
  served from cache. A skill edit re-uploads under new ids, so a hit cannot be
  stale.
- **Not awaited.** The copy runs after the job's own priming, and a failure is
  just a miss.
- **Flag.** `SANDBOX_PULL_THROUGH_CACHE=true`. Size:
  `SANDBOX_INPUT_CACHE_MAX_BYTES` (512 MB default; all five skills are ~4.5 MB).
  Eviction stays LRU via `pruneInputCache`.
- **Tests.** `api/src/session-inputs.pullthrough.test.ts`: store/commit, no
  rewrite of an existing entry, oversize refusal, no staging left behind,
  download-once-then-serve-locally, writable files fetched every time, flag off
  = no caching, and a new skill version missing because its ids changed.

### 2.3 Cache the `.dirkeep` listing for skill sessions — implemented

- **Change.** `fetchSessionMarkers` (`api/src/job.ts`) keeps each session's
  listing in a per-process map. It is reused only for sessions this runner has
  seen serve read-only objects exclusively (`noteObjectReadOnly`, fed by the
  download path); a user session gains objects between turns and is always
  listed fresh.
- **Flag.** `SANDBOX_MARKER_CACHE_TTL_SECONDS=600` (0 = off).
- **Tests.** In the same file: a read-only session is listed once, a session
  holding a writable object is listed every time, an expired entry is listed
  again, and TTL 0 disables reuse.

### 2.4 Parallel stat in the file server listing — implemented

- **Change.** `GET /sessions/:id/objects` collects the listing first, then
  resolves the per-object detail 16 at a time through
  `mapWithConcurrency` (`service/src/concurrency.ts`), preserving order.
  Previously `normalized` awaited one `statObject` per object inside the loop.
- **Tests.** `service/src/concurrency.test.ts`: input order preserved, the
  limit is never exceeded, every item visited once, empty input, a
  non-positive limit does not stall, and worker failures propagate.

### Round 2 measured, locally

`scripts/perf` A/B at a 10 ms storage delay, 65 files (62 read-only skill + 3
user), REPS=12, medians. **A** = HEAD images, **B** = this change with both
flags on, **C** = this change with flags off, **C2** = changed runner (flags
off) with the HEAD file server.

| scenario | A | B | C | C2 |
|---|---|---|---|---|
| lone call | 1278 ms | **139 ms** | 494 ms | 1263 ms |
| 3 concurrent | 1294 ms | **148 ms** | 470 ms | 1229 ms |
| 8 concurrent | 1334 ms | **212 ms** | 509 ms | 1264 ms |

- **File-server downloads per call:** 65 for A, C and C2; for B, 65 on the
  first call and **3** after it — only the user's own files.
- **Cold call in B** (fresh runner) is 527 ms, then ~139 ms.
- **Attribution:** batching the listing accounts for about -784 ms (A→C) and
  the runner caches for a further -355 ms (C→B). C2 confirms the runner change
  alone is inert with the flags off.
- **Correctness:** `/mnt/data` holds the same 66 files in A and B, and the
  md5 of the sorted per-file hashes matches.

Caveat: 2.4 is not flag-gated, so C is not a pure no-op against A — hence C2.
Local Docker has no microVM and no egress gateway, and production's ~50 ms per
file is modelled here as 10 ms, so the absolute saving in production should be
larger, not smaller.

### Round 2 targets

| | now | target |
|---|---|---|
| Overhead, lone call | 1.8 s | ≤ 0.6 s |
| Overhead, 3 started together | 3.2 s | ≤ 1.2 s |
| An 18-step reply, sandbox share | ~30–60 s | ~10–15 s |

Ship 2.4 first (file server only), then 2.1–2.3 together (runner). Measure after
each.

**Rollback.**
- 2.2 / 2.3: set `SANDBOX_PULL_THROUGH_CACHE=false` and
  `SANDBOX_MARKER_CACHE_TTL_SECONDS=0`, then restart.
- 2.4: go back to the `:pre-perf` file-server image.

---

## Later rounds

Only after Round 2 has been measured. They need an image rebuild, and most also
need a code change.

| Change | Where | Measured gain |
|---|---|---|
| Precompile Python bytecode: `--compile-bytecode` on the uv install | `docker/package-init.sh:183` | Imports 2–3× faster when not precompiled (pandas 0.6 → 0.18 s). The build's import check already precompiles the document libraries, so the gain is mainly matplotlib, numpy and lazily loaded modules |
| Mount `/var/cache/fontconfig` read-only in the jail | `api/config/sandbox.cfg` | ~90 ms per LibreOffice / ImageMagick / matplotlib start |
| Drop the prefix `listObjects` before each download, since the key is known from the id and extension | `service/src/file-server.ts:486` | 1 of 3 trips per file |
| Find the capacity limit under concurrency (egress gateway, file server, MinIO) with phase timings in production | runner logs, `scripts/perf/phases.patch` | Decides whether to scale the file path out |
| Fewer steps per reply: one script per edit-and-check, render once at the end | Office skill instructions | The largest lever overall; it cuts model time too |

Not planned: building skills into the image or shipping them as one archive
(2.2 gives the same speed and keeps skill updates automatic), log-level changes,
LibreOffice profile reuse.
