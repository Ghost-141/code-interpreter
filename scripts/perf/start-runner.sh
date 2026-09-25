#!/bin/bash
# usage: IMG=runnerbench:base NAME=rb-runner ./start-runner.sh [extra -e VAR=val ...]
R=$(cd "$(dirname "$0")" && pwd)
IMG=${IMG:-runnerbench:base}; NAME=${NAME:-rb-runner}
docker rm -f $NAME >/dev/null 2>&1
docker create --name $NAME --network runnerbench -p 127.0.0.1:2000:2000 \
  --privileged --cpus 4 \
  --entrypoint /sandbox_api/entrypoint.sh \
  -e KVM_ENABLED=false -e SANDBOX_USE_CGROUPV2=${CGV2:-false} -e SANDBOX_REMOVE_UMOUNT_AFTER_STARTUP=false \
  -e SANDBOX_PACKAGES_DIRECTORY=/pkgs \
  -e FILE_SERVER_URL=http://rb-fs:3000 -e CODEAPI_INTERNAL_SERVICE_TOKEN=benchtoken \
  -e CODEAPI_HARDENED_SANDBOX_MODE=false -e SANDBOX_REQUIRE_EGRESS_MANIFEST=false \
  -e SANDBOX_MAX_CONCURRENT_JOBS=8 -e SANDBOX_LOG_LEVEL=${LOG:-DEBUG} \
  "$@" $IMG >/dev/null
docker cp $R/pkgs/. $NAME:/pkgs/
docker start $NAME >/dev/null
for i in $(seq 1 60); do curl -sf localhost:2000/api/v2/runtimes >/dev/null && break; sleep 1; done
curl -s localhost:2000/api/v2/runtimes; echo
