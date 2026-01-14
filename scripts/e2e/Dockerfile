FROM node:22-bookworm

RUN corepack enable

WORKDIR /app

ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts ./
COPY patches ./patches
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
COPY skills ./skills

RUN pnpm install --frozen-lockfile
RUN pnpm build

CMD ["bash"]
