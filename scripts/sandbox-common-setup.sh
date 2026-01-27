#!/usr/bin/env bash
set -euo pipefail

BASE_IMAGE="${BASE_IMAGE:-moltbot-sandbox:bookworm-slim}"
TARGET_IMAGE="${TARGET_IMAGE:-moltbot-sandbox-common:bookworm-slim}"
PACKAGES="${PACKAGES:-curl wget jq coreutils grep nodejs npm python3 git ca-certificates golang-go rustc cargo unzip pkg-config libasound2-dev build-essential file}"
INSTALL_PNPM="${INSTALL_PNPM:-1}"
INSTALL_BUN="${INSTALL_BUN:-1}"
BUN_INSTALL_DIR="${BUN_INSTALL_DIR:-/opt/bun}"
INSTALL_BREW="${INSTALL_BREW:-1}"
BREW_INSTALL_DIR="${BREW_INSTALL_DIR:-/home/linuxbrew/.linuxbrew}"

if ! docker image inspect "${BASE_IMAGE}" >/dev/null 2>&1; then
  echo "Base image missing: ${BASE_IMAGE}"
  echo "Building base image via scripts/sandbox-setup.sh..."
  scripts/sandbox-setup.sh
fi

echo "Building ${TARGET_IMAGE} with: ${PACKAGES}"

docker build \
  -t "${TARGET_IMAGE}" \
  --build-arg INSTALL_PNPM="${INSTALL_PNPM}" \
  --build-arg INSTALL_BUN="${INSTALL_BUN}" \
  --build-arg BUN_INSTALL_DIR="${BUN_INSTALL_DIR}" \
  --build-arg INSTALL_BREW="${INSTALL_BREW}" \
  --build-arg BREW_INSTALL_DIR="${BREW_INSTALL_DIR}" \
  - <<EOF
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
ARG INSTALL_PNPM=1
ARG INSTALL_BUN=1
ARG BUN_INSTALL_DIR=/opt/bun
ARG INSTALL_BREW=1
ARG BREW_INSTALL_DIR=/home/linuxbrew/.linuxbrew
ENV BUN_INSTALL=\${BUN_INSTALL_DIR}
ENV HOMEBREW_PREFIX="\${BREW_INSTALL_DIR}"
ENV HOMEBREW_CELLAR="\${BREW_INSTALL_DIR}/Cellar"
ENV HOMEBREW_REPOSITORY="\${BREW_INSTALL_DIR}/Homebrew"
ENV PATH="\${BUN_INSTALL_DIR}/bin:\${BREW_INSTALL_DIR}/bin:\${BREW_INSTALL_DIR}/sbin:\${PATH}"
RUN apt-get update \\
  && apt-get install -y --no-install-recommends ${PACKAGES} \\
  && rm -rf /var/lib/apt/lists/*
RUN if [ "\${INSTALL_PNPM}" = "1" ]; then npm install -g pnpm; fi
RUN if [ "\${INSTALL_BUN}" = "1" ]; then \\
  curl -fsSL https://bun.sh/install | bash; \\
  ln -sf "\${BUN_INSTALL_DIR}/bin/bun" /usr/local/bin/bun; \\
fi
RUN if [ "\${INSTALL_BREW}" = "1" ]; then \\
  if ! id -u linuxbrew >/dev/null 2>&1; then useradd -m -s /bin/bash linuxbrew; fi; \\
  mkdir -p "\${BREW_INSTALL_DIR}"; \\
  chown -R linuxbrew:linuxbrew "\$(dirname "\${BREW_INSTALL_DIR}")"; \\
  su - linuxbrew -c "NONINTERACTIVE=1 CI=1 /bin/bash -c '\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'"; \\
  if [ ! -e "\${BREW_INSTALL_DIR}/Library" ]; then ln -s "\${BREW_INSTALL_DIR}/Homebrew/Library" "\${BREW_INSTALL_DIR}/Library"; fi; \\
  if [ ! -x "\${BREW_INSTALL_DIR}/bin/brew" ]; then echo "brew install failed"; exit 1; fi; \\
  ln -sf "\${BREW_INSTALL_DIR}/bin/brew" /usr/local/bin/brew; \\
fi
EOF

cat <<NOTE
Built ${TARGET_IMAGE}.
To use it, set agents.defaults.sandbox.docker.image to "${TARGET_IMAGE}" and restart.
If you want a clean re-create, remove old sandbox containers:
  docker rm -f \$(docker ps -aq --filter label=moltbot.sandbox=1)
NOTE
