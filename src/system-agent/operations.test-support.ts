import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { captureEnv } from "../test-utils/env.js";
import { listSystemAgentAuditEntriesForTests } from "./audit.test-support.js";

type TestConfig = Record<string, unknown>;

const requireRecord = createRequireRecord("object", "label-not-object");

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function expectAuditRecord(
  audit: unknown,
  fields: Record<string, unknown>,
  detailFields: Record<string, unknown>,
) {
  const auditRecord = requireRecord(audit, "audit record");
  expectRecordFields(auditRecord, fields);
  expectRecordFields(requireRecord(auditRecord.details, "audit details"), detailFields);
}

export function readLastAuditEntry(): unknown {
  return listSystemAgentAuditEntriesForTests().at(-1)?.value;
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
const pluginLifecycleMocks = vi.hoisted(() => ({
  install: vi.fn(),
  uninstall: vi.fn(),
  planUninstall: vi.fn(),
  gateway: vi.fn(),
}));
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
vi.mock("../plugins/management-mutations.js", () => ({
  installManagedPlugin: pluginLifecycleMocks.install,
  uninstallManagedPlugin: pluginLifecycleMocks.uninstall,
  planManagedPluginUninstall: pluginLifecycleMocks.planUninstall,
}));
vi.mock("../cli/plugins-lifecycle-client.js", () => ({
  resolvePluginLifecycleGateway: pluginLifecycleMocks.gateway,
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
export const opTempDirs = useAutoCleanupTempDirTracker(afterEach);

export function useSystemAgentOperationsTestHarness() {
  let stateDirSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(() => {
    mockConfig.reset();
    mockDaemonRestart.mockClear();
    pluginLifecycleMocks.install.mockReset();
    pluginLifecycleMocks.uninstall.mockReset();
    pluginLifecycleMocks.planUninstall
      .mockReset()
      .mockImplementation(async ({ pluginId }: { pluginId: string }) => ({
        pluginId,
        pluginIds: [pluginId],
      }));
    pluginLifecycleMocks.gateway.mockReset().mockResolvedValue(null);
    mockScheduleGatewayRestart.mockClear();
    stateDirSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    stateDirSnapshot?.restore();
    vi.unstubAllEnvs();
  });
}

export { mockConfig, mockDaemonRestart, mockScheduleGatewayRestart, pluginLifecycleMocks };
