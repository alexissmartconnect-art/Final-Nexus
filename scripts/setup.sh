#!/usr/bin/env bash
# First-run setup: install dependencies, create the local environment file, migrate the DB.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
  # portable in-place edit
  node -e "
    const fs=require('node:fs');const p='.env';let s=fs.readFileSync(p,'utf8');
    s=s.replace(/^NEXUS_MASTER_KEY=.*\$/m,'NEXUS_MASTER_KEY=${KEY}');
    fs.writeFileSync(p,s);
  "
  echo "[setup] .env created with a freshly generated NEXUS_MASTER_KEY"
else
  echo "[setup] .env already present, leaving it untouched"
fi

npm install --no-audit --no-fund
npm run db:migrate
echo "[setup] done. Start with: npm run dev:api  (terminal 1)  and  npm run dev:web  (terminal 2)"
