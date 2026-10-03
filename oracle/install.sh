#!/usr/bin/env bash
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "شغّل الملف باستخدام sudo: sudo bash oracle/install.sh"
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git docker.io docker-compose-v2
systemctl enable --now docker

if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo
echo "تم تثبيت Docker Compose وTailscale."
echo "الخطوة التالية:"
echo "sudo tailscale up"
echo "ثم بعد تسجيل الدخول:"
echo "sudo bash oracle/start.sh"
