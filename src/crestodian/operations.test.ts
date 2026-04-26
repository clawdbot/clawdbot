import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrestodianTestRuntime } from "./crestodian.test-helpers.js";
import {
  executeCrestodianOperation,
  parseCrestodianOperation,
  type CrestodianOperationResult,
} from "./operations.js";

type TestConfig = Record<string, unknown>;

const mockConfig = vi.hoisted(() => {
  const initial = {};
  const state = {
    path: "/tmp/openclaw.json",
    exists: true,
    config: initial as TestConfig,
    hash: "mock-hash-0" as string | undefined,
  };
  const cloneConfig = () => structuredClone(state.config);
  const snapshot = () => {
    const config = cloneConfig();
    return {
      path: state.path,
      exists: state.exists,
      raw: state.exists ? `${JSON.stringify(config)}\n` : null,
      parsed: state.exists ? config : undefined,
      sourceConfig: config,
      resolved: config,
      valid: state.exists,
      runtimeConfig: config,
      config,
      hash: state.hash,
      issues: state.exists ? [] : [{ path: "", message: "missing config" }],
      warnings: [],
      legacyIssues: [],
    };
  };
  return {
    reset() {
      state.path = "/tmp/openclaw.json";
      state.exists = true;
      state.config = {};
      state.hash = "mock-hash-0";
    },
    missing(path: string) {
      state.path = path;
      state.exists = false;
      state.config = {};
      state.hash = undefined;
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
        state.exists = true;
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

vi.mock("./probes.js", () => ({
  probeLocalCommand: vi.fn(async (command: string) => ({
    command,
    found: false,
    error: "not found",
  })),
  probeGatewayUrl: vi.fn(async (url: string) => ({ reachable: false, url, error: "offline" })),
}));

vi.mock("./overview.js", () => ({
  formatCrestodianOverview: () => "Default model: openai/gpt-5.5",
  loadCrestodianOverview: vi.fn(async () => ({
    defaultAgentId: "main",
    defaultModel: undefined,
    agents: [
      { id: "main", isDefault: true },
      { id: "work", isDefault: false, model: "openai/gpt-5.2" },
    ],
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
    tools: {
      codex: { command: "codex", found: false, error: "not found" },
      claude: { command: "claude", found: false, error: "not found" },
      apiKeys: { openai: true, anthropic: false },
    },
    gateway: {
      url: "ws://127.0.0.1:18789",
      source: "local loopback",
      reachable: false,
      error: "offline",
    },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  })),
}));

vi.mock("../config/config.js", () => ({
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

describe("parseCrestodianOperation", () => {
  beforeEach(() => {
    mockConfig.reset();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses typed model writes", () => {
    expect(parseCrestodianOperation("set default model openai/gpt-5.2")).toEqual({
      kind: "set-default-model",
      model: "openai/gpt-5.2",
    });
    expect(parseCrestodianOperation("configure models openai/gpt-5.2")).toEqual({
      kind: "set-default-model",
      model: "openai/gpt-5.2",
    });
  });

  it("parses verbal agent switching", () => {
    expect(parseCrestodianOperation("talk to work agent")).toEqual({
      kind: "open-tui",
      agentId: "work",
    });
  });

  it("keeps ambiguous model requests read-only", () => {
    expect(parseCrestodianOperation("models please")).toEqual({ kind: "models" });
  });

  it("parses gateway lifecycle operations", () => {
    expect(parseCrestodianOperation("gateway status")).toEqual({ kind: "gateway-status" });
    expect(parseCrestodianOperation("restart gateway")).toEqual({ kind: "gateway-restart" });
    expect(parseCrestodianOperation("start gateway")).toEqual({ kind: "gateway-start" });
    expect(parseCrestodianOperation("stop gateway")).toEqual({ kind: "gateway-stop" });
  });

  it("parses config and doctor repair operations", () => {
    expect(parseCrestodianOperation("validate config")).toEqual({ kind: "config-validate" });
    expect(parseCrestodianOperation("config set gateway.port 19001")).toEqual({
      kind: "config-set",
      path: "gateway.port",
      value: "19001",
    });
    expect(parseCrestodianOperation("config set-ref gateway.auth.token env GATEWAY_TOKEN")).toEqual(
      {
        kind: "config-set-ref",
        path: "gateway.auth.token",
        source: "env",
        id: "GATEWAY_TOKEN",
      },
    );
    expect(parseCrestodianOperation("doctor fix")).toEqual({ kind: "doctor-fix" });
  });

  it("parses agent creation requests", () => {
    expect(
      parseCrestodianOperation("create agent Work workspace /tmp/work model openai/gpt-5.2"),
    ).toEqual({
      kind: "create-agent",
      agentId: "work",
      workspace: "/tmp/work",
      model: "openai/gpt-5.2",
    });
    expect(parseCrestodianOperation("add agent ops")).toEqual({
      kind: "create-agent",
      agentId: "ops",
    });
    expect(parseCrestodianOperation("setup workspace /tmp/work model openai/gpt-5.5")).toEqual({
      kind: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
    });
    expect(parseCrestodianOperation("setup agent ops")).toEqual({
      kind: "create-agent",
      agentId: "ops",
    });
  });

  it("requires approval before restarting gateway", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    const runGatewayRestart = vi.fn(async () => {});

    const result = await executeCrestodianOperation({ kind: "gateway-restart" }, runtime, {
      deps: { runGatewayRestart },
    });

    expect(result).toMatchObject<CrestodianOperationResult>({
      applied: false,
      message: "Plan: restart the Gateway. Say yes to apply.",
    });
    expect(lines.join("\n")).toContain("Plan: restart the Gateway");
    expect(runGatewayRestart).not.toHaveBeenCalled();
  });

  it("validates missing config without exiting the process", async () => {
    mockConfig.missing("/tmp/openclaw.json");
    const { runtime, lines } = createCrestodianTestRuntime();

    await expect(
      executeCrestodianOperation({ kind: "config-validate" }, runtime),
    ).resolves.toMatchObject({ applied: false });

    expect(lines.join("\n")).toContain("Config missing:");
  });

  it("applies config set through typed deps and writes an audit entry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-config-set-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    await expect(
      executeCrestodianOperation(
        { kind: "config-set", path: "gateway.port", value: "19001" },
        runtime,
        {
          approved: true,
          deps: { runConfigSet },
          auditDetails: { rescue: true, channel: "whatsapp" },
        },
      ),
    ).resolves.toMatchObject({ applied: true });

    expect(runConfigSet).toHaveBeenCalledWith({
      path: "gateway.port",
      value: "19001",
      cliOptions: {},
    });
    expect(lines.join("\n")).toContain("[crestodian] done: config.set");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "config.set",
      summary: "Set config gateway.port",
      details: {
        rescue: true,
        channel: "whatsapp",
        path: "gateway.port",
      },
    });
  });

  it("applies SecretRef config set through typed deps and writes an audit entry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-config-ref-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    await expect(
      executeCrestodianOperation(
        {
          kind: "config-set-ref",
          path: "gateway.auth.token",
          source: "env",
          id: "OPENCLAW_GATEWAY_TOKEN",
        },
        runtime,
        {
          approved: true,
          deps: { runConfigSet },
          auditDetails: { rescue: true, channel: "whatsapp" },
        },
      ),
    ).resolves.toMatchObject({ applied: true });

    expect(runConfigSet).toHaveBeenCalledWith({
      path: "gateway.auth.token",
      cliOptions: {
        refProvider: "default",
        refSource: "env",
        refId: "OPENCLAW_GATEWAY_TOKEN",
      },
    });
    expect(lines.join("\n")).toContain("[crestodian] done: config.setRef");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "config.setRef",
      summary: "Set config gateway.auth.token SecretRef",
      details: {
        rescue: true,
        channel: "whatsapp",
        path: "gateway.auth.token",
        source: "env",
        provider: "default",
      },
    });
  });

  it("runs setup bootstrap only after approval and audits it", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-setup-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const { runtime, lines } = createCrestodianTestRuntime();

    const plan = await executeCrestodianOperation(
      { kind: "setup", workspace: "/tmp/work" },
      runtime,
    );
    expect(plan).toMatchObject({
      applied: false,
    });
    expect(lines.join("\n")).toContain("Model choice: openai/gpt-5.5 (OPENAI_API_KEY).");

    await expect(
      executeCrestodianOperation({ kind: "setup", workspace: "/tmp/work" }, runtime, {
        approved: true,
        auditDetails: { rescue: true },
      }),
    ).resolves.toMatchObject({ applied: true });

    expect(lines.join("\n")).toContain("[crestodian] done: crestodian.setup");
    expect(mockConfig.currentConfig()).toMatchObject({
      agents: {
        defaults: {
          workspace: "/tmp/work",
          model: { primary: "openai/gpt-5.5" },
        },
      },
    });
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      operation: "crestodian.setup",
      summary: "Bootstrapped setup with openai/gpt-5.5",
      details: {
        rescue: true,
        workspace: "/tmp/work",
        model: "openai/gpt-5.5",
        modelSource: "OPENAI_API_KEY",
      },
    });
  });

  it("runs doctor repairs only after approval and audits them", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-doctor-fix-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runDoctor = vi.fn(async () => {});

    const plan = await executeCrestodianOperation({ kind: "doctor-fix" }, runtime, {
      deps: { runDoctor },
    });
    expect(plan).toMatchObject({
      applied: false,
      message: "Plan: run doctor repairs. Say yes to apply.",
    });
    expect(runDoctor).not.toHaveBeenCalled();

    await expect(
      executeCrestodianOperation({ kind: "doctor-fix" }, runtime, {
        approved: true,
        deps: { runDoctor },
        auditDetails: { rescue: true },
      }),
    ).resolves.toMatchObject({ applied: true });

    expect(runDoctor).toHaveBeenCalledWith(runtime, {
      nonInteractive: true,
      repair: true,
      yes: true,
    });
    expect(lines.join("\n")).toContain("[crestodian] done: doctor.fix");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim().split("\n").at(-1)!);
    expect(audit).toMatchObject({
      operation: "doctor.fix",
      summary: "Ran doctor repairs",
      details: { rescue: true },
    });
  });

  it("returns from the agent TUI back to Crestodian", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    const runTui = vi.fn(async () => ({
      exitReason: "return-to-crestodian" as const,
      crestodianMessage: "restart gateway",
    }));

    const result = await executeCrestodianOperation(
      { kind: "open-tui", agentId: "work" },
      runtime,
      {
        deps: { runTui },
      },
    );

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      session: "agent:work:main",
      deliver: false,
      historyLimit: 200,
    });
    expect(result).toMatchObject({
      applied: false,
      nextInput: "restart gateway",
    });
    expect(lines.join("\n")).toContain(
      "[crestodian] returned from agent with request: restart gateway",
    );
  });
});
