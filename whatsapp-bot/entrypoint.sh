#!/bin/sh
set -eu
mkdir -p /data/whatsapp
chown -R node:node /data
exec gosu node node /app/whatsapp-bot/src/server.js
