// Cleanup utility tests cover filesystem cleanup helpers, temp paths, and command runtime behavior.
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { acquireGatewayLock, GatewayLockError } from "../infra/gateway-lock.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function attemptGatewayLockInChild(env: NodeJS.ProcessEnv): Promise<string> {
  const lockModuleUrl = pathToFileURL(path.resolve("src/infra/gateway-lock.ts")).href;
  const script = `
    const { acquireGatewayLock } = await import(${JSON.stringify(lockModuleUrl)});
    const report = (message) => process.send?.(message, () => process.exit(0));
    try {
      const lock = await acquireGatewayLock({
        allowInTests: true,
        env: process.env,
        pollIntervalMs: 2,
        timeoutMs: 15,
      });
      await lock?.release();
      report("acquired");
    } catch {
      report("blocked");
    }
  `;
  const childEnv = { ...env };
  delete childEnv.NODE_ENV;
  delete childEnv.VITEST;
  delete childEnv.VITEST_POOL_ID;
  delete childEnv.VITEST_WORKER_ID;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, "openclaw", "gateway"],
    { cwd: path.resolve("."), env: childEnv, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const message = await Promise.race([
    once(child, "message").then(([value]) => String(value)),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(
        `Gateway lock probe exited before reporting (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8")}`,
      );
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "exit");
  }
  return message;
}

const workspaceStateMocks = vi.hoisted(() => ({
  deleteWorkspaceState: vi.fn(),
  prepareWorkspaceStateDeletion: vi.fn((workspaceDir: string) => ({ workspaceDir })),
}));

const fsSafeMocks = vi.hoisted(() => ({
  movePathToTrash: vi.fn(async (targetPath: string) => `${targetPath}.trashed`),
}));

const processMocks = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
  movePathToTrash: fsSafeMocks.movePathToTrash,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: processMocks.runCommandWithTimeout,
}));

vi.mock("../agents/workspace-state-store.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/workspace-state-store.js")>(
    "../agents/workspace-state-store.js",
  )),
  deleteWorkspaceState: workspaceStateMocks.deleteWorkspaceState,
  prepareWorkspaceStateDeletion: workspaceStateMocks.prepareWorkspaceStateDeletion,
}));

import {
  buildCleanupPlan,
  listAgentSessionDirs,
  moveToTrash,
  removePath,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
} from "./cleanup-utils.js";

afterEach(() => {
  fsSafeMocks.movePathToTrash.mockReset();
  fsSafeMocks.movePathToTrash.mockImplementation(
    async (targetPath: string) => `${targetPath}.trashed`,
  );
  vi.restoreAllMocks();
});

function expectedTrashSourcePath(targetPath: string): string {
  return path.join(fsSync.realpathSync(path.dirname(targetPath)), path.basename(targetPath));
}

describe("moveToTrash", () => {
  it("uses fs-safe trash instead of resolving a PATH trash command", async () => {
    const testRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-trash-helper-"));
    const targetPath = path.join(testRoot, "target");
    fsSync.mkdirSync(targetPath, { recursive: true });
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
    const sourcePath = expectedTrashSourcePath(targetPath);

    try {
      await moveToTrash(targetPath, runtime);
    } finally {
      fsSync.rmSync(testRoot, { recursive: true, force: true });
    }

    expect(fsSafeMocks.movePathToTrash).toHaveBeenCalledWith(sourcePath, {
      allowedRoots: [path.dirname(sourcePath)],
    });
    expect(processMocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(`Moved to Trash: ${targetPath}`);
  });

  it("allows fs-safe trash to move a symlink whose target resolves outside the parent", async () => {
    const testRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-trash-symlink-"));
    const targetPath = path.join(testRoot, "target-link");
    const outsideTarget = path.join(os.tmpdir(), "openclaw-trash-symlink-target");
    fsSync.writeFileSync(targetPath, "link placeholder");
    vi.spyOn(fs, "lstat").mockResolvedValue({
      isSymbolicLink: () => true,
    } as fsSync.Stats);
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate) =>
      String(candidate) === path.dirname(targetPath) ? path.dirname(targetPath) : outsideTarget,
    );
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    try {
      await moveToTrash(targetPath, runtime);
    } finally {
      fsSync.rmSync(testRoot, { recursive: true, force: true });
    }

    expect(fsSafeMocks.movePathToTrash).toHaveBeenCalledWith(targetPath, {
      allowedRoots: [path.dirname(targetPath), path.dirname(outsideTarget)],
    });
  });

  it("moves a dangling symlink instead of treating it as already removed", async () => {
    const testRoot = tempDirs.make("openclaw-trash-dangling-link-");
    const targetPath = path.join(testRoot, "workspace-link");
    fsSync.symlinkSync(path.join(testRoot, "missing-target"), targetPath, "dir");
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
    const sourcePath = expectedTrashSourcePath(targetPath);

    try {
      await expect(moveToTrash(targetPath, runtime)).resolves.toBe(true);
    } finally {
      fsSync.rmSync(testRoot, { recursive: true, force: true });
    }

    expect(fsSafeMocks.movePathToTrash).toHaveBeenCalledWith(sourcePath, {
      allowedRoots: [path.dirname(sourcePath)],
    });
  });

  it("canonicalizes a symlinked parent before calling fs-safe trash", async () => {
    const testRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-trash-parent-link-"));
    const lexicalParent = path.join(testRoot, "state-link");
    const realParent = path.join(testRoot, "state-real");
    const targetPath = path.join(lexicalParent, "openclaw.json");
    const sourcePath = path.join(realParent, "openclaw.json");
    fsSync.mkdirSync(lexicalParent, { recursive: true });
    fsSync.writeFileSync(targetPath, "{}\n");
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate) =>
      String(candidate) === lexicalParent ? realParent : String(candidate),
    );
    vi.spyOn(fs, "lstat").mockResolvedValue({
      isSymbolicLink: () => false,
    } as fsSync.Stats);
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    try {
      await moveToTrash(targetPath, runtime);
    } finally {
      fsSync.rmSync(testRoot, { recursive: true, force: true });
    }

    expect(fsSafeMocks.movePathToTrash).toHaveBeenCalledWith(sourcePath, {
      allowedRoots: [realParent],
    });
  });
});

describe("buildCleanupPlan", () => {
  test("resolves inside-state flags and workspace dirs", () => {
    const tmpRoot = path.join(path.parse(process.cwd()).root, "tmp");
    const defaultWorkspace = path.join(tmpRoot, "openclaw-workspace-default");
    const opsWorkspace = path.join(tmpRoot, "openclaw-workspace-ops");
    const cfg = {
      agents: {
        defaults: { workspace: defaultWorkspace },
        list: [{ id: "main" }, { id: "ops", workspace: opsWorkspace }],
      },
    };
    const plan = buildCleanupPlan({
      cfg: cfg as unknown as OpenClawConfig,
      stateDir: path.join(tmpRoot, "openclaw-state"),
      configPath: path.join(tmpRoot, "openclaw-state", "openclaw.json"),
      oauthDir: path.join(tmpRoot, "openclaw-oauth"),
    });

    expect(plan.configInsideState).toBe(true);
    expect(plan.oauthInsideState).toBe(false);
    expect(new Set(plan.workspaceDirs)).toEqual(
      new Set([path.join(defaultWorkspace, "main"), opsWorkspace]),
    );
  });

  test("includes implicit per-agent workspaces under the state dir", () => {
    const tmpRoot = path.join(path.parse(process.cwd()).root, "tmp", "openclaw-cleanup-plan");
    const home = path.join(tmpRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const cfg = {
      agents: {
        list: [{ id: "main" }, { id: "work" }],
      },
    };

    return withEnvAsync(
      {
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_WORKSPACE_DIR: undefined,
      },
      async () => {
        const plan = buildCleanupPlan({
          cfg: cfg as unknown as OpenClawConfig,
          stateDir,
          configPath: path.join(stateDir, "openclaw.json"),
          oauthDir: path.join(stateDir, "credentials"),
        });

        expect(new Set(plan.workspaceDirs)).toEqual(
          new Set([path.join(stateDir, "workspace-main"), path.join(stateDir, "workspace-work")]),
        );
      },
    );
  });
});

describe("cleanup path removals", () => {
  beforeEach(() => {
    workspaceStateMocks.deleteWorkspaceState.mockClear();
  });

  function createRuntimeMock() {
    return {
      log: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string) => void>(),
    } as unknown as RuntimeEnv & {
      log: ReturnType<typeof vi.fn<(message: string) => void>>;
      error: ReturnType<typeof vi.fn<(message: string) => void>>;
    };
  }

  it("removes state and only linked paths outside state", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = path.join(path.parse(process.cwd()).root, "tmp", "openclaw-cleanup");
    const stateRemoved = await removeStateAndLinkedPaths(
      {
        stateDir: path.join(tmpRoot, "state"),
        configPath: path.join(tmpRoot, "state", "openclaw.json"),
        oauthDir: path.join(tmpRoot, "oauth"),
        configInsideState: true,
        oauthInsideState: false,
      },
      runtime,
      { dryRun: true },
    );

    expect(runtime.log.mock.calls.map(([line]) => line.replaceAll("\\", "/"))).toEqual([
      "[dry-run] remove /tmp/openclaw-cleanup/state",
      "[dry-run] remove /tmp/openclaw-cleanup/oauth",
    ]);
    expect(stateRemoved).toBe(true);
  });

  it("keeps the canonical state lock visible until state removal completes", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = await fs.realpath(tempDirs.make("openclaw-cleanup-lock-visible-"));
    const stateDir = path.join(tmpRoot, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const markerPath = path.join(stateDir, "keep.txt");
    await fs.mkdir(stateDir);
    await fs.writeFile(configPath, "{}");
    await fs.writeFile(markerPath, "remove me");
    let continueRemoval = () => {};
    const removalMayContinue = new Promise<void>((resolve) => {
      continueRemoval = resolve;
    });
    let markRemovalStarted = () => {};
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve;
    });
    const realRm = fs.rm;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === markerPath) {
        markRemovalStarted();
        await removalMayContinue;
      }
      return await realRm(target, options);
    });
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };

    try {
      const cleanup = removeStateAndLinkedPaths(
        {
          stateDir,
          configPath,
          oauthDir: path.join(stateDir, "credentials"),
          configInsideState: true,
          oauthInsideState: true,
        },
        runtime,
      );
      await removalStarted;

      await expect(
        acquireGatewayLock({
          allowInTests: true,
          env,
          pollIntervalMs: 2,
          timeoutMs: 15,
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);

      continueRemoval();
      await expect(cleanup).resolves.toBe(true);
      await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      continueRemoval();
      rmSpy.mockRestore();
    }
  });

  it("retains external Gateway ownership through linked-path cleanup", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = await fs.realpath(tempDirs.make("openclaw-cleanup-finalization-lock-"));
    const stateDir = path.join(tmpRoot, "state");
    const configPath = path.join(tmpRoot, "openclaw.json");
    const markerPath = path.join(stateDir, "marker.txt");
    await fs.mkdir(stateDir);
    await fs.writeFile(markerPath, "remove me");
    await fs.writeFile(configPath, "{}\n");
    let continueRemoval = () => {};
    const removalMayContinue = new Promise<void>((resolve) => {
      continueRemoval = resolve;
    });
    let markLinkedRemovalStarted = () => {};
    const linkedRemovalStarted = new Promise<void>((resolve) => {
      markLinkedRemovalStarted = resolve;
    });
    const realRm = fs.rm;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === configPath) {
        markLinkedRemovalStarted();
        await removalMayContinue;
      }
      return await realRm(target, options);
    });
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };

    try {
      const cleanup = removeStateAndLinkedPaths(
        {
          stateDir,
          configPath,
          oauthDir: path.join(stateDir, "credentials"),
          configInsideState: false,
          oauthInsideState: true,
        },
        runtime,
      );
      await linkedRemovalStarted;

      const lockAttempt = await attemptGatewayLockInChild(env);
      continueRemoval();
      const [cleanupResult] = await Promise.allSettled([cleanup]);

      expect(lockAttempt).toBe("blocked");
      expect(cleanupResult).toEqual({ status: "fulfilled", value: true });
      await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      continueRemoval();
      rmSpy.mockRestore();
    }
  });

  it("fails without removing state recreated during cleanup finalization", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = await fs.realpath(tempDirs.make("openclaw-cleanup-recreated-state-"));
    const stateDir = path.join(tmpRoot, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const lockDir = resolveGatewayLockDir(stateDir);
    const recreatedPath = path.join(lockDir, "new-owner.txt");
    await fs.mkdir(stateDir);
    await fs.writeFile(configPath, "{}");
    const realRmdir = fs.rmdir;
    const rmdirSpy = vi.spyOn(fs, "rmdir").mockImplementation(async (target) => {
      if (target === path.dirname(lockDir)) {
        await fs.mkdir(lockDir, { recursive: true });
        await fs.writeFile(recreatedPath, "active");
      }
      return await realRmdir(target);
    });

    try {
      await expect(
        removeStateAndLinkedPaths(
          {
            stateDir,
            configPath,
            oauthDir: path.join(stateDir, "credentials"),
            configInsideState: true,
            oauthInsideState: true,
          },
          runtime,
        ),
      ).rejects.toThrow(/interrupted by a new state operation/);
      await expect(fs.readFile(recreatedPath, "utf8")).resolves.toBe("active");
    } finally {
      rmdirSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "cleans a state directory reached through a symbolic-link alias",
    async () => {
      const runtime = createRuntimeMock();
      const tmpRoot = await fs.realpath(tempDirs.make("openclaw-cleanup-alias-"));
      const stateDir = path.join(tmpRoot, "state");
      const stateAlias = path.join(tmpRoot, "state-alias");
      const configPath = path.join(tmpRoot, "openclaw.json");
      await fs.mkdir(stateDir);
      await fs.writeFile(path.join(stateDir, "marker.txt"), "remove me");
      await fs.writeFile(configPath, "{}");
      await fs.symlink(stateDir, stateAlias, "dir");

      await expect(
        removeStateAndLinkedPaths(
          {
            stateDir: stateAlias,
            configPath,
            oauthDir: path.join(stateAlias, "credentials"),
            configInsideState: false,
            oauthInsideState: true,
          },
          runtime,
        ),
      ).resolves.toBe(true);

      await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(stateAlias)).rejects.toMatchObject({ code: "ENOENT" });
      await fs.mkdir(stateAlias);
      await expect(fs.stat(stateAlias).then((stat) => stat.isDirectory())).resolves.toBe(true);
      await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves linked paths when guarded state removal fails", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = await fs.realpath(tempDirs.make("openclaw-cleanup-state-failure-"));
    const stateDir = path.join(tmpRoot, "state");
    const configPath = path.join(tmpRoot, "openclaw.json");
    const oauthDir = path.join(tmpRoot, "credentials");
    const oauthPath = path.join(oauthDir, "token.json");
    const markerPath = path.join(stateDir, "marker.txt");
    await fs.mkdir(stateDir);
    await fs.mkdir(oauthDir);
    await fs.writeFile(markerPath, "remove me");
    await fs.writeFile(configPath, "{}\n");
    await fs.writeFile(oauthPath, "keep me");
    const realRm = fs.rm;
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === markerPath) {
        throw new Error("simulated state removal failure");
      }
      return await realRm(target, options);
    });

    try {
      await expect(
        removeStateAndLinkedPaths(
          {
            stateDir,
            configPath,
            oauthDir,
            configInsideState: false,
            oauthInsideState: false,
          },
          runtime,
        ),
      ).rejects.toThrow(/Failed to remove non-preserved OpenClaw state/);

      await expect(fs.readFile(configPath, "utf8")).resolves.toBe("{}\n");
      await expect(fs.readFile(oauthPath, "utf8")).resolves.toBe("keep me");
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("rejects a preserved workspace overlapping the active lock before cleanup", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = await fs.realpath(tempDirs.make("openclaw-cleanup-lock-overlap-"));
    const stateDir = path.join(tmpRoot, "state");
    const configPath = path.join(tmpRoot, "openclaw.json");
    const workspaceDir = path.join(resolveGatewayLockDir(stateDir), "workspace");
    const workspaceFile = path.join(workspaceDir, "project.txt");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(workspaceFile, "keep me");
    await fs.writeFile(configPath, "{}");

    await expect(
      removeStateAndLinkedPaths(
        {
          stateDir,
          configPath,
          oauthDir: path.join(stateDir, "credentials"),
          configInsideState: false,
          oauthInsideState: true,
        },
        runtime,
        { preservePaths: [workspaceDir] },
      ),
    ).rejects.toThrow(/overlaps the active state lock/);

    await expect(fs.readFile(workspaceFile, "utf8")).resolves.toBe("keep me");
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe("{}");
  });

  it("preserves nested workspace paths during state-only removal", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-")),
    );
    const stateDir = path.join(tmpRoot, ".openclaw");
    const workspaceDir = path.join(stateDir, "tmp", "workspace");
    const workspaceFile = path.join(workspaceDir, "project.txt");
    const configPath = path.join(stateDir, "openclaw.json");
    const cacheFile = path.join(stateDir, "cache.json");

    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(workspaceFile, "keep me");
      await fs.writeFile(configPath, "{}");
      await fs.writeFile(cacheFile, "remove me");

      await removeStateAndLinkedPaths(
        {
          stateDir,
          configPath,
          oauthDir: path.join(stateDir, "credentials"),
          configInsideState: true,
          oauthInsideState: true,
        },
        runtime,
        { preservePaths: [workspaceDir] },
      );

      await expect(fs.readFile(workspaceFile, "utf8")).resolves.toBe("keep me");
      await expect(fs.stat(configPath)).rejects.toThrow();
      await expect(fs.stat(cacheFile)).rejects.toThrow();
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("removes every workspace directory", async () => {
    const runtime = createRuntimeMock();
    const workspaces = ["/tmp/openclaw-workspace-1", "/tmp/openclaw-workspace-2"];

    await removeWorkspaceDirs(workspaces, runtime, { dryRun: true });

    const logs = runtime.log.mock.calls.map(([line]) => line);
    expect(logs).toEqual([
      "[dry-run] remove /tmp/openclaw-workspace-1",
      "[dry-run] remove /tmp/openclaw-workspace-2",
    ]);
  });

  it("deletes workspace state only after workspace removal succeeds", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = tempDirs.make("openclaw-cleanup-workspace-");
    const workspaceDir = path.join(tmpRoot, "workspace");

    try {
      await fs.mkdir(workspaceDir, { recursive: true });

      await removeWorkspaceDirs([workspaceDir], runtime, { removeStateRows: true });

      await expect(fs.stat(workspaceDir)).rejects.toThrow();
      expect(workspaceStateMocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("cleans workspace state when the workspace directory is already missing", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = tempDirs.make("openclaw-cleanup-missing-workspace-");
    const workspaceDir = path.join(tmpRoot, "workspace");
    const siblingMarker = `${workspaceDir}.attested`;

    try {
      await fs.writeFile(
        siblingMarker,
        "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n",
      );

      await removeWorkspaceDirs([workspaceDir], runtime, { removeStateRows: true });

      await expect(fs.stat(siblingMarker)).rejects.toThrow();
      expect(workspaceStateMocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("removes a retired sibling marker after workspace removal without opening SQLite", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = tempDirs.make("openclaw-cleanup-legacy-");
    const workspaceDir = path.join(tmpRoot, "workspace");
    const siblingMarker = `${workspaceDir}.attested`;

    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(
        siblingMarker,
        "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n",
      );

      await removeWorkspaceDirs([workspaceDir], runtime);

      await expect(fs.stat(workspaceDir)).rejects.toThrow();
      await expect(fs.stat(siblingMarker)).rejects.toThrow();
      expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("does not delete workspace state during dry-run", async () => {
    const runtime = createRuntimeMock();

    await removeWorkspaceDirs(["/tmp/openclaw-workspace"], runtime, {
      dryRun: true,
      removeStateRows: true,
    });

    expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
  });

  it("previews retired sibling-marker cleanup during workspace dry-run", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = tempDirs.make("openclaw-cleanup-dry-run-legacy-");
    const workspaceDir = path.join(tmpRoot, "workspace");
    const siblingMarker = `${workspaceDir}.attested`;

    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(
        siblingMarker,
        "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n",
      );

      await removeWorkspaceDirs([workspaceDir], runtime, { dryRun: true });

      expect(runtime.log).toHaveBeenCalledWith(`[dry-run] remove ${siblingMarker}`);
      await expect(fs.lstat(siblingMarker)).resolves.toBeDefined();
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("retains workspace state when filesystem removal fails", async () => {
    const runtime = createRuntimeMock();
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("permission denied"));

    try {
      await removeWorkspaceDirs(["/tmp/openclaw-workspace"], runtime, {
        removeStateRows: true,
      });
    } finally {
      rmSpy.mockRestore();
    }

    expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
  });

  it("continues after an injected workspace remover rejects", async () => {
    const runtime = createRuntimeMock();
    const removeWorkspace = vi
      .fn<(workspace: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("trash unavailable"))
      .mockResolvedValueOnce(true);

    const failures = await removeWorkspaceDirs(["/tmp/first", "/tmp/second"], runtime, {
      removeWorkspace,
    });

    expect(removeWorkspace).toHaveBeenCalledTimes(2);
    expect(failures).toEqual(["/tmp/first"]);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("trash unavailable"));
  });

  it("refuses to remove the current working directory", async () => {
    const runtime = createRuntimeMock();
    const result = await removePath(process.cwd(), runtime, { dryRun: true });

    expect(result.ok).toBe(false);
    expect(result.skipped).toBeUndefined();
    expect(runtime.error.mock.calls.length).toBe(1);
    expect(
      expectDefined(runtime.error.mock.calls[0], "runtime.error.mock.calls[0] test invariant")[0],
    ).toMatch(/Refusing to remove unsafe path/);
    expect(runtime.log.mock.calls.length).toBe(0);
  });

  it("refuses to remove a directory containing the current working directory", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-cwd-"));
    const nestedCwd = path.join(tmpRoot, "nested");
    const cwdSpy = vi.spyOn(process, "cwd");

    try {
      await fs.mkdir(nestedCwd);
      cwdSpy.mockReturnValue(nestedCwd);

      const result = await removePath(tmpRoot, runtime, { dryRun: true });

      expect(result.ok).toBe(false);
      expect(result.skipped).toBeUndefined();
      expect(runtime.error.mock.calls.length).toBe(1);
      expect(
        expectDefined(runtime.error.mock.calls[0], "runtime.error.mock.calls[0] test invariant")[0],
      ).toMatch(/Refusing to remove unsafe path/);
      expect(runtime.log.mock.calls.length).toBe(0);
    } finally {
      cwdSpy.mockRestore();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("listAgentSessionDirs", () => {
  it("treats a missing agents root as empty but propagates inspection failures", async () => {
    await expect(listAgentSessionDirs("/tmp/openclaw-missing-state")).resolves.toEqual([]);

    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const readdir = vi.spyOn(fs, "readdir").mockRejectedValueOnce(error);
    try {
      await expect(listAgentSessionDirs("/tmp/openclaw-unreadable-state")).rejects.toBe(error);
    } finally {
      readdir.mockRestore();
    }
  });
});
