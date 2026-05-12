import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { extractCrestodianRescueMessage, runCrestodianRescueMessage } from "./rescue-message.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
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
          snapshot: before,
          nextConfig: cloneConfig(),
          result: undefined,
        };
      },
    ),
  };
});

vi.mock("../config/config.js", () => ({
  clearConfigCache: vi.fn(),
  mutateConfigFile: mockConfig.mutateConfigFile,
  readConfigFileSnapshot: mockConfig.readConfigFileSnapshot,
}));

vi.mock("../commands/models/shared.js", () => ({
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
}));

vi.mock("../config/model-input.js", () => ({
  resolveAgentModelPrimaryValue: (model?: string | { primary?: string }) =>
    typeof model === "string" ? model : model?.primary,
}));

async function makeStateDir(prefix: string): Promise<string> {
  const dir = path.join(tempRoot, `${prefix}${tempDirId++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function commandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    surface: "whatsapp",
    channel: "whatsapp",
    channelId: "whatsapp",
    ownerList: ["user:owner"],
    senderIsOwner: true,
    isAuthorizedSender: true,
    senderId: "user:owner",
    rawBodyNormalized: "/crestodian models",
    commandBodyNormalized: "/crestodian models",
    from: "user:owner",
    to: "account:default",
    ...overrides,
  };
}

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

async function runRescue(
  commandBody: string,
  cfg: OpenClawConfig,
  ctx = commandContext(),
  deps?: Parameters<typeof runCrestodianRescueMessage>[0]["deps"],
) {
  return await runCrestodianRescueMessage({
    cfg,
    command: { ...ctx, commandBodyNormalized: commandBody },
    commandBody,
    isGroup: false,
    deps,
  });
}

describe("Crestodian rescue message", () => {
  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-rescue-"));
  });

  beforeEach(() => {
    mockConfig.reset();
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("recognizes the Crestodian rescue command", () => {
    expect(extractCrestodianRescueMessage("/crestodian status")).toBe("status");
    expect(extractCrestodianRescueMessage("/crestodian")).toBe("");
    expect(extractCrestodianRescueMessage("/status")).toBeNull();
  });

  it("denies rescue when sandboxing is active", async () => {
    await expect(
      runRescue("/crestodian status", {
        crestodian: { rescue: { enabled: true } },
        agents: { defaults: { sandbox: { mode: "all" } } },
      }),
    ).resolves.toContain("sandboxing is active");
  });

  it("refuses TUI handoff from remote rescue", async () => {
    const cfg: OpenClawConfig = { crestodian: { rescue: { enabled: true } } };
    const deps = {
      runTui: vi.fn(async () => {
        throw new Error("remote rescue must not open the TUI");
      }),
    };

    await expect(
      runRescue("/crestodian talk to agent", cfg, commandContext(), deps),
    ).resolves.toContain("cannot open the local TUI");
    await expect(runRescue("/crestodian chat", cfg, commandContext(), deps)).resolves.toContain(
      "cannot open the local TUI",
    );
    expect(deps.runTui).not.toHaveBeenCalled();
  });

  it("refuses plugin install from remote rescue", async () => {
    const cfg: OpenClawConfig = { crestodian: { rescue: { enabled: true } } };
    const deps = {
      runPluginInstall: vi.fn(async () => {
        throw new Error("remote rescue must not install plugins");
      }),
    };

    await expect(
      runRescue("/crestodian plugin install clawhub:openclaw-demo", cfg, commandContext(), deps),
    ).resolves.toContain("cannot install plugins from a message channel");
    expect(deps.runPluginInstall).not.toHaveBeenCalled();
  });

  it("allows plugin list and search from remote rescue", async () => {
    const cfg: OpenClawConfig = { crestodian: { rescue: { enabled: true } } };
    const deps = {
      runPluginsList: vi.fn(async (runtime: RuntimeEnv) => {
        runtime.log("plugin rows");
      }),
      runPluginsSearch: vi.fn(async (query: string, runtime: RuntimeEnv) => {
        runtime.log(`search rows: ${query}`);
      }),
    };

    await expect(
      runRescue("/crestodian plugins list", cfg, commandContext(), deps),
    ).resolves.toContain("plugin rows");
    await expect(
      runRescue("/crestodian plugins search calendar", cfg, commandContext(), deps),
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
    const tempDir = await makeStateDir("models-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);

    const cfg: OpenClawConfig = { crestodian: { rescue: { enabled: true } } };
    await expect(runRescue("/crestodian set default model openai/gpt-5.2", cfg)).resolves.toContain(
      "Reply /crestodian yes to apply",
    );
    await expect(runRescue("/crestodian yes", cfg)).resolves.toContain(
      "Default model: openai/gpt-5.2",
    );

    const currentConfig = mockConfig.currentConfig() as {
      agents?: { defaults?: { model?: { primary?: string } } };
    };
    expect(currentConfig.agents?.defaults?.model?.primary).toBe("openai/gpt-5.2");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim()) as {
      details?: { rescue?: boolean; channel?: string; senderId?: string };
    };
    expect(audit.details?.rescue).toBe(true);
    expect(audit.details?.channel).toBe("whatsapp");
    expect(audit.details?.senderId).toBe("user:owner");
  });

  it("queues and applies gateway restart through conversational approval", async () => {
    const tempDir = await makeStateDir("gateway-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    const cfg: OpenClawConfig = { crestodian: { rescue: { enabled: true } } };
    const deps = { runGatewayRestart: vi.fn(async () => {}) };

    await expect(
      runRescue("/crestodian restart gateway", cfg, commandContext(), deps),
    ).resolves.toBe("Plan: restart the Gateway. Reply /crestodian yes to apply.");
    await expect(runRescue("/crestodian yes", cfg, commandContext(), deps)).resolves.toContain(
      "[crestodian] done: gateway.restart",
    );

    expect(deps.runGatewayRestart).toHaveBeenCalledTimes(1);
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim()) as {
      operation?: string;
      details?: { rescue?: boolean; channel?: string; senderId?: string };
    };
    expect(audit.operation).toBe("gateway.restart");
    expect(audit.details?.rescue).toBe(true);
    expect(audit.details?.channel).toBe("whatsapp");
    expect(audit.details?.senderId).toBe("user:owner");
  });

  it("queues and applies agent creation through conversational approval", async () => {
    const tempDir = await makeStateDir("agent-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    const cfg: OpenClawConfig = { crestodian: { rescue: { enabled: true } } };
    const deps = { runAgentsAdd: vi.fn(async () => {}) };

    await expect(
      runRescue("/crestodian create agent work workspace /tmp/work", cfg, commandContext(), deps),
    ).resolves.toBe(
      "Plan: create agent work with workspace /tmp/work. Reply /crestodian yes to apply.",
    );
    await expect(runRescue("/crestodian yes", cfg, commandContext(), deps)).resolves.toContain(
      "[crestodian] done: agents.create",
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
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
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
