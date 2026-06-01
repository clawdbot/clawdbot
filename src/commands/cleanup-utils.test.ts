import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyAgentDefaultPrimaryModel } from "../plugins/provider-model-primary.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildCleanupPlan,
  removeStateAndLinkedPaths,
  removeWorkspaceAttestationPaths,
  removeWorkspaceDirs,
} from "./cleanup-utils.js";

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
    expect(new Set(plan.workspaceDirs)).toEqual(new Set([defaultWorkspace, opsWorkspace]));
  });

  test("includes implicit per-agent workspaces under the state dir", () => {
    const previousHome = process.env.HOME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousWorkspaceDir = process.env.OPENCLAW_WORKSPACE_DIR;
    const tmpRoot = path.join(path.parse(process.cwd()).root, "tmp", "openclaw-cleanup-plan");
    const home = path.join(tmpRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const cfg = {
      agents: {
        list: [{ id: "main" }, { id: "work" }],
      },
    };

    try {
      process.env.HOME = home;
      process.env.OPENCLAW_STATE_DIR = stateDir;
      delete process.env.OPENCLAW_WORKSPACE_DIR;

      const plan = buildCleanupPlan({
        cfg: cfg as unknown as OpenClawConfig,
        stateDir,
        configPath: path.join(stateDir, "openclaw.json"),
        oauthDir: path.join(stateDir, "credentials"),
      });

      expect(new Set(plan.workspaceDirs)).toEqual(
        new Set([path.join(stateDir, "workspace"), path.join(stateDir, "workspace-work")]),
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousWorkspaceDir === undefined) {
        delete process.env.OPENCLAW_WORKSPACE_DIR;
      } else {
        process.env.OPENCLAW_WORKSPACE_DIR = previousWorkspaceDir;
      }
    }
  });
});

describe("applyAgentDefaultPrimaryModel", () => {
  it("does not mutate when already set", () => {
    const cfg = { agents: { defaults: { model: { primary: "a/b" } } } } as OpenClawConfig;
    const result = applyAgentDefaultPrimaryModel({ cfg, model: "a/b" });
    expect(result.changed).toBe(false);
    expect(result.next).toBe(cfg);
  });

  it("normalizes legacy models", () => {
    const cfg = { agents: { defaults: { model: { primary: "legacy" } } } } as OpenClawConfig;
    const result = applyAgentDefaultPrimaryModel({
      cfg,
      model: "a/b",
      legacyModels: new Set(["legacy"]),
    });
    expect(result.changed).toBe(false);
    expect(result.next).toBe(cfg);
  });

  it("normalizes retired Google Gemini primary models before writing config", () => {
    const cfg = { agents: { defaults: {} } } as OpenClawConfig;
    const result = applyAgentDefaultPrimaryModel({
      cfg,
      model: "google/gemini-3-pro-preview",
    });
    expect(result.changed).toBe(true);
    expect(result.next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
    });
  });
});

describe("cleanup path removals", () => {
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
    await removeStateAndLinkedPaths(
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
  });

  it("preserves nested workspace paths during state-only removal", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-"));
    const stateDir = path.join(tmpRoot, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
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

  it("removes owned legacy workspace attestations", async () => {
    const runtime = createRuntimeMock();
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cleanup-attest-"));
    const workspaceDir = path.join(tmpRoot, "workspace");
    const legacyAttestationPath = `${workspaceDir}.attested`;

    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(
        legacyAttestationPath,
        `openclaw-workspace-attestation:v1\n${new Date().toISOString()}\n`,
      );

      await removeWorkspaceAttestationPaths([workspaceDir], runtime);

      await expect(fs.stat(legacyAttestationPath)).rejects.toThrow();
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
