#!/bin/bash
# ./latency.sh 10   -> add 10 ms netem delay on MinIO egress (file server <-> storage)
# ./latency.sh 0    -> remove it
set -euo pipefail
MS=${1:?usage: latency.sh <ms>}
if [ "$MS" = 0 ]; then CMD="tc qdisc del dev eth0 root 2>/dev/null || true"
else CMD="tc qdisc replace dev eth0 root netem delay ${MS}ms"; fi
docker run --rm --net container:rb-minio --cap-add NET_ADMIN alpine \
  sh -c "apk add -q iproute2-tc >/dev/null 2>&1; $CMD; tc qdisc show dev eth0"
