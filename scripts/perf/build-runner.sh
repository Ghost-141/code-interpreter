#!/bin/bash
# Build a runner image from a code-interpreter checkout (default: this repo).
#   ./build-runner.sh base             -> runnerbench:base  (repo as-is)
#   ./build-runner.sh prof             -> runnerbench:prof  (repo + phases.patch, built in a temp copy)
#   SRC=/path/to/other/checkout TAG=runnerbench:fix ./build-runner.sh [base|prof]
set -euo pipefail
P=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "${SRC:-$P/../..}" && pwd)
MODE=${1:-base}
TAG=${TAG:-runnerbench:$MODE}
CTX=$SRC
if [ "$MODE" = prof ]; then
  CTX=$(mktemp -d)
  trap 'rm -rf "$CTX"' EXIT
  rsync -a --exclude node_modules --exclude dist --exclude .build "$SRC/api" "$SRC/shared" "$CTX/"
  cp "$SRC/.dockerignore" "$CTX/" 2>/dev/null || true
  (cd "$CTX" && patch -p1 --quiet < "$P/phases.patch")
fi
echo "building $TAG from $SRC (mode=$MODE)"
docker build -f "$P/Dockerfile.slim" --target sandbox-build -t "$TAG" "$CTX"
