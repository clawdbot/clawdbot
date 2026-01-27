FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
  && rm -rf /var/lib/apt/lists/*

COPY run.sh /usr/local/bin/moltbot-install-e2e
RUN chmod +x /usr/local/bin/moltbot-install-e2e

ENTRYPOINT ["/usr/local/bin/moltbot-install-e2e"]
