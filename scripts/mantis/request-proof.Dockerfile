# Trusted harness image. Build before admitting any candidate source.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac
WORKDIR /harness
COPY . .
RUN chmod -R a+rX /harness && corepack enable && corepack pnpm install --frozen-lockfile \
    && mkdir /candidate /out \
    && find . -type d -name node_modules -prune -exec cp -a --parents {} /candidate \; \
    && chown pwuser:pwuser /out
ENV CI=true
