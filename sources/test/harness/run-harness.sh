#!/bin/bash
# Bundles the harness the same way the action itself is bundled, starts the local cache service, and runs
# the bench against it. The action code under test is therefore the same shape that ships in dist/.
#
#   ./run-harness.sh [--mbps=100] [--cores=0-3] [--] <bench args...>
#
# Everything after -- is passed to the bench: --scenario=fanout|switches, --fanout=1,2,4, --runs=2.
set -euo pipefail

cd "$(dirname "$0")/../.."   # sources/

WORK="${HARNESS_WORK:-/tmp/gradle-actions-harness}"
MBPS=100
CORES=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --mbps=*) MBPS="${1#*=}"; shift ;;
        --cores=*) CORES="${1#*=}"; shift ;;
        --) shift; break ;;
        *) break ;;
    esac
done

mkdir -p "$WORK"
BUNDLE="$WORK/bench.mjs"

npx esbuild test/harness/fanout-bench.ts \
    --bundle --platform=node --target=node24 --format=esm \
    --banner:js="import {createRequire} from 'module';const require=createRequire(import.meta.url);" \
    --outfile="$BUNDLE" --log-level=warning

# The cache service runs in its own process so that it does not compete for the client's event loop,
# which is what a remote service does not do either.
node test/harness/cache-server.mjs "$WORK/storage" --mbps="$MBPS" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
    PORT=$(sed -n 's/^CACHE_SERVER_PORT=//p' "$WORK/server.log" 2>/dev/null | head -1)
    [[ -n "$PORT" ]] && break
    sleep 0.1
done
[[ -n "${PORT:-}" ]] || { echo "cache server did not start:"; cat "$WORK/server.log"; exit 1; }

echo "cache service on port $PORT, bandwidth ${MBPS} MB/s, cores ${CORES:-all}"

mkdir -p "$WORK/workspace" "$WORK/temp"
export ACTIONS_CACHE_URL="http://127.0.0.1:$PORT/"
export ACTIONS_RUNTIME_TOKEN="harness"
export GITHUB_WORKSPACE="$WORK/workspace"
export RUNNER_TEMP="$WORK/temp"
export RUNNER_OS="Linux"
export RUNNER_ARCH="X64"
export GITHUB_STATE="$WORK/state"
export GITHUB_ENV="$WORK/env"
export GITHUB_OUTPUT="$WORK/output"
: > "$GITHUB_STATE"; : > "$GITHUB_ENV"; : > "$GITHUB_OUTPUT"
export GRADLE_BUILD_ACTION_CACHE_KEY_PREFIX="harness-"
export GRADLE_BUILD_ACTION_CACHE_KEY_JOB="harness"
export GRADLE_BUILD_ACTION_CACHE_KEY_JOB_INSTANCE="harness"
export GRADLE_BUILD_ACTION_CACHE_KEY_JOB_EXECUTION="run-1"

# The Gradle User Home entry caches what the action's inputs say it should; with no inputs set at all it
# would cache only the action's own metadata directory. Passed through 'env' because the variable name
# contains dashes, which 'export' will not take.
RUNNER=(env $'INPUT_GRADLE-HOME-CACHE-INCLUDES=caches\nnotifications' \
    node "$BUNDLE" "$WORK/guh-template" "--home=$WORK/guh")
if [[ -n "$CORES" ]]; then
    RUNNER=(taskset -c "$CORES" "${RUNNER[@]}")
fi
"${RUNNER[@]}" "$@"
