FROM python:3.13-alpine

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# replay.py ships alongside the logger on purpose: the recovery tool has to be
# available wherever the data is, so `docker compose exec powerflow-mqttlog
# python /app/replay.py ...` works during an incident.
COPY mqttlog.py replay.py ./

RUN adduser -D -u 10001 mqttlog && mkdir -p /log && chown mqttlog:mqttlog /log
USER mqttlog

# No VOLUME directive: it adds nothing over the compose volume and would turn a
# forgotten mount into a silent anonymous volume.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Keyed on data actually being written, not just on the process being alive.
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "/app/mqttlog.py", "--healthcheck"]

ENTRYPOINT ["python", "-u", "/app/mqttlog.py"]
