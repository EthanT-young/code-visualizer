# Code Visualizer: the React page plus the Java (JDI) and C++ (GDB) tracers.

# 1. Build the React site.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# 2. The server and tracers, serving the built site.
FROM eclipse-temurin:21-jdk-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ gdb python3 util-linux tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=web /web/dist/ ./public/
COPY server/ ./server/

# Compile the Java tracer and precompile the C++ prelude (cuts each C++ compile
# from ~4 s to under 1 s). The PCH flags must match the ones in server.py.
RUN javac --release 21 -d server/java/classes server/java/Tracer.java \
 && g++ -std=gnu++20 -g -O0 -fno-omit-frame-pointer -x c++-header server/cpp/prelude.h -o server/cpp/prelude.h.gch \
 && rm -rf server/__pycache__ server/cpp/__pycache__

# Programs run as this unprivileged user. The server starts as root with only the
# capabilities listed in docker-compose.yml and switches to `runner` for every program.
RUN useradd --create-home --uid 10001 runner

ENV LISTEN=8080 \
    CODEVIZ_CONTAINER=1 \
    JOBS_DIR=/tmp \
    HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=6s --start-period=10s --retries=3 \
  CMD ["python3", "-I", "-B", "/app/server/server.py", "--health"]

# tini is PID 1 so orphaned processes (e.g. from a fork bomb) get reaped instead of
# piling up as zombies against the container's process limit.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "-I", "-B", "/app/server/server.py"]
