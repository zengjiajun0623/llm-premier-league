#!/bin/bash
# Nightly autonomous matchweek (M6). Verification loop gates the night; every
# stage is budget-bounded; the site republishes itself at the end.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/opt/podman/bin:$PATH"
cd /Users/jiajunzeng/llm-worldcup
mkdir -p logs
LOG="logs/nightly-$(date +%Y%m%d).log"
# Portable wall-clock cap (macOS has no coreutils timeout).
capped() {
  local secs=$1; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid"; local rc=$?
  kill "$wd" 2>/dev/null
  return $rc
}
{
  echo "=== nightly start $(date) ==="
  # Gate: nothing runs unless the verification loop is green.
  ./verify.sh || { echo "VERIFY RED - night aborted"; exit 1; }
  # Sandbox runtime up (best-effort; verified legs void->defer if down).
  /opt/podman/bin/podman machine start nicenode-machine >/dev/null 2>&1 || true
  # M8: poll the catalog and enroll newly listed frontier models (best-effort).
  npx tsx src/enroll.ts >> "$LOG" 2>&1 || true
  # League 1: one fresh verified round per night (~66 legs, ~$0.8), wall-capped.
  SANDBOX=podman capped 7200 npx tsx src/verified/run.ts --id "verified-nightly-$(date +%Y%m%d)" --rounds 1
  # League 3 (persuasion): capped debate chunk (~45 min wall clock, resume-safe).
  capped 2700 npm start --silent -- run --mode league
  # Refit happens at read time; export + deploy the public site.
  ./publish.sh
  echo "=== nightly done $(date) ==="
} >> "$LOG" 2>&1
