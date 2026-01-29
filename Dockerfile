FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install dependencies Start
RUN apt-get update && apt-get install -y bash build-essential curl file git sudo

## Create user for brew

# 1. Create user (via /bin/sh)
RUN /bin/sh -c "useradd -m -s /bin/bash linuxbrew && echo 'linuxbrew ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers"

USER linuxbrew

# 2. Install Homebrew (via /bin/sh, calling bash for the script)
RUN /bin/sh -c "curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash"

# Setup paths
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

RUN brew update
# Now you can install go
RUN brew install go

# Install dependencies End

# Switch back to superuser for system settings
USER root

RUN corepack enable

WORKDIR /app

ARG CLAWDBOT_DOCKER_APT_PACKAGES=""
RUN if [ -n "$CLAWDBOT_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $CLAWDBOT_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN CLAWDBOT_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV CLAWDBOT_PREFER_PNPM=1
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

CMD ["node", "dist/index.js"]
