// System prompt params tests cover runtime metadata assembly, especially repo
// root discovery from workspace, cwd, and explicit config.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActiveNodeContext } from "../infra/active-node-context.js";
import { buildSystemPromptParams, resolveSystemPromptRepoRoot } from "./system-prompt-params.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function makeRepoRoot(root: string): Promise<void> {
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
}

function buildParams(params: { config?: OpenClawConfig; workspaceDir?: string; cwd?: string }) {
  const preparedRepoRoot = resolveSystemPromptRepoRoot(params);
  return buildSystemPromptParams({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    preparedRepoRoot,
    runtime: {
      host: "host",
      os: "os",
      arch: "arch",
      node: "node",
      model: "model",
    },
  });
}

describe("buildSystemPromptParams", () => {
  afterEach(() => {
    setActiveNodeContext(null);
    vi.useRealTimers();
  });

  it("formats the current date in the configured user timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T23:30:00.000Z"));

    const utc = buildParams({
      config: { agents: { defaults: { userTimezone: "UTC" } } },
    });
    const tokyo = buildParams({
      config: { agents: { defaults: { userTimezone: "Asia/Tokyo" } } },
    });

    expect(utc.userDate).toBe("2026-01-05");
    expect(tokyo.userDate).toBe("2026-01-06");
  });

  it("projects only the stable active-node identity", () => {
    setActiveNodeContext({ nodeId: "mac-123" });

    const { runtimeInfo } = buildParams({});

    expect(runtimeInfo.activeNode).toBe("mac-123");
  });

  it("omits an active node that fails current-generation validation", () => {
    setActiveNodeContext(
      { nodeId: "mac-123", pairingGeneration: "generation-a" },
      { isCurrent: () => false },
    );

    const { runtimeInfo } = buildParams({});

    expect(runtimeInfo.activeNode).toBeUndefined();
  });

  it("detects repo root from workspaceDir", async () => {
    const temp = tempDirs.make("openclaw-workspace-");
    const repoRoot = path.join(temp, "repo");
    const workspaceDir = path.join(repoRoot, "nested", "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(repoRoot);

    const { runtimeInfo } = buildParams({ workspaceDir });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("falls back to cwd when workspaceDir has no repo", async () => {
    const temp = tempDirs.make("openclaw-cwd-");
    const repoRoot = path.join(temp, "repo");
    const workspaceDir = path.join(temp, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(repoRoot);

    const { runtimeInfo } = buildParams({ workspaceDir, cwd: repoRoot });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("uses configured repoRoot when valid", async () => {
    const temp = tempDirs.make("openclaw-config-");
    const repoRoot = path.join(temp, "config-root");
    const workspaceDir = path.join(temp, "workspace");
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(workspaceDir);

    const config: OpenClawConfig = {
      agents: {
        defaults: {
          repoRoot,
        },
      },
    };

    const { runtimeInfo } = buildParams({ config, workspaceDir });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("ignores invalid repoRoot config and auto-detects", async () => {
    // Invalid explicit roots must not poison runtime metadata; auto-detection
    // still finds the real repository root from the workspace path.
    const temp = tempDirs.make("openclaw-invalid-");
    const repoRoot = path.join(temp, "repo");
    const workspaceDir = path.join(repoRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await makeRepoRoot(repoRoot);

    const config: OpenClawConfig = {
      agents: {
        defaults: {
          repoRoot: path.join(temp, "missing"),
        },
      },
    };

    const { runtimeInfo } = buildParams({ config, workspaceDir });

    expect(runtimeInfo.repoRoot).toBe(repoRoot);
  });

  it("returns undefined when no repo is found", async () => {
    const workspaceDir = tempDirs.make("openclaw-norepo-");

    const { runtimeInfo } = buildParams({ workspaceDir });

    expect(runtimeInfo.repoRoot).toBeUndefined();
  });

  it("does not rediscover the repository after preparation", async () => {
    const workspaceDir = tempDirs.make("openclaw-prepared-norepo-");
    const repoRoot = tempDirs.make("openclaw-late-repo-");
    const preparedRepoRoot = resolveSystemPromptRepoRoot({ workspaceDir });
    await makeRepoRoot(repoRoot);

    const { runtimeInfo } = buildSystemPromptParams({
      preparedRepoRoot,
      workspaceDir,
      cwd: repoRoot,
      runtime: {
        host: "host",
        os: "os",
        arch: "arch",
        node: "node",
        model: "model",
      },
    });

    expect(runtimeInfo.repoRoot).toBeUndefined();
  });

  it("carries session identity into runtime info", () => {
    const { runtimeInfo } = buildSystemPromptParams({
      agentId: "main",
      runtime: {
        sessionKey: "agent:main:main",
        sessionId: "23ae7fce-3c27-4a51-b58e-d800d8ca091f",
        host: "host",
        os: "os",
        arch: "arch",
        node: "node",
        model: "model",
      },
    });

    expect(runtimeInfo.sessionKey).toBe("agent:main:main");
    expect(runtimeInfo.sessionId).toBe("23ae7fce-3c27-4a51-b58e-d800d8ca091f");
  });
});
