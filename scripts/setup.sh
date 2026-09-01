#!/usr/bin/env bash
# AutoEditPost server setup: installs FFmpeg, caption fonts, and Node deps.
# Tested on Debian/Ubuntu. Run from the project root: bash scripts/setup.sh
set -euo pipefail

echo "==> Installing FFmpeg + fonts (needs sudo/root)"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  # fonts-montserrat provides Montserrat Black/ExtraBold used by the templates.
  apt-get install -y ffmpeg fonts-montserrat fontconfig
  fc-cache -f || true
else
  echo "   apt-get not found — install ffmpeg + a bold sans font manually."
fi

echo "==> Optional: Anton font (classic condensed Hormozi look)"
ANTON_DIR="/usr/share/fonts/truetype/anton"
if command -v curl >/dev/null 2>&1; then
  mkdir -p "$ANTON_DIR" || true
  curl -fsSL -o "$ANTON_DIR/Anton-Regular.ttf" \
    "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf" \
    && fc-cache -f || echo "   Anton download skipped (network); hormozi uses Montserrat Black."
fi

echo "==> Installing Node dependencies + building"
npm install --no-audit --no-fund
npm run build

echo "==> Done. Try:  node dist/cli.js styles"
echo "   For captions/b-roll, copy .env.example to .env and add keys,"
echo "   or set TRANSCRIBE_PROVIDER=local and 'pip install openai-whisper'."
