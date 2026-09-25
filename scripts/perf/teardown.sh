#!/bin/bash
# Remove bench containers + network (images are kept).
docker rm -f rb-runner rb-fs rb-redis rb-minio >/dev/null 2>&1
docker network rm runnerbench >/dev/null 2>&1
echo "teardown done"
