FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /workspace/openclaw
COPY . .

RUN OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL=1 pnpm install --frozen-lockfile --ignore-scripts --filter openclaw

CMD ["bash"]
