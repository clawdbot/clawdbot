# Trusted Telegram proof harness image. Build before admitting candidate source.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac
WORKDIR /harness
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git rsync curl sudo python3 \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN chmod -R a+rX /harness && corepack enable && corepack pnpm install --frozen-lockfile \
    && mkdir /candidate /out \
    && find . -type d -name node_modules -prune -exec cp -a --parents {} /candidate \; \
    && chown pwuser:pwuser /out \
    && OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=8192 OPENCLAW_BUILD_PRIVATE_QA=1 corepack pnpm build qaRuntime
ENV CI=true
