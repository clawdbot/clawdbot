import fs from "node:fs/promises";
import path from "node:path";
// OpenClaw operation tests cover rescue operation planning and execution.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGatewayHostLifecycle } from "../cli/gateway-cli/host-lifecycle.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { listSystemAgentAuditEntriesForTests } from "./audit.test-support.js";
import { runGatewayLifecycle } from "./operations-execution-helpers.js";
import {
  describeSystemAgentPersistentOperation,
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
} from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
import { installSystemAgentPluginMetadataTestSnapshot } from "./system-agent.test-helpers.js";

type TestConfig = Record<string, unknown>;

const requireRecord = createRequireRecord("object", "label-not-object");

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

function readLastAuditEntry(): unknown {
  return listSystemAgentAuditEntriesForTests().at(-1)?.value;
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
    valid: true,
    config: initial as TestConfig,
    pinnedConfig: undefined as TestConfig | undefined,
    sourceConfigBeforeMigrations: undefined as TestConfig | undefined,
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
      sourceConfigBeforeMigrations: structuredClone(state.sourceConfigBeforeMigrations ?? config),
      sourceConfig: config,
      resolved: config,
      valid: state.valid,
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
      state.valid = true;
      state.config = {};
      state.pinnedConfig = undefined;
      state.sourceConfigBeforeMigrations = undefined;
      state.hash = "mock-hash-0";
    },
    missing(pathLocal: string) {
      state.path = pathLocal;
      state.exists = false;
      state.valid = false;
      state.config = {};
      state.pinnedConfig = undefined;
      state.sourceConfigBeforeMigrations = undefined;
      state.hash = undefined;
    },
    setConfig(config: TestConfig) {
      state.config = structuredClone(config);
      state.valid = true;
      state.pinnedConfig = undefined;
      state.sourceConfigBeforeMigrations = undefined;
    },
    setInvalidConfig(config: TestConfig, pinnedConfig?: TestConfig) {
      state.exists = true;
      state.valid = false;
      state.config = structuredClone(config);
      state.pinnedConfig = pinnedConfig ? structuredClone(pinnedConfig) : undefined;
      state.sourceConfigBeforeMigrations = undefined;
    },
    setResolvedConfig(config: TestConfig, sourceConfigBeforeMigrations: TestConfig) {
      state.config = structuredClone(config);
      state.sourceConfigBeforeMigrations = structuredClone(sourceConfigBeforeMigrations);
    },
    readConfigFileSnapshot: vi.fn(async () => snapshot()),
    getRuntimeConfig() {
      if (state.pinnedConfig) {
        return structuredClone(state.pinnedConfig);
      }
      if (!state.valid) {
        throw new Error("invalid runtime config");
      }
      return cloneConfig();
    },
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
const mockDaemonRestart = vi.hoisted(() => vi.fn(async () => true));
const runPluginInstallCommandMock = vi.hoisted(() => vi.fn(async () => undefined));
const mockScheduleGatewayRestart = vi.hoisted(() =>
  vi.fn(() => ({
    ok: true,
    pid: process.pid,
    signal: "SIGUSR1" as const,
    delayMs: 0,
    mode: "emit" as const,
    coalesced: false,
    cooldownMsApplied: 0,
    emitHooksQueued: false,
  })),
);
vi.mock("../cli/daemon-cli/lifecycle.js", () => ({
  runDaemonStart: vi.fn(async () => {}),
  runDaemonStop: vi.fn(async () => {}),
  runDaemonRestart: mockDaemonRestart,
}));
vi.mock("../cli/plugins-install-command.js", () => ({
  runPluginInstallCommand: runPluginInstallCommandMock,
}));
vi.mock("../infra/restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/restart.js")>()),
  scheduleGatewaySigusr1Restart: mockScheduleGatewayRestart,
}));
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
  getRuntimeConfig: () => mockConfig.getRuntimeConfig(),
  mutateConfigFile: mockConfig.mutateConfigFile,
  readConfigFileSnapshot: mockConfig.readConfigFileSnapshot,
}));
const opTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("system agent operations", () => {
  let stateDirSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(() => {
    mockConfig.reset();
    mockDaemonRestart.mockClear();
    runPluginInstallCommandMock.mockClear();
    mockScheduleGatewayRestart.mockClear();
    stateDirSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    stateDirSnapshot?.restore();
    vi.unstubAllEnvs();
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

  it("keeps invalid config reads available without exposing recovery secrets", async () => {
    mockConfig.setInvalidConfig(
      {
        gateway: { port: 19_001, auth: { token: "recovery-secret" } },
        plugins: {
          entries: { missing: { config: { opaque: "invalid-plugin-secret" } } },
        },
      },
      {},
    );
    const { runtime, lines } = createSystemAgentTestRuntime();
    await executeSystemAgentOperation({ kind: "config-get", path: "gateway" }, runtime);
    await executeSystemAgentOperation(
      { kind: "config-get", path: "plugins.entries.missing" },
      runtime,
    );
    const output = lines.join("\n");
    expect(output).toContain('"port": 19001');
    expect(output).toContain('"token": "<redacted>"');
    expect(output).toContain('"config": "<redacted>"');
    expect(output).not.toContain("recovery-secret");
    expect(output).not.toContain("invalid-plugin-secret");
  });

  it("fails closed for model-visible config owned by missing plugins and channels", async () => {
    mockConfig.setConfig({
      plugins: {
        entries: {
          missing: { enabled: true, config: { opaque: "missing-plugin-secret" } },
        },
      },
      channels: { missing: { enabled: true, opaque: "missing-channel-secret" } },
    });
    const { runtime, lines } = createSystemAgentTestRuntime();

    await executeSystemAgentOperation(
      { kind: "config-get", path: "plugins.entries.missing" },
      runtime,
    );
    await executeSystemAgentOperation({ kind: "config-get", path: "channels.missing" }, runtime);

    const output = lines.join("\n");
    expect(output).toContain('"enabled": true');
    expect(output).toContain('"config": "<redacted>"');
    expect(output).toContain('channels.missing = "<redacted>"');
    expect(output).not.toContain("missing-plugin-secret");
    expect(output).not.toContain("missing-channel-secret");
  });

  it("preserves kernel-owned channel namespaces in model-visible config reads", async () => {
    mockConfig.setConfig({
      channels: {
        defaults: { groupPolicy: "open" },
        modelByChannel: { telegram: { chat: "openai/gpt-5.5" } },
      },
    });
    const { runtime, lines } = createSystemAgentTestRuntime();

    await executeSystemAgentOperation({ kind: "config-get", path: "channels.defaults" }, runtime);
    await executeSystemAgentOperation(
      { kind: "config-get", path: "channels.modelByChannel" },
      runtime,
    );

    const output = lines.join("\n");
    expect(output).toContain('"groupPolicy": "open"');
    expect(output).toContain('"chat": "openai/gpt-5.5"');
    expect(output).not.toContain("<redacted>");
  });

  it("redacts config values marked sensitive only by active plugin metadata", async () => {
    const authorization = "Bearer plugin-only-secret";
    const config = {
      plugins: {
        entries: {
          codex: { config: { appServer: { headers: { Authorization: authorization } } } },
        },
      },
    };
    mockConfig.setConfig(config);
    const pluginMetadata = installSystemAgentPluginMetadataTestSnapshot(config);
    const { runtime, lines } = createSystemAgentTestRuntime();

    try {
      await executeSystemAgentOperation(
        { kind: "config-get", path: "plugins.entries.codex.config.appServer" },
        runtime,
      );
    } finally {
      pluginMetadata.restore();
    }

    expect(lines.join("\n")).toContain('"headers": "<redacted>"');
    expect(lines.join("\n")).not.toContain(authorization);
  });

  it("keeps sensitive channel callback URLs out of model-visible config reads", async () => {
    const callbackUrl = "https://gateway.example/webhook/synology?access_token=callback-secret";
    const incomingUrl = "https://nas.example/webapi/entry.cgi?token=incoming-secret";
    const config = {
      channels: {
        "synology-chat": {
          incomingUrl,
          webhookUrl: callbackUrl,
          accounts: {
            work: { incomingUrl, webhookUrl: callbackUrl },
          },
        },
      },
    };
    mockConfig.setConfig(config);
    setRuntimeConfigSnapshot(config, config);
    const pluginMetadata = installSystemAgentPluginMetadataTestSnapshot(config);
    const { runtime, lines } = createSystemAgentTestRuntime();

    try {
      await executeSystemAgentOperation(
        { kind: "config-get", path: "channels.synology-chat" },
        runtime,
      );

      expect(lines.join("\n")).toContain('"webhookUrl": "<redacted>"');
      expect(lines.join("\n")).toContain('"incomingUrl": "<redacted>"');
      expect(lines.join("\n")).not.toContain("callback-secret");
      expect(lines.join("\n")).not.toContain("incoming-secret");
      expect(
        describeSystemAgentPersistentOperation({
          kind: "config-set",
          path: "channels.synology-chat.accounts.work.webhookUrl",
          value: callbackUrl,
        }),
      ).toBe("set config channels.synology-chat.accounts.work.webhookUrl to <redacted>");
      expect(
        describeSystemAgentPersistentOperation({
          kind: "config-set",
          path: "channels.synology-chat",
          value: `{ webhookUrl: "${callbackUrl}" }`,
        }),
      ).toBe("set config channels.synology-chat to <redacted>");
    } finally {
      pluginMetadata.restore();
      clearRuntimeConfigSnapshot();
    }
  });

  it("rejects an explicit new-agent model before any config write or audit", async () => {
    const tempDir = opTempDirs.make("openclaw-agent-model-rejected-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const createAgent = vi.fn();
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
        { approved: true, deps: { createAgent } },
      ),
    ).rejects.toThrow("Retry without `model`; the new agent inherits");

    expect(createAgent).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] running: agents.create");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("reserves the normalized OpenClaw agent identity before any write or audit", async () => {
    const tempDir = opTempDirs.make("openclaw-agent-id-reserved-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const createAgent = vi.fn();
    const operation = {
      kind: "create-agent" as const,
      agentId: "OpenClaw",
      workspace: "/tmp/work",
    };

    expect(isPersistentSystemAgentOperation(operation)).toBe(false);
    await expect(
      executeSystemAgentOperation(operation, runtime, {
        approved: true,
        deps: { createAgent },
      }),
    ).rejects.toThrow('Agent id "openclaw" is reserved');

    expect(createAgent).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] running: agents.create");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("delegates literal main to the canonical creation gate", async () => {
    const tempDir = opTempDirs.make("openclaw-agent-main-gate-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime } = createSystemAgentTestRuntime();
    const createAgent = vi.fn(async () => ({
      status: "error" as const,
      reason: "legacy-session-migration-required" as const,
      agentId: "main",
      message: "Run openclaw doctor --fix before creating main.",
    }));

    await expect(
      executeSystemAgentOperation(
        { kind: "create-agent", agentId: "main", workspace: "/tmp/main" },
        runtime,
        { approved: true, deps: { createAgent } },
      ),
    ).rejects.toThrow("Run openclaw doctor --fix before creating main.");

    expect(createAgent).toHaveBeenCalledWith({
      name: "main",
      workspace: "/tmp/main",
      provenance: { createdVia: "agent", creatorAgentId: "openclaw" },
    });
  });

  it("keeps the retired agent identity reserved", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    const createAgent = vi.fn();
    const operation = {
      kind: "create-agent" as const,
      agentId: "crestodian", // reserved retired id
      workspace: "/tmp/retired",
    };

    expect(isPersistentSystemAgentOperation(operation)).toBe(false);
    await expect(
      executeSystemAgentOperation(operation, runtime, {
        approved: true,
        deps: { createAgent },
      }),
    ).rejects.toThrow('Agent id "crestodian" is reserved'); // reserved retired id
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("requires approval before restarting gateway", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runGatewayRestart = vi.fn(async () => {});

    const result = await executeSystemAgentOperation({ kind: "gateway-restart" }, runtime, {
      deps: { runGatewayRestart, setupSurface: "gateway" },
    });

    expectRecordFields(result as unknown as Record<string, unknown>, {
      applied: false,
      message: "Plan: restart the Gateway. Say yes to apply.",
    });
    expect(lines.join("\n")).toContain("Plan: restart the Gateway");
    expect(runGatewayRestart).not.toHaveBeenCalled();
  });

  it("restarts its own Gateway despite hostile remote Gateway routing", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://another-gateway.example:9443");
    mockConfig.setConfig({
      gateway: {
        mode: "remote",
        remote: { url: "wss://configured-remote-gateway.example:9443" },
      },
    });

    const host = createGatewayHostLifecycle({
      processOwner: { ownsProcessLifecycle: true, supervisor: null },
      isCurrent: () => true,
      isServing: () => true,
      acceptStop: () => {},
    });
    await expect(host.capability.request("restart", () => {})).resolves.toEqual({
      ok: true,
      value: { outcome: "scheduled" },
    });
    await host.retire();

    expect(mockScheduleGatewayRestart).toHaveBeenCalledExactlyOnceWith({
      reason: "gateway.restart.safe",
      delayMs: 0,
    });
    expect(mockDaemonRestart).not.toHaveBeenCalled();
  });

  it("preserves the standalone CLI Gateway restart route", async () => {
    await runGatewayLifecycle("restart");

    expect(mockDaemonRestart).toHaveBeenCalledExactlyOnceWith();
    expect(mockScheduleGatewayRestart).not.toHaveBeenCalled();
  });

  it("records an approved standalone restart truthfully", async () => {
    const tempDir = opTempDirs.make("openclaw-restart-applied-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime } = createSystemAgentTestRuntime();
    const runGatewayRestart = vi.fn(async () => true);
    const result = await executeSystemAgentOperation({ kind: "gateway-restart" }, runtime, {
      approved: true,
      deps: { runGatewayRestart },
    });
    expect(result.applied).toBe(true);
    expect(runGatewayRestart).toHaveBeenCalledOnce();
    expectAuditRecord(
      readLastAuditEntry(),
      { operation: "gateway.restart", summary: "Restarted Gateway" },
      {},
    );
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
    const audit = readLastAuditEntry();
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

  it("records SQLite audit state despite a retired audit-directory symlink", async () => {
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
    expect(readLastAuditEntry()).toMatchObject({ operation: "config.set" });
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
    const audit = readLastAuditEntry();
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
    { kind: "config-set" as const, path: "agents.list[0].models.openai", value: "{}" },
    { kind: "config-set" as const, path: "agents.list[0].params.temperature", value: "0.5" },
    { kind: "config-set" as const, path: "agents.list[0].default", value: "true" },
    { kind: "config-set" as const, path: "agents.list[0].agentDir", value: '"/tmp/agent"' },
    { kind: "config-set" as const, path: "auth.order.anthropic", value: "[]" },
    { kind: "config-set" as const, path: "env.vars.ANTHROPIC_API_KEY", value: '"changed"' },
    { kind: "config-set" as const, path: '["env"]["vars"]["OPENAI_API_KEY"]', value: '"x"' },
    { kind: "config-set" as const, path: "secrets.defaults.env", value: '"changed"' },
    { kind: "config-set" as const, path: '["secrets"]["defaults"]["env"]', value: '"x"' },
    { kind: "config-set" as const, path: "plugins.load", value: "{}" },
    {
      kind: "config-set" as const,
      path: String.raw`mo\dels.providers.openai.apiKey`,
      value: '"x"',
    },
    { kind: "config-set" as const, path: "$include", value: '"./alternate.json5"' },
    { kind: "config-set" as const, path: '["$include"]', value: '"./alternate.json5"' },
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
      // Denylisted roots cite their documented escalation; route paths point
      // at the verified set_default_model/onboard flows.
    ).rejects.toThrow(/openclaw onboard|trusted shell/);

    expect(runConfigSet).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] running:");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  // Operator parity: surfaces the Control UI edits freely stay agent-writable
  // behind the exact-operation approval gate instead of a path ban.
  it.each([
    { kind: "config-set" as const, path: "tools.profile", value: '"full"' },
    { kind: "config-set" as const, path: '["tools"]["profile"]', value: '"full"' },
    { kind: "config-set" as const, path: "agents.defaults.tools.profile", value: '"full"' },
    { kind: "config-set" as const, path: "plugins.entries.codex.enabled", value: "false" },
    {
      kind: "config-set" as const,
      path: '["plugins"]["entries"]["openai"]["enabled"]',
      value: "false",
    },
  ])("allows approved operator-parity write $path", async (operation) => {
    const tempDir = opTempDirs.make("openclaw-parity-write-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime } = createSystemAgentTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    const result = await executeSystemAgentOperation(operation, runtime, {
      approved: true,
      deps: { runConfigSet },
    });

    expect(result.applied).toBe(true);
    expect(runConfigSet).toHaveBeenCalledOnce();
  });

  it("fails closed on plugin-entry writes when route ownership cannot be proven", async () => {
    // Same invariant as plugin_uninstall: without a readable config the entry
    // cannot be proven off the active inference route.
    mockConfig.missing("/tmp/openclaw.json");
    const { runtime } = createSystemAgentTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "plugins.entries.codex.enabled", value: "false" },
        runtime,
        { approved: true, deps: { runConfigSet } },
      ),
    ).rejects.toThrow("active inference route");
    expect(runConfigSet).not.toHaveBeenCalled();
  });

  it("still blocks per-agent routing writes that hit the system agent owner", async () => {
    const tempDir = opTempDirs.make("openclaw-default-agent-route-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    mockConfig.setConfig({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        list: [{ id: "main" }, { id: "helper" }],
      },
    });
    const { runtime } = createSystemAgentTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "agents.list[0].model", value: '"openai/gpt-5.5"' },
        runtime,
        { approved: true, deps: { runConfigSet } },
      ),
    ).rejects.toThrow("openclaw onboard");
    expect(runConfigSet).not.toHaveBeenCalled();

    // The same routing field on a non-default agent is an approved write.
    const result = await executeSystemAgentOperation(
      { kind: "config-set", path: "agents.list[1].model", value: '"openai/gpt-5.5"' },
      runtime,
      { approved: true, deps: { runConfigSet } },
    );
    expect(result.applied).toBe(true);
    expect(runConfigSet).toHaveBeenCalledOnce();
  });

  it("resolves numeric legacy list indices from the authored array order", async () => {
    const tempDir = opTempDirs.make("openclaw-numeric-agent-route-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    mockConfig.setResolvedConfig(
      {
        agents: {
          entries: {
            "2": {},
            "10": { default: true },
          },
        },
      },
      {
        agents: {
          list: [{ id: "10", default: true }, { id: "2" }],
        },
      },
    );
    const { runtime } = createSystemAgentTestRuntime();
    const runConfigSet = vi.fn(async () => {});

    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "agents.list[0].model", value: '"openai/gpt-5.5"' },
        runtime,
        { approved: true, deps: { runConfigSet } },
      ),
    ).rejects.toThrow("openclaw onboard");
    expect(runConfigSet).not.toHaveBeenCalled();

    const result = await executeSystemAgentOperation(
      { kind: "config-set", path: "agents.list[1].model", value: '"openai/gpt-5.5"' },
      runtime,
      { approved: true, deps: { runConfigSet } },
    );
    expect(result.applied).toBe(true);
    expect(runConfigSet).toHaveBeenCalledOnce();
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
    const beforePersistentApply = vi.fn();

    const plan = await executeSystemAgentOperation(
      { kind: "plugin-install", spec: "clawhub:openclaw-demo" },
      runtime,
    );
    expectRecordFields(plan as unknown as Record<string, unknown>, {
      applied: false,
      message: "Plan: install plugin clawhub:openclaw-demo. Say yes to apply.",
    });
    expect(runPluginInstallCommandMock).not.toHaveBeenCalled();

    const result = await executeSystemAgentOperation(
      { kind: "plugin-install", spec: "clawhub:openclaw-demo" },
      runtime,
      {
        approved: true,
        beforePersistentApply,
        auditDetails: { rescue: true },
      },
    );
    expect(result.applied).toBe(true);

    const [installParams] = requireFirstMockCall(
      runPluginInstallCommandMock,
      "runPluginInstallCommand",
    );
    const installRequest = requireRecord(installParams, "plugin install request");
    expectRecordFields(installRequest, {
      raw: "clawhub:openclaw-demo",
      opts: {},
      allowInstallPolicyWarningPrompt: false,
    });
    expect(typeof installRequest.beforePersistentApply).toBe("function");
    expect(beforePersistentApply).toHaveBeenCalledOnce();
    expectRuntimeArg(installRequest.runtime);
    expect(lines.join("\n")).toContain("[openclaw] done: plugin.install");
    const audit = readLastAuditEntry();
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
        { approved: true },
      ),
    ).rejects.toThrow("accepts npm or ClawHub package specs only");

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runPluginInstallCommandMock).not.toHaveBeenCalled();
    expect(mockConfig.readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("rejects arbitrary plugin sources before proposing or installing them", async () => {
    const { runtime } = createSystemAgentTestRuntime();

    // Untrusted spec must be rejected on the unapproved path too, so a
    // formatted "plan" never surfaces an arbitrary source for approval.
    await expect(
      executeSystemAgentOperation({ kind: "plugin-install", spec: "npm:@example/plugin" }, runtime),
    ).rejects.toThrow("trusted shell");
    expect(runPluginInstallCommandMock).not.toHaveBeenCalled();
  });

  it("uninstalls a non-route plugin only after approval and audits the write", async () => {
    const tempDir = opTempDirs.make("openclaw-plugin-uninstall-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runPluginUninstall = vi.fn(async (pluginId: string, pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log(`uninstalled ${pluginId}`);
    });

    const plan = await executeSystemAgentOperation(
      { kind: "plugin-uninstall", pluginId: "openclaw-demo" },
      runtime,
      { deps: { runPluginUninstall } },
    );
    expectRecordFields(plan as unknown as Record<string, unknown>, {
      applied: false,
      message: "Plan: uninstall plugin openclaw-demo. Say yes to apply.",
    });
    expect(runPluginUninstall).not.toHaveBeenCalled();

    const result = await executeSystemAgentOperation(
      { kind: "plugin-uninstall", pluginId: "openclaw-demo" },
      runtime,
      { approved: true, deps: { runPluginUninstall } },
    );
    expect(result.applied).toBe(true);
    const uninstallCall = requireFirstMockCall(runPluginUninstall, "runPluginUninstall");
    expect(uninstallCall[0]).toBe("openclaw-demo");
    expectRuntimeArg(uninstallCall[1]);
    expect(lines.join("\n")).toContain("[openclaw] done: plugin.uninstall");
    expect(lines.join("\n")).toContain("Restart the Gateway to apply plugin changes.");
  });

  it("refuses plugin uninstall when it cannot prove inference survives", async () => {
    // Fail closed: without a readable config the route cannot be proven safe.
    mockConfig.missing("/tmp/openclaw.json");
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
    expect(lines.join("\n")).toContain("could remove the provider behind");
    expect(lines.join("\n")).toContain("openclaw plugins uninstall openclaw-demo");
  });
});
