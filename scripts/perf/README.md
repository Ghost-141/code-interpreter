# Sandbox runner per-call overhead bench

Client-side latency of `POST /api/v2/execute` on a local NsJail-mode runner (no microVM)
against the real file server, MinIO and Redis, all on the `runnerbench` Docker network.

## Prerequisites
- Docker (tested on macOS, OrbStack engine, 4 CPUs), `curl`, `python3`, `rsync`, `patch`.
- The xlsx skill at `../skill/xlsx`, a sibling of this repo (override with `SKILL_DIR=`).
- The first build takes about 5–10 min (it compiles NsJail). `Dockerfile.slim` is `api/Dockerfile`
  (`sandbox-build`) without LibreOffice, fonts or tesseract. Bash jobs only need `/usr`.

## Reproduce table rows b/c/d
```sh
cd scripts/perf
./setup.sh                  # network, MinIO/Redis/file server, 65 fixtures, runnerbench:base
./start-runner.sh           # runner on localhost:2000 (IMG=, LOG=INFO, CGV2=true, extra -e ...)
for ms in 0 5 10; do
  ./latency.sh $ms          # netem delay on MinIO = storage round trip seen by the file server
  SCEN=b,c,d REPS=12 TAG=base_${ms}ms ./bench.sh
done
./latency.sh 0
./teardown.sh               # removes containers and network, keeps images
```
Scenarios (`bench/bench.ts`): a `true` 0 files; b `true` 65 files; c/d 65 files at 3/8
concurrent; e/f 0 files at 3/8 concurrent. `bench.sh` prints the median and p90 and appends every sample to `bench/client.jsonl`.

Expected medians: b about 80 / 740 / 1260 ms at 0 / 5 / 10 ms; c and d grow with concurrency
only if storage or the file server is capacity-bound (try `docker update --cpus 0.1 rb-minio`).

## Phase timings
`phases.patch` adds one `PHASES` log line per job: prime (`dirkeep_list`, `download_files`),
NsJail setup gate (`gate_wait`, `spawn_to_marker`), run, output walk, upload, cleanup.
```sh
./build-runner.sh prof                       # repo + patch, built in a temp copy (repo untouched)
IMG=runnerbench:prof ./start-runner.sh
SCEN=b REPS=12 TAG=prof ./bench.sh
python3 analyze.py "$PWD" prof               # joins client samples with PHASES (medians/p90)
```
The patch applies to a clean tree (`git apply --check scripts/perf/phases.patch`). Regenerate it
if `api/src` drifts.

## A/B test a fix
```sh
SRC=/path/to/fixed/checkout TAG=runnerbench:fix ./build-runner.sh base   # or: prof
IMG=runnerbench:base ./start-runner.sh && SCEN=b,c,d REPS=12 TAG=A ./bench.sh
IMG=runnerbench:fix  ./start-runner.sh && SCEN=b,c,d REPS=12 TAG=B ./bench.sh
```
Keep the same `latency.sh` value for both runs. File-server fixes: rebuild `stagebench-file-server`
(`docker build -f service/Dockerfile --target production -t stagebench-file-server .`), then rerun
`./setup.sh`.

## Differences from prod
- No libkrun microVM; runner is a `--privileged` container.
- Hardened mode and the egress manifest are off (`CODEAPI_HARDENED_SANDBOX_MODE=false`,
  `SANDBOX_REQUIRE_EGRESS_MANIFEST=false`). Files go directly to the file server, so the egress
  gateway hop is not measured.
- `pkgs/` holds bash plus stub python/node/bun runtimes, so bash jobs get the same pkg-dir mounts
  as prod.
- A run's `wall_time` includes the NsJail setup-gate wait and the spawn.
