# syntax=docker/dockerfile:1
FROM python:3.12-slim
LABEL org.opencontainers.image.source=https://github.com/vitafortis/debrief
# Speaker labels (pyannote) pull in PyTorch, about 1 GB more. Build with DIARIZE=false for a slim image.
ARG DIARIZE=true
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MODEL_DIR=/models HF_HOME=/models/hf
# tzdata for TZ. No ffmpeg: faster-whisper decodes with PyAV's own copy, and pyannote is handed that audio.
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY debrief_transcriber ./debrief_transcriber
RUN if [ "$DIARIZE" = "true" ]; then \
      pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio && pip install ".[diarize]"; \
    else pip install .; fi
RUN useradd -u 1000 -m app && mkdir -p /models && chown app /models
USER app
VOLUME /models
CMD ["debrief-transcriber"]
