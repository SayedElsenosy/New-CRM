#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f oracle/.env ]; then
  echo "ملف oracle/.env غير موجود."
  echo "انسخ oracle/.env.example إلى oracle/.env وضع بيانات Supabase ورابط Tailscale."
  exit 1
fi

docker compose --env-file oracle/.env -f docker-compose.oracle.yml up -d --build
tailscale funnel --bg 443 http://127.0.0.1:3001

echo
echo "تم تشغيل مسار 24/7."
echo "رابط Funnel يظهر مع الأمر:"
echo "tailscale funnel status"
echo
echo "لمراقبة البوت:"
echo "docker logs -f masar"
