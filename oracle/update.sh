#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git pull --ff-only
docker compose -f docker-compose.oracle.yml up -d --build
docker image prune -f

echo "تم تحديث مسار وإعادة تشغيله."
