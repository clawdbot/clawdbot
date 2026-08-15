# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

RUN --mount=type=cache,id=openclaw-install-sh-e2e-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-install-sh-e2e-apt-lists,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git

COPY install-sh-common/version-parse.sh /usr/local/install-sh-common/version-parse.sh
COPY --chmod=755 install-sh-e2e/run.sh /usr/local/bin/openclaw-install-e2e

RUN useradd --create-home --shell /bin/bash appuser
USER appuser

ENTRYPOINT ["/usr/local/bin/openclaw-install-e2e"]
