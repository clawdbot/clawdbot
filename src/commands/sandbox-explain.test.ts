// Sandbox explain tests cover command output for sandbox browser and container diagnostics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { sandboxExplainCommand } from "./sandbox-explain.js";

const SANDBOX_EXPLAIN_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 30_000;

let mockCfg: unknown = {};
let testState: OpenClawTestState;

beforeEach(async () => {
  mockCfg = {};
  testState = await createOpenClawTestState({
    label: "sandbox-explain",
    applyEnv: false,
  });
});

afterEach(async () => {
  await testState.cleanup();
});

function testSessionStore(): string {
  return testState.statePath("sessions", "{agentId}.json");
}

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: vi.fn().mockImplementation(() => mockCfg),
    loadConfig: vi.fn().mockImplementation(() => mockCfg),
  };
});

describe("sandbox explain command", () => {
  it("honors an explicit agent in an ownerless multi-agent fleet", async () => {
    mockCfg = {
      agents: {
        ownership: "explicit",
        defaults: { sandbox: { mode: "off" } },
        list: [
          { id: "ops", workspace: "/tmp/openclaw-ops-workspace" },
          { id: "research", workspace: "/tmp/openclaw-research-workspace" },
        ],
      },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, agent: "research" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.agentId).toBe("research");
    expect(parsed.sandbox.effectiveHostWorkspaceRoot).toBe(
      path.resolve("/tmp/openclaw-research-workspace"),
    );
  });

  it("reads a missing session without creating or registering an agent database", async () => {
    await withOpenClawTestState({ label: "sandbox-explain-readonly" }, async (state) => {
      const agentDatabasePath = state.statePath(
        "agents",
        "readonly",
        "agent",
        "openclaw-agent.sqlite",
      );
      mockCfg = {
        agents: {
          defaults: { sandbox: { mode: "off" } },
          list: [{ id: "readonly", workspace: state.workspaceDir }],
        },
        session: { store: agentDatabasePath },
      };
      const stateDatabase = openOpenClawStateDatabase({ env: state.env });

      await sandboxExplainCommand({ json: true, agent: "readonly" }, {
        log: () => {},
        error: () => {},
        exit: () => {},
      } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

      expect(stateDatabase.db.prepare("SELECT agent_id FROM agent_databases").all()).toEqual([]);
      await expect(fs.stat(agentDatabasePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("prints JSON shape + fix-it keys", { timeout: SANDBOX_EXPLAIN_TEST_TIMEOUT_MS }, async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        },
      },
      tools: {
        sandbox: { tools: { deny: ["browser"] } },
        elevated: { enabled: true, allowFrom: { quietchat: ["*"] } },
      },
      session: { store: testSessionStore() },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, session: "agent:main:main" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const out = logs.join("");
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("docsUrl", "https://docs.openclaw.ai/sandbox");
    expect(parsed).toHaveProperty("sandbox.mode", "all");
    expect(parsed).toHaveProperty("sandbox.tools.sources.allow.source");
    expect(parsed.fixIt).toEqual([
      "agents.defaults.sandbox.mode=off",
      "agents.entries.*.sandbox.mode=off",
      "tools.sandbox.tools.allow",
      "tools.sandbox.tools.alsoAllow",
      "tools.sandbox.tools.deny",
      "agents.entries.*.tools.sandbox.tools.allow",
      "agents.entries.*.tools.sandbox.tools.alsoAllow",
      "agents.entries.*.tools.sandbox.tools.deny",
      "tools.elevated.enabled",
    ]);
  });

  it("shows effective sandbox alsoAllow grants and default-deny removals", async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        },
        list: [
          {
            id: "tavern",
            tools: {
              sandbox: {
                tools: {
                  alsoAllow: ["message", "tts"],
                },
              },
            },
          },
        ],
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser"],
          },
        },
      },
      session: { store: testSessionStore() },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, agent: "tavern" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.sandbox.tools.allow).toEqual(["browser", "message", "tts", "view_image"]);
    expect(parsed.sandbox.tools.deny).not.toContain("browser");
    expect(parsed.sandbox.tools.sources.allow).toEqual({
      source: "agent",
      key: "agents.entries.*.tools.sandbox.tools.alsoAllow",
    });
  });

  it.each(["docker", "podman"])(
    "reports the effective rw workspace and %s mount without changing workspaceRoot",
    async (backend) => {
      mockCfg = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend,
              scope: "agent",
              workspaceAccess: "rw",
              workspaceRoot: "/tmp/openclaw-sandboxes",
            },
          },
          list: [{ id: "builder", workspace: "/tmp/openclaw-agent-workspace" }],
        },
        session: { store: testSessionStore() },
      };

      const logs: string[] = [];
      await sandboxExplainCommand({ json: true, agent: "builder" }, {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
        exit: (_code: number) => {},
      } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

      const parsed = JSON.parse(logs.join(""));
      const agentWorkspace = path.resolve("/tmp/openclaw-agent-workspace");
      expect(parsed.sandbox.backend).toBe(backend);
      expect(parsed.sandbox.workspaceRoot).toBe("/tmp/openclaw-sandboxes");
      expect(parsed.sandbox.effectiveHostWorkspaceRoot).toBe(agentWorkspace);
      expect(parsed.sandbox.runtimeWorkdir).toBe("/workspace");
      expect(parsed.sandbox.workspaceSource).toBe("agent");
      expect(parsed.sandbox.workspaceMounts).toEqual([
        {
          hostRoot: agentWorkspace,
          containerRoot: "/workspace",
          writable: true,
          source: "workspace",
        },
      ]);
    },
  );

  it("uses the canonical derived workspace for non-default agents", async () => {
    mockCfg = {
      agents: {
        defaults: {
          workspace: "/tmp/openclaw-agent-workspaces",
          sandbox: {
            mode: "all",
            scope: "agent",
            workspaceAccess: "rw",
            workspaceRoot: "/tmp/openclaw-sandboxes",
          },
        },
        list: [{ id: "main", default: true }, { id: "builder" }],
      },
      session: { store: testSessionStore() },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, agent: "builder" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.sandbox.effectiveHostWorkspaceRoot).toBe(
      path.resolve("/tmp/openclaw-agent-workspaces/builder"),
    );
    expect(parsed.sandbox.workspaceMounts[0]).toMatchObject({
      hostRoot: path.resolve("/tmp/openclaw-agent-workspaces/builder"),
      source: "workspace",
      writable: true,
    });
  });

  it("reports the generated sandbox workspace for non-rw sessions", async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
            workspaceAccess: "none",
            workspaceRoot: "/tmp/openclaw-sandboxes",
          },
        },
        list: [{ id: "builder", workspace: "/tmp/openclaw-agent-workspace" }],
      },
      session: { store: testSessionStore() },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, agent: "builder" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const parsed = JSON.parse(logs.join(""));
    expect(path.dirname(parsed.sandbox.effectiveHostWorkspaceRoot)).toBe(
      path.resolve("/tmp/openclaw-sandboxes"),
    );
    expect(path.basename(parsed.sandbox.effectiveHostWorkspaceRoot)).toMatch(
      /^workspace-[a-f0-9]{32}$/,
    );
    expect(parsed.sandbox.workspaceSource).toBe("sandbox");
    expect(parsed.sandbox.workspaceMounts).toEqual([
      expect.objectContaining({ source: "workspace", writable: false }),
    ]);
  });

  it("reports the agent workspace for direct sessions", async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: {
            mode: "off",
            scope: "agent",
            workspaceAccess: "none",
            workspaceRoot: "/tmp/openclaw-sandboxes",
          },
        },
        list: [{ id: "builder", workspace: "/tmp/openclaw-agent-workspace" }],
      },
      session: { store: testSessionStore() },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, agent: "builder" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.sandbox.effectiveHostWorkspaceRoot).toBe(
      path.resolve("/tmp/openclaw-agent-workspace"),
    );
    expect(parsed.sandbox.runtimeWorkdir).toBe(path.resolve("/tmp/openclaw-agent-workspace"));
    expect(parsed.sandbox.workspaceSource).toBe("direct");
    expect(parsed.sandbox.workspaceMounts).toEqual([]);
  });

  it("uses persisted spawned-session workspace and cwd overrides", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-explain-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:builder:subagent:child";
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: "child-session",
      updatedAt: Date.now(),
      spawnedBy: "agent:builder:main",
      spawnedWorkspaceDir: "/tmp/openclaw-child-workspace",
      spawnedCwd: "/tmp/openclaw-child-workspace/task",
    } as SessionEntry);
    mockCfg = {
      agents: {
        defaults: { sandbox: { mode: "off" } },
        list: [{ id: "builder", workspace: "/tmp/openclaw-agent-workspace" }],
      },
      session: { store: storePath },
    };

    try {
      const logs: string[] = [];
      await sandboxExplainCommand({ json: true, session: sessionKey }, {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
        exit: (_code: number) => {},
      } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

      const parsed = JSON.parse(logs.join(""));
      expect(parsed.sandbox.effectiveHostWorkspaceRoot).toBe(
        path.resolve("/tmp/openclaw-child-workspace"),
      );
      expect(parsed.sandbox.runtimeWorkdir).toBe("/tmp/openclaw-child-workspace/task");
      expect(parsed.sandbox.workspaceSource).toBe("direct");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("mounts a persisted spawned workspace for sandboxed sessions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-explain-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:builder:subagent:child";
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: "child-session",
      updatedAt: Date.now(),
      spawnedBy: "agent:builder:main",
      spawnedWorkspaceDir: "/tmp/openclaw-child-workspace",
    } as SessionEntry);
    mockCfg = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "rw" },
        },
        list: [{ id: "builder", workspace: "/tmp/openclaw-agent-workspace" }],
      },
      session: { store: storePath },
    };

    try {
      const logs: string[] = [];
      await sandboxExplainCommand({ json: true, session: sessionKey }, {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
        exit: (_code: number) => {},
      } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

      const parsed = JSON.parse(logs.join(""));
      expect(parsed.sandbox.effectiveHostWorkspaceRoot).toBe(
        path.resolve("/tmp/openclaw-child-workspace"),
      );
      expect(parsed.sandbox.runtimeWorkdir).toBe("/workspace");
      expect(parsed.sandbox.workspaceMounts[0]).toMatchObject({
        hostRoot: path.resolve("/tmp/openclaw-child-workspace"),
        containerRoot: "/workspace",
        writable: true,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports a global main session as direct in non-main mode", async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",
            scope: "agent",
            workspaceAccess: "none",
            workspaceRoot: "/tmp/openclaw-sandboxes",
          },
        },
        list: [{ id: "main", workspace: "/tmp/openclaw-main-workspace" }],
      },
      session: {
        scope: "global",
        store: testSessionStore(),
      },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, session: "global" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.sandbox.sessionIsSandboxed).toBe(false);
    expect(parsed.sandbox.effectiveHostWorkspaceRoot).toBe(
      path.resolve("/tmp/openclaw-main-workspace"),
    );
    expect(parsed.sandbox.workspaceSource).toBe("direct");
    expect(parsed.sandbox.workspaceMounts).toEqual([]);
  });

  it("uses the configured default agent for global sessions", async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main" },
        },
        list: [
          {
            id: "ops",
            default: true,
            workspace: "/tmp/openclaw-ops-workspace",
          },
        ],
      },
      session: { scope: "global" },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, agent: "ops", session: "global" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.agentId).toBe("ops");
    expect(parsed.sandbox.sessionIsSandboxed).toBe(false);
    expect(parsed.sandbox.effectiveHostWorkspaceRoot).toBe(
      path.resolve("/tmp/openclaw-ops-workspace"),
    );
  });

  it("rejects a fully qualified session from a different agent", async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main" },
        },
      },
    };

    await expect(
      sandboxExplainCommand({ json: true, agent: "builder", session: "agent:main:main" }, {
        log: () => {},
        error: () => {},
        exit: (_code: number) => {},
      } as unknown as Parameters<typeof sandboxExplainCommand>[1]),
    ).rejects.toThrow('agent "builder" does not match session agent "main"');
  });
});
