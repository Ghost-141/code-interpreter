#!/bin/bash
# Bring up MinIO + Redis + real file server on network `runnerbench`, upload fixtures,
# and build runnerbench:base (PROF=1 also builds runnerbench:prof).
set -euo pipefail
P=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$P/../.." && pwd)
SKILL_DIR=${SKILL_DIR:-$(cd "$REPO/../skill/xlsx" && pwd)}
FS_IMG=stagebench-file-server

docker network inspect runnerbench >/dev/null 2>&1 || docker network create runnerbench >/dev/null
if ! docker image inspect $FS_IMG >/dev/null 2>&1; then
  docker build -f "$REPO/service/Dockerfile" --target production -t $FS_IMG "$REPO"
fi
docker rm -f rb-minio rb-redis rb-fs >/dev/null 2>&1 || true
docker run -d --name rb-minio --network runnerbench -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  quay.io/minio/minio server /data >/dev/null
docker run -d --name rb-redis --network runnerbench redis:7-alpine >/dev/null
sleep 3
docker run -d --name rb-fs --network runnerbench -e MINIO_ENDPOINT=rb-minio -e MINIO_PORT=9000 \
  -e MINIO_ACCESS_KEY=minioadmin -e MINIO_SECRET_KEY=minioadmin -e REDIS_HOST=rb-redis \
  -e CODEAPI_INTERNAL_SERVICE_TOKEN=benchtoken $FS_IMG >/dev/null
for i in $(seq 1 30); do docker logs rb-fs 2>&1 | grep -q 'Server running' && break; sleep 1; done

echo "uploading fixtures from $SKILL_DIR"
docker run --rm --network runnerbench -e FS_URL=http://rb-fs:3000 -v "$P/bench:/bench" \
  -v "$SKILL_DIR:/skill/xlsx:ro" -w /app $FS_IMG bun run /bench/upload.ts

"$P/build-runner.sh" base
[ "${PROF:-0}" = 1 ] && "$P/build-runner.sh" prof
echo "setup done"
