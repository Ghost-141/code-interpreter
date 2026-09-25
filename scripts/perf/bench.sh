#!/bin/bash
# usage: SCEN=a,b REPS=12 TAG=x ./bench.sh
R=$(cd "$(dirname "$0")" && pwd)
docker run --rm --network runnerbench -e SCEN -e REPS -e TAG -v $R/bench:/bench -w /app stagebench-file-server bun run /bench/bench.ts
