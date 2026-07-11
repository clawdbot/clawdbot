// Crestodian operation tests cover rescue operation planning and execution.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeEnv } from "../runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createCrestodianTestRuntime } from "./crestodian.test-helpers.js";
import {
  describeCrestodianPersistentOperation,
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  parseCrestodianOperation,
} from "./operations.js";
import type { ActivateSetupInferenceResult } from "./setup-inference.js";

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

vi.mock("../config/model-input.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/model-input.js")>()),
  resolveAgentModelPrimaryValue: (model?: string | { primary?: string }) =>
    typeof model === "string" ? model : model?.primary,
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

  it("uninstalls plugins only after approval and audits the write", async () => {
    const tempDir = opTempDirs.make("crestodian-plugin-uninstall-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runPluginUninstall = vi.fn(async (pluginId: string, pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log(`uninstalled ${pluginId}`);
    });

    const plan = await executeCrestodianOperation(
      { kind: "plugin-uninstall", pluginId: "openclaw-demo" },
      runtime,
      { deps: { runPluginUninstall } },
    );
    expectRecordFields(plan as unknown as Record<string, unknown>, {
      applied: false,
      message: "Plan: uninstall plugin openclaw-demo. Say yes to apply.",
    });
    expect(runPluginUninstall).not.toHaveBeenCalled();

    const result = await executeCrestodianOperation(
      { kind: "plugin-uninstall", pluginId: "openclaw-demo" },
      runtime,
      {
        approved: true,
        deps: { runPluginUninstall },
        auditDetails: { rescue: true },
      },
    );
    expect(result.applied).toBe(true);

    const uninstallCall = requireFirstMockCall(runPluginUninstall, "runPluginUninstall");
    expect(uninstallCall[0]).toBe("openclaw-demo");
    expectRuntimeArg(uninstallCall[1]);
    expect(lines.join("\n")).toContain("[crestodian] done: plugin.uninstall");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expectAuditRecord(
      audit,
      {
        operation: "plugin.uninstall",
        summary: "Uninstalled plugin openclaw-demo",
      },
      { rescue: true, pluginId: "openclaw-demo" },
    );
  });

  it("runs setup bootstrap only after approval and audits it", async () => {
    const tempDir = opTempDirs.make("crestodian-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const detectInferenceBackends = vi.fn(async () => [
      {
        kind: "openai-api-key" as const,
        modelRef: "openai/gpt-5.6",
        label: "OpenAI API key",
        detail: "OPENAI_API_KEY set",
        credentials: true,
      },
    ]);
    const activateSetupInference = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.6",
      latencyMs: 250,
      lines: ["Workspace: /tmp/work", "Default model: openai/gpt-5.6"],
    }));
    const operation = { kind: "setup" as const, workspace: "/tmp/work" };
    const deps = { activateSetupInference, detectInferenceBackends };

    const plan = await executeCrestodianOperation(operation, runtime, { deps });
    expectRecordFields(plan as unknown as Record<string, unknown>, {
      applied: false,
    });
    expect(lines.join("\n")).toContain("Model choice: openai/gpt-5.6 (OPENAI_API_KEY).");
    expect(operation).toMatchObject({
      model: "openai/gpt-5.6",
      inferenceRoutes: [{ kind: "openai-api-key", model: "openai/gpt-5.6" }],
    });
    expect(activateSetupInference).not.toHaveBeenCalled();

    const result = await executeCrestodianOperation(operation, runtime, {
      approved: true,
      auditDetails: { rescue: true },
      deps,
    });
    expect(result.applied).toBe(true);

    expect(lines.join("\n")).toContain("[crestodian] done: crestodian.setup");
    expect(detectInferenceBackends).toHaveBeenCalledOnce();
    expect(activateSetupInference).toHaveBeenCalledWith({
      kind: "openai-api-key",
      modelRef: "openai/gpt-5.6",
      workspace: "/tmp/work",
      surface: "cli",
      recordSetupAudit: false,
      runtime,
    });
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expectAuditRecord(
      audit,
      {
        operation: "crestodian.setup",
        summary: "Bootstrapped setup with openai/gpt-5.6",
      },
      {
        rescue: true,
        workspace: "/tmp/work",
        model: "openai/gpt-5.6",
        modelSource: "OPENAI_API_KEY",
        inferenceKind: "openai-api-key",
      },
    );
  });

  it("falls through the captured inference routes without re-detecting", async () => {
    const tempDir = opTempDirs.make("crestodian-setup-fallback-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime } = createCrestodianTestRuntime();
    const detectInferenceBackends = vi.fn(async () => [
      {
        kind: "codex-cli" as const,
        modelRef: "openai/gpt-5.6-sol",
        label: "Codex",
        detail: "logged in",
        credentials: true,
      },
      {
        kind: "claude-cli" as const,
        modelRef: "claude-cli/claude-opus-4-8",
        label: "Claude Code",
        detail: "logged in",
        credentials: true,
      },
    ]);
    const activateSetupInference = vi.fn(
      async ({ kind }: { kind: string }): Promise<ActivateSetupInferenceResult> =>
        kind === "codex-cli"
          ? { ok: false, status: "auth", error: "Codex session expired" }
          : {
              ok: true,
              modelRef: "claude-cli/claude-opus-4-8",
              latencyMs: 200,
              lines: ["Default model: claude-cli/claude-opus-4-8"],
            },
    );
    const operation = { kind: "setup" as const, workspace: "/tmp/work" };
    const deps = { activateSetupInference, detectInferenceBackends };

    await executeCrestodianOperation(operation, runtime, { deps });
    expect(operation).toMatchObject({
      model: "openai/gpt-5.6-sol",
      inferenceRoutes: [
        { kind: "codex-cli", model: "openai/gpt-5.6-sol" },
        { kind: "claude-cli", model: "claude-cli/claude-opus-4-8" },
      ],
    });

    const result = await executeCrestodianOperation(operation, runtime, {
      approved: true,
      deps,
    });

    expect(result.applied).toBe(true);
    expect(detectInferenceBackends).toHaveBeenCalledOnce();
    expect(activateSetupInference.mock.calls.map(([params]) => params.kind)).toEqual([
      "codex-cli",
      "claude-cli",
    ]);
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = JSON.parse((await fs.readFile(auditPath, "utf8")).trim());
    expect(audit).toMatchObject({
      summary: "Bootstrapped setup with claude-cli/claude-opus-4-8",
      details: {
        model: "claude-cli/claude-opus-4-8",
        modelSource: "Claude Code CLI",
        inferenceKind: "claude-cli",
      },
    });
  });

  it("captures and activates an exact explicit model through a compatible route", async () => {
    const tempDir = opTempDirs.make("crestodian-explicit-model-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime } = createCrestodianTestRuntime();
    const detectInferenceBackends = vi.fn(async () => [
      {
        kind: "codex-cli" as const,
        modelRef: "openai/gpt-5.6-sol",
        label: "Codex",
        detail: "logged in",
        credentials: true,
      },
      {
        kind: "claude-cli" as const,
        modelRef: "claude-cli/claude-opus-4-8",
        label: "Claude Code",
        detail: "logged in",
        credentials: true,
      },
    ]);
    const activateSetupInference = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.4",
      latencyMs: 200,
      lines: ["Default model: openai/gpt-5.4"],
    }));
    const applySetup = vi.fn();
    const operation = {
      kind: "setup" as const,
      workspace: "/tmp/work",
      model: "openai/gpt-5.4",
    };
    const deps = { activateSetupInference, applySetup, detectInferenceBackends };

    await executeCrestodianOperation(operation, runtime, { deps });
    expect(operation).toMatchObject({
      model: "openai/gpt-5.4",
      inferenceRoutes: [{ kind: "codex-cli", model: "openai/gpt-5.4" }],
    });

    const result = await executeCrestodianOperation(operation, runtime, {
      approved: true,
      deps,
    });

    expect(result.applied).toBe(true);
    expect(detectInferenceBackends).toHaveBeenCalledOnce();
    expect(activateSetupInference).toHaveBeenCalledWith({
      kind: "codex-cli",
      modelRef: "openai/gpt-5.4",
      workspace: "/tmp/work",
      surface: "cli",
      recordSetupAudit: false,
      runtime,
    });
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("keeps an explicitly selected model when it is already the default", async () => {
    const tempDir = opTempDirs.make("crestodian-explicit-existing-model-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const { loadCrestodianOverview } = await import("./overview.js");
    const loadOverview = vi.fn(async () => ({
      ...(await loadCrestodianOverview()),
      defaultModel: "openai/gpt-5.4",
    }));
    const detectInferenceBackends = vi.fn(async () => []);
    const activateSetupInference = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.4",
      latencyMs: 100,
      lines: ["Workspace: /tmp/work", "Default model: openai/gpt-5.4"],
    }));
    const applySetup = vi.fn();
    const operation = {
      kind: "setup" as const,
      workspace: "/tmp/work",
      model: "openai/gpt-5.4",
    };
    const deps = {
      activateSetupInference,
      applySetup,
      detectInferenceBackends,
      loadOverview,
    };

    const plan = await executeCrestodianOperation(operation, runtime, { deps });
    expect(plan.message).toContain(
      "Model choice: test existing default openai/gpt-5.4 before keeping it.",
    );
    expect(operation).toMatchObject({
      inferenceRoutes: [{ kind: "existing-model", model: "openai/gpt-5.4" }],
    });

    const result = await executeCrestodianOperation(operation, runtime, {
      approved: true,
      deps,
    });

    expect(result.applied).toBe(true);
    expect(detectInferenceBackends).not.toHaveBeenCalled();
    expect(activateSetupInference).toHaveBeenCalledWith({
      kind: "existing-model",
      modelRef: "openai/gpt-5.4",
      workspace: "/tmp/work",
      surface: "cli",
      recordSetupAudit: false,
      runtime,
    });
    expect(applySetup).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("Default model: openai/gpt-5.4");
  });

  it("does not select another provider if a captured existing model disappears", async () => {
    const tempDir = opTempDirs.make("crestodian-existing-model-disappears-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime } = createCrestodianTestRuntime();
    const { loadCrestodianOverview } = await import("./overview.js");
    const loadOverview = vi
      .fn()
      .mockResolvedValueOnce({
        ...(await loadCrestodianOverview()),
        defaultModel: "openai/gpt-5.4",
      })
      .mockResolvedValueOnce({
        ...(await loadCrestodianOverview()),
        defaultModel: undefined,
      });
    const detectInferenceBackends = vi.fn(async () => [
      {
        kind: "claude-cli" as const,
        modelRef: "claude-cli/claude-opus-4-8",
        label: "Claude Code",
        detail: "logged in",
        credentials: true,
      },
    ]);
    const activateSetupInference = vi.fn(async () => ({
      ok: false as const,
      status: "unavailable" as const,
      error: "The configured default model changed. Try setup again.",
    }));
    const applySetup = vi.fn();
    const operation = { kind: "setup" as const, workspace: "/tmp/work" };
    const deps = {
      activateSetupInference,
      applySetup,
      detectInferenceBackends,
      loadOverview,
    };

    await executeCrestodianOperation(operation, runtime, { deps });
    expect(operation).toMatchObject({
      model: "openai/gpt-5.4",
      inferenceRoutes: [{ kind: "existing-model", model: "openai/gpt-5.4" }],
    });

    await expect(
      executeCrestodianOperation(operation, runtime, { approved: true, deps }),
    ).rejects.toThrow(
      "AI setup failed: existing default model: The configured default model changed",
    );
    expect(detectInferenceBackends).not.toHaveBeenCalled();
    expect(activateSetupInference).toHaveBeenCalledWith({
      kind: "existing-model",
      modelRef: "openai/gpt-5.4",
      workspace: "/tmp/work",
      surface: "cli",
      recordSetupAudit: false,
      runtime,
    });
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("reports an actionable error when an explicit model has no usable route", async () => {
    const tempDir = opTempDirs.make("crestodian-explicit-model-no-route-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime } = createCrestodianTestRuntime();
    const detectInferenceBackends = vi.fn(async () => []);
    const applySetup = vi.fn();
    const operation = {
      kind: "setup" as const,
      workspace: "/tmp/work",
      model: "openai/gpt-5.4",
    };
    const deps = { applySetup, detectInferenceBackends };

    await executeCrestodianOperation(operation, runtime, { deps });
    expect(operation).toMatchObject({ inferenceRoutes: [] });

    await expect(
      executeCrestodianOperation(operation, runtime, { approved: true, deps }),
    ).rejects.toThrow(
      "No usable inference access was detected for openai/gpt-5.4. Configure its provider credentials, then try again.",
    );
    expect(detectInferenceBackends).toHaveBeenCalledOnce();
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("offers provider setup after a providerless bootstrap", async () => {
    const tempDir = opTempDirs.make("crestodian-providerless-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const applySetup = vi.fn(async () => ({
      configPath: path.join(tempDir, "openclaw.json"),
      configHashBefore: null,
      configHashAfter: "after",
      lines: ["Workspace: /tmp/work"],
    }));
    const detectInferenceBackends = vi.fn(async () => []);
    const deps = {
      applySetup,
      detectInferenceBackends,
    };
    const operation = { kind: "setup" as const, workspace: "/tmp/work" };

    const plan = await executeCrestodianOperation(operation, runtime, { deps });

    expect(plan.message).toContain("then offer guided model-provider setup");
    expect(operation).toMatchObject({ inferenceRoutes: [] });

    const result = await executeCrestodianOperation(operation, runtime, {
      approved: true,
      deps,
    });

    expect(result).toMatchObject({
      applied: true,
      followUp: { kind: "model-setup", workspace: "/tmp/work" },
    });
    expect(detectInferenceBackends).toHaveBeenCalledOnce();
    expect(lines.join("\n")).toContain("Default model: not configured yet");
  });

  it("runs doctor repairs only after approval and audits them", async () => {
    const tempDir = opTempDirs.make("crestodian-doctor-fix-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createCrestodianTestRuntime();
    const runDoctor = vi.fn(async () => {});

    const plan = await executeCrestodianOperation({ kind: "doctor-fix" }, runtime, {
      deps: { runDoctor },
    });
    expectRecordFields(plan as unknown as Record<string, unknown>, {
      applied: false,
      message: "Plan: run doctor repairs. Say yes to apply.",
    });
    expect(runDoctor).not.toHaveBeenCalled();

    const result = await executeCrestodianOperation({ kind: "doctor-fix" }, runtime, {
      approved: true,
      deps: { runDoctor },
      auditDetails: { rescue: true },
    });
    expect(result.applied).toBe(true);

    expect(runDoctor).toHaveBeenCalledWith(runtime, {
      nonInteractive: true,
      repair: true,
      yes: true,
    });
    expect(lines.join("\n")).toContain("[crestodian] done: doctor.fix");
    const auditPath = path.join(tempDir, "audit", "crestodian.jsonl");
    const audit = parseLastJsonLine(await fs.readFile(auditPath, "utf8"));
    expectAuditRecord(
      audit,
      { operation: "doctor.fix", summary: "Ran doctor repairs" },
      { rescue: true },
    );
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
