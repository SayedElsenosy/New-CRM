#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f whatsapp-bot/.env ]; then
  echo "ملف whatsapp-bot/.env غير موجود."
  echo "انسخ whatsapp-bot/.env.example إلى whatsapp-bot/.env وضع بيانات Supabase."
  exit 1
fi

docker compose -f docker-compose.oracle.yml up -d --build

tailscale funnel --bg 443 http://127.0.0.1:3001

echo
echo "تم تشغيل مسار."
echo "للحصول على الرابط العام:"
echo "tailscale status"
echo
echo "لفحص البوت:"
echo "docker logs -f masar"
