import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

    expect(mockConfig.currentConfig()).toMatchObject({
      agents: { defaults: { model: { primary: "openai/gpt-5.2" } } },
    });
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit.details).toMatchObject({
      rescue: true,
      channel: "whatsapp",
      senderId: "user:owner",
    });
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
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "gateway.restart",
      details: {
        rescue: true,
        channel: "whatsapp",
        senderId: "user:owner",
      },
    });
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
    expect(deps.runAgentsAdd).toHaveBeenCalledWith(
      {
        name: "work",
        workspace: "/tmp/work",
        nonInteractive: true,
      },
      expect.any(Object),
      { hasFlags: true },
    );
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "agents.create",
      details: {
        rescue: true,
        channel: "whatsapp",
        senderId: "user:owner",
        agentId: "work",
        workspace: "/tmp/work",
      },
    });
  });
});
