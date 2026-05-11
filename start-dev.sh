#!/usr/bin/env bash
# Footage Brain – Unix/Mac local dev startup
set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}"
echo "  Footage Brain – Local Dev"
echo -e "${NC}"

# Check deps
command -v python3 >/dev/null 2>&1 || { echo "Python 3 required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js required"; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || echo -e "${YELLOW}[WARN] ffmpeg not found – metadata extraction will fail${NC}"

# .env setup
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  echo -e "${GREEN}[INFO] Created backend/.env${NC}"
fi

# Python venv
if [ ! -d backend/venv ]; then
  python3 -m venv backend/venv
fi
source backend/venv/bin/activate
pip install -r backend/requirements.txt -q

# Frontend deps
if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install)
fi

# Start both with trap for clean exit
trap 'kill $(jobs -p) 2>/dev/null' EXIT

echo -e "${GREEN}[INFO] Starting backend on :8000${NC}"
(cd backend && source venv/bin/activate && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000) &

sleep 2

echo -e "${GREEN}[INFO] Starting frontend on :5173${NC}"
(cd frontend && npm run dev) &

echo -e "${GREEN}Open http://localhost:5173${NC}"
wait
