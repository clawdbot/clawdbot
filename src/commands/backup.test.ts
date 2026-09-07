// Backup command tests cover backup create, verify, and runtime output paths.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliOperatorError } from "../cli/failure-output.js";
import type { RuntimeEnv } from "../runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  buildBackupArchivePath,
  buildBackupArchiveRoot,
  type BackupAsset,
  resolveBackupPlanFromDisk,
} from "./backup-shared.js";
import {
  backupVerifyCommandMock,
  createMockTarStream,
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
    agentRoots: Array<{ agentId: string; sourcePath: string }>;
  };
  assets: Array<Pick<BackupAsset, "kind" | "sourcePath" | "archivePath">>;
  skipped: Array<{ kind: string; sourcePath: string; reason: string; coveredBy?: string }>;
};

describe("backup commands", () => {
  let tempHome: TempHomeEnv;

  async function writeWorkspaceBackupConfig(stateDir: string, workspaceDir: string) {
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: { ownership: "explicit", entries: { main: { workspace: workspaceDir } } },
      }),
      "utf8",
    );
  }

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-test-");
  });

  beforeEach(async () => {
    await resetBackupTempHome(tempHome);
    tarCreateMock.mockReset();
    tarCreateMock.mockImplementation(() => createMockTarStream());
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

  async function withInvalidWorkspaceBackupConfig<T>(
    raw: string,
    fn: (runtime: RuntimeEnv) => Promise<T>,
  ) {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const configPath = path.join(tempHome.home, "custom-config.json");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.writeFile(configPath, raw, "utf8");

    const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH"]);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    const runtime = createBackupTestRuntime();
    try {
      return await fn(runtime);
    } finally {
      envSnapshot.restore();
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
        archivePath: buildBackupArchivePath(buildBackupArchiveRoot(123), stateSourcePath),
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

  it("formats backup archive timestamps in local time", () => {
    const envSnapshot = captureEnv(["TZ"]);
    try {
      setTestEnvValue("TZ", "Asia/Shanghai");
      expect(buildBackupArchiveRoot(Date.UTC(2026, 2, 14, 1, 2, 3, 456))).toBe(
        "2026-03-14T09-02-03.456+08-00-openclaw-backup",
      );
      setTestEnvValue("TZ", "America/New_York");
      expect(buildBackupArchiveRoot(Date.UTC(2026, 2, 14, 1, 2, 3, 456))).toBe(
        "2026-03-13T21-02-03.456-04-00-openclaw-backup",
      );
    } finally {
      envSnapshot.restore();
    }
  });

  it("collapses default config, credentials, and workspace into the state backup root", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const oauthDir = path.join(stateDir, "credentials");
    const workspaceDir = path.join(stateDir, "workspace");
    await writeWorkspaceBackupConfig(stateDir, workspaceDir);
    await fs.mkdir(oauthDir, { recursive: true });
    await fs.writeFile(path.join(oauthDir, "oauth.json"), "{}", "utf8");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# soul\n", "utf8");

    const plan = await resolveBackupPlanFromDisk({ includeWorkspace: true, nowMs: 123 });
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
      await writeWorkspaceBackupConfig(stateDir, workspaceLink);
      const plan = await resolveBackupPlanFromDisk({ includeWorkspace: true, nowMs: 123 });
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
    const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH"]);
    try {
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            ownership: "explicit",
            entries: { main: { workspace: externalWorkspace } },
          },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");
      await fs.writeFile(path.join(externalWorkspace, "SOUL.md"), "# external\n", "utf8");

      const runtime = createBackupTestRuntime();

      const nowMs = Date.UTC(2026, 2, 9, 0, 0, 0);
      tarCreateMock.mockImplementationOnce(
        (options: { onWriteEntry?: (entry: { path: string }) => void }, entryPaths: string[]) =>
          createMockTarStream({
            beforeRead: async () => {
              capturedManifest = JSON.parse(
                await fs.readFile(
                  expectDefined(entryPaths[0], "entryPaths[0] test invariant"),
                  "utf8",
                ),
              ) as CapturedBackupManifest;
              capturedEntryPaths = entryPaths;
              capturedOnWriteEntry = options.onWriteEntry ?? null;
            },
          }),
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
        agentRoots: [
          {
            agentId: "main",
            sourcePath: path.join(await fs.realpath(stateDir), "agents", "main", "agent"),
          },
        ],
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

      const manifestPath = expectDefined(capturedEntryPaths[0], "manifest archive path");
      const remappedManifestEntry = { path: manifestPath };
      onWriteEntry(remappedManifestEntry);
      expect(remappedManifestEntry.path).toBe(
        path.posix.join(buildBackupArchiveRoot(nowMs), "manifest.json"),
      );

      const remappedStateEntry = { path: stateAsset.sourcePath };
      onWriteEntry(remappedStateEntry);
      expect(remappedStateEntry.path).toBe(
        buildBackupArchivePath(buildBackupArchiveRoot(nowMs), stateAsset.sourcePath),
      );

      const remappedWorkspaceEntry = { path: workspaceAsset.sourcePath };
      onWriteEntry(remappedWorkspaceEntry);
      expect(remappedWorkspaceEntry.path).toBe(
        buildBackupArchivePath(buildBackupArchiveRoot(nowMs), workspaceAsset.sourcePath),
      );
    } finally {
      envSnapshot.restore();
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
        (
          options: {
            filter?: (entryPath: string, entryStat: { isDirectory: () => boolean }) => boolean;
          },
          entryPaths: string[],
        ) =>
          createMockTarStream({
            beforeRead: () => {
              const manifestPath = entryPaths[0];
              const stateRoot = entryPaths[1];
              if (!manifestPath || !stateRoot) {
                throw new Error("backup test expected manifest and state entries");
              }
              const fileStat = { isDirectory: () => false };
              expect(options.filter?.(manifestPath, fileStat)).toBe(true);
              expect(
                options.filter?.(
                  path.join(stateRoot, "agents", "main", "sessions", "s.jsonl"),
                  fileStat,
                ),
              ).toBe(false);
            },
          }),
      );

      const result = await backupCreateCommand(runtime, {
        output: backupDir,
        json: true,
      });

      expect(result.skippedVolatileCount).toBe(1);
      expect(runtime.log).toHaveBeenCalledTimes(1);
      const [payload] = expectDefined(vi.mocked(runtime.log).mock.calls[0], "runtime log call");
      if (typeof payload !== "string") {
        throw new Error("backup test expected JSON string output");
      }
      expect(payload).not.toContain("Backup skipped");
      expect(JSON.parse(payload)).toHaveProperty("skippedVolatileCount", 1);
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

  it("creates missing output parent directories", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const outputPath = path.join(tempHome.home, "backups", "daily", "backup.tar.gz");
    await mockStateOnlyBackupPlan(stateDir);

    const result = await backupCreateCommand(createBackupTestRuntime(), { output: outputPath });

    expect(result.archivePath).toBe(outputPath);
    expect(await fs.readFile(outputPath, "utf8")).toBe("archive-bytes");
  });

  it.each([
    {
      code: "ENOENT",
      detail: "Backup output directory could not be created",
      recovery: "Check the path and run `openclaw backup create --output <archive>` again.",
    },
    {
      code: "EACCES",
      detail: "Backup output directory is not writable",
      recovery:
        "Check the path and directory permissions, then run `openclaw backup create --output <archive>` again.",
    },
    {
      code: "ENOSPC",
      detail: "The destination does not have enough free space",
      recovery: "Free up disk space and run `openclaw backup create --output <archive>` again.",
    },
    {
      code: "EIO",
      detail: "The output path could not be prepared",
      recovery:
        "Check the path and filesystem, then run `openclaw backup create --output <archive>` again.",
    },
  ])("reports an actionable $code output-parent failure", async ({ code, detail, recovery }) => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const outputParent = path.join(tempHome.home, "missing-parent", "daily");
    const outputPath = path.join(outputParent, "backup.tar.gz");
    await mockStateOnlyBackupPlan(stateDir);
    vi.spyOn(fs, "mkdir").mockRejectedValueOnce(
      Object.assign(new Error(`${code}: filesystem error, mkdir '${outputParent}'`), {
        code,
        path: outputParent,
        syscall: "mkdir",
      }),
    );

    const error = await backupCreateCommand(createBackupTestRuntime(), {
      output: outputPath,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const operatorMessage = `Backup archive creation failed: ${outputPath}. ${detail}: ${outputParent}. ${recovery}`;
    expect(formatCliOperatorError(error, { argv: [], env: {} })).toBe(operatorMessage);
    const debugMessage = `${operatorMessage} | ${code}: filesystem error, mkdir '${outputParent}' | ${code}`;
    expect(formatCliOperatorError(error, { argv: [], env: { OPENCLAW_DEBUG: "1" } })).toBe(
      debugMessage,
    );
  });

  it("does not describe an output parent file as a missing directory", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const outputParent = path.join(tempHome.home, "not-a-directory");
    const outputPath = path.join(outputParent, "backup.tar.gz");
    await fs.writeFile(outputParent, "file\n", "utf8");
    await mockStateOnlyBackupPlan(stateDir);

    const error = await backupCreateCommand(createBackupTestRuntime(), {
      output: outputPath,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const operatorMessage = `Backup archive creation failed: ${outputPath}. Backup output parent is not a directory: ${outputParent}. Choose a directory path and run \`openclaw backup create --output <archive>\` again.`;
    expect(formatCliOperatorError(error, { argv: [], env: {} })).toBe(operatorMessage);
    expect(formatCliOperatorError(error, { argv: [], env: { OPENCLAW_DEBUG: "1" } })).toMatch(
      /\| EEXIST: .*mkdir.*\| EEXIST/u,
    );
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
    await writeWorkspaceBackupConfig(stateDir, workspaceDir);

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
        vi.mocked(process["cwd"]).mockReturnValue(workspaceLink);
        const symlinkNowMs = Date.UTC(2026, 2, 9, 1, 3, 4);
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
    await mockStateOnlyBackupPlan(stateDir);

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

  it.each(["syntax", "workspace"])(
    "handles invalid %s according to backup scope",
    async (invalid) => {
      const raw =
        invalid === "syntax"
          ? '{"agents": { defaults: { workspace: '
          : JSON.stringify({
              agents: {
                ownership: "explicit",
                defaults: { workspace: 42 },
                entries: { main: { workspace: path.join(tempHome.home, "workspace") } },
              },
            });
      await withInvalidWorkspaceBackupConfig(raw, async (runtime) => {
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
    },
  );

  it("discovers workspaces through the stable upgrade compatibility view", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const configPath = path.join(tempHome.home, "stable-openclaw.json");
    const workspaceDir = path.join(tempHome.home, "stable-workspace");
    const stableConfig = {
      meta: {
        lastTouchedAt: "2026-08-01T00:00:00.000Z",
        lastTouchedVersion: "2026.7.1-2",
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          heartbeat: { skipWhenBusy: true },
        },
      },
      gateway: { mode: "local" },
    };
    const originalRaw = `${JSON.stringify(stableConfig, null, 2)}\n`;
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(configPath, originalRaw, "utf8");
    const canonicalWorkspaceDir = await fs.realpath(workspaceDir);
    const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH"]);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
    try {
      const plan = await resolveBackupPlanFromDisk({ nowMs: 123 });

      expect(plan.included).toContainEqual(
        expect.objectContaining({ kind: "workspace", sourcePath: canonicalWorkspaceDir }),
      );
      expect(await fs.readFile(configPath, "utf8")).toBe(originalRaw);
      expect(plan.configPath).toBe(configPath);
      expect(plan.stateDir).toBe(stateDir);
    } finally {
      envSnapshot.restore();
    }
  });

  it("backs up only the active config file when --only-config is requested", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ theme: "config-only" }), "utf8");
    await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");
    await fs.writeFile(path.join(stateDir, "credentials", "oauth.json"), "{}", "utf8");

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
