#!/usr/bin/env bash
# Start API + web together for local development.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then bash scripts/setup.sh; fi
npm run dev:api &
API_PID=$!
sleep 2
npm run dev:web &
WEB_PID=$!
trap 'kill $API_PID $WEB_PID 2>/dev/null || true' INT TERM EXIT
wait
