# Clawdis Gateway Dockerfile
# Multi-stage build for minimal image size
# Supports both ARM64 (Oracle Cloud Ampere) and x86_64

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files first for better caching
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# Build
RUN pnpm build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Runtime
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS runtime

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd --create-home --shell /bin/bash clawdis

# Install pnpm for runtime (needed for node_modules)
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create directories for volumes
RUN mkdir -p /home/clawdis/.clawdis/credentials \
    /home/clawdis/.clawdis/sessions \
    /home/clawdis/clawd \
    && chown -R clawdis:clawdis /home/clawdis /app

# Switch to non-root user
USER clawdis

# Set environment
ENV NODE_ENV=production
ENV HOME=/home/clawdis

# Expose gateway port
EXPOSE 18789

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:18789/health || exit 1

# Default command: run gateway
CMD ["node", "dist/index.js", "gateway", "--port", "18789", "--bind", "auto"]
