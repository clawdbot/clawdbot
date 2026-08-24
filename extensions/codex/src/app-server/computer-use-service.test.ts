// Codex tests cover native Computer Use service provisioning.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexComputerUseServiceApp } from "./computer-use-service.js";
import { resolveMacOSDesktopCodexComputerUseServiceAppCandidates } from "./desktop-app-paths.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const CLIENT_RELATIVE_PATH = path.join(
  "Contents",
  "SharedSupport",
  "SkyComputerUseClient.app",
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
);
const IDENTITY_FILE = ".test-signed-identity.json";

type EnsureParams = Parameters<typeof ensureCodexComputerUseServiceApp>[0];
type InspectServiceApp = NonNullable<EnsureParams["inspectServiceApp"]>;
type ServiceIdentity = NonNullable<Awaited<ReturnType<InspectServiceApp>>>;

const CURRENT_IDENTITY = serviceIdentity({
  version: "26.817.1000761",
  build: "1000761",
  cdHash: "current-service",
  clientCdHash: "current-client",
});
const STALE_IDENTITY = serviceIdentity({
  version: "26.721.1000502",
  build: "1000502",
  cdHash: "stale-service",
  clientCdHash: "stale-client",
});
const UNEXPECTED_IDENTITY = serviceIdentity({
  version: "26.900.1000900",
  build: "1000900",
  cdHash: "unexpected-service",
  clientCdHash: "unexpected-client",
});

describe("Codex Computer Use native service", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("creates a fresh agent tree and installs beneath the isolated Codex home", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "source", "Codex Computer Use.app");
    const codexHome = path.join(root, "agent", "codex-home");
    await writeServiceFixture(sourcePath, CURRENT_IDENTITY);

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp: copyServiceFixture,
      inspectServiceApp: inspectServiceFixture,
    });

    expect(result).toMatchObject({
      status: "installed",
      changed: true,
      sourcePath,
      sourceBuild: "1000761",
    });
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await expect(fs.access(path.join(targetPath, CLIENT_RELATIVE_PATH))).resolves.toBeUndefined();
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(CURRENT_IDENTITY);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked isolated Codex home without touching its external target",
    async () => {
      const root = tempDirs.make("openclaw-computer-use-service-symlink-");
      const sourcePath = path.join(root, "source", "Codex Computer Use.app");
      const agentDir = path.join(root, "agent");
      const codexHome = path.join(agentDir, "codex-home");
      const externalHome = path.join(root, "external-home");
      const externalParent = path.join(externalHome, "computer-use");
      const externalTarget = path.join(externalParent, "Codex Computer Use.app");
      const sentinelPath = path.join(externalParent, "sentinel.txt");
      await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
      await writeServiceFixture(externalTarget, STALE_IDENTITY);
      await fs.writeFile(sentinelPath, "outside");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.symlink(externalHome, codexHome);
      const externalInode = (await fs.lstat(externalTarget)).ino;
      const copyServiceApp = vi.fn(copyServiceFixture);

      await expect(
        ensureCodexComputerUseServiceApp({
          codexHome,
          platform: "darwin",
          sourceAppCandidates: [sourcePath],
          copyServiceApp,
          inspectServiceApp: inspectServiceFixture,
        }),
      ).rejects.toThrow(/symlinked directory|real directory|symbolic link/iu);

      expect(copyServiceApp).not.toHaveBeenCalled();
      expect((await fs.lstat(codexHome)).isSymbolicLink()).toBe(true);
      expect((await fs.lstat(externalTarget)).ino).toBe(externalInode);
      await expect(inspectServiceFixture(externalTarget)).resolves.toEqual(STALE_IDENTITY);
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("outside");
      await expect(findInstallDebris(externalParent)).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked ownership root without touching its external target",
    async () => {
      const root = tempDirs.make("openclaw-computer-use-service-symlink-");
      const sourcePath = path.join(root, "source", "Codex Computer Use.app");
      const ownershipRoot = path.join(root, "agent");
      const codexHome = path.join(ownershipRoot, "codex-home");
      const externalAgentRoot = path.join(root, "external-agent");
      const externalParent = path.join(externalAgentRoot, "codex-home", "computer-use");
      const externalTarget = path.join(externalParent, "Codex Computer Use.app");
      const sentinelPath = path.join(externalParent, "sentinel.txt");
      await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
      await writeServiceFixture(externalTarget, STALE_IDENTITY);
      await fs.writeFile(sentinelPath, "outside");
      await fs.symlink(externalAgentRoot, ownershipRoot);
      const externalInode = (await fs.lstat(externalTarget)).ino;
      const copyServiceApp = vi.fn(copyServiceFixture);

      await expect(
        ensureCodexComputerUseServiceApp({
          codexHome,
          ownershipRoot,
          platform: "darwin",
          sourceAppCandidates: [sourcePath],
          copyServiceApp,
          inspectServiceApp: inspectServiceFixture,
        }),
      ).rejects.toThrow(/symlinked directory|real director|symbolic link/iu);

      expect(copyServiceApp).not.toHaveBeenCalled();
      expect((await fs.lstat(ownershipRoot)).isSymbolicLink()).toBe(true);
      expect((await fs.lstat(externalTarget)).ino).toBe(externalInode);
      await expect(inspectServiceFixture(externalTarget)).resolves.toEqual(STALE_IDENTITY);
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("outside");
      await expect(findInstallDebris(externalParent)).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked Computer Use parent without touching its external target",
    async () => {
      const root = tempDirs.make("openclaw-computer-use-service-symlink-");
      const sourcePath = path.join(root, "source", "Codex Computer Use.app");
      const codexHome = path.join(root, "codex-home");
      const targetParent = path.join(codexHome, "computer-use");
      const externalParent = path.join(root, "external-computer-use");
      const externalTarget = path.join(externalParent, "Codex Computer Use.app");
      const sentinelPath = path.join(externalParent, "sentinel.txt");
      await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
      await writeServiceFixture(externalTarget, STALE_IDENTITY);
      await fs.writeFile(sentinelPath, "outside");
      await fs.mkdir(codexHome, { recursive: true });
      await fs.symlink(externalParent, targetParent);
      const externalInode = (await fs.lstat(externalTarget)).ino;
      const copyServiceApp = vi.fn(copyServiceFixture);

      await expect(
        ensureCodexComputerUseServiceApp({
          codexHome,
          platform: "darwin",
          sourceAppCandidates: [sourcePath],
          copyServiceApp,
          inspectServiceApp: inspectServiceFixture,
        }),
      ).rejects.toThrow(/symlinked directory|real directory|symbolic link/iu);

      expect(copyServiceApp).not.toHaveBeenCalled();
      expect((await fs.lstat(targetParent)).isSymbolicLink()).toBe(true);
      expect((await fs.lstat(externalTarget)).ino).toBe(externalInode);
      await expect(inspectServiceFixture(externalTarget)).resolves.toEqual(STALE_IDENTITY);
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("outside");
      await expect(findInstallDebris(externalParent)).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked service target without following its external app",
    async () => {
      const root = tempDirs.make("openclaw-computer-use-service-symlink-");
      const sourcePath = path.join(root, "source", "Codex Computer Use.app");
      const codexHome = path.join(root, "codex-home");
      const targetParent = path.join(codexHome, "computer-use");
      const targetPath = path.join(targetParent, "Codex Computer Use.app");
      const externalTarget = path.join(root, "external", "Codex Computer Use.app");
      await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
      await writeServiceFixture(externalTarget, STALE_IDENTITY);
      await fs.mkdir(targetParent, { recursive: true });
      await fs.symlink(externalTarget, targetPath);
      const externalInode = (await fs.lstat(externalTarget)).ino;
      const copyServiceApp = vi.fn(copyServiceFixture);

      await expect(
        ensureCodexComputerUseServiceApp({
          codexHome,
          platform: "darwin",
          sourceAppCandidates: [sourcePath],
          copyServiceApp,
          inspectServiceApp: inspectServiceFixture,
        }),
      ).rejects.toThrow(/must not be a symbolic link/iu);

      expect(copyServiceApp).not.toHaveBeenCalled();
      expect((await fs.lstat(targetPath)).isSymbolicLink()).toBe(true);
      await expect(fs.readlink(targetPath)).resolves.toBe(externalTarget);
      expect((await fs.lstat(externalTarget)).ino).toBe(externalInode);
      await expect(inspectServiceFixture(externalTarget)).resolves.toEqual(STALE_IDENTITY);
      await expect(findInstallDebris(targetParent)).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses to publish or clean up through a parent rebound during staging",
    async () => {
      const root = tempDirs.make("openclaw-computer-use-service-rebind-");
      const sourcePath = path.join(root, "source", "Codex Computer Use.app");
      const codexHome = path.join(root, "codex-home");
      const targetParent = path.join(codexHome, "computer-use");
      const targetPath = path.join(targetParent, "Codex Computer Use.app");
      const parkedParent = path.join(codexHome, "computer-use-owned");
      const externalParent = path.join(root, "external-computer-use");
      const externalTarget = path.join(externalParent, "Codex Computer Use.app");
      const externalSentinel = path.join(externalParent, "sentinel.txt");
      await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
      await writeServiceFixture(targetPath, STALE_IDENTITY);
      await writeServiceFixture(externalTarget, UNEXPECTED_IDENTITY);
      await fs.writeFile(externalSentinel, "outside");
      const externalInode = (await fs.lstat(externalTarget)).ino;
      let externalStagingSentinel = "";

      await expect(
        ensureCodexComputerUseServiceApp({
          codexHome,
          platform: "darwin",
          sourceAppCandidates: [sourcePath],
          copyServiceApp: async (source, stagedTarget) => {
            await copyServiceFixture(source, stagedTarget);
            const stagingName = path.basename(path.dirname(stagedTarget));
            externalStagingSentinel = path.join(
              externalParent,
              stagingName,
              "external-sentinel.txt",
            );
            await fs.mkdir(path.dirname(externalStagingSentinel), { recursive: true });
            await fs.writeFile(externalStagingSentinel, "do-not-delete");
            await fs.rename(targetParent, parkedParent);
            await fs.symlink(externalParent, targetParent);
          },
          inspectServiceApp: inspectServiceFixture,
        }),
      ).rejects.toThrow(/service parent changed during refresh/iu);

      expect(externalStagingSentinel).not.toBe("");
      await expect(fs.readFile(externalStagingSentinel, "utf8")).resolves.toBe("do-not-delete");
      await expect(fs.readFile(externalSentinel, "utf8")).resolves.toBe("outside");
      expect((await fs.lstat(externalTarget)).ino).toBe(externalInode);
      await expect(inspectServiceFixture(externalTarget)).resolves.toEqual(UNEXPECTED_IDENTITY);
      await expect(
        inspectServiceFixture(path.join(parkedParent, "Codex Computer Use.app")),
      ).resolves.toEqual(STALE_IDENTITY);
      await expect(
        findInstallDebris(externalParent).then((entries) =>
          entries.filter((entry) => entry.startsWith(".service-app.backup-")),
        ),
      ).resolves.toEqual([]);
    },
  );

  it("reuses a target only when its full signed identity matches the selected source", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "source", "Codex Computer Use.app");
    const codexHome = path.join(root, "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
    await writeServiceFixture(targetPath, CURRENT_IDENTITY);
    const copyServiceApp = vi.fn();

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp,
      inspectServiceApp: inspectServiceFixture,
    });

    expect(result).toMatchObject({
      status: "already_current",
      changed: false,
      sourceBuild: "1000761",
    });
    expect(copyServiceApp).not.toHaveBeenCalled();
  });

  it("reuses a completed process-lifetime sync without repeated signature inspection", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "source", "Codex Computer Use.app");
    const codexHome = path.join(root, "codex-home");
    await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
    const copyServiceApp = vi.fn(copyServiceFixture);
    const inspectServiceApp = vi.fn(inspectServiceFixture);

    const first = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp,
      inspectServiceApp,
    });
    expect(first.status).toBe("installed");
    const inspectionCount = inspectServiceApp.mock.calls.length;
    const copyCount = copyServiceApp.mock.calls.length;

    const second = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp,
      inspectServiceApp,
    });

    expect(second).toMatchObject({
      status: "already_current",
      changed: false,
      sourceBuild: "1000761",
    });
    expect(inspectServiceApp).toHaveBeenCalledTimes(inspectionCount);
    expect(copyServiceApp).toHaveBeenCalledTimes(copyCount);
  });

  it("bounds completed synchronization state and re-inspects an evicted home", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-cache-");
    const sourcePath = path.join(root, "source", "Codex Computer Use.app");
    await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
    const inspectServiceApp = vi.fn(inspectServiceFixture);
    const codexHomes = Array.from({ length: 65 }, (_, index) =>
      path.join(root, `codex-home-${index}`),
    );
    const oldestCodexHome = codexHomes[0];
    if (!oldestCodexHome) {
      throw new Error("expected at least one Codex home fixture");
    }

    for (const codexHome of codexHomes) {
      const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
      await writeServiceFixture(targetPath, CURRENT_IDENTITY);
      await ensureCodexComputerUseServiceApp({
        codexHome,
        platform: "darwin",
        sourceAppCandidates: [sourcePath],
        inspectServiceApp,
      });
    }

    const inspectionsBeforeRecall = inspectServiceApp.mock.calls.length;
    await expect(
      ensureCodexComputerUseServiceApp({
        codexHome: oldestCodexHome,
        platform: "darwin",
        sourceAppCandidates: [sourcePath],
        inspectServiceApp,
      }),
    ).resolves.toMatchObject({ status: "already_current", changed: false });
    expect(inspectServiceApp.mock.calls.length).toBeGreaterThan(inspectionsBeforeRecall);
  });

  it("invalidates a completed selection before a different selection fails", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const firstSourcePath = path.join(root, "first", "Codex Computer Use.app");
    const failingSourcePath = path.join(root, "failing", "Codex Computer Use.app");
    const codexHome = path.join(root, "codex-home");
    await writeServiceFixture(firstSourcePath, CURRENT_IDENTITY);
    await writeServiceFixture(failingSourcePath, UNEXPECTED_IDENTITY);
    const inspectServiceApp = vi.fn(inspectServiceFixture);

    await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [firstSourcePath],
      copyServiceApp: copyServiceFixture,
      inspectServiceApp,
    });
    await expect(
      ensureCodexComputerUseServiceApp({
        codexHome,
        platform: "darwin",
        sourceAppCandidates: [failingSourcePath],
        copyServiceApp: async (source, target) => {
          await copyServiceFixture(source, target);
          await writeFixtureIdentity(target, STALE_IDENTITY);
        },
        inspectServiceApp,
      }),
    ).rejects.toThrow("does not match its selected signed source");
    const inspectionsAfterFailure = inspectServiceApp.mock.calls.length;

    await expect(
      ensureCodexComputerUseServiceApp({
        codexHome,
        platform: "darwin",
        sourceAppCandidates: [firstSourcePath],
        copyServiceApp: copyServiceFixture,
        inspectServiceApp,
      }),
    ).resolves.toMatchObject({ status: "already_current", changed: false });
    expect(inspectServiceApp.mock.calls.length).toBeGreaterThan(inspectionsAfterFailure);
  });

  it("refreshes a complete but stale signed generation through the staged swap", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "source", "Codex Computer Use.app");
    const codexHome = path.join(root, "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
    await writeServiceFixture(targetPath, STALE_IDENTITY);

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp: copyServiceFixture,
      inspectServiceApp: inspectServiceFixture,
    });

    expect(result).toMatchObject({
      status: "refreshed",
      changed: true,
      previousBuild: "1000502",
      sourceBuild: "1000761",
    });
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(CURRENT_IDENTITY);
  });

  it("reports a missing or untrusted source without changing the target", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "untrusted", "Codex Computer Use.app");
    const codexHome = path.join(root, "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeExecutableClient(sourcePath);
    await writeServiceFixture(targetPath, STALE_IDENTITY);

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [path.join(root, "missing.app"), sourcePath],
      copyServiceApp: copyServiceFixture,
      inspectServiceApp: inspectServiceFixture,
    });

    expect(result).toMatchObject({ status: "source_missing", changed: false });
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(STALE_IDENTITY);
  });

  it("replaces an incomplete home-owned service app", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "source", "Codex Computer Use.app");
    const codexHome = path.join(root, "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(path.join(targetPath, "partial"), "incomplete");

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp: copyServiceFixture,
      inspectServiceApp: inspectServiceFixture,
    });

    expect(result).toMatchObject({ status: "refreshed", changed: true });
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(CURRENT_IDENTITY);
    await expect(fs.access(path.join(targetPath, "partial"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves the previous target when the staged copy does not match its source", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "source", "Codex Computer Use.app");
    const codexHome = path.join(root, "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
    await writeServiceFixture(targetPath, STALE_IDENTITY);

    await expect(
      ensureCodexComputerUseServiceApp({
        codexHome,
        platform: "darwin",
        sourceAppCandidates: [sourcePath],
        copyServiceApp: async (source, target) => {
          await copyServiceFixture(source, target);
          await writeFixtureIdentity(target, UNEXPECTED_IDENTITY);
        },
        inspectServiceApp: inspectServiceFixture,
      }),
    ).rejects.toThrow("does not match its selected signed source");

    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(STALE_IDENTITY);
    await expect(findInstallDebris(path.dirname(targetPath))).resolves.toEqual([]);
  });

  it("keeps a concurrent installer that wins with the same selected identity", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "source", "Codex Computer Use.app");
    const codexHome = path.join(root, "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
    await writeServiceFixture(targetPath, STALE_IDENTITY);

    const result = await ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [sourcePath],
      copyServiceApp: async (source, target) => {
        await copyServiceFixture(source, target);
        await writeFixtureIdentity(targetPath, CURRENT_IDENTITY);
      },
      inspectServiceApp: inspectServiceFixture,
    });

    expect(result).toMatchObject({ status: "already_current", changed: false });
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(CURRENT_IDENTITY);
    await expect(findInstallDebris(path.dirname(targetPath))).resolves.toEqual([]);
  });

  it("restores an unexpected concurrent generation instead of overwriting it", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const sourcePath = path.join(root, "source", "Codex Computer Use.app");
    const codexHome = path.join(root, "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceFixture(sourcePath, CURRENT_IDENTITY);
    await writeServiceFixture(targetPath, STALE_IDENTITY);

    await expect(
      ensureCodexComputerUseServiceApp({
        codexHome,
        platform: "darwin",
        sourceAppCandidates: [sourcePath],
        copyServiceApp: async (source, target) => {
          await copyServiceFixture(source, target);
          await writeFixtureIdentity(targetPath, UNEXPECTED_IDENTITY);
        },
        inspectServiceApp: inspectServiceFixture,
      }),
    ).rejects.toThrow("changed to an unexpected generation");

    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(UNEXPECTED_IDENTITY);
    await expect(findInstallDebris(path.dirname(targetPath))).resolves.toEqual([]);
  });

  it("serializes different selected sources and invalidates the prior completed selection", async () => {
    const root = tempDirs.make("openclaw-computer-use-service-");
    const firstSourcePath = path.join(root, "first", "Codex Computer Use.app");
    const secondSourcePath = path.join(root, "second", "Codex Computer Use.app");
    const codexHome = path.join(root, "codex-home");
    const targetPath = path.join(codexHome, "computer-use", "Codex Computer Use.app");
    await writeServiceFixture(firstSourcePath, CURRENT_IDENTITY);
    await writeServiceFixture(secondSourcePath, UNEXPECTED_IDENTITY);
    const firstCopyStarted = createDeferred<void>();
    const firstCopyGate = createDeferred<void>();
    let activeCopies = 0;
    let maxActiveCopies = 0;
    const copyServiceApp = vi.fn(async (source: string, target: string) => {
      activeCopies += 1;
      maxActiveCopies = Math.max(maxActiveCopies, activeCopies);
      try {
        if (source === firstSourcePath) {
          firstCopyStarted.resolve();
          await firstCopyGate.promise;
        }
        await copyServiceFixture(source, target);
      } finally {
        activeCopies -= 1;
      }
    });

    const first = ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [firstSourcePath],
      copyServiceApp,
      inspectServiceApp: inspectServiceFixture,
    });
    await firstCopyStarted.promise;
    const second = ensureCodexComputerUseServiceApp({
      codexHome,
      platform: "darwin",
      sourceAppCandidates: [secondSourcePath],
      copyServiceApp,
      inspectServiceApp: inspectServiceFixture,
    });
    firstCopyGate.resolve();

    await expect(first).resolves.toMatchObject({
      status: "installed",
      sourceBuild: "1000761",
    });
    await expect(second).resolves.toMatchObject({
      status: "refreshed",
      previousBuild: "1000761",
      sourceBuild: "1000900",
    });
    await expect(
      ensureCodexComputerUseServiceApp({
        codexHome,
        platform: "darwin",
        sourceAppCandidates: [firstSourcePath],
        copyServiceApp,
        inspectServiceApp: inspectServiceFixture,
      }),
    ).resolves.toMatchObject({
      status: "refreshed",
      previousBuild: "1000900",
      sourceBuild: "1000761",
    });
    expect(maxActiveCopies).toBe(1);
    expect(copyServiceApp.mock.calls.map(([source]) => source)).toEqual([
      firstSourcePath,
      secondSourcePath,
      firstSourcePath,
    ]);
    await expect(inspectServiceFixture(targetPath)).resolves.toEqual(CURRENT_IDENTITY);
  });

  it("does not provision the macOS service on other platforms", async () => {
    const inspectServiceApp = vi.fn();
    const result = await ensureCodexComputerUseServiceApp({
      codexHome: "/tmp/codex-home",
      platform: "linux",
      inspectServiceApp,
    });

    expect(result).toEqual({ status: "unsupported", changed: false });
    expect(inspectServiceApp).not.toHaveBeenCalled();
  });

  it("prefers service assets owned by the selected desktop app-server", () => {
    expect(
      resolveMacOSDesktopCodexComputerUseServiceAppCandidates(
        "darwin",
        "/Applications/Codex.app/Contents/Resources/codex",
      )[0],
    ).toBe(
      "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app",
    );
  });
});

function serviceIdentity(
  overrides: Pick<ServiceIdentity, "version" | "build" | "cdHash" | "clientCdHash">,
): ServiceIdentity {
  return {
    bundleId: "com.openai.sky.CUAService",
    teamId: "2DC432GLL2",
    clientBundleId: "com.openai.sky.CUAService.cli",
    clientTeamId: "2DC432GLL2",
    ...overrides,
  };
}

async function writeServiceFixture(appPath: string, identity: ServiceIdentity): Promise<void> {
  await writeExecutableClient(appPath);
  await fs.writeFile(path.join(appPath, "Contents", "Info.plist"), "fixture");
  await writeFixtureIdentity(appPath, identity);
}

async function writeFixtureIdentity(appPath: string, identity: ServiceIdentity): Promise<void> {
  await fs.writeFile(path.join(appPath, IDENTITY_FILE), JSON.stringify(identity));
}

async function inspectServiceFixture(appPath: string): Promise<ServiceIdentity | undefined> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(appPath, IDENTITY_FILE), "utf8"),
    ) as ServiceIdentity;
  } catch {
    return undefined;
  }
}

async function copyServiceFixture(sourcePath: string, targetPath: string): Promise<void> {
  await fs.cp(sourcePath, targetPath, { recursive: true });
}

async function writeExecutableClient(appPath: string): Promise<void> {
  const clientPath = path.join(appPath, CLIENT_RELATIVE_PATH);
  await fs.mkdir(path.dirname(clientPath), { recursive: true });
  await fs.writeFile(clientPath, "client");
  await fs.chmod(clientPath, 0o755);
}

async function findInstallDebris(targetParent: string): Promise<string[]> {
  return (await fs.readdir(targetParent)).filter(
    (entry) =>
      entry.startsWith(".service-app.staging-") || entry.startsWith(".service-app.backup-"),
  );
}
