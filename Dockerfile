FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

# Install gosu for secure privilege dropping in entrypoint
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gosu && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

WORKDIR /app

ARG CLAWDBOT_DOCKER_APT_PACKAGES=""
RUN if [ -n "$CLAWDBOT_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $CLAWDBOT_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

# Install SSH server for remote debug access (optional, disabled by default)
ARG CLAWDBOT_ENABLE_SSH="false"
RUN if [ "$CLAWDBOT_ENABLE_SSH" = "true" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* && \
      mkdir -p /run/sshd && \
      mkdir -p /home/node/.ssh && \
      chown node:node /home/node/.ssh && \
      chmod 700 /home/node/.ssh && \
      sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && \
      sed -i 's/#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && \
      sed -i 's/#PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
      echo "AllowUsers node" >> /etc/ssh/sshd_config; \
    fi

# Add SSH authorized keys for debug access (only if SSH is enabled)
ARG SSH_AUTHORIZED_KEYS=""
RUN if [ "$CLAWDBOT_ENABLE_SSH" = "true" ] && [ -n "$SSH_AUTHORIZED_KEYS" ]; then \
      echo "$SSH_AUTHORIZED_KEYS" > /home/node/.ssh/authorized_keys && \
      chown node:node /home/node/.ssh/authorized_keys && \
      chmod 600 /home/node/.ssh/authorized_keys; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV CLAWDBOT_PREFER_PNPM=1
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Security hardening notes:
# - When CLAWDBOT_ENABLE_SSH=false (default): runs as node user for security
# - When CLAWDBOT_ENABLE_SSH=true: runs as root to start sshd, then drops to node via gosu
# The entrypoint handles privilege dropping when SSH is enabled

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
