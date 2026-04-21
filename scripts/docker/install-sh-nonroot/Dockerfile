# syntax=docker/dockerfile:1.7

FROM ubuntu:24.04@sha256:cd1dba651b3080c3686ecf4e3c4220f026b521fb76978881737d24f200828b2b

# Smoke images are pinned and short-lived, so skip distro upgrades here and
# spend the time budget on installer coverage instead.
RUN --mount=type=cache,id=openclaw-install-sh-nonroot-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-install-sh-nonroot-apt-lists,target=/var/lib/apt,sharing=locked \
  set -eux; \
  for attempt in 1 2 3; do \
    if apt-get update -o Acquire::Retries=3; then break; fi; \
    echo "apt-get update failed (attempt ${attempt})" >&2; \
    if [ "${attempt}" -eq 3 ]; then exit 1; fi; \
    sleep 3; \
  done; \
  apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    g++ \
    make \
    python3 \
    sudo

# Preinstall the supported Node runtime in a cacheable build layer so the
# non-root smoke covers user-local npm prefixing and missing git without paying
# the full NodeSource bootstrap cost on every container run.
RUN --mount=type=cache,id=openclaw-install-sh-nonroot-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-install-sh-nonroot-apt-lists,target=/var/lib/apt,sharing=locked \
  set -eux; \
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -; \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs

RUN useradd -m -s /bin/bash app \
  && echo "app ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/app

USER app
WORKDIR /home/app

ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY install-sh-common/cli-verify.sh /usr/local/install-sh-common/cli-verify.sh
COPY install-sh-common/version-parse.sh /usr/local/install-sh-common/version-parse.sh
COPY --chmod=755 install-sh-nonroot/run.sh /usr/local/bin/openclaw-install-nonroot

ENTRYPOINT ["/usr/local/bin/openclaw-install-nonroot"]
