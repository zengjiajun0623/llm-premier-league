#!/bin/bash
# Full verification loop: run after every change, before any real-money season.
set -e
cd "$(dirname "$0")"
echo "1/3 typecheck" && npx tsc --noEmit
echo "2/3 tests (unit + simulated end-to-end season + server API + frontend consistency)"
npx tsx --test test/*.test.ts
echo "3/3 done - ALL VERIFICATIONS PASSED"
