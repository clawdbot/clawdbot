// Workspace run tests cover runtime workspace resolution from explicit input,
// agent config, session keys, and environment fallback.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveRunWorkspaceDir } from "./workspace-run.js";

describe("resolveRunWorkspaceDir", () => {
  it("resolves explicit workspace values without fallback", () => {
    const explicit = path.join(process.cwd(), "tmp", "workspace-run-explicit");
    const result = resolveRunWorkspaceDir({
      workspaceDir: explicit,
      sessionKey: "agent:main:subagent:test",
      config: { agents: { list: [{ id: "main", default: true }] } },
    });

    expect(result.usedFallback).toBe(false);
    expect(result.isCanonicalWorkspace).toBe(false);
    expect(result.agentId).toBe("main");
    expect(result.workspaceDir).toBe(path.resolve(explicit));
  });

  it("recognizes an explicitly supplied configured workspace as canonical", () => {
    const workspaceDir = path.join(process.cwd(), "tmp", "workspace-run-canonical");
    const cfg = {
      agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main", default: true }] },
    } satisfies OpenClawConfig;

    const result = resolveRunWorkspaceDir({
      workspaceDir,
      sessionKey: "agent:main:subagent:test",
      config: cfg,
    });

    expect(result.usedFallback).toBe(false);
    expect(result.isCanonicalWorkspace).toBe(true);
  });

  it("falls back to configured per-agent workspace when input is missing", () => {
    const defaultWorkspace = path.join(process.cwd(), "tmp", "workspace-default-main");
    const researchWorkspace = path.join(process.cwd(), "tmp", "workspace-research");
    const cfg = {
      agents: {
        defaults: { workspace: defaultWorkspace },
        list: [{ id: "research", workspace: researchWorkspace, default: true }],
      },
    } satisfies OpenClawConfig;

    const result = resolveRunWorkspaceDir({
      workspaceDir: undefined,
      sessionKey: "agent:research:subagent:test",
      config: cfg,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.isCanonicalWorkspace).toBe(true);
    expect(result.fallbackReason).toBe("missing");
    expect(result.agentId).toBe("research");
    expect(result.workspaceDir).toBe(path.resolve(researchWorkspace));
  });

  it("falls back to default workspace for blank strings", () => {
    const defaultWorkspace = path.join(process.cwd(), "tmp", "workspace-default-main");
    const cfg = {
      agents: {
        defaults: { workspace: defaultWorkspace },
        list: [{ id: "main", default: true }],
      },
    } satisfies OpenClawConfig;

    const result = resolveRunWorkspaceDir({
      workspaceDir: "   ",
      sessionKey: "agent:main:subagent:test",
      config: cfg,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe("blank");
    expect(result.agentId).toBe("main");
    expect(result.workspaceDir).toBe(path.resolve(defaultWorkspace));
  });

  it("refuses to invent an agent when config is unavailable", () => {
    const workspaceDir = path.join(path.sep, "srv", "openclaw-workspace");
    expect(() =>
      resolveRunWorkspaceDir({
        workspaceDir: null,
        sessionKey: "custom-main-key",
        config: undefined,
        env: { ...process.env, OPENCLAW_WORKSPACE_DIR: workspaceDir },
      }),
    ).toThrow("No agents configured");
  });

  it("throws for malformed agent session keys", () => {
    expect(() =>
      resolveRunWorkspaceDir({
        workspaceDir: undefined,
        sessionKey: "agent::broken",
        config: undefined,
      }),
    ).toThrow("Malformed agent session key");
  });

  it("requires roster config for per-agent fallback", () => {
    const env = {
      ...process.env,
      HOME: "/home/runner",
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
    } satisfies NodeJS.ProcessEnv;
    expect(() =>
      resolveRunWorkspaceDir({
        workspaceDir: undefined,
        sessionKey: "definitely-not-a-valid-session-key",
        agentId: "research",
        config: undefined,
        env,
      }),
    ).toThrow("No agents configured");
  });

  it("throws for malformed agent session keys even when config has a default agent", () => {
    // Malformed agent-prefixed keys are configuration/data errors; default
    // agents should not mask them as legacy main-session keys.
    const mainWorkspace = path.join(process.cwd(), "tmp", "workspace-main-default");
    const researchWorkspace = path.join(process.cwd(), "tmp", "workspace-research-default");
    const cfg = {
      agents: {
        defaults: { workspace: mainWorkspace },
        list: [
          { id: "main", workspace: mainWorkspace },
          { id: "research", workspace: researchWorkspace, default: true },
        ],
      },
    } satisfies OpenClawConfig;

    expect(() =>
      resolveRunWorkspaceDir({
        workspaceDir: undefined,
        sessionKey: "agent::broken",
        config: cfg,
      }),
    ).toThrow("Malformed agent session key");
  });

  it("treats non-agent legacy keys as default, not malformed", () => {
    const fallbackWorkspace = path.join(process.cwd(), "tmp", "workspace-default-legacy");
    const cfg = {
      agents: {
        defaults: { workspace: fallbackWorkspace },
        list: [{ id: "main", default: true }],
      },
    } satisfies OpenClawConfig;

    const result = resolveRunWorkspaceDir({
      workspaceDir: undefined,
      sessionKey: "custom-main-key",
      config: cfg,
    });

    expect(result.agentId).toBe("main");
    expect(result.agentIdSource).toBe("default");
    expect(result.workspaceDir).toBe(path.resolve(fallbackWorkspace));
  });
});
