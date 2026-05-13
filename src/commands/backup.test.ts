import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import * as backupShared from "./backup-shared.js";
import {
  buildBackupArchiveRoot,
  encodeAbsolutePathForBackupArchive,
  type BackupAsset,
  resolveBackupPlanFromPaths,
  resolveBackupPlanFromDisk,
} from "./backup-shared.js";
import {
  backupVerifyCommandMock,
  createBackupTestRuntime,
  mockStateOnlyBackupPlan,
  resetBackupTempHome,
  tarCreateMock,
} from "./backup.test-support.js";

const { backupCreateCommand } = await import("./backup.js");

type CapturedBackupManifest = {
  schemaVersion: 1;
  createdAt: string;
  archiveRoot: string;
  platform: NodeJS.Platform;
  options: {
    includeWorkspace: boolean;
    onlyConfig: boolean;
  };
  paths: {
    stateDir: string;
    configPath: string;
    oauthDir: string;
    workspaceDirs: string[];
  };
  assets: Array<Pick<BackupAsset, "kind" | "sourcePath" | "archivePath">>;
  skipped: Array<{ kind: string; sourcePath: string; reason: string; coveredBy?: string }>;
};

describe("backup commands", () => {
  let tempHome: TempHomeEnv;

  function requireFirstMockArg<T>(mock: { mock: { calls: T[][] } }, label: string): T {
    const call = mock.mock.calls[0];
    if (!call) {
      throw new Error(`expected ${label} call`);
    }
    const [arg] = call;
    return arg;
  }

  async function mockWorkspaceBackupPlan(stateDir: string, workspaceDir: string, nowMs: number) {
    vi.spyOn(backupShared, "resolveBackupPlanFromDisk").mockResolvedValue(
      await resolveBackupPlanFromPaths({
        stateDir,
        configPath: path.join(stateDir, "openclaw.json"),
        oauthDir: path.join(stateDir, "credentials"),
        workspaceDirs: [workspaceDir],
        includeWorkspace: true,
        configInsideState: true,
        oauthInsideState: true,
        nowMs,
      }),
    );
  }

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-test-");
  });

  beforeEach(async () => {
    await resetBackupTempHome(tempHome);
    tarCreateMock.mockReset();
    tarCreateMock.mockImplementation(async ({ file }: { file: string }) => {
      await fs.writeFile(file, "archive-bytes", "utf8");
    });
    backupVerifyCommandMock.mockReset();
    backupVerifyCommandMock.mockResolvedValue({
      ok: true,
      archivePath: "/tmp/fake.tar.gz",
      archiveRoot: "fake",
      createdAt: new Date().toISOString(),
      runtimeVersion: "test",
      assetCount: 1,
      entryCount: 2,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  async function withInvalidWorkspaceBackupConfig<T>(fn: (runtime: RuntimeEnv) => Promise<T>) {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const configPath = path.join(tempHome.home, "custom-config.json");
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.writeFile(configPath, '{"agents": { defaults: { workspace: ', "utf8");
    const runtime = createBackupTestRuntime();

    try {
      return await fn(runtime);
    } finally {
      delete process.env.OPENCLAW_CONFIG_PATH;
    }
  }

  function expectWorkspaceCoveredByState(
    plan: Awaited<ReturnType<typeof resolveBackupPlanFromDisk>>,
  ) {
    const included = plan.included[0];
    if (!included) {
      throw new Error("Expected state asset to be included");
    }
    const stateSourcePath = included.sourcePath;
    expect(plan.included).toStrictEqual([
      {
        kind: "state",
        sourcePath: stateSourcePath,
        displayPath: included.displayPath,
        archivePath: path.posix.join(
          buildBackupArchiveRoot(123),
          "payload",
          encodeAbsolutePathForBackupArchive(stateSourcePath),
        ),
      },
    ]);
    const workspaceSourcePath = path.join(included.sourcePath, "workspace");
    expect(plan.skipped).toStrictEqual([
      {
        kind: "workspace",
        sourcePath: workspaceSourcePath,
        displayPath: path.join(included.displayPath, "workspace"),
        reason: "covered",
        coveredBy: included.displayPath,
      },
    ]);
    const [skipped] = plan.skipped;
    if (!skipped) {
      throw new Error("Expected covered workspace skip entry");
    }
    expect(path.relative(included.sourcePath, skipped.sourcePath).startsWith("..")).toBe(false);
  }

  function expectOnlyAssetKind(assets: BackupAsset[], kind: BackupAsset["kind"]) {
    expect(assets).toStrictEqual([
      {
        kind,
        sourcePath: expect.any(String),
        displayPath: expect.any(String),
        archivePath: expect.stringContaining("/payload/"),
      },
    ]);
  }

  it("collapses default config, credentials, and workspace into the state backup root", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const oauthDir = path.join(stateDir, "credentials");
    const workspaceDir = path.join(stateDir, "workspace");
    await fs.writeFile(configPath, JSON.stringify({}), "utf8");
    await fs.mkdir(oauthDir, { recursive: true });
    await fs.writeFile(path.join(oauthDir, "oauth.json"), "{}", "utf8");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# soul\n", "utf8");

    const plan = await resolveBackupPlanFromPaths({
      stateDir,
      configPath,
      oauthDir,
      workspaceDirs: [workspaceDir],
      includeWorkspace: true,
      configInsideState: true,
      oauthInsideState: true,
      nowMs: 123,
    });
    expectWorkspaceCoveredByState(plan);
  });

  it("orders coverage checks by canonical path so symlinked workspaces do not duplicate state", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    const symlinkDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-link-"));
    const workspaceLink = path.join(symlinkDir, "ws-link");
    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# soul\n", "utf8");
      await fs.symlink(workspaceDir, workspaceLink);
      const plan = await resolveBackupPlanFromPaths({
        stateDir,
        configPath: path.join(stateDir, "openclaw.json"),
        oauthDir: path.join(stateDir, "credentials"),
        workspaceDirs: [workspaceLink],
        includeWorkspace: true,
        configInsideState: true,
        oauthInsideState: true,
        nowMs: 123,
      });
      expectWorkspaceCoveredByState(plan);
    } finally {
      await fs.rm(symlinkDir, { recursive: true, force: true });
    }
  });

  it("creates an archive with a manifest and external workspace payload", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const externalWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const configPath = path.join(tempHome.home, "custom-config.json");
    const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backups-"));
    let capturedManifest: CapturedBackupManifest | null = null;
    let capturedEntryPaths: string[] = [];
    let capturedOnWriteEntry: ((entry: { path: string }) => void) | null = null;
    try {
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace: externalWorkspace,
            },
          },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");
      await fs.writeFile(path.join(externalWorkspace, "SOUL.md"), "# external\n", "utf8");

      const runtime = createBackupTestRuntime();

      const nowMs = Date.UTC(2026, 2, 9, 0, 0, 0);
      vi.spyOn(backupShared, "resolveBackupPlanFromDisk").mockResolvedValue(
        await resolveBackupPlanFromPaths({
          stateDir,
          configPath,
          oauthDir: path.join(stateDir, "credentials"),
          workspaceDirs: [externalWorkspace],
          includeWorkspace: true,
          configInsideState: false,
          oauthInsideState: true,
          nowMs,
        }),
      );
      tarCreateMock.mockImplementationOnce(
        async (
          options: { file: string; onWriteEntry?: (entry: { path: string }) => void },
          entryPaths: string[],
        ) => {
          capturedManifest = JSON.parse(
            await fs.readFile(entryPaths[0], "utf8"),
          ) as CapturedBackupManifest;
          capturedEntryPaths = entryPaths;
          capturedOnWriteEntry = options.onWriteEntry ?? null;
          await fs.writeFile(options.file, "archive-bytes", "utf8");
        },
      );
      const result = await backupCreateCommand(runtime, {
        output: backupDir,
        includeWorkspace: true,
        nowMs,
      });

      expect(result.archivePath).toBe(
        path.join(backupDir, `${buildBackupArchiveRoot(nowMs)}.tar.gz`),
      );
      expect(typeof capturedOnWriteEntry).toBe("function");
      if (capturedManifest === null || capturedOnWriteEntry === null) {
        throw new Error("Expected backup manifest and archive entry callback");
      }
      const manifest = capturedManifest as CapturedBackupManifest;
      const onWriteEntry = capturedOnWriteEntry as unknown as (entry: { path: string }) => void;
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.createdAt).toBe(result.createdAt);
      expect(manifest.archiveRoot).toBe(result.archiveRoot);
      expect(manifest.platform).toBe(process.platform);
      expect(manifest.options).toEqual({ includeWorkspace: true, onlyConfig: false });
      expect(manifest.paths).toEqual({
        stateDir,
        configPath,
        oauthDir: path.join(stateDir, "credentials"),
        workspaceDirs: [externalWorkspace],
      });
      expect(manifest.assets).toEqual(
        result.assets.map((asset) => ({
          kind: asset.kind,
          sourcePath: asset.sourcePath,
          archivePath: asset.archivePath,
        })),
      );
      expect(manifest.assets.map((asset) => asset.kind).toSorted()).toEqual([
        "config",
        "state",
        "workspace",
      ]);
      expect(manifest.skipped).toEqual([]);

      const stateAsset = result.assets.find((asset) => asset.kind === "state");
      const workspaceAsset = result.assets.find((asset) => asset.kind === "workspace");
      if (!stateAsset || !workspaceAsset) {
        throw new Error("Expected backup assets to include state and workspace entries.");
      }
      expect(capturedEntryPaths).toHaveLength(result.assets.length + 1);

      const manifestPath = capturedEntryPaths[0];
      const remappedManifestEntry = { path: manifestPath };
      onWriteEntry(remappedManifestEntry);
      expect(remappedManifestEntry.path).toBe(
        path.posix.join(buildBackupArchiveRoot(nowMs), "manifest.json"),
      );

      const remappedStateEntry = { path: stateAsset.sourcePath };
      onWriteEntry(remappedStateEntry);
      expect(remappedStateEntry.path).toBe(
        path.posix.join(
          buildBackupArchiveRoot(nowMs),
          "payload",
          encodeAbsolutePathForBackupArchive(stateAsset.sourcePath),
        ),
      );

      const remappedWorkspaceEntry = { path: workspaceAsset.sourcePath };
      onWriteEntry(remappedWorkspaceEntry);
      expect(remappedWorkspaceEntry.path).toBe(
        path.posix.join(
          buildBackupArchiveRoot(nowMs),
          "payload",
          encodeAbsolutePathForBackupArchive(workspaceAsset.sourcePath),
        ),
      );
    } finally {
      delete process.env.OPENCLAW_CONFIG_PATH;
      await fs.rm(externalWorkspace, { recursive: true, force: true });
      await fs.rm(backupDir, { recursive: true, force: true });
    }
  });

  it("keeps volatile-skip notices out of json output", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backups-json-"));
    try {
      const runtime = createBackupTestRuntime();
      await mockStateOnlyBackupPlan(stateDir);
      tarCreateMock.mockImplementationOnce(
        async (
          options: { file: string; filter?: (entryPath: string) => boolean },
          entryPaths: string[],
        ) => {
          const manifestPath = entryPaths[0];
          const stateRoot = entryPaths[1];
          if (!manifestPath || !stateRoot) {
            throw new Error("backup test expected manifest and state entries");
          }
          expect(options.filter?.(manifestPath)).toBe(true);
          expect(
            options.filter?.(path.join(stateRoot, "agents", "main", "sessions", "s.jsonl")),
          ).toBe(false);
          await fs.writeFile(options.file, "archive-bytes", "utf8");
        },
      );

      const result = await backupCreateCommand(runtime, {
        output: backupDir,
        json: true,
      });

      expect(result.skippedVolatileCount).toBe(1);
      expect(runtime.log).toHaveBeenCalledTimes(1);
      const payload = requireFirstMockArg(vi.mocked(runtime.log), "runtime log");
      if (typeof payload !== "string") {
        throw new Error("backup test expected JSON string output");
      }
      expect(payload).not.toContain("Backup skipped");
      const parsedPayload = JSON.parse(payload) as { skippedVolatileCount?: unknown };
      expect(parsedPayload.skippedVolatileCount).toBe(1);
    } finally {
      await fs.rm(backupDir, { recursive: true, force: true });
    }
  });

  it("rejects output paths that would be created inside a backed-up directory", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");

    const runtime = createBackupTestRuntime();
    await mockStateOnlyBackupPlan(stateDir);

    await expect(
      backupCreateCommand(runtime, {
        output: path.join(stateDir, "backups"),
      }),
    ).rejects.toThrow(/must not be written inside a source path/i);
  });

  it("rejects symlinked output paths even when intermediate directories do not exist yet", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateDir = path.join(tempHome.home, ".openclaw");
    const symlinkDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-link-"));
    const symlinkPath = path.join(symlinkDir, "linked-state");
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.symlink(stateDir, symlinkPath);

      const runtime = createBackupTestRuntime();
      await mockStateOnlyBackupPlan(stateDir);

      await expect(
        backupCreateCommand(runtime, {
          output: path.join(symlinkPath, "new", "subdir", "backup.tar.gz"),
        }),
      ).rejects.toThrow(/must not be written inside a source path/i);
    } finally {
      await fs.rm(symlinkDir, { recursive: true, force: true });
    }
  });

  it("falls back to the home directory when cwd is inside a backed-up source tree", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# soul\n", "utf8");
    vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
    const nowMs = Date.UTC(2026, 2, 9, 1, 2, 3);
    await mockWorkspaceBackupPlan(stateDir, workspaceDir, nowMs);

    const runtime = createBackupTestRuntime();

    const result = await backupCreateCommand(runtime, { nowMs });

    expect(result.archivePath).toBe(
      path.join(tempHome.home, `${buildBackupArchiveRoot(nowMs)}.tar.gz`),
    );
    await fs.rm(result.archivePath, { force: true });

    if (process.platform !== "win32") {
      const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-cwd-link-"));
      const workspaceLink = path.join(linkParent, "workspace-link");
      try {
        await fs.symlink(workspaceDir, workspaceLink);
        vi.mocked(process.cwd).mockReturnValue(workspaceLink);
        const symlinkNowMs = Date.UTC(2026, 2, 9, 1, 3, 4);
        await mockWorkspaceBackupPlan(stateDir, workspaceDir, symlinkNowMs);
        const symlinkResult = await backupCreateCommand(createBackupTestRuntime(), {
          nowMs: symlinkNowMs,
        });
        expect(symlinkResult.archivePath).toBe(
          path.join(tempHome.home, `${buildBackupArchiveRoot(symlinkNowMs)}.tar.gz`),
        );
        await fs.rm(symlinkResult.archivePath, { force: true });
      } finally {
        await fs.rm(linkParent, { recursive: true, force: true });
      }
    }
  });

  it("allows dry-run preview even when the target archive already exists", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const existingArchive = path.join(tempHome.home, "existing-backup.tar.gz");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.writeFile(existingArchive, "already here", "utf8");
    vi.spyOn(backupShared, "resolveBackupPlanFromDisk").mockResolvedValue(
      await resolveBackupPlanFromPaths({
        stateDir,
        configPath: path.join(stateDir, "openclaw.json"),
        oauthDir: path.join(stateDir, "credentials"),
        includeWorkspace: false,
        configInsideState: true,
        oauthInsideState: true,
        nowMs: 123,
      }),
    );

    const runtime = createBackupTestRuntime();

    const result = await backupCreateCommand(runtime, {
      output: existingArchive,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.archivePath).toBe(existingArchive);
    expect(await fs.readFile(existingArchive, "utf8")).toBe("already here");
  });

  it("handles invalid config according to backup scope", async () => {
    await withInvalidWorkspaceBackupConfig(async (runtime) => {
      await expect(backupCreateCommand(runtime, { dryRun: true })).rejects.toThrow(
        /--no-include-workspace/i,
      );

      const result = await backupCreateCommand(runtime, {
        dryRun: true,
        includeWorkspace: false,
      });

      expect(result.includeWorkspace).toBe(false);
      expect(result.assets.map((asset) => asset.kind)).not.toContain("workspace");

      const configOnly = await backupCreateCommand(runtime, {
        dryRun: true,
        onlyConfig: true,
      });
      expectOnlyAssetKind(configOnly.assets, "config");
    });
  });

  it("backs up only the active config file when --only-config is requested", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ theme: "config-only" }), "utf8");
    await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");
    await fs.writeFile(path.join(stateDir, "credentials", "oauth.json"), "{}", "utf8");
    vi.spyOn(backupShared, "resolveBackupPlanFromDisk").mockResolvedValue(
      await resolveBackupPlanFromPaths({
        stateDir,
        configPath,
        oauthDir: path.join(stateDir, "credentials"),
        includeWorkspace: false,
        onlyConfig: true,
        configInsideState: true,
        oauthInsideState: true,
        nowMs: 123,
      }),
    );

    const runtime = createBackupTestRuntime();

    const result = await backupCreateCommand(runtime, {
      dryRun: true,
      onlyConfig: true,
    });

    expect(result.onlyConfig).toBe(true);
    expect(result.includeWorkspace).toBe(false);
    expectOnlyAssetKind(result.assets, "config");
  });
});
