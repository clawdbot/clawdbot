FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

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

# Copy all workspace package.json files before install so pnpm can resolve workspace:* dependencies
COPY packages/clawdbot/package.json ./packages/clawdbot/package.json
COPY extensions/bluebubbles/package.json ./extensions/bluebubbles/package.json
COPY extensions/copilot-proxy/package.json ./extensions/copilot-proxy/package.json
COPY extensions/diagnostics-otel/package.json ./extensions/diagnostics-otel/package.json
COPY extensions/discord/package.json ./extensions/discord/package.json
COPY extensions/google-antigravity-auth/package.json ./extensions/google-antigravity-auth/package.json
COPY extensions/google-gemini-cli-auth/package.json ./extensions/google-gemini-cli-auth/package.json
COPY extensions/googlechat/package.json ./extensions/googlechat/package.json
COPY extensions/imessage/package.json ./extensions/imessage/package.json
COPY extensions/line/package.json ./extensions/line/package.json
COPY extensions/llm-task/package.json ./extensions/llm-task/package.json
COPY extensions/lobster/package.json ./extensions/lobster/package.json
COPY extensions/matrix/package.json ./extensions/matrix/package.json
COPY extensions/mattermost/package.json ./extensions/mattermost/package.json
COPY extensions/memory-core/package.json ./extensions/memory-core/package.json
COPY extensions/memory-lancedb/package.json ./extensions/memory-lancedb/package.json
COPY extensions/msteams/package.json ./extensions/msteams/package.json
COPY extensions/nextcloud-talk/package.json ./extensions/nextcloud-talk/package.json
COPY extensions/nostr/package.json ./extensions/nostr/package.json
COPY extensions/open-prose/package.json ./extensions/open-prose/package.json
COPY extensions/signal/package.json ./extensions/signal/package.json
COPY extensions/slack/package.json ./extensions/slack/package.json
COPY extensions/telegram/package.json ./extensions/telegram/package.json
COPY extensions/tlon/package.json ./extensions/tlon/package.json
COPY extensions/twitch/package.json ./extensions/twitch/package.json
COPY extensions/voice-call/package.json ./extensions/voice-call/package.json
COPY extensions/whatsapp/package.json ./extensions/whatsapp/package.json
COPY extensions/zalo/package.json ./extensions/zalo/package.json
COPY extensions/zalouser/package.json ./extensions/zalouser/package.json

RUN pnpm install --no-frozen-lockfile

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
