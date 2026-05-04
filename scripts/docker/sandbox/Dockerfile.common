# syntax=docker/dockerfile:1.7

ARG BASE_IMAGE=openclaw-sandbox:bookworm-slim
FROM ${BASE_IMAGE}

USER root

ENV DEBIAN_FRONTEND=noninteractive

ARG PACKAGES="curl wget jq coreutils grep nodejs npm python3 git ca-certificates golang-go rustc cargo unzip pkg-config libasound2-dev build-essential file"
ARG INSTALL_PNPM=1
ARG INSTALL_BUN=1
ARG BUN_INSTALL_DIR=/opt/bun
ARG INSTALL_BREW=1
ARG BREW_INSTALL_DIR=/home/linuxbrew/.linuxbrew
ARG FINAL_USER=sandbox

ENV BUN_INSTALL=${BUN_INSTALL_DIR}
ENV HOMEBREW_PREFIX=${BREW_INSTALL_DIR}
ENV HOMEBREW_CELLAR=${BREW_INSTALL_DIR}/Cellar
ENV HOMEBREW_REPOSITORY=${BREW_INSTALL_DIR}/Homebrew
ENV PATH=${BUN_INSTALL_DIR}/bin:${BREW_INSTALL_DIR}/bin:${BREW_INSTALL_DIR}/sbin:${PATH}

RUN --mount=type=cache,id=openclaw-sandbox-common-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-sandbox-common-apt-lists,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ${PACKAGES}

RUN if [ "${INSTALL_PNPM}" = "1" ]; then npm install -g pnpm; fi

RUN if [ "${INSTALL_BUN}" = "1" ]; then \
  curl -fsSL https://bun.sh/install | bash; \
  ln -sf "${BUN_INSTALL_DIR}/bin/bun" /usr/local/bin/bun; \
fi

RUN if [ "${INSTALL_BREW}" = "1" ]; then \
  if ! id -u linuxbrew >/dev/null 2>&1; then useradd -m -s /bin/bash linuxbrew; fi; \
  mkdir -p "${BREW_INSTALL_DIR}"; \
  chown -R linuxbrew:linuxbrew "$(dirname "${BREW_INSTALL_DIR}")"; \
  su - linuxbrew -c "NONINTERACTIVE=1 CI=1 /bin/bash -c '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'"; \
  if [ ! -e "${BREW_INSTALL_DIR}/Library" ]; then ln -s "${BREW_INSTALL_DIR}/Homebrew/Library" "${BREW_INSTALL_DIR}/Library"; fi; \
  if [ ! -x "${BREW_INSTALL_DIR}/bin/brew" ]; then echo \"brew install failed\"; exit 1; fi; \
  ln -sf "${BREW_INSTALL_DIR}/bin/brew" /usr/local/bin/brew; \
fi

# Default is sandbox, but allow BASE_IMAGE overrides to select another final user.
USER ${FINAL_USER}
