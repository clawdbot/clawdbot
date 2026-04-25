import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

function indexOfPattern(source: string, pattern: RegExp): number {
  return source.search(pattern);
}

describe("docker build cache layout", () => {
  it("keeps the root dependency layer independent from scripts changes", async () => {
    const dockerfile = await readRepoFile("Dockerfile");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const copyAllIndex = dockerfile.indexOf("COPY . .");
    const scriptsCopyIndex = dockerfile.indexOf("COPY scripts ./scripts");

    expect(installIndex).toBeGreaterThan(-1);
    expect(copyAllIndex).toBeGreaterThan(installIndex);
    expect(scriptsCopyIndex === -1 || scriptsCopyIndex > installIndex).toBe(true);
  });

  it("uses pnpm cache mounts in Dockerfiles that install repo dependencies", async () => {
    for (const path of [
      "Dockerfile",
      "scripts/e2e/Dockerfile",
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
    for (const path of [
      "Dockerfile",
      "Dockerfile.sandbox",
      "Dockerfile.sandbox-browser",
      "Dockerfile.sandbox-common",
      "scripts/docker/cleanup-smoke/Dockerfile",
      "scripts/docker/install-sh-smoke/Dockerfile",
      "scripts/docker/install-sh-e2e/Dockerfile",
      "scripts/docker/install-sh-nonroot/Dockerfile",
    ]) {
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
    const dockerfile = await readRepoFile("Dockerfile.sandbox-common");
    expect(dockerfile).not.toContain("apt-get install -y --no-install-recommends ${PACKAGES} \\");
    expect(dockerfile).toContain(
      'RUN if [ "${INSTALL_PNPM}" = "1" ]; then npm install -g pnpm; fi',
    );
  });

  it("does not leave blank lines after shell continuation markers", async () => {
    for (const path of [
      "Dockerfile.sandbox",
      "Dockerfile.sandbox-browser",
      "Dockerfile.sandbox-common",
      "scripts/docker/cleanup-smoke/Dockerfile",
      "scripts/docker/install-sh-smoke/Dockerfile",
      "scripts/docker/install-sh-e2e/Dockerfile",
      "scripts/docker/install-sh-nonroot/Dockerfile",
    ]) {
      const dockerfile = await readRepoFile(path);
      expect(
        dockerfile,
        `${path} should not have blank lines after a trailing backslash`,
      ).not.toMatch(/\\\n\s*\n/);
    }
  });

  it("copies only install inputs before pnpm install in the e2e image", async () => {
    const dockerfile = await readRepoFile("scripts/e2e/Dockerfile");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const expectPatternBeforeInstall = (pattern: RegExp) => {
      const index = indexOfPattern(dockerfile, pattern);
      expect(index).toBeGreaterThan(-1);
      expect(index).toBeLessThan(installIndex);
    };
    const expectPatternAfterInstall = (pattern: RegExp) => {
      const index = indexOfPattern(dockerfile, pattern);
      expect(index).toBeGreaterThan(installIndex);
    };

    expectPatternBeforeInstall(
      /^COPY(?:\s+--chown=\S+)?\s+package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \.npmrc \.\/$/m,
    );
    expectPatternBeforeInstall(
      /^COPY(?:\s+--chown=\S+)?\s+ui\/package\.json \.\/ui\/package\.json$/m,
    );
    expectPatternBeforeInstall(
      /^RUN --mount=type=bind,source=extensions,target=\/tmp\/extensions,readonly\s+\\$/m,
    );
    expectPatternBeforeInstall(/^COPY(?:\s+--chown=\S+)?\s+patches \.\/patches$/m);
    expectPatternBeforeInstall(
      /^COPY(?:\s+--chown=\S+)?\s+scripts\/postinstall-bundled-plugins\.mjs scripts\/preinstall-package-manager-warning\.mjs scripts\/npm-runner\.mjs scripts\/windows-cmd-helpers\.mjs \.\/scripts\/$/m,
    );
    expectPatternAfterInstall(
      /^COPY(?:\s+--chown=\S+)?\s+tsconfig\.json tsconfig\.plugin-sdk\.dts\.json tsdown\.config\.ts vitest\.config\.ts openclaw\.mjs \.\/$/m,
    );
    expectPatternAfterInstall(/^COPY(?:\s+--chown=\S+)?\s+src \.\/src$/m);
    expectPatternAfterInstall(/^COPY(?:\s+--chown=\S+)?\s+test \.\/test$/m);
    expectPatternAfterInstall(/^COPY(?:\s+--chown=\S+)?\s+scripts \.\/scripts$/m);
    expectPatternAfterInstall(/^COPY(?:\s+--chown=\S+)?\s+ui \.\/ui$/m);
    expectPatternAfterInstall(
      /^COPY(?:\s+--link)?(?:\s+--chown=\S+)?\s+extensions \.\/extensions$/m,
    );
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
