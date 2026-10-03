@echo off
chcp 65001 >nul
title Masar - Free Local Mode
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ غير مثبت.
  echo نزّل Node.js LTS ثم شغّل الملف مرة أخرى.
  pause
  exit /b 1
)

if not exist "whatsapp-bot\.env" (
  echo ملف whatsapp-bot\.env غير موجود.
  echo انسخ whatsapp-bot\.env.example إلى whatsapp-bot\.env وضع بيانات Supabase.
  pause
  exit /b 1
)

if not exist "admin-dashboard\.env" (
  echo ملف admin-dashboard\.env غير موجود.
  echo انسخ admin-dashboard\.env.example إلى admin-dashboard\.env وضع بيانات Supabase.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo تثبيت المكتبات لأول مرة...
  call npm ci
  if errorlevel 1 (
    echo فشل تثبيت المكتبات.
    pause
    exit /b 1
  )
)

echo تشغيل خدمة واتساب...
start "Masar WhatsApp Bot" cmd /k "cd /d %~dp0 && npm start"

echo تشغيل لوحة التحكم...
start "Masar Dashboard" cmd /k "cd /d %~dp0 && npm run dev"

timeout /t 5 /nobreak >nul
start "" "http://localhost:5173"

echo.
echo تم تشغيل مسار محلياً.
echo لا تغلق نافذة WhatsApp Bot لو عايز الرد الآلي يفضل شغال.
pause
