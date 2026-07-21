#!/bin/bash
# Export the current results and deploy to https://llm-premier-league.vercel.app
set -e
cd "$(dirname "$0")"
npx tsx src/export.ts ~/claude-artifacts/llm-premier-league
vercel deploy --prod --yes --cwd ~/claude-artifacts/llm-premier-league 2>&1 | grep -E "Production|Aliased" || true
