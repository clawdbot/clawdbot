# Replace the placeholder with an immutable linux/amd64 digest from the official
# Docker Hub repository. Cloudflare Containers cannot pull OpenClaw from GHCR.
ARG OPENCLAW_IMAGE=openclaw/openclaw@sha256:<official-openclaw-image-digest>
FROM ${OPENCLAW_IMAGE}

USER root

ARG LITESTREAM_VERSION=0.5.16
ARG LITESTREAM_SHA256=9e29112380a942e4a62ee07773684396cb8b308dc4d67e130bef41f75e937f0a

ADD --checksum=sha256:${LITESTREAM_SHA256} \
  https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz \
  /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
  && chmod 0755 /usr/local/bin/litestream \
  && rm /tmp/litestream.tar.gz

COPY litestream.yml /etc/litestream.yml
COPY entrypoint.sh /usr/local/bin/cloudflare-entrypoint.sh
RUN chmod 0755 /usr/local/bin/cloudflare-entrypoint.sh \
  && chown root:root /etc/litestream.yml /usr/local/bin/cloudflare-entrypoint.sh

USER node
ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/cloudflare-entrypoint.sh"]
