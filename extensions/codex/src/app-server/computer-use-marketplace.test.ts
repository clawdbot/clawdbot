import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCodexManagedBundledMarketplace,
  resolveCodexManagedBundledMarketplacePath,
} from "./computer-use-marketplace.js";
import type { MacOSDesktopCodexAppPathCandidate } from "./desktop-app-paths.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

describe("managed Codex bundled marketplace", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes a real reserved root with links to the selected desktop marketplace", async () => {
    const root = tempDirs.make("openclaw-codex-marketplace-");
    const candidate = await writeCandidate(root);
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");

    const result = await ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      appServerCommand: candidate.appServerCommandPath,
      candidates: [candidate],
    });

    const target = resolveCodexManagedBundledMarketplacePath(codexHome);
    expect(result).toBe(target);
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
    expect(await fs.realpath(target)).toBe(target);
    expect(await fs.readlink(path.join(target, "plugins"))).toBe(
      path.join(candidate.bundledMarketplacePath, "plugins"),
    );
    await expect(
      ensureCodexManagedBundledMarketplace({
        codexHome,
        ownershipRoot: agentDir,
        candidates: [candidate],
      }),
    ).resolves.toBe(target);
  });

  it("coalesces concurrent publication without leaving swap debris", async () => {
    const root = tempDirs.make("openclaw-codex-marketplace-concurrent-");
    const candidate = await writeCandidate(root);
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        ensureCodexManagedBundledMarketplace({
          codexHome,
          ownershipRoot: agentDir,
          candidates: [candidate],
        }),
      ),
    );

    const target = resolveCodexManagedBundledMarketplacePath(codexHome);
    expect(results).toEqual([target, target, target]);
    expect(await fs.readlink(path.join(target, "plugins"))).toBe(
      path.join(candidate.bundledMarketplacePath, "plugins"),
    );
    expect(
      (await fs.readdir(path.dirname(target))).filter((entry) =>
        entry.startsWith(".openai-bundled"),
      ),
    ).toEqual([]);
  });

  it("converges a concurrent replacement to the newly selected desktop source", async () => {
    const root = tempDirs.make("openclaw-codex-marketplace-transition-");
    const firstCandidate = await writeCandidate(path.join(root, "first"));
    const secondCandidate = await writeCandidate(path.join(root, "second"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    const target = resolveCodexManagedBundledMarketplacePath(codexHome);
    const firstPublishStarted = createDeferred<void>();
    const releaseFirstPublish = createDeferred<void>();
    const rename = fs.rename.bind(fs);
    let heldFirstPublish = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (!heldFirstPublish && destination === target) {
        heldFirstPublish = true;
        firstPublishStarted.resolve();
        await releaseFirstPublish.promise;
      }
      return await rename(source, destination);
    });

    const first = ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      appServerCommand: firstCandidate.appServerCommandPath,
      candidates: [firstCandidate],
      ownershipCandidates: [firstCandidate, secondCandidate],
    });
    await firstPublishStarted.promise;
    const second = ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      appServerCommand: secondCandidate.appServerCommandPath,
      candidates: [secondCandidate],
      ownershipCandidates: [firstCandidate, secondCandidate],
    });
    releaseFirstPublish.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([target, target]);
    expect(await fs.readlink(path.join(target, "plugins"))).toBe(
      path.join(secondCandidate.bundledMarketplacePath, "plugins"),
    );
    expect(
      (await fs.readdir(path.dirname(target))).filter((entry) =>
        entry.startsWith(".openai-bundled"),
      ),
    ).toEqual([]);
  });

  it("does not let a matching fast path outrun a conflicting publication", async () => {
    const root = tempDirs.make("openclaw-codex-marketplace-conflict-");
    const firstCandidate = await writeCandidate(path.join(root, "first"));
    const secondCandidate = await writeCandidate(path.join(root, "second"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    const target = resolveCodexManagedBundledMarketplacePath(codexHome);
    const ownershipCandidates = [firstCandidate, secondCandidate];
    await ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      candidates: [secondCandidate],
      ownershipCandidates,
    });

    const firstStagingStarted = createDeferred<void>();
    const releaseFirstStaging = createDeferred<void>();
    const createStagingDir = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async (prefix, options) => {
      firstStagingStarted.resolve();
      await releaseFirstStaging.promise;
      return await createStagingDir(prefix, options);
    });
    const first = ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      candidates: [firstCandidate],
      ownershipCandidates,
    });
    await firstStagingStarted.promise;
    const lstat = fs.lstat.bind(fs);
    let firstReleased = false;
    let targetChecksBeforeRelease = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (filePath, options) => {
      if (path.resolve(String(filePath)) === target && !firstReleased) {
        targetChecksBeforeRelease += 1;
        if (targetChecksBeforeRelease > 1) {
          throw new Error("conflicting wrapper fast path ran before active publication settled");
        }
        setImmediate(() => {
          firstReleased = true;
          releaseFirstStaging.resolve();
        });
      }
      return await lstat(filePath, options);
    });
    const second = ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      candidates: [secondCandidate],
      ownershipCandidates,
    });
    const results = await Promise.allSettled([first, second]);

    expect(targetChecksBeforeRelease).toBe(1);
    expect(results).toEqual([
      { status: "fulfilled", value: target },
      { status: "fulfilled", value: target },
    ]);
    expect(await fs.readlink(path.join(target, "plugins"))).toBe(
      path.join(secondCandidate.bundledMarketplacePath, "plugins"),
    );
  });

  it("replaces a prior owned wrapper when desktop app selection changes", async () => {
    const root = tempDirs.make("openclaw-codex-marketplace-owner-transition-");
    const firstCandidate = await writeCandidate(path.join(root, "first"));
    const secondCandidate = await writeCandidate(path.join(root, "second"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    const target = resolveCodexManagedBundledMarketplacePath(codexHome);
    const ownershipCandidates = [firstCandidate, secondCandidate];

    await ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      appServerCommand: firstCandidate.appServerCommandPath,
      candidates: [firstCandidate],
      ownershipCandidates,
    });
    await ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      appServerCommand: secondCandidate.appServerCommandPath,
      candidates: [secondCandidate],
      ownershipCandidates,
    });

    expect(await fs.readlink(path.join(target, "plugins"))).toBe(
      path.join(secondCandidate.bundledMarketplacePath, "plugins"),
    );
  });

  it("leaves the prior wrapper intact when its generation becomes stale before publication", async () => {
    const root = tempDirs.make("openclaw-codex-marketplace-stale-");
    const firstCandidate = await writeCandidate(path.join(root, "first"));
    const secondCandidate = await writeCandidate(path.join(root, "second"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    const target = resolveCodexManagedBundledMarketplacePath(codexHome);
    const ownershipCandidates = [firstCandidate, secondCandidate];
    await ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      candidates: [firstCandidate],
      ownershipCandidates,
    });

    let currentnessChecks = 0;
    await expect(
      ensureCodexManagedBundledMarketplace({
        codexHome,
        ownershipRoot: agentDir,
        candidates: [secondCandidate],
        ownershipCandidates,
        assertCurrent: () => {
          currentnessChecks += 1;
          if (currentnessChecks === 2) {
            throw new Error("desktop generation is stale");
          }
        },
      }),
    ).rejects.toThrow("desktop generation is stale");
    expect(currentnessChecks).toBe(2);

    expect(await fs.readlink(path.join(target, "plugins"))).toBe(
      path.join(firstCandidate.bundledMarketplacePath, "plugins"),
    );
    expect(
      (await fs.readdir(path.dirname(target))).filter((entry) =>
        entry.startsWith(".openai-bundled"),
      ),
    ).toEqual([]);
  });

  it("does not replace an unowned directory at the reserved managed path", async () => {
    const root = tempDirs.make("openclaw-codex-marketplace-unowned-");
    const candidate = await writeCandidate(root);
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    const target = resolveCodexManagedBundledMarketplacePath(codexHome);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "sentinel"), "operator-owned");

    await expect(
      ensureCodexManagedBundledMarketplace({
        codexHome,
        ownershipRoot: agentDir,
        candidates: [candidate],
      }),
    ).rejects.toThrow("unowned bundled marketplace");
    await expect(fs.readFile(path.join(target, "sentinel"), "utf8")).resolves.toBe(
      "operator-owned",
    );
  });

  it("restores the prior managed wrapper when publication fails after backup", async () => {
    const root = tempDirs.make("openclaw-codex-marketplace-rollback-");
    const firstCandidate = await writeCandidate(path.join(root, "first"));
    const secondCandidate = await writeCandidate(path.join(root, "second"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    const target = resolveCodexManagedBundledMarketplacePath(codexHome);
    await ensureCodexManagedBundledMarketplace({
      codexHome,
      ownershipRoot: agentDir,
      appServerCommand: firstCandidate.appServerCommandPath,
      candidates: [firstCandidate, secondCandidate],
    });
    const rename = fs.rename.bind(fs);
    let renameCount = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      renameCount += 1;
      if (renameCount === 2) {
        throw new Error("injected publish failure");
      }
      return await rename(source, destination);
    });

    await expect(
      ensureCodexManagedBundledMarketplace({
        codexHome,
        ownershipRoot: agentDir,
        appServerCommand: secondCandidate.appServerCommandPath,
        candidates: [firstCandidate, secondCandidate],
      }),
    ).rejects.toThrow("injected publish failure");

    expect(await fs.readlink(path.join(target, "plugins"))).toBe(
      path.join(firstCandidate.bundledMarketplacePath, "plugins"),
    );
    expect(
      (await fs.readdir(path.dirname(target))).filter((entry) =>
        entry.startsWith(".openai-bundled"),
      ),
    ).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked isolated home without touching its external target",
    async () => {
      const root = tempDirs.make("openclaw-codex-marketplace-home-link-");
      const candidate = await writeCandidate(root);
      const agentDir = path.join(root, "agent");
      const external = path.join(root, "external");
      const codexHome = path.join(agentDir, "codex-home");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.mkdir(external, { recursive: true });
      await fs.writeFile(path.join(external, "sentinel"), "outside");
      await fs.symlink(external, codexHome, "dir");

      await expect(
        ensureCodexManagedBundledMarketplace({
          codexHome,
          ownershipRoot: agentDir,
          candidates: [candidate],
        }),
      ).rejects.toThrow(/symlink|symbolic link|real directories/u);
      await expect(fs.readFile(path.join(external, "sentinel"), "utf8")).resolves.toBe("outside");
      await expect(fs.access(path.join(external, ".tmp"))).rejects.toThrow();
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not publish through a marketplace parent rebound during the staged swap",
    async () => {
      const root = tempDirs.make("openclaw-codex-marketplace-rebind-");
      const candidate = await writeCandidate(root);
      const agentDir = path.join(root, "agent");
      const codexHome = path.join(agentDir, "codex-home");
      const target = resolveCodexManagedBundledMarketplacePath(codexHome);
      const parent = path.dirname(target);
      const movedParent = `${parent}.moved`;
      const external = path.join(root, "external");
      await fs.mkdir(external, { recursive: true });
      await fs.writeFile(path.join(external, "sentinel"), "outside");
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementationOnce(async (source, destination) => {
        await rename(parent, movedParent);
        await fs.symlink(external, parent, "dir");
        return await rename(source, destination);
      });

      await expect(
        ensureCodexManagedBundledMarketplace({
          codexHome,
          ownershipRoot: agentDir,
          candidates: [candidate],
        }),
      ).rejects.toThrow();
      await expect(fs.readFile(path.join(external, "sentinel"), "utf8")).resolves.toBe("outside");
      await expect(fs.access(path.join(external, "openai-bundled"))).rejects.toThrow();
    },
  );
});

async function writeCandidate(root: string): Promise<MacOSDesktopCodexAppPathCandidate> {
  const appBundlePath = path.join(root, "ChatGPT.app");
  const bundledMarketplacePath = path.join(appBundlePath, "openai-bundled");
  await fs.mkdir(path.join(bundledMarketplacePath, ".agents", "plugins"), { recursive: true });
  await fs.mkdir(path.join(bundledMarketplacePath, "plugins", "computer-use", ".codex-plugin"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(bundledMarketplacePath, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({ name: "openai-bundled", plugins: [{ name: "computer-use" }] }),
  );
  await fs.writeFile(
    path.join(bundledMarketplacePath, "plugins", "computer-use", ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "computer-use", version: "1.0.0" }),
  );
  return {
    appName: "ChatGPT.app",
    appBundlePath,
    appServerCommandPath: path.join(appBundlePath, "codex"),
    bundledMarketplacePath,
    computerUseServiceAppPaths: [],
  };
}
