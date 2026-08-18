#!/bin/bash
# Runs the action as a runner does -- the committed dist/ bundles, main step then post step, with state
# handed between them through GITHUB_STATE -- against the local cache service. Two jobs at two commits:
# the first writes the cache, the second restores it, adds content, and writes again.
#
# This is the closest thing to the GitHub-hosted integration workflows that can run without a runner: the
# code under test is the bundle that ships, not the sources.
#
#   ./run-dist-cycle.sh [--mbps=100]
set -euo pipefail

cd "$(dirname "$0")/../.."   # sources/
REPO="$(cd .. && pwd)"

WORK="${HARNESS_WORK:-/tmp/gradle-actions-dist-cycle}"
MBPS=100
[[ "${1:-}" == --mbps=* ]] && MBPS="${1#*=}"

rm -rf "$WORK"
mkdir -p "$WORK"/{storage,workspace,temp}
: > "$WORK/env"; : > "$WORK/output"

node test/harness/cache-server.mjs "$WORK/storage" --mbps="$MBPS" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
    PORT=$(sed -n 's/^CACHE_SERVER_PORT=//p' "$WORK/server.log" 2>/dev/null | head -1)
    [[ -n "$PORT" ]] && break
    sleep 0.1
done
[[ -n "${PORT:-}" ]] || { echo "cache server did not start"; cat "$WORK/server.log"; exit 1; }

GUH="$WORK/gradle-home"
seed_home() {
    node -e "
    import('./test/harness/fixture.mjs').then(m => {
        m.buildFixture('$GUH', {transforms: 4000, dependencies: 200, buildCache: 400, kotlinDsl: 200})
        console.log('  the build populated the Gradle User Home with', m.inventory('$GUH').length, 'paths')
    })"
}

export ACTIONS_CACHE_URL="http://127.0.0.1:$PORT/"
export ACTIONS_RUNTIME_TOKEN="harness"
export GITHUB_WORKSPACE="$WORK/workspace"
export RUNNER_TEMP="$WORK/temp"
export RUNNER_OS="Linux"
export RUNNER_ARCH="X64"
export RUNNER_TOOL_CACHE="$WORK/tools"
export GITHUB_REPOSITORY="jacinpoz/gradle-actions"
export GITHUB_REF="refs/heads/main"
export GITHUB_JOB="dist-cycle"
export GITHUB_WORKFLOW="dist-cycle"
export GRADLE_USER_HOME="$GUH"
# Only caching is under test here: wrapper validation, build scans, dependency graphs and the job summary
# all reach the network or need a real build, and none of them touch the cache. Action inputs arrive as
# INPUT_<NAME> with the dashes kept, which 'export' will not take, so they are passed through 'env'. The
# booleans default to false when unset; the enum-valued ones throw, so they are all given here.
INPUTS=(
    "INPUT_GRADLE-HOME-CACHE-INCLUDES=caches
notifications"
    "INPUT_CACHE-DISABLED=false"
    "INPUT_CACHE-READ-ONLY=false"
    "INPUT_VALIDATE-WRAPPERS=false"
    "INPUT_CACHE-CLEANUP=never"
    "INPUT_ADD-JOB-SUMMARY=never"
    "INPUT_ADD-JOB-SUMMARY-AS-PR-COMMENT=never"
    "INPUT_DEPENDENCY-GRAPH=disabled"
    "INPUT_BUILD-SCAN-PUBLISH=false"
    "INPUT_DEVELOCITY-INJECTION-ENABLED=false"
)

run_step() {   # run_step <bundle> <state-file>
    local bundle="$1" state="$2"
    env "${INPUTS[@]}" ${STATES[@]+"${STATES[@]}"} \
        GITHUB_STATE="$state" GITHUB_ENV="$WORK/env" GITHUB_OUTPUT="$WORK/output" \
        node "$REPO/$bundle" 2>&1 | sed 's/^/    /'
}

# The runner passes what the main step wrote to GITHUB_STATE to the post step as STATE_<name>. Collected
# into an array rather than exported, because some of those names contain dashes.
STATES=()
collect_state() {
    local state="$1" name=""
    STATES=()
    while IFS= read -r line; do
        [[ "$line" =~ ^([A-Za-z0-9_-]+)\<\< ]] && { name="${BASH_REMATCH[1]}"; continue; }
        [[ "$line" =~ ^ghadelimiter_ ]] && continue
        [[ -n "$name" ]] && { STATES+=("STATE_${name}=${line}"); name=""; }
    done < "$state"
}

inventory() { node -e "import('./test/harness/fixture.mjs').then(m => console.log(m.inventory('$GUH').length))"; }

echo
echo "== job 1 at commit-1: cold cache, then the build populates the home, then it is saved =="
export GITHUB_SHA="commit-1"
STATES=()
: > "$WORK/state1"
run_step dist/setup-gradle/main/index.js "$WORK/state1" | tail -2
seed_home
BEFORE=$(inventory)
collect_state "$WORK/state1"
run_step dist/setup-gradle/post/index.js "$WORK/state1" | tail -2
STORED=$(curl -s "http://127.0.0.1:$PORT/_apis/artifactcache/__stats" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);
console.log(j.entries+' entries, '+Math.round(j.bytes/1048576)+' MB')})")
echo "  cache now holds: $STORED"

echo
echo "== job 2 at commit-2: restore into an empty home, the build adds a little, save again =="
rm -rf "$GUH"
export GITHUB_SHA="commit-2"
STATES=()
: > "$WORK/state2"
run_step dist/setup-gradle/main/index.js "$WORK/state2" | tail -2
RESTORED=$(inventory)
node -e "import('./test/harness/fixture.mjs').then(m => {
    const added = m.mutate('$GUH', {transforms: 200, dependencies: 10})
    console.log('  build added', added.length, 'paths')
})"
collect_state "$WORK/state2"
run_step dist/setup-gradle/post/index.js "$WORK/state2" | tail -2
FINAL=$(curl -s "http://127.0.0.1:$PORT/_apis/artifactcache/__stats" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);
console.log(j.entries+' entries, '+Math.round(j.bytes/1048576)+' MB')})")

echo
echo "seeded before job 1 : $BEFORE paths"
echo "restored in job 2   : $RESTORED paths"
echo "cache after job 2   : $FINAL"
[[ "$RESTORED" -ge "$BEFORE" ]] && echo "RESULT: the Gradle User Home was fully restored by the shipped bundle" \
    || { echo "RESULT: FAILED -- job 2 restored fewer paths than job 1 saved"; exit 1; }
