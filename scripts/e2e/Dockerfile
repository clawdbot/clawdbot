FROM node:22-bookworm

RUN corepack enable

WORKDIR /app

ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts vitest.e2e.config.ts ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
COPY docs ./docs
COPY skills ./skills
COPY patches ./patches
COPY ui ./ui
COPY extensions/memory-core ./extensions/memory-core

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm ui:build

CMD ["bash"]
