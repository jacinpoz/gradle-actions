#!/usr/bin/env bash
# Measure hex-shard balance and invalidation cost against a real Gradle User Home.
#
# For each sharded family: number of content-hash dirs, total bytes, and the distribution of
# bytes across the 16 single-hex-character shards. From that we derive the cost of a single
# changed artifact under v5 (whole bundle re-uploaded) vs sharded (one shard re-uploaded).
set -uo pipefail
G="${1:-$HOME/.gradle/caches}"
OUT="${2:-/dev/stdout}"

emit() { printf '%s\n' "$*" >>"$OUT"; }
: >"$OUT"

# $1 = family label, $2 = du output file, $3 = depth of the hash dir relative to root
report() {
  local label="$1" duf="$2"
  awk -v label="$label" '
    { size=$1; $1=""; sub(/^ /,""); p=$0
      n=split(p, seg, "/"); name=tolower(seg[n])
      c=substr(name,1,1)
      if (c ~ /^[0-9a-f]$/) { bytes[c]+=size; count[c]++; tot+=size; ndir++ }
      else { unsharded+=size; nun++ }
    }
    END {
      printf "%s\n", label
      printf "  hash dirs        : %d\n", ndir
      printf "  total bytes      : %.1f MiB\n", tot/1048576
      if (nun>0) printf "  non-hex dirs     : %d (%.1f MiB, stay in main entry)\n", nun, unsharded/1048576
      # shard stats
      mn=1e18; mx=0
      split("0 1 2 3 4 5 6 7 8 9 a b c d e f", H, " ")
      for (i=1;i<=16;i++) { h=H[i]; b=bytes[h]+0; if(b<mn)mn=b; if(b>mx)mx=b; s+=b }
      printf "  shards populated : %d/16\n", 16
      printf "  bytes per shard  : min %.1f MiB / mean %.1f MiB / max %.1f MiB\n", mn/1048576, (s/16)/1048576, mx/1048576
      printf "  max/mean skew    : %.2fx\n", (s>0 ? mx/(s/16) : 0)
      printf "  ---- one changed artifact re-uploads ----\n"
      printf "  v5 (whole bundle): %.1f MiB\n", tot/1048576
      printf "  sharded (1 shard): %.1f MiB mean, %.1f MiB worst case\n", (s/16)/1048576, mx/1048576
      printf "  reduction        : %.1fx mean, %.1fx worst case\n", (s>0 ? tot/(s/16) : 0), (mx>0 ? tot/mx : 0)
      printf "\n"
    }' "$duf" >>"$OUT"
}

# --- transforms: hash dirs are direct children of caches/<ver>/transforms ---
for tdir in "$G"/*/transforms; do
  [ -d "$tdir" ] || continue
  ver=$(basename "$(dirname "$tdir")")
  du -b --max-depth=1 "$tdir" 2>/dev/null | grep -v "	$tdir\$" > /tmp/du-transforms.txt
  report "transforms ($ver)" /tmp/du-transforms.txt
done

# --- kotlin-dsl accessors ---
for adir in "$G"/*/kotlin-dsl/accessors; do
  [ -d "$adir" ] || continue
  ver=$(basename "$(dirname "$(dirname "$adir")")")
  du -b --max-depth=1 "$adir" 2>/dev/null | grep -v "	$adir\$" > /tmp/du-accessors.txt
  report "kotlin-dsl accessors ($ver)" /tmp/du-accessors.txt
done

# --- dependencies: hash dirs are at modules-2/files-2.1/<group>/<module>/<version>/<sha1> ---
if [ -d "$G/modules-2/files-2.1" ]; then
  du -b --max-depth=4 "$G/modules-2/files-2.1" 2>/dev/null \
    | awk -F'files-2.1/' 'NF==2 { n=split($2, s, "/"); if (n==4) print }' > /tmp/du-deps.txt
  report "dependencies (modules-2)" /tmp/du-deps.txt
fi
