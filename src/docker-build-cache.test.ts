import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePaths = [
  "Dockerfile",
  "scripts/docker/sandbox/Dockerfile",
  "scripts/docker/sandbox/Dockerfile.browser",
  "scripts/docker/sandbox/Dockerfile.common",
  "scripts/docker/cleanup-smoke/Dockerfile",
  "scripts/docker/install-sh-smoke/Dockerfile",
  "scripts/docker/install-sh-e2e/Dockerfile",
  "scripts/docker/install-sh-nonroot/Dockerfile",
  "scripts/e2e/Dockerfile",
  "scripts/e2e/Dockerfile.qr-import",
] as const;
const aptCacheDockerfilePaths = dockerfilePaths.filter(
  (path) => path !== "scripts/e2e/Dockerfile.qr-import" && path !== "scripts/e2e/Dockerfile",
);
const shellContinuationDockerfilePaths = dockerfilePaths.filter(
  (path) =>
    path !== "Dockerfile" &&
    path !== "scripts/e2e/Dockerfile" &&
    path !== "scripts/e2e/Dockerfile.qr-import",
);
const repoFileCache = new Map<string, Promise<string>>();

async function readRepoFile(path: string): Promise<string> {
  let cached = repoFileCache.get(path);
  if (!cached) {
    cached = readFile(resolve(repoRoot, path), "utf8");
    repoFileCache.set(path, cached);
  }
  return cached;
}

function indexOfPattern(source: string, pattern: RegExp): number {
  return source.search(pattern);
}

describe("docker build cache layout", () => {
  beforeAll(async () => {
    await Promise.all(dockerfilePaths.map((path) => readRepoFile(path)));
  });

  it("keeps the root dependency layer independent from scripts changes", async () => {
    const dockerfile = await readRepoFile("Dockerfile");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const copyAllIndex = dockerfile.indexOf("COPY . .");
    const scriptsCopyIndex = dockerfile.indexOf("COPY scripts ./scripts");

    expect(installIndex).toBeGreaterThan(-1);
    expect(copyAllIndex).toBeGreaterThan(installIndex);
    if (scriptsCopyIndex === -1) {
      expect(scriptsCopyIndex).toBe(-1);
    } else {
      expect(scriptsCopyIndex).toBeGreaterThan(installIndex);
    }
  });

  it("uses pnpm cache mounts in Dockerfiles that install repo dependencies", async () => {
    for (const path of [
      "Dockerfile",
      "scripts/e2e/Dockerfile.qr-import",
      "scripts/docker/cleanup-smoke/Dockerfile",
    ]) {
      const dockerfile = await readRepoFile(path);
      expect(
        dockerfile,
        `${path} should use a shared pnpm store cache under the active user's home`,
      ).toMatch(
        /--mount=type=cache,id=openclaw-pnpm-store,target=\/(?:root|home\/appuser)\/\.local\/share\/pnpm\/store,sharing=locked/,
      );
    }
  });

  it("uses apt cache mounts in Dockerfiles that install system packages", async () => {
    for (const path of aptCacheDockerfilePaths) {
      const dockerfile = await readRepoFile(path);
      expect(dockerfile, `${path} should cache apt package archives`).toContain(
        "target=/var/cache/apt,sharing=locked",
      );
      expect(dockerfile, `${path} should cache apt metadata`).toContain(
        "target=/var/lib/apt,sharing=locked",
      );
    }
  });

  it("does not leave empty shell continuation lines in sandbox-common", async () => {
    const dockerfile = await readRepoFile("scripts/docker/sandbox/Dockerfile.common");
    expect(dockerfile).not.toContain("apt-get install -y --no-install-recommends ${PACKAGES} \\");
    expect(dockerfile).toContain(
      'RUN if [ "${INSTALL_PNPM}" = "1" ]; then npm install -g pnpm; fi',
    );
  });

  it("does not leave blank lines after shell continuation markers", async () => {
    for (const path of shellContinuationDockerfilePaths) {
      const dockerfile = await readRepoFile(path);
      expect(
        dockerfile,
        `${path} should not have blank lines after a trailing backslash`,
      ).not.toMatch(/\\\n\s*\n/);
    }
  });

  it("keeps the shared e2e image on the packaged tarball install path", async () => {
    const dockerfile = await readRepoFile("scripts/e2e/Dockerfile");

    expect(dockerfile).not.toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).not.toContain("COPY . .");
    expect(dockerfile).toMatch(
      /^COPY --from=openclaw_package --chown=appuser:appuser openclaw-current\.tgz \/tmp\/openclaw-current\.tgz$/m,
    );
    expect(dockerfile).toContain(
      "npm install -g --prefix /tmp/openclaw-prefix /tmp/openclaw-current.tgz --no-fund --no-audit",
    );
    expect(dockerfile).not.toContain(
      "cp -a /tmp/openclaw-prefix/lib/node_modules/. /app/node_modules/",
    );
    expect(dockerfile).toContain("cp -a /tmp/openclaw-prefix/lib/node_modules/openclaw/. /app/");
    expect(dockerfile).toContain("rm -rf /app/node_modules/openclaw");
    expect(dockerfile).toContain("ln -sf /app /app/node_modules/openclaw");
  });

  it("copies manifests before install in the qr-import image", async () => {
    const dockerfile = await readRepoFile("scripts/e2e/Dockerfile.qr-import");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");

    expect(
      indexOfPattern(
        dockerfile,
        /^COPY(?:\s+--chown=\S+)?\s+package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \.\/$/m,
      ),
    ).toBeLessThan(installIndex);
    expect(
      indexOfPattern(
        dockerfile,
        /^COPY(?:\s+--chown=\S+)?\s+ui\/package\.json \.\/ui\/package\.json$/m,
      ),
    ).toBeLessThan(installIndex);
    expect(dockerfile).toContain("This image only exercises the root QR runtime dependency path.");
    expect(
      indexOfPattern(
        dockerfile,
        /^COPY(?:\s+--chown=\S+)?\s+extensions\/memory-core\/package\.json \.\/extensions\/memory-core\/package\.json$/m,
      ),
    ).toBe(-1);
    expect(indexOfPattern(dockerfile, /^COPY(?:\s+--chown=\S+)?\s+\.\s+\.$/m)).toBeGreaterThan(
      installIndex,
    );
  });

  it("copies .npmrc before install in the cleanup smoke image", async () => {
    const dockerfile = await readRepoFile("scripts/docker/cleanup-smoke/Dockerfile");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");

    expect(
      indexOfPattern(
        dockerfile,
        /^COPY(?:\s+--chown=\S+)?\s+package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \.npmrc \.\/$/m,
      ),
    ).toBeLessThan(installIndex);
    expect(indexOfPattern(dockerfile, /^COPY(?:\s+--chown=\S+)?\s+\.\s+\.$/m)).toBeGreaterThan(
      installIndex,
    );
  });
});
