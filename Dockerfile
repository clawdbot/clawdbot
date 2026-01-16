FROM node:24-trixie

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io \
    python3 \
    git \
    curl \
    jq \
    ripgrep \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/* && \
    corepack enable

WORKDIR /app
COPY . .

RUN pnpm install && \
    pnpm build && \
    pnpm ui:install && \
    pnpm ui:build && \
    npm install -g https://github.com/tobi/qmd

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
