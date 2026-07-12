// Crestodian operation tests cover rescue operation planning and execution.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeEnv } from "../runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createCrestodianTestRuntime } from "./crestodian.test-helpers.js";
import { CrestodianInferenceUnavailableError } from "./inference-error.js";
import {
  describeCrestodianPersistentOperation,
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  parseCrestodianOperation,
} from "./operations.js";

type TestConfig = Record<string, unknown>;

function parseLastJsonLine(raw: string): unknown {
  const lastLine = raw.trim().split("\n").at(-1);
  if (!lastLine) {
    throw new Error("Expected audit log to contain at least one JSON line");
  }
  return JSON.parse(lastLine) as unknown;
}

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

describe("parseCrestodianOperation", () => {
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
    expect(parseCrestodianOperation("set default model openai/gpt-5.2")).toEqual({
      kind: "set-default-model",
      model: "openai/gpt-5.2",
    });
    expect(parseCrestodianOperation("configure models openai/gpt-5.2")).toEqual({
      kind: "set-default-model",
      model: "openai/gpt-5.2",
    });
  });

  it("parses interactive model provider setup", () => {
    expect(parseCrestodianOperation("configure model provider")).toEqual({
      kind: "model-setup",
    });
    expect(parseCrestodianOperation("setup model provider")).toEqual({
      kind: "model-setup",
    });
    expect(parseCrestodianOperation("model setup workspace /tmp/work")).toEqual({
      kind: "model-setup",
      workspace: "/tmp/work",
    });
  });

  it("parses verbal agent switching", () => {
    expect(parseCrestodianOperation("talk to work agent")).toEqual({
      kind: "open-tui",
      agentId: "work",
    });
  });

  it("routes ambiguous model requests to the AI instead of guessing", () => {
    expect(parseCrestodianOperation("models please").kind).toBe("none");
    expect(parseCrestodianOperation("why did my gateway stop").kind).toBe("none");
    expect(parseCrestodianOperation("should I talk to my agent about this?").kind).toBe("none");
    expect(parseCrestodianOperation("set me up with telegram").kind).toBe("none");
    expect(parseCrestodianOperation("can I set the default model gpt-5.5 later?").kind).toBe(
      "none",
    );
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

  it("parses plugin management operations", () => {
    expect(parseCrestodianOperation("plugins list")).toEqual({ kind: "plugin-list" });
    expect(parseCrestodianOperation("list plugin")).toEqual({ kind: "plugin-list" });
    expect(parseCrestodianOperation("plugins search calendar sync")).toEqual({
      kind: "plugin-search",
      query: "calendar sync",
    });
    expect(parseCrestodianOperation("install npm plugin @openclaw/demo")).toEqual({
      kind: "plugin-install",
      spec: "npm:@openclaw/demo",
    });
    expect(parseCrestodianOperation("plugin install clawhub:openclaw-demo")).toEqual({
      kind: "plugin-install",
      spec: "clawhub:openclaw-demo",
    });
    expect(parseCrestodianOperation("plugin uninstall openclaw-demo")).toEqual({
      kind: "plugin-uninstall",
      pluginId: "openclaw-demo",
    });
  });

  it("parses config read and schema lookups", () => {
    expect(parseCrestodianOperation("config get gateway.port")).toEqual({
      kind: "config-get",
      path: "gateway.port",
    });
    expect(parseCrestodianOperation("config schema channels.telegram")).toEqual({
      kind: "config-schema",
      path: "channels.telegram",
    });
    expect(parseCrestodianOperation("config schema")).toEqual({ kind: "config-schema" });
    // Read-only: no approval gate.
    expect(isPersistentCrestodianOperation({ kind: "config-get", path: "gateway.port" })).toBe(
      false,
    );
    expect(isPersistentCrestodianOperation({ kind: "config-schema" })).toBe(false);
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
    const { runtime, lines } = createCrestodianTestRuntime();

    await executeCrestodianOperation(
      { kind: "config-get", path: "models.providers.local.localService" },
      runtime,
    );

    expect(lines.join("\n")).toContain('"HF_HOME": "<redacted>"');
    expect(lines.join("\n")).not.toContain("/private/model-cache");
    expect(
      describeCrestodianPersistentOperation({
        kind: "config-set",
        path: "models.providers.local.localService.env.HF_HOME",
        value: "/private/model-cache",
      }),
    ).toBe("set config models.providers.local.localService.env.HF_HOME to <redacted>");
  });

  it("parses channel listing and connect requests", () => {
    expect(parseCrestodianOperation("channels")).toEqual({ kind: "channel-list" });
    expect(parseCrestodianOperation("list channels")).toEqual({ kind: "channel-list" });
    expect(parseCrestodianOperation("connect telegram")).toEqual({
      kind: "channel-setup",
      channel: "telegram",
    });
    expect(parseCrestodianOperation("connect to WhatsApp")).toEqual({
      kind: "channel-setup",
      channel: "whatsapp",
    });
    expect(parseCrestodianOperation("link discord channel")).toEqual({
      kind: "channel-setup",
      channel: "discord",
    });
    // Starting the wizard is not a write; the wizard collects explicit answers.
    expect(isPersistentCrestodianOperation({ kind: "channel-setup", channel: "telegram" })).toBe(
      false,
    );
    expect(isPersistentCrestodianOperation({ kind: "channel-list" })).toBe(false);
  });

  it("parses anchored setup switches and channel info", () => {
    for (const input of [
      "open setup wizard",
      "setup wizard",
      "menu setup",
      "use the setup wizard",
      "use the wizard",
    ]) {
      expect(parseCrestodianOperation(input)).toEqual({ kind: "open-setup", target: "guided" });
    }
    for (const input of ["open classic wizard", "open classic setup wizard", "classic setup"]) {
      expect(parseCrestodianOperation(input)).toEqual({ kind: "open-setup", target: "classic" });
    }
    expect(parseCrestodianOperation("open channel wizard")).toEqual({
      kind: "open-setup",
      target: "channels",
    });
    expect(parseCrestodianOperation("open channel wizard for Slack")).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });
    expect(parseCrestodianOperation("channel info Slack")).toEqual({
      kind: "channel-info",
      channel: "slack",
    });
    expect(parseCrestodianOperation("about Telegram channel")).toEqual({
      kind: "channel-info",
      channel: "telegram",
    });
    expect(parseCrestodianOperation("please open the setup wizard soon").kind).toBe("none");
    expect(parseCrestodianOperation("channel info slack please").kind).toBe("none");
  });

  it("prints one-shot setup pointers", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();

    for (const operation of [
      { kind: "open-setup", target: "guided" } as const,
      { kind: "open-setup", target: "classic" } as const,
      { kind: "open-setup", target: "channels", channel: "slack" } as const,
    ]) {
      const result = await executeCrestodianOperation(operation, runtime);
      expect(result.applied).toBe(false);
    }

    const output = lines.join("\n");
    expect(output).toContain("openclaw onboard`");
    expect(output).toContain("openclaw onboard --classic");
    expect(output).toContain("openclaw channels add --channel slack");
  });

  it("routes one-shot model setup through the verified Crestodian flow", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();

    const result = await executeCrestodianOperation({ kind: "model-setup" }, runtime);

    expect(result.applied).toBe(false);
    expect(lines.join("\n")).toContain("Exit Crestodian and run `openclaw onboard`");
    expect(lines.join("\n")).not.toContain("openclaw configure --section model");
  });

  it("prints discovered channel metadata and sorted unknown-channel choices", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
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

    await executeCrestodianOperation({ kind: "channel-info", channel: "slack" }, runtime, {
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
    await executeCrestodianOperation({ kind: "channel-info", channel: "matrix" }, runtime, {
      deps,
    });
    expect(lines.join("\n")).toContain("Known channels: slack, telegram");
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

  it("rejects an explicit new-agent model before any config write or audit", async () => {
    const tempDir = opTempDirs.make("crestodian-agent-model-rejected-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runAgentsAdd = vi.fn(async () => {});
    expect(
      isPersistentCrestodianOperation({
        kind: "create-agent",
        agentId: "work",
        model: "openai/gpt-5.5",
      }),
    ).toBe(false);
    expect(isPersistentCrestodianOperation({ kind: "create-agent", agentId: "work" })).toBe(true);

    await expect(
      executeCrestodianOperation(
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
    expect(lines.join("\n")).not.toContain("[crestodian] running: agents.create");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("reserves the normalized Crestodian agent identity before any write or audit", async () => {
    const tempDir = opTempDirs.make("crestodian-agent-id-reserved-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runAgentsAdd = vi.fn(async () => {});
    const operation = {
      kind: "create-agent" as const,
      agentId: "Crestodian",
      workspace: "/tmp/work",
    };

    expect(isPersistentCrestodianOperation(operation)).toBe(false);
    await expect(
      executeCrestodianOperation(operation, runtime, {
        approved: true,
        deps: { runAgentsAdd },
      }),
    ).rejects.toThrow('Agent id "crestodian" is reserved');

    expect(runAgentsAdd).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[crestodian] running: agents.create");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("requires approval before restarting gateway", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    const runGatewayRestart = vi.fn(async () => {});

    const result = await executeCrestodianOperation({ kind: "gateway-restart" }, runtime, {
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
    const tempDir = opTempDirs.make("crestodian-restart-failed-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runGatewayRestart = vi.fn(async () => false);

    await expect(
      executeCrestodianOperation({ kind: "gateway-restart" }, runtime, {
        approved: true,
        deps: { runGatewayRestart },
      }),
    ).rejects.toThrow("Gateway restart did not complete");

    expect(lines.join("\n")).toContain("[crestodian] running: gateway.restart");
    expect(lines.join("\n")).not.toContain("[crestodian] done: gateway.restart");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("validates missing config without exiting the process", async () => {
    mockConfig.missing("/tmp/openclaw.json");
    const { runtime, lines } = createCrestodianTestRuntime();

    const result = await executeCrestodianOperation({ kind: "config-validate" }, runtime);
    expect(result.applied).toBe(false);

    expect(lines.join("\n")).toContain("Config missing:");
  });

  it("applies config set through typed deps and writes an audit entry", async () => {
    const tempDir = opTempDirs.make("crestodian-config-set-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    const result = await executeCrestodianOperation(
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
    expect(lines.join("\n")).toContain("[crestodian] done: config.set");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
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
    const tempDir = opTempDirs.make("crestodian-audit-warning-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const redirectedAuditDir = path.join(tempDir, "redirected-audit");
    await fs.mkdir(redirectedAuditDir);
    await fs.symlink(redirectedAuditDir, path.join(tempDir, "audit"), "dir");
    const { runtime, lines } = createCrestodianTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    const result = await executeCrestodianOperation(
      { kind: "config-set", path: "gateway.port", value: "19001" },
      runtime,
      { approved: true, deps: { runConfigSet } },
    );

    expect(result.applied).toBe(true);
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(lines.join("\n")).toContain(
      "Set config gateway.port, but OpenClaw could not record its audit entry:",
    );
    expect(lines.join("\n")).toContain("[crestodian] done: config.set");
  });

  it("applies SecretRef config set through typed deps and writes an audit entry", async () => {
    const tempDir = opTempDirs.make("crestodian-config-ref-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    const result = await executeCrestodianOperation(
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
    expect(lines.join("\n")).toContain("[crestodian] done: config.setRef");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
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
    const { runtime } = createCrestodianTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    const result = await executeCrestodianOperation(
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
    const tempDir = opTempDirs.make("crestodian-route-write-refused-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    await expect(
      executeCrestodianOperation(operation, runtime, {
        approved: true,
        deps: { runConfigSet },
      }),
    ).rejects.toThrow("openclaw onboard");

    expect(runConfigSet).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[crestodian] running:");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("runs plugin list and search as read-only operations", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    const runPluginsList = vi.fn(async (pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log("plugin rows");
    });
    const runPluginsSearch = vi.fn(async (query: string, pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log(`search rows: ${query}`);
    });

    const listResult = await executeCrestodianOperation({ kind: "plugin-list" }, runtime, {
      deps: { runPluginsList, runPluginsSearch },
    });
    expect(listResult.applied).toBe(false);
    const searchResult = await executeCrestodianOperation(
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
    const tempDir = opTempDirs.make("crestodian-plugin-install-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runPluginInstall = vi.fn(async (spec: string, pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log(`installed ${spec}`);
    });

    const plan = await executeCrestodianOperation(
      { kind: "plugin-install", spec: "clawhub:openclaw-demo" },
      runtime,
      { deps: { runPluginInstall } },
    );
    expectRecordFields(plan as unknown as Record<string, unknown>, {
      applied: false,
      message: "Plan: install plugin clawhub:openclaw-demo. Say yes to apply.",
    });
    expect(runPluginInstall).not.toHaveBeenCalled();

    const result = await executeCrestodianOperation(
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
    expect(lines.join("\n")).toContain("[crestodian] done: plugin.install");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
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
      executeCrestodianOperation(
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

  it("refuses plugin uninstall because it cannot prove inference survives", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    const runPluginUninstall = vi.fn();

    const result = await executeCrestodianOperation(
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

  it("runs setup bootstrap only after approval and audits it", async () => {
    const tempDir = opTempDirs.make("crestodian-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    mockConfig.setConfig({ agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } });
    const applySetup = vi.fn(async () => ({
      configPath: path.join(tempDir, "openclaw.json"),
      configHashBefore: "mock-hash-0",
      configHashAfter: "mock-hash-1",
      lines: ["Workspace: /tmp/work"],
    }));
    const deps = {
      applySetup,
      loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
      verifyInferenceConfig: vi.fn(async () => ({
        ok: true as const,
        modelRef: "openai/gpt-5.5",
        latencyMs: 12,
      })),
    };

    const plan = await executeCrestodianOperation(
      { kind: "setup", workspace: "/tmp/work" },
      runtime,
      { deps },
    );
    expectRecordFields(plan as unknown as Record<string, unknown>, {
      applied: false,
    });
    expect(lines.join("\n")).toContain("Model choice: keep verified default openai/gpt-5.5.");
    expect(applySetup).not.toHaveBeenCalled();

    const result = await executeCrestodianOperation(
      { kind: "setup", workspace: "/tmp/work" },
      runtime,
      {
        approved: true,
        auditDetails: { rescue: true },
        deps,
      },
    );
    expect(result.applied).toBe(true);

    expect(lines.join("\n")).toContain("[crestodian] done: crestodian.setup");
    expect(applySetup).toHaveBeenCalledWith(
      {
        workspace: "/tmp/work",
        expectedInferenceRoute: expect.any(Object),
        surface: "cli",
        runtime,
      },
      { commit: expect.any(Function) },
    );
    expect(lines.join("\n")).toContain("Default model: openai/gpt-5.5 (verified and kept)");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expectAuditRecord(
      audit,
      {
        operation: "crestodian.setup",
        summary: "Bootstrapped setup workspace",
      },
      {
        rescue: true,
        workspace: "/tmp/work",
        model: "openai/gpt-5.5",
        modelSource: "live-verified default model",
        inferenceLatencyMs: 12,
      },
    );
  });

  it("rejects setup without a default model before any workspace or Gateway write", async () => {
    const tempDir = opTempDirs.make("crestodian-no-inference-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const applySetup = vi.fn();
    const deps = {
      applySetup,
      setupSurface: "gateway" as const,
      loadOverview: async () => ({ defaultModel: undefined }) as never,
    };

    await expect(
      executeCrestodianOperation({ kind: "setup", workspace: "/tmp/work" }, runtime, {
        approved: true,
        deps,
      }),
    ).rejects.toThrow("requires working inference first");

    expect(applySetup).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[crestodian] running: crestodian.setup");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("rejects setup when the current route fails its live inference check", async () => {
    const tempDir = opTempDirs.make("crestodian-failed-inference-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    mockConfig.setConfig({ agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } });
    const { runtime, lines } = createCrestodianTestRuntime();
    const applySetup = vi.fn();

    await expect(
      executeCrestodianOperation({ kind: "setup", workspace: "/tmp/work" }, runtime, {
        approved: true,
        deps: {
          applySetup,
          loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          verifyInferenceConfig: async () => ({
            ok: false as const,
            status: "auth" as const,
            error: "not authenticated",
          }),
        },
      }),
    ).rejects.toThrow("failed a live check");

    expect(applySetup).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[crestodian] running: crestodian.setup");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("rejects route drift during setup verification but preserves the concurrent edit", async () => {
    mockConfig.setConfig({
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      auth: { order: { openai: ["openai:old"] } },
    });
    const { runtime } = createCrestodianTestRuntime();
    const applySetup = vi.fn();

    await expect(
      executeCrestodianOperation({ kind: "setup", workspace: "/tmp/work" }, runtime, {
        approved: true,
        deps: {
          applySetup,
          loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          verifyInferenceConfig: async () => {
            mockConfig.setConfig({
              agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
              auth: { order: { openai: ["openai:new"] } },
            });
            return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 8 };
          },
        },
      }),
    ).rejects.toThrow("changed during setup verification");

    expect(applySetup).not.toHaveBeenCalled();
    expect(mockConfig.currentConfig()).toMatchObject({
      auth: { order: { openai: ["openai:new"] } },
    });
  });

  it("preserves unrelated concurrent edits after re-verifying the same setup route", async () => {
    mockConfig.setConfig({
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      gateway: { port: 18789 },
    });
    const { runtime } = createCrestodianTestRuntime();
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: "mock-hash-0",
      configHashAfter: "mock-hash-1",
      lines: [],
    }));

    const result = await executeCrestodianOperation(
      { kind: "setup", workspace: "/tmp/work" },
      runtime,
      {
        approved: true,
        deps: {
          applySetup,
          loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          verifyInferenceConfig: async () => {
            mockConfig.setConfig({
              agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
              gateway: { port: 19000 },
            });
            return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 7 };
          },
        },
      },
    );

    expect(result.applied).toBe(true);
    expect(mockConfig.currentConfig()).toMatchObject({ gateway: { port: 19000 } });
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ expectedInferenceRoute: expect.any(Object) }),
      { commit: expect.any(Function) },
    );
  });

  it("rejects a setup model switch before writing", async () => {
    const tempDir = opTempDirs.make("crestodian-model-switch-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime } = createCrestodianTestRuntime();
    const applySetup = vi.fn();

    await expect(
      executeCrestodianOperation(
        { kind: "setup", workspace: "/tmp/work", model: "acme/different" },
        runtime,
        {
          approved: true,
          deps: {
            applySetup,
            loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          },
        },
      ),
    ).rejects.toThrow("Exit Crestodian and run `openclaw onboard`");

    expect(applySetup).not.toHaveBeenCalled();
  });

  it("allows the same requested model while preserving it without a model write", async () => {
    const tempDir = opTempDirs.make("crestodian-same-model-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime } = createCrestodianTestRuntime();
    mockConfig.setConfig({ agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } });
    const applySetup = vi.fn(async () => ({
      configPath: path.join(tempDir, "openclaw.json"),
      configHashBefore: "mock-hash-0",
      configHashAfter: "mock-hash-1",
      lines: ["Workspace: /tmp/work"],
    }));

    const result = await executeCrestodianOperation(
      { kind: "setup", workspace: "/tmp/work", model: "openai/gpt-5.5" },
      runtime,
      {
        approved: true,
        deps: {
          applySetup,
          loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          verifyInferenceConfig: async () => ({
            ok: true as const,
            modelRef: "openai/gpt-5.5",
            latencyMs: 5,
          }),
        },
      },
    );

    expect(result).toEqual({ applied: true });
    expect(applySetup).toHaveBeenCalledWith(
      {
        workspace: "/tmp/work",
        expectedInferenceRoute: expect.any(Object),
        surface: "cli",
        runtime,
      },
      { commit: expect.any(Function) },
    );
  });

  it("live-verifies a staged default model before writing and preserves concurrent edits", async () => {
    const tempDir = opTempDirs.make("crestodian-verified-model-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    mockConfig.setConfig({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["openai/gpt-5.2"] },
        },
        list: [{ id: "main", default: true, workspace: "/tmp/main" }],
      },
      gateway: { port: 18789 },
      models: { providers: { openai: { baseUrl: "https://api.openai.com/v1" } } },
    });
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createCrestodianTestRuntime();
    let verificationCalls = 0;
    const verifyInferenceConfig = vi.fn(async ({ config }: { config: TestConfig }) => {
      verificationCalls += 1;
      const stagedDefaults = requireRecord(
        requireRecord(config.agents, "agents").defaults,
        "defaults",
      );
      expect(stagedDefaults.model).toEqual({
        primary: "openai/gpt-5.5",
        fallbacks: ["openai/gpt-5.2"],
      });
      expect(
        requireRecord(
          requireRecord(
            requireRecord(mockConfig.currentConfig().agents, "agents").defaults,
            "defaults",
          ).model,
          "persisted model",
        ).primary,
      ).toBe("anthropic/claude-sonnet-4-6");
      if (verificationCalls === 1) {
        const current = mockConfig.currentConfig();
        const currentModels = requireRecord(current.models, "models");
        const currentProviders = requireRecord(currentModels.providers, "providers");
        mockConfig.setConfig({
          ...current,
          auth: {
            profiles: { "google:other": { provider: "google", mode: "api_key" } },
          },
          models: {
            ...currentModels,
            providers: {
              ...currentProviders,
              google: {
                baseUrl: "https://example.invalid",
                models: [{ id: "unrelated", name: "Unrelated", contextWindow: 1, maxTokens: 1 }],
              },
            },
          },
          agents: {
            ...requireRecord(current.agents, "agents"),
            defaults: {
              ...requireRecord(requireRecord(current.agents, "agents").defaults, "defaults"),
              models: { "google/unrelated": { agentRuntime: { id: "openclaw" } } },
            },
            list: [
              { id: "main", default: true, workspace: "/tmp/main" },
              { id: "work", workspace: "/tmp/work" },
            ],
          },
          channels: { telegram: { enabled: true } },
        });
      }
      return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 17 };
    });

    const result = await executeCrestodianOperation(
      { kind: "set-default-model", model: "openai/gpt-5.5" },
      runtime,
      { approved: true, deps: { verifyInferenceConfig } },
    );

    expect(result).toEqual({ applied: true });
    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(verifyInferenceConfig).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ requireExecutionOwner: true }),
    );
    expect(verifyInferenceConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requireExecutionOwner: true }),
    );
    expect(mockConfig.mutateConfigFile).toHaveBeenCalledOnce();
    expect(mockConfig.mutateConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        writeOptions: { preCommitRuntimePreflight: expect.any(Function) },
      }),
    );
    const persisted = mockConfig.currentConfig();
    expect(
      requireRecord(requireRecord(persisted.agents, "agents").defaults, "defaults").model,
    ).toEqual({ primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.2"] });
    expect(requireRecord(persisted.agents, "agents").list).toEqual([
      { id: "main", default: true, workspace: "/tmp/main" },
      { id: "work", workspace: "/tmp/work" },
    ]);
    expect(requireRecord(persisted.auth, "auth").profiles).toEqual({
      "google:other": { provider: "google", mode: "api_key" },
    });
    expect(
      requireRecord(requireRecord(persisted.models, "models").providers, "providers"),
    ).toMatchObject({
      openai: { baseUrl: "https://api.openai.com/v1" },
      google: expect.any(Object),
    });
    expect(
      requireRecord(
        requireRecord(requireRecord(persisted.agents, "agents").defaults, "defaults").models,
        "default models",
      ),
    ).toHaveProperty("google/unrelated");
    expect(persisted.channels).toEqual({ telegram: { enabled: true } });
    expect(lines.join("\n")).toContain("Default model: openai/gpt-5.5");

    const audit = parseLastJsonLine(
      await fs.readFile(path.join(tempDir, "audit", "crestodian.jsonl"), "utf8"),
    );
    expectAuditRecord(
      audit,
      {
        operation: "config.setDefaultModel",
        summary: "Set default model to openai/gpt-5.5",
      },
      {
        requestedModel: "openai/gpt-5.5",
        effectiveModel: "openai/gpt-5.5",
        inferenceVerified: true,
        inferenceLatencyMs: 17,
      },
    );
  });

  it.each([
    {
      field: "default agent",
      initial: {
        agents: {
          defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const list = requireRecord(next.agents, "agents").list as Array<{
          id: string;
          default?: boolean;
        }>;
        delete list[0]?.default;
        list[1]!.default = true;
        return next;
      },
    },
    {
      field: "default marker",
      initial: {
        agents: {
          defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const list = requireRecord(next.agents, "agents").list as Array<{
          id: string;
          default?: boolean;
        }>;
        delete list[0]?.default;
        return next;
      },
    },
    {
      field: "auth profile order",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        auth: { order: { anthropic: ["anthropic:one"] } },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        auth: { order: { anthropic: ["anthropic:two"] } },
      }),
    },
    {
      field: "runtime metadata",
      initial: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: {
              "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const defaults = requireRecord(requireRecord(next.agents, "agents").defaults, "defaults");
        defaults.models = {
          "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "openclaw" } },
        };
        return next;
      },
    },
    {
      field: "model",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const defaults = requireRecord(requireRecord(next.agents, "agents").defaults, "defaults");
        defaults.model = { primary: "anthropic/claude-opus-4-6" };
        return next;
      },
    },
    {
      field: "config-backed environment",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        env: { vars: { ANTHROPIC_API_KEY: "first" } },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        env: { vars: { ANTHROPIC_API_KEY: "second" } },
      }),
    },
    {
      field: "secret provider policy",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        secrets: { defaults: { env: "first" } },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        secrets: { defaults: { env: "second" } },
      }),
    },
    {
      field: "plugin load policy",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        plugins: { enabled: true },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        plugins: { enabled: false },
      }),
    },
  ])(
    "aborts when concurrent $field changes invalidate the verified route",
    async ({ initial, change }) => {
      const tempDir = opTempDirs.make("crestodian-route-conflict-");
      setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
      mockConfig.setConfig(initial);
      mockConfig.mutateConfigFile.mockClear();
      const { runtime, lines } = createCrestodianTestRuntime();
      const verifyInferenceConfig = vi.fn(async () => {
        mockConfig.setConfig(change(mockConfig.currentConfig()));
        return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 7 };
      });

      await expect(
        executeCrestodianOperation(
          { kind: "set-default-model", model: "openai/gpt-5.5" },
          runtime,
          {
            approved: true,
            deps: { verifyInferenceConfig },
          },
        ),
      ).rejects.toThrow("inference route changed during verification");

      expect(mockConfig.mutateConfigFile).toHaveBeenCalledOnce();
      expect(lines.join("\n")).not.toContain("[crestodian] done: config.setDefaultModel");
      await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
    },
  );

  it("keeps the working model and writes no audit when live inference fails", async () => {
    const tempDir = opTempDirs.make("crestodian-rejected-model-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      gateway: { port: 18789 },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createCrestodianTestRuntime();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: false as const,
      status: "auth" as const,
      error: "Provider authentication failed.",
    }));

    await expect(
      executeCrestodianOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow(
      "The requested model failed a live inference test, so the current default model was not changed. Provider authentication failed. Fix provider authentication or model access, then retry.",
    );

    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(mockConfig.mutateConfigFile).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[crestodian] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("writes nothing when the exact latest route fails its locked recheck", async () => {
    const tempDir = opTempDirs.make("crestodian-latest-route-rejected-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createCrestodianTestRuntime();
    const verifyInferenceConfig = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.5", latencyMs: 5 })
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "credential changed" });

    await expect(
      executeCrestodianOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow("no longer passes live inference at the config commit boundary");

    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[crestodian] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("rejects a live result from a different model before opening the write boundary", async () => {
    const tempDir = opTempDirs.make("crestodian-mismatched-model-result-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createCrestodianTestRuntime();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.4",
      latencyMs: 5,
    }));

    await expect(
      executeCrestodianOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow("did not verify the exact model route");

    expect(verifyInferenceConfig).toHaveBeenCalledOnce();
    expect(mockConfig.mutateConfigFile).not.toHaveBeenCalled();
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[crestodian] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("rejects a different model result from the final commit-boundary probe", async () => {
    const tempDir = opTempDirs.make("crestodian-final-mismatched-model-result-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createCrestodianTestRuntime();
    const verifyInferenceConfig = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.5", latencyMs: 5 })
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.4", latencyMs: 5 });

    await expect(
      executeCrestodianOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow("did not verify the exact model route at the config commit boundary");

    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[crestodian] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("rechecks the existing inference binding inside the locked model transform", async () => {
    const tempDir = opTempDirs.make("crestodian-model-binding-rotated-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createCrestodianTestRuntime();
    let bindingOwner = "verified";
    const verifyInferenceConfig = vi.fn(async () => {
      bindingOwner = "rotated";
      return {
        ok: true as const,
        modelRef: "openai/gpt-5.5",
        latencyMs: 5,
      };
    });
    const beforePersistentApply = vi.fn(async () => {
      if (bindingOwner !== "verified") {
        throw new CrestodianInferenceUnavailableError("conversation");
      }
    });

    await expect(
      executeCrestodianOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
        beforePersistentApply,
      }),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);

    expect(verifyInferenceConfig).toHaveBeenCalledOnce();
    expect(beforePersistentApply).toHaveBeenCalledOnce();
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[crestodian] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("rechecks the existing inference binding after the candidate's final live probe", async () => {
    const tempDir = opTempDirs.make("crestodian-model-binding-final-probe-rotated-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createCrestodianTestRuntime();
    let bindingOwner = "verified";
    let verificationCalls = 0;
    const verifyInferenceConfig = vi.fn(async () => {
      verificationCalls += 1;
      if (verificationCalls === 2) {
        bindingOwner = "rotated";
      }
      return {
        ok: true as const,
        modelRef: "openai/gpt-5.5",
        latencyMs: 5,
      };
    });
    const beforePersistentApply = vi.fn(async () => {
      if (bindingOwner !== "verified") {
        throw new CrestodianInferenceUnavailableError("conversation");
      }
    });

    await expect(
      executeCrestodianOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
        beforePersistentApply,
      }),
    ).rejects.toBeInstanceOf(CrestodianInferenceUnavailableError);

    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(beforePersistentApply).toHaveBeenCalledTimes(2);
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[crestodian] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
  });

  it("stages and persists model changes at the effective default-agent owner", async () => {
    const tempDir = opTempDirs.make("crestodian-default-agent-model-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    mockConfig.setConfig({
      agents: {
        defaults: { model: { primary: "anthropic/global-default" } },
        list: [
          {
            id: "work",
            default: true,
            model: { primary: "anthropic/work-default" },
          },
        ],
      },
    });
    const { runtime } = createCrestodianTestRuntime();
    const verifyInferenceConfig = vi.fn(async ({ config }: { config: TestConfig }) => {
      const agents = requireRecord(config.agents, "agents");
      expect(requireRecord(agents.defaults, "defaults").model).toEqual({
        primary: "anthropic/global-default",
      });
      const list = agents.list as Array<{ id: string; model: unknown }>;
      expect(list.find((agent) => agent.id === "work")?.model).toEqual({
        primary: "openai/gpt-5.5",
      });
      return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 9 };
    });

    await executeCrestodianOperation(
      { kind: "set-default-model", model: "openai/gpt-5.5" },
      runtime,
      { approved: true, deps: { verifyInferenceConfig } },
    );

    const agents = requireRecord(mockConfig.currentConfig().agents, "agents");
    expect(requireRecord(agents.defaults, "defaults").model).toEqual({
      primary: "anthropic/global-default",
    });
    const list = agents.list as Array<{ id: string; model: unknown }>;
    expect(list.find((agent) => agent.id === "work")?.model).toEqual({
      primary: "openai/gpt-5.5",
    });
  });

  it("refuses doctor repairs before any write or audit", async () => {
    const tempDir = opTempDirs.make("crestodian-doctor-fix-refused-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runDoctor = vi.fn(async () => {});

    const result = await executeCrestodianOperation({ kind: "doctor-fix" }, runtime, {
      approved: true,
      deps: { runDoctor },
      auditDetails: { rescue: true },
    });
    expect(result).toEqual({ applied: false });
    expect(isPersistentCrestodianOperation({ kind: "doctor-fix" })).toBe(false);
    expect(runDoctor).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("Exit Crestodian");
    expect(lines.join("\n")).toContain("openclaw doctor --fix");
    expect(lines.join("\n")).not.toContain("[crestodian] running: doctor.fix");
    await expect(fs.access(path.join(tempDir, "audit", "crestodian.jsonl"))).rejects.toThrow();
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
    expectRecordFields(result as unknown as Record<string, unknown>, {
      applied: false,
      nextInput: "restart gateway",
    });
    expect(lines.join("\n")).toContain(
      "[crestodian] returned from agent with request: restart gateway",
    );
  });
});
