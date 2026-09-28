FROM node:22.22.0-bookworm-slim
ARG CODE_SERVER_VERSION=4.139.1
ARG DSH_VERSION=0.1.7-rc.2
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-venv build-essential tini \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -l coder -d /home/coder node && groupmod -n coder node \
    && mkdir -p /home/coder && chown 1000:1000 /home/coder
# Release is pinned; CI scans the resulting image and deployment requires an immutable digest.
RUN set -eux; arch="$(dpkg --print-architecture)"; \
    curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_${arch}.deb" -o /tmp/code-server.deb; \
    dpkg -i /tmp/code-server.deb; rm /tmp/code-server.deb; \
    npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" pnpm@10.28.2; npm cache clean --force
WORKDIR /opt/gateway
COPY runtime/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY runtime/auth.mjs runtime/gateway.mjs runtime/gateway-core.mjs runtime/seed.mjs runtime/privacy.yml runtime/entrypoint.sh ./
RUN chmod +x entrypoint.sh
USER 1000:1000
ENV HOME=/home/coder NODE_ENV=production
EXPOSE 8088
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/gateway/entrypoint.sh"]
