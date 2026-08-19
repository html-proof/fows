FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# No build-essential: every serving dependency (numpy included) ships a manylinux
# wheel, and dropping the toolchain takes ~300 MB off the image. Training deps
# are intentionally not installed here -- see requirements-train.txt.
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd --create-home --uid 10001 mlservice && chown -R mlservice:mlservice /app
USER mlservice

# Render sets PORT at runtime.
ENV PORT=8000
EXPOSE $PORT

# Single worker on purpose: each extra uvicorn worker forks another copy of the
# embedding matrices, which is the fastest way to OOM a 512 MB instance.
CMD uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1
