# tools/media_server.py, which deploy.sh copies beside this file.
FROM python:3.12-slim-bookworm
RUN pip install --no-cache-dir qbittorrent-api==2026.5.2
COPY media_server.py /app/media_server.py
USER nobody
EXPOSE 8090
CMD ["python3", "-u", "/app/media_server.py"]
