// OpenClaw rescue message tests cover generated rescue message content.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createCorePluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { extractSystemAgentRescueMessage, runSystemAgentRescueMessage } from "./rescue-message.js";

let tempRoot = "";
let tempDirId = 0;

type TestConfig = Record<string, unknown>;

const mockConfig = vi.hoisted(() => {
  const state = {
    path: "/tmp/openclaw.json",
    config: {} as TestConfig,
    hash: "mock-hash-0" as string | undefined,
  };
  const cloneConfig = () => structuredClone(state.config);
  const snapshot = () => {
    const config = cloneConfig();
    return {
      path: state.path,
      exists: true,
      raw: `${JSON.stringify(config)}\n`,
      parsed: config,
      sourceConfig: config,
      resolved: config,
      valid: true,
      runtimeConfig: config,
      config,
      hash: state.hash,
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
  };
  return {
    reset() {
      state.path = "/tmp/openclaw.json";
      state.config = {};
      state.hash = "mock-hash-0";
    },
    currentConfig() {
      return cloneConfig();
    },
    readConfigFileSnapshot: vi.fn(async () => snapshot()),
    mutateConfigFile: vi.fn(
      async (params: {
        mutate: (
          draft: TestConfig,
          context: { snapshot: ReturnType<typeof snapshot> },
        ) => Promise<void> | void;
      }) => {
        const before = snapshot();
        const draft = cloneConfig();
        await params.mutate(draft, { snapshot: before });
        state.config = draft;
        state.hash = "mock-hash-1";
        return {
          path: state.path,
          previousHash: before.hash ?? null,
          persistedHash: before.hash ?? null,
          snapshot: before,
          nextConfig: cloneConfig(),
          result: undefined,
        };
      },
    ),
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    clearConfigCache: vi.fn(),
    mutateConfigFile: mockConfig.mutateConfigFile,
    readConfigFileSnapshot: mockConfig.readConfigFileSnapshot,
  };
});

vi.mock("../commands/models/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/models/shared.js")>();
  return {
    ...actual,
    applyDefaultModelPrimaryUpdate: ({
      cfg,
      modelRaw,
      field,
    }: {
      cfg: TestConfig;
      modelRaw: string;
      field: "model" | "imageModel";
    }) => ({
      ...cfg,
      agents: {
        ...(cfg.agents as TestConfig | undefined),
        defaults: {
          ...(cfg.agents as { defaults?: TestConfig } | undefined)?.defaults,
          [field]: { primary: modelRaw },
        },
      },
    }),
  };
});

vi.mock("../config/model-input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/model-input.js")>();
  return {
    ...actual,
    resolveAgentModelPrimaryValue: (model?: string | { primary?: string }) =>
      typeof model === "string" ? model : model?.primary,
  };
});

async function makeStateDir(prefix: string): Promise<string> {
  const dir = path.join(tempRoot, `${prefix}${tempDirId++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function withRescueStateDir(
  prefix: string,
  run: (stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await makeStateDir(prefix);
  resetPluginStateStoreForTests();
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => await run(stateDir));
  } finally {
    resetPluginStateStoreForTests();
  }
}

function commandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    surface: "whatsapp",
    channel: "whatsapp",
    channelId: "whatsapp",
    accountId: "default",
    ownerList: ["user:owner"],
    senderIsOwner: true,
    isAuthorizedSender: true,
    senderId: "user:owner",
    rawBodyNormalized: "/openclaw models",
    commandBodyNormalized: "/openclaw models",
    from: "user:owner",
    to: "account:default",
    ...overrides,
  };
}

function openRescuePendingTestStore() {
  return createCorePluginStateSyncKeyedStore<unknown>({
    ownerId: "core:system-agent",
    namespace: "rescue-pending",
    maxEntries: 1_024,
    overflowPolicy: "reject-new",
  });
}

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

async function runRescue(
  commandBody: string,
  cfg: OpenClawConfig,
  ctx = commandContext(),
  deps?: Parameters<typeof runSystemAgentRescueMessage>[0]["deps"],
) {
  return await runSystemAgentRescueMessage({
    cfg,
    command: { ...ctx, commandBodyNormalized: commandBody },
    commandBody,
    isGroup: false,
    deps,
  });
}

describe("OpenClaw rescue message", () => {
  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "system-agent-rescue-"));
  });

  beforeEach(() => {
    mockConfig.reset();
  });

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPluginStateStoreForTests();
  });

  it("recognizes the OpenClaw rescue command", () => {
    expect(extractSystemAgentRescueMessage("/openclaw status")).toBe("status");
    expect(extractSystemAgentRescueMessage("/openclaw")).toBe("");
    expect(extractSystemAgentRescueMessage("/status")).toBeNull();
  });

  it("denies rescue when sandboxing is active", async () => {
    await expect(
      runRescue("/openclaw status", {
        systemAgent: { rescue: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      }),
    ).resolves.toContain("sandboxing is active");
  });

  it("refuses TUI handoff from remote rescue", async () => {
    const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
    const deps = {
      runTui: vi.fn(async () => {
        throw new Error("remote rescue must not open the TUI");
      }),
    };

    await expect(
      runRescue("/openclaw talk to agent", cfg, commandContext(), deps),
    ).resolves.toContain("cannot open the local TUI");
    await expect(runRescue("/openclaw chat", cfg, commandContext(), deps)).resolves.toContain(
      "cannot open the local TUI",
    );
    expect(deps.runTui).not.toHaveBeenCalled();
  });

  it("rejects natural language instead of guessing an operation", async () => {
    const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
    const deps = {
      runGatewayStop: vi.fn(async () => {}),
      runGatewayRestart: vi.fn(async () => {}),
    };

    // Questions must never become mutation plans (previously "why did my
    // gateway stop" keyword-matched into a gateway-stop proposal).
    await expect(
      runRescue("/openclaw why did my gateway stop", cfg, commandContext(), deps),
    ).resolves.toContain("I can run doctor/status/health");
    await expect(
      runRescue("/openclaw explain how restart gateway works", cfg, commandContext(), deps),
    ).resolves.toContain("I can run doctor/status/health");
    expect(deps.runGatewayStop).not.toHaveBeenCalled();
    expect(deps.runGatewayRestart).not.toHaveBeenCalled();
  });

  it("refuses channel setup from remote rescue with a local pointer", async () => {
    const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
    await expect(runRescue("/openclaw connect telegram", cfg)).resolves.toContain(
      "cannot host the interactive channel setup",
    );
  });

  it("refuses model provider setup from remote rescue with a local pointer", async () => {
    const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
    const reply = await runRescue("/openclaw configure model provider", cfg);
    expect(reply).toContain("cannot host model-provider credential setup");
    expect(reply).toContain("openclaw onboard");
  });

  it("refuses doctor repairs without creating a pending approval", async () => {
    await withRescueStateDir("doctor-fix-refused-", async () => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = {
        runDoctor: vi.fn(async () => {
          throw new Error("remote rescue must not run doctor repair");
        }),
      };

      await expect(
        runRescue("/openclaw doctor fix", cfg, commandContext(), deps),
      ).resolves.toContain("run `openclaw doctor --fix` in a terminal");
      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(deps.runDoctor).not.toHaveBeenCalled();
    });
  });

  it("drops a pending rescue change on decline", async () => {
    await withRescueStateDir("decline-", async () => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = { runGatewayRestart: vi.fn(async () => {}) };

      await expect(
        runRescue("/openclaw restart gateway", cfg, commandContext(), deps),
      ).resolves.toContain("Reply /openclaw yes to apply");
      await expect(runRescue("/openclaw no", cfg, commandContext(), deps)).resolves.toContain(
        "Dropped the pending OpenClaw rescue change",
      );
      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(deps.runGatewayRestart).not.toHaveBeenCalled();
    });
  });

  it("revokes a pending write when a fresh read-only command arrives", async () => {
    await withRescueStateDir("read-revokes-", async () => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = {
        runGatewayRestart: vi.fn(async () => {}),
        runPluginsList: vi.fn(async (runtime: RuntimeEnv) => runtime.log("plugin rows")),
      };

      await expect(
        runRescue("/openclaw restart gateway", cfg, commandContext(), deps),
      ).resolves.toContain("Reply /openclaw yes to apply");
      await expect(runRescue("/openclaw plugins list", cfg, commandContext(), deps)).resolves.toBe(
        "plugin rows",
      );
      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(deps.runGatewayRestart).not.toHaveBeenCalled();
    });
  });

  it("consumes a pending approval at most once under concurrent approvals", async () => {
    await withRescueStateDir("concurrent-approve-", async () => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = { runGatewayRestart: vi.fn(async () => {}) };

      await runRescue("/openclaw restart gateway", cfg, commandContext(), deps);
      const replies = await Promise.all([
        runRescue("/openclaw yes", cfg, commandContext(), deps),
        runRescue("/openclaw yes", cfg, commandContext(), deps),
      ]);

      expect(deps.runGatewayRestart).toHaveBeenCalledTimes(1);
      expect(replies).toContain("No pending OpenClaw rescue change is waiting for approval.");
      expect(replies.some((reply) => reply?.includes("[openclaw] done: gateway.restart"))).toBe(
        true,
      );
    });
  });

  it("keeps failed execution consumed", async () => {
    await withRescueStateDir("failed-consumed-", async () => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = {
        runGatewayRestart: vi.fn(async () => {
          throw new Error("restart failed");
        }),
      };

      await runRescue("/openclaw restart gateway", cfg, commandContext(), deps);
      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).rejects.toThrow(
        "restart failed",
      );
      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(deps.runGatewayRestart).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves a new plan created while the consumed plan executes", async () => {
    await withRescueStateDir("replacement-during-execute-", async () => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      let releaseRestart: (() => void) | undefined;
      let noteRestartEntered: (() => void) | undefined;
      const restartEntered = new Promise<void>((resolve) => {
        noteRestartEntered = resolve;
      });
      const restartGate = new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
      const deps = {
        runGatewayRestart: vi.fn(async () => {
          noteRestartEntered?.();
          await restartGate;
        }),
        runGatewayStart: vi.fn(async () => {}),
      };

      await runRescue("/openclaw restart gateway", cfg, commandContext(), deps);
      const approval = runRescue("/openclaw yes", cfg, commandContext(), deps);
      await restartEntered;
      await runRescue("/openclaw start gateway", cfg, commandContext(), deps);
      releaseRestart?.();
      await expect(approval).resolves.toContain("[openclaw] done: gateway.restart");
      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toContain(
        "[openclaw] done: gateway.start",
      );
      expect(deps.runGatewayRestart).toHaveBeenCalledTimes(1);
      expect(deps.runGatewayStart).toHaveBeenCalledTimes(1);
    });
  });

  it("publishes concurrently invoked persistent plans in call order", async () => {
    await withRescueStateDir("latest-plan-", async () => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = {
        runGatewayRestart: vi.fn(async () => {}),
        runGatewayStart: vi.fn(async () => {}),
      };

      const olderPlan = runRescue("/openclaw restart gateway", cfg, commandContext(), deps);
      const newerPlan = runRescue("/openclaw start gateway", cfg, commandContext(), deps);
      await expect(olderPlan).resolves.toContain("restart the Gateway");
      await expect(newerPlan).resolves.toContain("start the Gateway");
      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toContain(
        "[openclaw] done: gateway.start",
      );
      expect(deps.runGatewayRestart).not.toHaveBeenCalled();
      expect(deps.runGatewayStart).toHaveBeenCalledTimes(1);
    });
  });

  it("persists a pending approval only in SQLite across store reopen", async () => {
    await withRescueStateDir("sqlite-reopen-", async (stateDir) => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = { runGatewayRestart: vi.fn(async () => {}) };

      await runRescue("/openclaw restart gateway", cfg, commandContext(), deps);
      resetPluginStateStoreForTests();

      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toContain(
        "[openclaw] done: gateway.restart",
      );
      expect(deps.runGatewayRestart).toHaveBeenCalledTimes(1);
      await expect(fs.access(path.join(stateDir, "openclaw", "rescue-pending"))).rejects.toThrow(
        /ENOENT/,
      );
    });
  });

  it("isolates pending approvals by account, channel, and sender", async () => {
    await withRescueStateDir("route-isolation-", async () => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = { runGatewayRestart: vi.fn(async () => {}) };
      const original = commandContext();

      await runRescue("/openclaw restart gateway", cfg, original, deps);
      for (const isolated of [
        commandContext({ accountId: "secondary" }),
        commandContext({ channelId: "telegram" }),
        commandContext({ from: "user:other", senderId: "user:other" }),
      ]) {
        await expect(runRescue("/openclaw yes", cfg, isolated, deps)).resolves.toBe(
          "No pending OpenClaw rescue change is waiting for approval.",
        );
      }
      await expect(runRescue("/openclaw yes", cfg, original, deps)).resolves.toContain(
        "[openclaw] done: gateway.restart",
      );
      expect(deps.runGatewayRestart).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to the channel destination when account id is absent", async () => {
    await withRescueStateDir("route-account-fallback-", async () => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = { runGatewayRestart: vi.fn(async () => {}) };
      const original = commandContext({ accountId: undefined, to: "bot:primary" });

      await runRescue("/openclaw restart gateway", cfg, original, deps);
      await expect(
        runRescue(
          "/openclaw yes",
          cfg,
          commandContext({ accountId: undefined, to: "bot:secondary" }),
          deps,
        ),
      ).resolves.toBe("No pending OpenClaw rescue change is waiting for approval.");
      await expect(runRescue("/openclaw yes", cfg, original, deps)).resolves.toContain(
        "[openclaw] done: gateway.restart",
      );
      expect(deps.runGatewayRestart).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses plugin install from remote rescue", async () => {
    const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
    const deps = {
      runPluginInstall: vi.fn(async () => {
        throw new Error("remote rescue must not install plugins");
      }),
    };

    await expect(
      runRescue("/openclaw plugin install clawhub:openclaw-demo", cfg, commandContext(), deps),
    ).resolves.toContain("cannot install plugins from a message channel");
    expect(deps.runPluginInstall).not.toHaveBeenCalled();
  });

  it("allows plugin list and search from remote rescue", async () => {
    const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
    const deps = {
      runPluginsList: vi.fn(async (runtime: RuntimeEnv) => {
        runtime.log("plugin rows");
      }),
      runPluginsSearch: vi.fn(async (query: string, runtime: RuntimeEnv) => {
        runtime.log(`search rows: ${query}`);
      }),
    };

    await expect(
      runRescue("/openclaw plugins list", cfg, commandContext(), deps),
    ).resolves.toContain("plugin rows");
    await expect(
      runRescue("/openclaw plugins search calendar", cfg, commandContext(), deps),
    ).resolves.toContain("search rows: calendar");
    expect(deps.runPluginsList).toHaveBeenCalledTimes(1);
    expect(deps.runPluginsSearch).toHaveBeenCalledTimes(1);
    const [searchQuery, searchRuntime] = requireFirstMockCall(
      deps.runPluginsSearch,
      "plugins search",
    );
    expect(searchQuery).toBe("calendar");
    expect(searchRuntime).toBeTypeOf("object");
  });

  it("queues and applies persistent writes through conversational approval", async () => {
    await withRescueStateDir("models-", async (tempDir) => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = {
        verifyInferenceConfig: vi.fn(async () => ({
          ok: true as const,
          modelRef: "openai/gpt-5.2",
          latencyMs: 17,
        })),
      };
      await expect(
        runRescue("/openclaw set default model openai/gpt-5.2", cfg, commandContext(), deps),
      ).resolves.toContain("Reply /openclaw yes to apply");
      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toContain(
        "Default model: openai/gpt-5.2",
      );

      const currentConfig = mockConfig.currentConfig() as {
        agents?: { defaults?: { model?: string | { primary?: string } } };
      };
      const model = currentConfig.agents?.defaults?.model;
      expect(typeof model === "string" ? model : model?.primary).toBe("openai/gpt-5.2");
      const auditPath = path.join(tempDir, "audit", "system-agent.jsonl");
      const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim()) as {
        details?: { rescue?: boolean; channel?: string; accountId?: string; senderId?: string };
      };
      expect(audit.details?.rescue).toBe(true);
      expect(audit.details?.channel).toBe("whatsapp");
      expect(audit.details?.accountId).toBe("default");
      expect(audit.details?.senderId).toBe("user:owner");
    });
  });

  it("queues and applies gateway restart through conversational approval", async () => {
    await withRescueStateDir("gateway-", async (tempDir) => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = { runGatewayRestart: vi.fn(async () => {}) };

      await expect(
        runRescue("/openclaw restart gateway", cfg, commandContext(), deps),
      ).resolves.toBe("Plan: restart the Gateway. Reply /openclaw yes to apply.");
      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toContain(
        "[openclaw] done: gateway.restart",
      );

      expect(deps.runGatewayRestart).toHaveBeenCalledTimes(1);
      const auditPath = path.join(tempDir, "audit", "system-agent.jsonl");
      const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim()) as {
        operation?: string;
        details?: { rescue?: boolean; channel?: string; senderId?: string };
      };
      expect(audit.operation).toBe("gateway.restart");
      expect(audit.details?.rescue).toBe(true);
      expect(audit.details?.channel).toBe("whatsapp");
      expect(audit.details?.senderId).toBe("user:owner");
    });
  });

  it("does not queue persistent rescue approval when expiry would exceed the Date range", async () => {
    await withRescueStateDir("overflow-expiry-", async (tempDir) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(8_640_000_000_000_000));
      try {
        const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };

        await expect(
          runRescue("/openclaw restart gateway", cfg, commandContext()),
        ).resolves.toContain("expiry clock is invalid");

        await expect(fs.readdir(path.join(tempDir, "openclaw", "rescue-pending"))).rejects.toThrow(
          /ENOENT/,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("expires pending approvals through the SQLite row TTL", async () => {
    await withRescueStateDir("expired-", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = { runGatewayRestart: vi.fn(async () => {}) };

      await runRescue(
        "/openclaw restart gateway",
        { systemAgent: { rescue: { enabled: true, pendingTtlMinutes: 1 } } },
        commandContext(),
        deps,
      );
      vi.advanceTimersByTime(60_001);

      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(deps.runGatewayRestart).not.toHaveBeenCalled();
    });
  });

  it("consumes malformed pending rows without executing them", async () => {
    await withRescueStateDir("malformed-", async () => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = { runGatewayRestart: vi.fn(async () => {}) };

      await runRescue("/openclaw restart gateway", cfg, commandContext(), deps);
      const store = openRescuePendingTestStore();
      const [entry] = store.entries();
      if (!entry) {
        throw new Error("expected pending rescue row");
      }
      store.register(
        entry.key,
        { version: 1, operation: { kind: "gateway-restart", unexpected: true } },
        { ttlMs: 60_000 },
      );

      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toBe(
        "No pending OpenClaw rescue change is waiting for approval.",
      );
      expect(deps.runGatewayRestart).not.toHaveBeenCalled();
    });
  });

  it("queues and applies agent creation through conversational approval", async () => {
    await withRescueStateDir("agent-", async (tempDir) => {
      const cfg: OpenClawConfig = { systemAgent: { rescue: { enabled: true } } };
      const deps = { runAgentsAdd: vi.fn(async () => {}) };

      await expect(
        runRescue("/openclaw create agent work workspace /tmp/work", cfg, commandContext(), deps),
      ).resolves.toBe(
        "Plan: create agent work with workspace /tmp/work. Reply /openclaw yes to apply.",
      );
      await expect(runRescue("/openclaw yes", cfg, commandContext(), deps)).resolves.toContain(
        "[openclaw] done: agents.create",
      );

      expect(deps.runAgentsAdd).toHaveBeenCalledTimes(1);
      const [agentParams, agentRuntime, agentOptions] = requireFirstMockCall(
        deps.runAgentsAdd,
        "agents add",
      ) as unknown as [
        { name: string; workspace: string; nonInteractive: boolean },
        object,
        { hasFlags: boolean },
      ];
      expect(agentParams).toEqual({
        name: "work",
        workspace: "/tmp/work",
        nonInteractive: true,
      });
      expect(agentRuntime).toBeTypeOf("object");
      expect(agentOptions).toEqual({ hasFlags: true });
      const auditPath = path.join(tempDir, "audit", "system-agent.jsonl");
      const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim()) as {
        operation?: string;
        details?: {
          rescue?: boolean;
          channel?: string;
          senderId?: string;
          agentId?: string;
          workspace?: string;
        };
      };
      expect(audit.operation).toBe("agents.create");
      expect(audit.details?.rescue).toBe(true);
      expect(audit.details?.channel).toBe("whatsapp");
      expect(audit.details?.senderId).toBe("user:owner");
      expect(audit.details?.agentId).toBe("work");
      expect(audit.details?.workspace).toBe("/tmp/work");
    });
  });
});
