#!/usr/bin/env python3
"""Per-call sandbox overhead from production container logs.

Usage (on the sandbox host, read-only):
    docker logs --since 6h api            > api.log 2>&1
    docker logs --since 6h service-worker > worker.log 2>&1
    python3 overhead.py api.log worker.log

overhead = (worker "Sandbox response" - api "Request received") - run.wall_time
wall_time already includes the NsJail setup gate and spawn, so overhead is
queueing, dispatch, input priming and output handling.
Calls are grouped by how many other calls started within the same second.
"""

import json
import sys
from collections import defaultdict
from datetime import datetime
from statistics import median


def parse_time(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def read_json_lines(path):
    with open(path, encoding='utf-8', errors='replace') as handle:
        for line in handle:
            start = line.find('{')
            if start < 0:
                continue
            try:
                yield json.loads(line[start:])
            except json.JSONDecodeError:
                continue


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(fraction * len(ordered)))]


def summarize(label, values):
    if not values:
        return f'{label:<28} n=0'
    return (
        f'{label:<28} n={len(values):<4} median={round(median(values)):>5} ms  '
        f'p90={round(percentile(values, 0.9)):>5} ms'
    )


def main(api_path, worker_path):
    requests = {}
    for entry in read_json_lines(api_path):
        if entry.get('message') == 'Request received':
            requests[entry['session_id']] = (parse_time(entry['timestamp']), entry.get('files', {}))

    responses = {}
    for entry in read_json_lines(worker_path):
        if entry.get('message') == 'Sandbox response':
            responses[entry['session_id']] = (parse_time(entry['timestamp']), entry['run']['wall_time'])

    starts_per_second = defaultdict(int)
    for started, _ in requests.values():
        starts_per_second[started.replace(microsecond=0)] += 1

    overall, walls = [], []
    by_concurrency = defaultdict(list)
    for session_id, (started, files) in requests.items():
        if session_id not in responses:
            continue
        responded, wall = responses[session_id]
        overhead = (responded - started).total_seconds() * 1000 - wall
        overall.append(overhead)
        walls.append(wall)
        concurrent = starts_per_second[started.replace(microsecond=0)]
        by_concurrency['lone' if concurrent == 1 else f'{concurrent} started together'].append(overhead)

    print(summarize('overhead (all calls)', overall))
    print(summarize('code wall_time', walls))
    for label in sorted(by_concurrency, key=lambda key: (key != 'lone', key)):
        print(summarize(f'overhead, {label}', by_concurrency[label]))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
