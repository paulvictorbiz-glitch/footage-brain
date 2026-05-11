# Footage Brain – Running on Windows (Production Mode)

Production mode serves the entire app — UI and API — from a single backend process on port 8000. No Vite dev server is needed. This is the correct way to run Footage Brain day-to-day.

---

## Prerequisites

Install these once. All three must be on your system `PATH`.

| Tool | Minimum version | Download |
|------|----------------|---------|
| Python | 3.11+ | https://python.org (check "Add to PATH" during install) |
| Node.js | 18+ | https://nodejs.org |
| ffmpeg | Any recent | https://ffmpeg.org/download.html → Windows builds → add the `bin/` folder to PATH |

Verify in a new PowerShell window:
```
python --version     # Python 3.11.x
node --version       # v18.x.x or higher
ffmpeg -version      # ffmpeg version ...
```

---

## First-Time Setup (run once per machine)

Open a PowerShell or Command Prompt window at the project root.

### 1. Create Python virtualenv and install packages

```bat
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

Expected output ends with:
```
Successfully installed fastapi-0.111.0 uvicorn-0.29.0 ...
```

### 2. Install frontend dependencies

```bat
cd frontend
npm install
cd ..
```

Expected output ends with:
```
added 312 packages in 18s
```

### 3. Create your `.env` file

```bat
copy backend\.env.example backend\.env
```

Then open `backend\.env` and verify or adjust:

```env
WHISPER_DEVICE=cuda          # change to cpu if no NVIDIA GPU
WHISPER_COMPUTE_TYPE=int8_float16   # good default for 6GB VRAM
WHISPER_MODEL=large-v3
EMBED_MODEL=mixedbread-ai/mxbai-embed-large-v1
```

---

## Running in Production Mode

Double-click `start-prod.bat` **or** run from the project root:

```bat
start-prod.bat
```

What happens:
1. Checks Python, Node, ffmpeg are available
2. Runs `npm run build` — compiles React to `frontend\dist\`
3. Starts the backend with `uvicorn` — serves both API and built UI
4. Opens your browser to `http://localhost:8000`

**Expected terminal output during build:**

```
[1/2] Building frontend (tsc + vite build)...

vite v5.x.x building for production...
✓ 1234 modules transformed.
dist/index.html                  0.46 kB │ gzip:  0.30 kB
dist/assets/index-Cxxxxxxx.css  28.14 kB │ gzip:  5.40 kB
dist/assets/index-Bxxxxxxx.js  412.18 kB │ gzip: 123.45 kB
✓ built in 8.32s

[1/2] Frontend built OK  →  frontend\dist\
[2/2] Starting backend on http://localhost:8000 ...
```

**Expected backend window output on first start:**

```
INFO:     Started server process [12345]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
```

Open `http://localhost:8000` in your browser. You should see the Footage Brain UI.

---

## Running in Development Mode

Dev mode runs Vite's dev server separately so you get hot-module reload when editing frontend code.

```bat
start-dev.bat
```

- Backend at `http://localhost:8000` (API only)
- Frontend at `http://localhost:5173` (Vite dev server with HMR)
- Open `http://localhost:5173` in your browser during development

The Vite dev server proxies `/api` and `/thumbnails` to the backend automatically.

---

## Stopping the Server

Click the server window and press `Ctrl+C`.

---

## Re-building After Frontend Changes

If you edit any frontend source file and want to update the production build:

```bat
cd frontend
npm run build
cd ..
```

Then restart the backend (stop and re-run `start-prod.bat`). The backend reads `frontend\dist\` at startup — a hot-reload is not needed for static asset changes, but the backend process must be restarted once to pick up the new `index.html` path registration.

---

## Folder Layout After a Successful Build

```
footage-brain/
├── backend/
│   ├── app/
│   ├── data/
│   │   ├── thumbnails/
│   │   ├── keyframes/
│   │   └── chroma/
│   ├── footage_brain.db
│   ├── .env
│   └── venv/
├── frontend/
│   ├── src/           ← source (not needed at runtime)
│   ├── dist/          ← built assets served by backend
│   │   ├── index.html
│   │   └── assets/
│   │       ├── index-Bxxxxxxx.js
│   │       └── index-Cxxxxxxx.css
│   └── node_modules/
├── start-dev.bat
├── start-prod.bat
└── RUN_PRODUCTION_WINDOWS.md
```

---

## Troubleshooting

### "Frontend not built" or blank page at localhost:8000

The backend only serves the UI if `frontend\dist\index.html` exists. Build it first:

```bat
cd frontend && npm run build && cd ..
```

Then restart the backend.

### TypeScript errors during `npm run build`

```
error TS2345: Argument of type ...
```

Fix the TypeScript errors in `frontend\src\` shown in the output, then retry `npm run build`.

### Port 8000 already in use

```
ERROR:    [Errno 10048] error while attempting to bind on address ('0.0.0.0', 8000)
```

Find and stop the old process:

```bat
netstat -ano | findstr :8000
```

Note the PID in the last column, then:

```bat
taskkill /PID <pid> /F
```

### ffmpeg not found

The backend logs `ffprobe_error` for every video. Install ffmpeg:

1. Download a Windows build from https://ffmpeg.org/download.html
2. Extract to e.g. `C:\tools\ffmpeg\`
3. Add `C:\tools\ffmpeg\bin` to your system PATH
4. Open a new terminal and verify: `ffmpeg -version`

### Models downloading on first run

The first time transcription or embedding runs, the backend downloads model weights from HuggingFace (~5 GB total for large-v3 + CLIP + mxbai). This is normal — subsequent starts use the cached copies at `C:\Users\<you>\.cache\huggingface\`.

To move the cache into the project folder (portable), add to `backend\.env`:

```env
HF_HOME=./data/models
```

---

## Summary: Dev vs Production

| | Dev mode (`start-dev.bat`) | Production mode (`start-prod.bat`) |
|---|---|---|
| **Open in browser** | `http://localhost:5173` | `http://localhost:8000` |
| **Frontend served by** | Vite dev server (HMR) | FastAPI (static files) |
| **Backend** | `localhost:8000` | `localhost:8000` |
| **Build step needed** | No | Yes (`npm run build`) |
| **Code changes apply** | Instantly (HMR) | After rebuild + backend restart |
| **Processes running** | 2 (backend + Vite) | 1 (backend only) |
