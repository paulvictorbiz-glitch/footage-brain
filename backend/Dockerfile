FROM python:3.11-slim

# Install system deps: ffmpeg for video processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download Whisper model at build time (optional: speeds up first run)
# RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base')"

# Copy app source
COPY . .

# Create data directories
RUN mkdir -p data/thumbnails data/keyframes data/chroma

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
