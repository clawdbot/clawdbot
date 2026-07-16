// OpenClaw operation tests cover rescue operation planning and execution.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeEnv } from "../runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  describeSystemAgentPersistentOperation,
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation,
} from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.test-helpers.js";

type TestConfig = Record<string, unknown>;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectAuditRecord(
  audit: unknown,
  fields: Record<string, unknown>,
  detailFields: Record<string, unknown>,
) {
  const auditRecord = requireRecord(audit, "audit record");
  expectRecordFields(auditRecord, fields);
  expectRecordFields(requireRecord(auditRecord.details, "audit details"), detailFields);
}

function requireFirstMockCall(mock: unknown, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[0];
  if (!call) {
    throw new Error(`missing ${label} call`);
  }
  return call;
}

function expectRuntimeArg(value: unknown) {
  const runtime = requireRecord(value, "runtime argument");
  expect(typeof runtime.log).toBe("function");
}

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
    missing(pathLocal: string) {
      state.path = pathLocal;
      state.exists = false;
      state.config = {};
      state.hash = undefined;
    },
    currentConfig() {
      return cloneConfig();
    },
    setConfig(config: TestConfig) {
      state.config = structuredClone(config);
    },
    readConfigFileSnapshot: vi.fn(async () => snapshot()),
    mutateConfigFile: vi.fn(
      async (params: {
        writeOptions?: {
          preCommitRuntimePreflight?: (sourceConfig: TestConfig) => Promise<unknown>;
        };
        mutate: (
          draft: TestConfig,
          context: { snapshot: ReturnType<typeof snapshot> },
        ) => Promise<void> | void;
      }) => {
        const before = snapshot();
        const draft = cloneConfig();
        await params.mutate(draft, { snapshot: before });
        await params.writeOptions?.preCommitRuntimePreflight?.(structuredClone(draft));
        state.exists = true;
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
vi.mock("./probes.js", () => ({
  probeLocalCommand: vi.fn(async (command: string) => ({
    command,
    found: false,
    error: "not found",
  })),
  probeGatewayUrl: vi.fn(async (url: string) => ({ reachable: false, url, error: "offline" })),
}));

vi.mock("./overview.js", () => ({
  formatSystemAgentOverview: () => "Default model: openai/gpt-5.5",
  loadSystemAgentOverview: vi.fn(async () => ({
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
      gemini: { command: "gemini", found: false, error: "not found" },
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
const opTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("parseSystemAgentOperation", () => {
  let stateDirSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(() => {
    mockConfig.reset();
    stateDirSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    stateDirSnapshot?.restore();
    vi.unstubAllEnvs();
  });

  it("parses typed model writes", () => {
    expect(parseSystemAgentOperation("set default model openai/gpt-5.2")).toEqual({
      kind: "set-default-model",
      model: "openai/gpt-5.2",
    });
    expect(parseSystemAgentOperation("configure models openai/gpt-5.2")).toEqual({
      kind: "set-default-model",
      model: "openai/gpt-5.2",
    });
  });

  it("parses interactive model provider setup", () => {
    expect(parseSystemAgentOperation("configure model provider")).toEqual({
      kind: "model-setup",
    });
    expect(parseSystemAgentOperation("setup model provider")).toEqual({
      kind: "model-setup",
    });
    expect(parseSystemAgentOperation("model setup workspace /tmp/work")).toEqual({
      kind: "model-setup",
      workspace: "/tmp/work",
    });
  });

  it("parses verbal agent switching", () => {
    expect(parseSystemAgentOperation("talk to work agent")).toEqual({
      kind: "open-tui",
      agentId: "work",
    });
  });

  it("routes ambiguous model requests to the AI instead of guessing", () => {
    expect(parseSystemAgentOperation("models please").kind).toBe("none");
    expect(parseSystemAgentOperation("why did my gateway stop").kind).toBe("none");
    expect(parseSystemAgentOperation("should I talk to my agent about this?").kind).toBe("none");
    expect(parseSystemAgentOperation("set me up with telegram").kind).toBe("none");
    expect(parseSystemAgentOperation("can I set the default model gpt-5.5 later?").kind).toBe(
      "none",
    );
  });

  it("parses gateway lifecycle operations", () => {
    expect(parseSystemAgentOperation("gateway status")).toEqual({ kind: "gateway-status" });
    expect(parseSystemAgentOperation("restart gateway")).toEqual({ kind: "gateway-restart" });
    expect(parseSystemAgentOperation("start gateway")).toEqual({ kind: "gateway-start" });
    expect(parseSystemAgentOperation("stop gateway")).toEqual({ kind: "gateway-stop" });
  });

  it("parses config and doctor repair operations", () => {
    expect(parseSystemAgentOperation("validate config")).toEqual({ kind: "config-validate" });
    expect(parseSystemAgentOperation("config set gateway.port 19001")).toEqual({
      kind: "config-set",
      path: "gateway.port",
      value: "19001",
    });
    expect(
      parseSystemAgentOperation("config set-ref gateway.auth.token env GATEWAY_TOKEN"),
    ).toEqual({
      kind: "config-set-ref",
      path: "gateway.auth.token",
      source: "env",
      id: "GATEWAY_TOKEN",
    });
    expect(parseSystemAgentOperation("doctor fix")).toEqual({ kind: "doctor-fix" });
  });

  it("parses plugin management operations", () => {
    expect(parseSystemAgentOperation("plugins list")).toEqual({ kind: "plugin-list" });
    expect(parseSystemAgentOperation("list plugin")).toEqual({ kind: "plugin-list" });
    expect(parseSystemAgentOperation("plugins search calendar sync")).toEqual({
      kind: "plugin-search",
      query: "calendar sync",
    });
    expect(parseSystemAgentOperation("install npm plugin @openclaw/discord")).toEqual({
      kind: "plugin-install",
      spec: "npm:@openclaw/discord",
    });
    expect(parseSystemAgentOperation("plugin install clawhub:openclaw-demo")).toEqual({
      kind: "plugin-install",
      spec: "clawhub:openclaw-demo",
    });
    expect(parseSystemAgentOperation("plugin uninstall openclaw-demo")).toEqual({
      kind: "plugin-uninstall",
      pluginId: "openclaw-demo",
    });
    expect(parseSystemAgentOperation("plugin install npm:@example/plugin")).toEqual({
      kind: "none",
      message:
        "OpenClaw installs only ClawHub, bundled, or official-catalog plugins. Use `openclaw plugins install <spec>` in a trusted shell to review an arbitrary executable source.",
    });
  });

  it("parses config read and schema lookups", () => {
    expect(parseSystemAgentOperation("config get gateway.port")).toEqual({
      kind: "config-get",
      path: "gateway.port",
    });
    expect(parseSystemAgentOperation("config schema channels.telegram")).toEqual({
      kind: "config-schema",
      path: "channels.telegram",
    });
    expect(parseSystemAgentOperation("config schema")).toEqual({ kind: "config-schema" });
    // Read-only: no approval gate.
    expect(isPersistentSystemAgentOperation({ kind: "config-get", path: "gateway.port" })).toBe(
      false,
    );
    expect(isPersistentSystemAgentOperation({ kind: "config-schema" })).toBe(false);
  });

  it("redacts sensitive config values using their complete paths", async () => {
    mockConfig.setConfig({
      models: {
        providers: {
          local: {
            localService: {
              env: { HF_HOME: "/private/model-cache" },
            },
          },
        },
      },
    });
    const { runtime, lines } = createSystemAgentTestRuntime();

    await executeSystemAgentOperation(
      { kind: "config-get", path: "models.providers.local.localService" },
      runtime,
    );

    expect(lines.join("\n")).toContain('"HF_HOME": "<redacted>"');
    expect(lines.join("\n")).not.toContain("/private/model-cache");
    expect(
      describeSystemAgentPersistentOperation({
        kind: "config-set",
        path: "models.providers.local.localService.env.HF_HOME",
        value: "/private/model-cache",
      }),
    ).toBe("set config models.providers.local.localService.env.HF_HOME to <redacted>");
  });

  it("parses channel listing and connect requests", () => {
    expect(parseSystemAgentOperation("channels")).toEqual({ kind: "channel-list" });
    expect(parseSystemAgentOperation("list channels")).toEqual({ kind: "channel-list" });
    expect(parseSystemAgentOperation("connect telegram")).toEqual({
      kind: "channel-setup",
      channel: "telegram",
    });
    expect(parseSystemAgentOperation("connect to WhatsApp")).toEqual({
      kind: "channel-setup",
      channel: "whatsapp",
    });
    expect(parseSystemAgentOperation("link discord channel")).toEqual({
      kind: "channel-setup",
      channel: "discord",
    });
    // Starting the wizard is not a write; the wizard collects explicit answers.
    expect(isPersistentSystemAgentOperation({ kind: "channel-setup", channel: "telegram" })).toBe(
      false,
    );
    expect(isPersistentSystemAgentOperation({ kind: "channel-list" })).toBe(false);
  });

  it("parses anchored setup switches and channel info", () => {
    for (const input of [
      "open setup wizard",
      "setup wizard",
      "menu setup",
      "use the setup wizard",
      "use the wizard",
    ]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "open-setup", target: "guided" });
    }
    for (const input of ["open classic wizard", "open classic setup wizard", "classic setup"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "open-setup", target: "classic" });
    }
    expect(parseSystemAgentOperation("open channel wizard")).toEqual({
      kind: "open-setup",
      target: "channels",
    });
    expect(parseSystemAgentOperation("open channel wizard for Slack")).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });
    expect(parseSystemAgentOperation("channel info Slack")).toEqual({
      kind: "channel-info",
      channel: "slack",
    });
    expect(parseSystemAgentOperation("about Telegram channel")).toEqual({
      kind: "channel-info",
      channel: "telegram",
    });
    expect(parseSystemAgentOperation("please open the setup wizard soon").kind).toBe("none");
    expect(parseSystemAgentOperation("channel info slack please").kind).toBe("none");
  });

  it("prints one-shot setup pointers", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    for (const operation of [
      { kind: "open-setup", target: "guided" } as const,
      { kind: "open-setup", target: "classic" } as const,
      { kind: "open-setup", target: "channels", channel: "slack" } as const,
    ]) {
      const result = await executeSystemAgentOperation(operation, runtime);
      expect(result.applied).toBe(false);
    }

    const output = lines.join("\n");
    expect(output).toContain("openclaw onboard`");
    expect(output).toContain("openclaw onboard --classic");
    expect(output).toContain("openclaw channels add --channel slack");
  });

  it("routes one-shot model setup through the verified OpenClaw flow", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    const result = await executeSystemAgentOperation({ kind: "model-setup" }, runtime);

    expect(result.applied).toBe(false);
    expect(lines.join("\n")).toContain("Exit OpenClaw and run `openclaw onboard`");
    expect(lines.join("\n")).not.toContain("openclaw configure --section model");
  });

  it("prints discovered channel metadata and sorted unknown-channel choices", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const entries = [
      {
        id: "telegram",
        meta: {
          label: "Telegram",
          blurb: "Telegram bot messaging.",
          docsPath: "/channels/telegram",
        },
      },
      {
        id: "slack",
        meta: {
          label: "Slack",
          blurb: "Slack app messaging.",
          docsPath: "/channels/slack",
        },
      },
    ];
    const deps = {
      listChannelSetupPlugins: () => [{ id: "slack" }],
      resolveChannelSetupEntries: () => ({
        entries,
        installedCatalogEntries: [],
        installableCatalogEntries: [],
        installedCatalogById: new Map(),
        installableCatalogById: new Map(),
      }),
      isChannelConfigured: (_cfg: unknown, channel: string) => channel === "slack",
    } as never;

    await executeSystemAgentOperation({ kind: "channel-info", channel: "slack" }, runtime, {
      deps,
    });
    const knownOutput = lines.join("\n");
    expect(knownOutput).toContain("Slack (slack)");
    expect(knownOutput).toContain("Slack app messaging.");
    expect(knownOutput).toContain("Configured: yes");
    expect(knownOutput).toContain("Installed: yes");
    expect(knownOutput).toContain("https://docs.openclaw.ai/channels/slack");
    expect(knownOutput).toContain("open channel wizard for slack");

    lines.length = 0;
    await executeSystemAgentOperation({ kind: "channel-info", channel: "matrix" }, runtime, {
      deps,
    });
    expect(lines.join("\n")).toContain("Known channels: slack, telegram");
  });

  it("parses agent creation requests", () => {
    expect(
      parseSystemAgentOperation("create agent Work workspace /tmp/work model openai/gpt-5.2"),
    ).toEqual({
      kind: "create-agent",
      agentId: "work",
      workspace: "/tmp/work",
      model: "openai/gpt-5.2",
    });
    expect(parseSystemAgentOperation("add agent ops")).toEqual({
      kind: "create-agent",
      agentId: "ops",
    });
    expect(parseSystemAgentOperation("setup workspace /tmp/work model openai/gpt-5.5")).toEqual({
      kind: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
    });
    expect(parseSystemAgentOperation("setup agent ops")).toEqual({
      kind: "create-agent",
      agentId: "ops",
    });
  });

  it("rejects an explicit new-agent model before any config write or audit", async () => {
    const tempDir = opTempDirs.make("openclaw-agent-model-rejected-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runAgentsAdd = vi.fn(async () => {});
    expect(
      isPersistentSystemAgentOperation({
        kind: "create-agent",
        agentId: "work",
        model: "openai/gpt-5.5",
      }),
    ).toBe(false);
    expect(isPersistentSystemAgentOperation({ kind: "create-agent", agentId: "work" })).toBe(true);

    await expect(
      executeSystemAgentOperation(
        {
          kind: "create-agent",
          agentId: "work",
          workspace: "/tmp/work",
          model: "openai/gpt-5.5",
        },
        runtime,
        { approved: true, deps: { runAgentsAdd } },
      ),
    ).rejects.toThrow("Retry without `model`; the new agent will inherit");

    expect(runAgentsAdd).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] running: agents.create");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("reserves the normalized OpenClaw agent identity before any write or audit", async () => {
    const tempDir = opTempDirs.make("openclaw-agent-id-reserved-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runAgentsAdd = vi.fn(async () => {});
    const operation = {
      kind: "create-agent" as const,
      agentId: "OpenClaw",
      workspace: "/tmp/work",
    };

    expect(isPersistentSystemAgentOperation(operation)).toBe(false);
    await expect(
      executeSystemAgentOperation(operation, runtime, {
        approved: true,
        deps: { runAgentsAdd },
      }),
    ).rejects.toThrow('Agent id "openclaw" is reserved');

    expect(runAgentsAdd).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] running: agents.create");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("keeps the retired agent identity reserved", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    const runAgentsAdd = vi.fn(async () => {});
    const operation = {
      kind: "create-agent" as const,
      agentId: "crestodian", // reserved retired id
      workspace: "/tmp/retired",
    };

    expect(isPersistentSystemAgentOperation(operation)).toBe(false);
    await expect(
      executeSystemAgentOperation(operation, runtime, {
        approved: true,
        deps: { runAgentsAdd },
      }),
    ).rejects.toThrow('Agent id "crestodian" is reserved'); // reserved retired id
    expect(runAgentsAdd).not.toHaveBeenCalled();
  });

  it("requires approval before restarting gateway", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runGatewayRestart = vi.fn(async () => {});

    const result = await executeSystemAgentOperation({ kind: "gateway-restart" }, runtime, {
      deps: { runGatewayRestart },
    });

    expectRecordFields(result as unknown as Record<string, unknown>, {
      applied: false,
      message: "Plan: restart the Gateway. Say yes to apply.",
    });
    expect(lines.join("\n")).toContain("Plan: restart the Gateway");
    expect(runGatewayRestart).not.toHaveBeenCalled();
  });

  it("does not report or audit a gateway restart that returned false", async () => {
    const tempDir = opTempDirs.make("openclaw-restart-failed-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runGatewayRestart = vi.fn(async () => false);

    await expect(
      executeSystemAgentOperation({ kind: "gateway-restart" }, runtime, {
        approved: true,
        deps: { runGatewayRestart },
      }),
    ).rejects.toThrow("Gateway restart did not complete");

    expect(lines.join("\n")).toContain("[openclaw] running: gateway.restart");
    expect(lines.join("\n")).not.toContain("[openclaw] done: gateway.restart");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("validates missing config without exiting the process", async () => {
    mockConfig.missing("/tmp/openclaw.json");
    const { runtime, lines } = createSystemAgentTestRuntime();

    const result = await executeSystemAgentOperation({ kind: "config-validate" }, runtime);
    expect(result.applied).toBe(false);

    expect(lines.join("\n")).toContain("Config missing:");
  });

  it("applies config set through typed deps and writes an audit entry", async () => {
    const tempDir = opTempDirs.make("openclaw-config-set-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    const result = await executeSystemAgentOperation(
      { kind: "config-set", path: "gateway.port", value: "19001" },
      runtime,
      {
        approved: true,
        deps: { runConfigSet },
        auditDetails: { rescue: true, channel: "whatsapp" },
      },
    );
    expect(result.applied).toBe(true);

    expect(runConfigSet).toHaveBeenCalledWith({
      path: "gateway.port",
      value: "19001",
      cliOptions: {},
    });
    expect(lines.join("\n")).toContain("[openclaw] done: config.set");
    const auditPath = path.join(tempDir, "audit", "system-agent.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expectAuditRecord(
      audit,
      { operation: "config.set", summary: "Set config gateway.port" },
      {
        rescue: true,
        channel: "whatsapp",
        path: "gateway.port",
      },
    );
  });

  it("reports an audit failure without claiming the committed operation failed", async () => {
    const tempDir = opTempDirs.make("openclaw-audit-warning-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const redirectedAuditDir = path.join(tempDir, "redirected-audit");
    await fs.mkdir(redirectedAuditDir);
    await fs.symlink(redirectedAuditDir, path.join(tempDir, "audit"), "dir");
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    const result = await executeSystemAgentOperation(
      { kind: "config-set", path: "gateway.port", value: "19001" },
      runtime,
      { approved: true, deps: { runConfigSet } },
    );

    expect(result.applied).toBe(true);
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(lines.join("\n")).toContain(
      "Set config gateway.port, but OpenClaw could not record its audit entry:",
    );
    expect(lines.join("\n")).toContain("[openclaw] done: config.set");
  });

  it("applies SecretRef config set through typed deps and writes an audit entry", async () => {
    const tempDir = opTempDirs.make("openclaw-config-ref-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    const result = await executeSystemAgentOperation(
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
    );
    expect(result.applied).toBe(true);

    expect(runConfigSet).toHaveBeenCalledWith({
      path: "gateway.auth.token",
      cliOptions: {
        refProvider: "default",
        refSource: "env",
        refId: "OPENCLAW_GATEWAY_TOKEN",
      },
    });
    expect(lines.join("\n")).toContain("[openclaw] done: config.setRef");
    const auditPath = path.join(tempDir, "audit", "system-agent.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expectAuditRecord(
      audit,
      {
        operation: "config.setRef",
        summary: "Set config gateway.auth.token SecretRef",
      },
      {
        rescue: true,
        channel: "whatsapp",
        path: "gateway.auth.token",
        source: "env",
        provider: "default",
      },
    );
  });

  it("keeps channel SecretRef writes available after inference is verified", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    const result = await executeSystemAgentOperation(
      {
        kind: "config-set-ref",
        path: "channels.telegram.botToken",
        source: "env",
        id: "TELEGRAM_BOT_TOKEN",
      },
      runtime,
      { approved: true, deps: { runConfigSet } },
    );

    expect(result.applied).toBe(true);
    expect(runConfigSet).toHaveBeenCalledWith({
      path: "channels.telegram.botToken",
      cliOptions: {
        refProvider: "default",
        refSource: "env",
        refId: "TELEGRAM_BOT_TOKEN",
      },
    });
  });

  it.each([
    { kind: "config-set" as const, path: "agents.defaults.model.primary", value: "openai/gpt-5.5" },
    {
      kind: "config-set" as const,
      path: "agents[defaults][model][primary]",
      value: "openai/gpt-5.5",
    },
    {
      kind: "config-set" as const,
      path: 'agents["defaults"]["model"].primary',
      value: "openai/gpt-5.5",
    },
    { kind: "config-set" as const, path: "agents.defaults.agentRuntime", value: "{}" },
    { kind: "config-set" as const, path: "agents.defaults.params.temperature", value: "0.5" },
    { kind: "config-set" as const, path: "agents.defaults.tools.profile", value: '"full"' },
    { kind: "config-set" as const, path: "agents.list[0].models.openai", value: "{}" },
    { kind: "config-set" as const, path: "agents.list[0].params.temperature", value: "0.5" },
    { kind: "config-set" as const, path: "agents.list[0].tools.profile", value: '"full"' },
    { kind: "config-set" as const, path: "agents.list[0].default", value: "true" },
    { kind: "config-set" as const, path: "agents.list[0].agentDir", value: '"/tmp/agent"' },
    { kind: "config-set" as const, path: "auth.order.anthropic", value: "[]" },
    { kind: "config-set" as const, path: "env.vars.ANTHROPIC_API_KEY", value: '"changed"' },
    { kind: "config-set" as const, path: '["env"]["vars"]["OPENAI_API_KEY"]', value: '"x"' },
    { kind: "config-set" as const, path: "secrets.defaults.env", value: '"changed"' },
    { kind: "config-set" as const, path: '["secrets"]["defaults"]["env"]', value: '"x"' },
    { kind: "config-set" as const, path: "plugins.entries.codex.enabled", value: "false" },
    {
      kind: "config-set" as const,
      path: '["plugins"]["entries"]["openai"]["enabled"]',
      value: "false",
    },
    {
      kind: "config-set" as const,
      path: String.raw`mo\dels.providers.openai.apiKey`,
      value: '"x"',
    },
    { kind: "config-set" as const, path: "$include", value: '"./alternate.json5"' },
    { kind: "config-set" as const, path: '["$include"]', value: '"./alternate.json5"' },
    { kind: "config-set" as const, path: "tools.profile", value: '"full"' },
    { kind: "config-set" as const, path: '["tools"]["profile"]', value: '"full"' },
    {
      kind: "config-set-ref" as const,
      path: "models.providers.openai.apiKey",
      source: "env" as const,
      id: "OPENAI_API_KEY",
    },
    {
      kind: "config-set-ref" as const,
      path: "models[providers][openai][apiKey]",
      source: "env" as const,
      id: "OPENAI_API_KEY",
    },
    {
      kind: "config-set-ref" as const,
      path: '["models"]["providers"]["openai"]["apiKey"]',
      source: "env" as const,
      id: "OPENAI_API_KEY",
    },
  ])("rejects unverified inference-route write $path", async (operation) => {
    const tempDir = opTempDirs.make("openclaw-route-write-refused-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    await expect(
      executeSystemAgentOperation(operation, runtime, {
        approved: true,
        deps: { runConfigSet },
      }),
    ).rejects.toThrow("openclaw onboard");

    expect(runConfigSet).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] running:");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("runs plugin list and search as read-only operations", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runPluginsList = vi.fn(async (pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log("plugin rows");
    });
    const runPluginsSearch = vi.fn(async (query: string, pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log(`search rows: ${query}`);
    });

    const listResult = await executeSystemAgentOperation({ kind: "plugin-list" }, runtime, {
      deps: { runPluginsList, runPluginsSearch },
    });
    expect(listResult.applied).toBe(false);
    const searchResult = await executeSystemAgentOperation(
      { kind: "plugin-search", query: "calendar" },
      runtime,
      {
        deps: { runPluginsList, runPluginsSearch },
      },
    );
    expect(searchResult.applied).toBe(false);

    expect(runPluginsList).toHaveBeenCalledWith(runtime);
    expect(runPluginsSearch).toHaveBeenCalledWith("calendar", runtime);
    expect(lines.join("\n")).toContain("plugin rows");
    expect(lines.join("\n")).toContain("search rows: calendar");
  });

  it("installs plugins only after approval and audits the write", async () => {
    const tempDir = opTempDirs.make("openclaw-plugin-install-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runPluginInstall = vi.fn(async (spec: string, pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log(`installed ${spec}`);
    });

    const plan = await executeSystemAgentOperation(
      { kind: "plugin-install", spec: "clawhub:openclaw-demo" },
      runtime,
      { deps: { runPluginInstall } },
    );
    expectRecordFields(plan as unknown as Record<string, unknown>, {
      applied: false,
      message: "Plan: install plugin clawhub:openclaw-demo. Say yes to apply.",
    });
    expect(runPluginInstall).not.toHaveBeenCalled();

    const result = await executeSystemAgentOperation(
      { kind: "plugin-install", spec: "clawhub:openclaw-demo" },
      runtime,
      {
        approved: true,
        deps: { runPluginInstall },
        auditDetails: { rescue: true },
      },
    );
    expect(result.applied).toBe(true);

    const installCall = requireFirstMockCall(runPluginInstall, "runPluginInstall");
    expect(installCall[0]).toBe("clawhub:openclaw-demo");
    expectRuntimeArg(installCall[1]);
    expect(lines.join("\n")).toContain("[openclaw] done: plugin.install");
    const auditPath = path.join(tempDir, "audit", "system-agent.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expectAuditRecord(
      audit,
      {
        operation: "plugin.install",
        summary: "Installed plugin clawhub:openclaw-demo",
      },
      { rescue: true, spec: "clawhub:openclaw-demo" },
    );
  });

  it("rejects an invalid approved plugin spec without exiting inside the executor", async () => {
    const runPluginInstall = vi.fn();
    mockConfig.readConfigFileSnapshot.mockClear();
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn() as unknown as RuntimeEnv["exit"],
    };

    await expect(
      executeSystemAgentOperation(
        { kind: "plugin-install", spec: "https://example.test/plugin.tgz" },
        runtime,
        { approved: true, deps: { runPluginInstall } },
      ),
    ).rejects.toThrow("accepts npm or ClawHub package specs only");

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runPluginInstall).not.toHaveBeenCalled();
    expect(mockConfig.readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("rejects arbitrary plugin sources before proposing or installing them", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    const runPluginInstall = vi.fn();

    // Untrusted spec must be rejected on the unapproved path too, so a
    // formatted "plan" never surfaces an arbitrary source for approval.
    await expect(
      executeSystemAgentOperation(
        { kind: "plugin-install", spec: "npm:@example/plugin" },
        runtime,
        { deps: { runPluginInstall } },
      ),
    ).rejects.toThrow("trusted shell");
    expect(runPluginInstall).not.toHaveBeenCalled();
  });

  it("refuses plugin uninstall because it cannot prove inference survives", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runPluginUninstall = vi.fn();

    const result = await executeSystemAgentOperation(
      { kind: "plugin-uninstall", pluginId: "openclaw-demo" },
      runtime,
      { approved: true, deps: { runPluginUninstall } },
    );
    expectRecordFields(result as unknown as Record<string, unknown>, {
      applied: false,
    });
    expect(runPluginUninstall).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("cannot prove that uninstalling a plugin");
    expect(lines.join("\n")).toContain("openclaw plugins uninstall openclaw-demo");
  });
});
