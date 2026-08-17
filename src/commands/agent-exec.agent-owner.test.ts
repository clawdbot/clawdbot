import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadAuthProfileStoreForRuntime, saveAuthProfileStore } from "../agents/auth-profiles.js";
import { getRuntimeConfigSnapshot } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentExecCommand } from "./agent-exec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent exec owner selection", () => {
  it("uses an explicitly selected agent's workspace, runtime, and credentials", async () => {
    const configRoot = tempDirs.make("openclaw-agent-exec-selected-agent-");
    const configPath = path.join(configRoot, "openclaw.json");
    const alphaWorkspace = path.join(configRoot, "workspaces", "alpha");
    const betaWorkspace = path.join(configRoot, "workspaces", "beta");
    const alphaAgentDir = path.join(configRoot, "agents", "alpha");
    const betaAgentDir = path.join(configRoot, "agents", "beta");
    await Promise.all(
      [alphaWorkspace, betaWorkspace, alphaAgentDir, betaAgentDir].map((dir) =>
        fs.mkdir(dir, { recursive: true }),
      ),
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          entries: {
            alpha: {
              workspace: alphaWorkspace,
              agentDir: alphaAgentDir,
              runtime: { type: "embedded" },
            },
            beta: {
              workspace: betaWorkspace,
              agentDir: betaAgentDir,
              runtime: { type: "acp", acp: { agent: "codex" } },
            },
          },
        },
      }),
      "utf8",
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai-codex:alpha": {
            type: "oauth",
            provider: "openai-codex",
            access: "alpha-access",
            refresh: "alpha-refresh",
            expires: Date.now() + 60_000,
          },
        },
      },
      alphaAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai-codex:beta": {
            type: "oauth",
            provider: "openai-codex",
            access: "beta-access",
            refresh: "beta-refresh",
            expires: Date.now() + 60_000,
          },
        },
      },
      betaAgentDir,
    );
    let selectedOptions: Record<string, unknown> | undefined;
    let selectedProfileIds: string[] = [];
    let selectedRuntime: unknown;
    const runAgent = vi.fn(async (options: Record<string, unknown>) => {
      selectedOptions = options;
      selectedProfileIds = Object.keys(
        loadAuthProfileStoreForRuntime(undefined, {
          allowKeychainPrompt: false,
          syncExternalCli: false,
        }).profiles,
      );
      selectedRuntime = getRuntimeConfigSnapshot()?.agents?.entries?.beta?.runtime;
      return {
        payloads: [{ text: "done" }],
        meta: { durationMs: 1 },
      };
    });

    const result = await agentExecCommand(
      "inspect",
      { config: configPath, agent: "beta" },
      runtime,
      { runAgent },
    );

    expect(result.exitCode).toBe(0);
    expect(selectedOptions).toMatchObject({
      agentId: "beta",
      workspaceDir: betaWorkspace,
      cwd: betaWorkspace,
    });
    expect(selectedRuntime).toMatchObject({ type: "acp", acp: { agent: "codex" } });
    expect(selectedProfileIds).toContain("openai-codex:beta");
    expect(selectedProfileIds).not.toContain("openai-codex:alpha");
  });

  it("lets an explicit cwd override the selected agent workspace", async () => {
    const configRoot = tempDirs.make("openclaw-agent-exec-selected-cwd-");
    const configPath = path.join(configRoot, "openclaw.json");
    const configuredWorkspace = path.join(configRoot, "configured-workspace");
    const overrideWorkspace = path.join(configRoot, "override-workspace");
    await Promise.all(
      [configuredWorkspace, overrideWorkspace].map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          entries: { beta: { workspace: configuredWorkspace } },
        },
      }),
      "utf8",
    );
    const runAgent = vi.fn(async () => ({
      payloads: [{ text: "done" }],
      meta: { durationMs: 1 },
    }));

    const result = await agentExecCommand(
      "inspect",
      { config: configPath, agent: "beta", cwd: overrideWorkspace },
      runtime,
      { runAgent },
    );

    expect(result.exitCode).toBe(0);
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "beta",
        workspaceDir: overrideWorkspace,
        cwd: overrideWorkspace,
      }),
      expect.any(Object),
    );
  });

  it("rejects an unknown explicit agent before starting a run", async () => {
    const configRoot = tempDirs.make("openclaw-agent-exec-unknown-agent-");
    const configPath = path.join(configRoot, "openclaw.json");
    const workspace = path.join(configRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          entries: { alpha: { workspace } },
        },
      }),
      "utf8",
    );
    const runAgent = vi.fn();

    const result = await agentExecCommand(
      "inspect",
      { config: configPath, agent: "missing" },
      runtime,
      { runAgent },
    );

    expect(result.exitCode).toBe(1);
    expect(result.envelope.error?.message).toBe(
      'Unknown agent id "missing". Run openclaw agents list to see configured agents.',
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a migrated legacy default",
      config: {
        agents: {
          entries: {
            alpha: { default: true },
            beta: {},
          },
        },
      },
    },
    {
      name: "the canonical system-agent owner",
      config: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "alpha" } },
          entries: { alpha: {}, beta: {} },
        },
      },
    },
  ])("uses $name for the run and its SQLite store scope", async ({ config }) => {
    const configRoot = tempDirs.make("openclaw-agent-exec-default-agent-");
    const configPath = path.join(configRoot, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    const runAgent = vi.fn(async (options: Record<string, unknown>) => {
      const requestedAgentId = typeof options.agentId === "string" ? options.agentId : "main";
      const sessionId = String(options.sessionId);
      const storePath = resolveSessionStorePathCore(undefined, {
        agentId: "alpha",
        env: process.env,
      });

      // Exercise the production guard that rejects keys owned by another agent.
      expect(() =>
        resolveSqliteScope({
          agentId: requestedAgentId,
          defaultAgentId: "alpha",
          env: process.env,
          sessionKey: `agent:${requestedAgentId}:explicit:${sessionId}`,
          storePath,
        }),
      ).not.toThrow();
      expect(requestedAgentId).toBe("alpha");
      return {
        payloads: [{ text: "done" }],
        meta: { durationMs: 1 },
      };
    });

    const result = await agentExecCommand("inspect", { config: configPath }, runtime, { runAgent });

    expect(result.envelope.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(runAgent).toHaveBeenCalledOnce();
  });
});
