import type { Mock } from "vitest";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type ResolveConfigPathMock = Mock<() => string>;

type StatusScanSharedMocks = {
  resolveConfigPath: ResolveConfigPathMock;
  hasPotentialConfiguredChannels: UnknownMock;
  readBestEffortConfig: UnknownMock;
  resolveCommandSecretRefsViaGateway: UnknownMock;
  getUpdateCheckResult: UnknownMock;
  getAgentLocalStatuses: UnknownMock;
  getStatusSummary: UnknownMock;
  getMemorySearchManager: UnknownMock;
  buildGatewayConnectionDetails: UnknownMock;
  resolveGatewayProbeTarget: UnknownMock;
  probeGateway: UnknownMock;
  resolveGatewayProbeAuthResolution: UnknownMock;
  ensurePluginRegistryLoaded: UnknownMock;
  buildPluginCompatibilityNotices: Mock<() => unknown[]>;
};

export function createStatusScanSharedMocks(configPathLabel: string): StatusScanSharedMocks {
  return {
    resolveConfigPath: vi.fn(() => `/tmp/openclaw-${configPathLabel}-missing-${process.pid}.json`),
    hasPotentialConfiguredChannels: vi.fn(),
    readBestEffortConfig: vi.fn(),
    resolveCommandSecretRefsViaGateway: vi.fn(),
    getUpdateCheckResult: vi.fn(),
    getAgentLocalStatuses: vi.fn(),
    getStatusSummary: vi.fn(),
    getMemorySearchManager: vi.fn(),
    buildGatewayConnectionDetails: vi.fn(),
    resolveGatewayProbeTarget: vi.fn(() => ({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    })),
    probeGateway: vi.fn(),
    resolveGatewayProbeAuthResolution: vi.fn(),
    ensurePluginRegistryLoaded: vi.fn(),
    buildPluginCompatibilityNotices: vi.fn(() => []),
  };
}

type StatusOsSummaryModuleMock = {
  resolveOsSummary: Mock<() => { label: string }>;
};

function createStatusOsSummaryModuleMock(): StatusOsSummaryModuleMock {
  return {
    resolveOsSummary: vi.fn(() => ({ label: "test-os" })),
  };
}

type StatusScanDepsRuntimeModuleMock = {
  getTailnetHostname: UnknownMock;
  getMemorySearchManager: StatusScanSharedMocks["getMemorySearchManager"];
};

function createStatusScanDepsRuntimeModuleMock(
  mocks: Pick<StatusScanSharedMocks, "getMemorySearchManager">,
): StatusScanDepsRuntimeModuleMock {
  return {
    getTailnetHostname: vi.fn(),
    getMemorySearchManager: mocks.getMemorySearchManager,
  };
}

type StatusGatewayProbeModuleMock = {
  pickGatewaySelfPresence: Mock<() => null>;
  resolveGatewayProbeAuthResolution: StatusScanSharedMocks["resolveGatewayProbeAuthResolution"];
};

function createStatusGatewayProbeModuleMock(
  mocks: Pick<StatusScanSharedMocks, "resolveGatewayProbeAuthResolution">,
): StatusGatewayProbeModuleMock {
  return {
    pickGatewaySelfPresence: vi.fn(() => null),
    resolveGatewayProbeAuthResolution: mocks.resolveGatewayProbeAuthResolution,
  };
}

type StatusGatewayCallModuleMock = {
  buildGatewayConnectionDetails: StatusScanSharedMocks["buildGatewayConnectionDetails"];
  callGateway?: unknown;
};

function createStatusGatewayCallModuleMock(
  mocks: Pick<StatusScanSharedMocks, "buildGatewayConnectionDetails"> & {
    callGateway?: unknown;
  },
): StatusGatewayCallModuleMock {
  return {
    buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
    ...(mocks.callGateway ? { callGateway: mocks.callGateway } : {}),
  };
}

function createStatusPluginRegistryModuleMock(
  mocks: Pick<StatusScanSharedMocks, "ensurePluginRegistryLoaded">,
): { ensurePluginRegistryLoaded: StatusScanSharedMocks["ensurePluginRegistryLoaded"] } {
  return {
    ensurePluginRegistryLoaded: mocks.ensurePluginRegistryLoaded,
  };
}

function createStatusPluginStatusModuleMock(
  mocks: Pick<StatusScanSharedMocks, "buildPluginCompatibilityNotices">,
): {
  buildPluginCompatibilityNotices: StatusScanSharedMocks["buildPluginCompatibilityNotices"];
  buildPluginCompatibilitySnapshotNotices: StatusScanSharedMocks["buildPluginCompatibilityNotices"];
} {
  return {
    buildPluginCompatibilityNotices: mocks.buildPluginCompatibilityNotices,
    buildPluginCompatibilitySnapshotNotices: mocks.buildPluginCompatibilityNotices,
  };
}

function createStatusUpdateModuleMock(mocks: Pick<StatusScanSharedMocks, "getUpdateCheckResult">): {
  getUpdateCheckResult: StatusScanSharedMocks["getUpdateCheckResult"];
} {
  return {
    getUpdateCheckResult: mocks.getUpdateCheckResult,
  };
}

function createStatusAgentLocalModuleMock(
  mocks: Pick<StatusScanSharedMocks, "getAgentLocalStatuses">,
): { getAgentLocalStatuses: StatusScanSharedMocks["getAgentLocalStatuses"] } {
  return {
    getAgentLocalStatuses: mocks.getAgentLocalStatuses,
  };
}

function createStatusSummaryModuleMock(mocks: Pick<StatusScanSharedMocks, "getStatusSummary">): {
  getStatusSummary: StatusScanSharedMocks["getStatusSummary"];
} {
  return {
    getStatusSummary: mocks.getStatusSummary,
  };
}

function createStatusExecModuleMock(): { runExec: UnknownMock } {
  return {
    runExec: vi.fn(),
  };
}

type StatusScanModuleTestMocks = StatusScanSharedMocks & {
  buildChannelsTable?: UnknownMock;
  callGateway?: UnknownMock;
  getStatusCommandSecretTargetIds?: UnknownMock;
  resolveMemorySearchConfig?: UnknownMock;
};

export async function loadStatusScanModuleForTest(
  mocks: StatusScanModuleTestMocks,
  options: {
    fastJson: true;
  },
): Promise<typeof import("./status.scan.fast-json.js")>;
export async function loadStatusScanModuleForTest(
  mocks: StatusScanModuleTestMocks,
  options?: {
    fastJson?: false;
  },
): Promise<typeof import("./status.scan.js")>;
export async function loadStatusScanModuleForTest(
  mocks: StatusScanModuleTestMocks,
  options: {
    fastJson?: boolean;
  } = {},
) {
  vi.resetModules();
  const getStatusCommandSecretTargetIds = mocks.getStatusCommandSecretTargetIds ?? vi.fn(() => []);
  const resolveMemorySearchConfig =
    mocks.resolveMemorySearchConfig ?? vi.fn(() => ({ store: { path: "/tmp/main.sqlite" } }));

  vi.doMock("../channels/config-presence.js", () => ({
    hasPotentialConfiguredChannels: mocks.hasPotentialConfiguredChannels,
  }));
  vi.doMock("../plugins/channel-plugin-ids.js", () => ({
    hasConfiguredChannelsForReadOnlyScope: (params: {
      config: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
      includePersistedAuthState?: boolean;
    }) =>
      Boolean(
        mocks.hasPotentialConfiguredChannels(
          params.config,
          params.env,
          params.includePersistedAuthState === undefined
            ? undefined
            : { includePersistedAuthState: params.includePersistedAuthState },
        ),
      ),
    listConfiguredChannelIdsForReadOnlyScope: (params: {
      config: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
      includePersistedAuthState?: boolean;
    }) =>
      mocks.hasPotentialConfiguredChannels(
        params.config,
        params.env,
        params.includePersistedAuthState === undefined
          ? undefined
          : { includePersistedAuthState: params.includePersistedAuthState },
      )
        ? ["mock-channel"]
        : [],
  }));

  vi.doMock("../config/io.js", () => ({
    readBestEffortConfig: mocks.readBestEffortConfig,
  }));
  vi.doMock("../config/config.js", () => ({
    readBestEffortConfig: mocks.readBestEffortConfig,
  }));
  vi.doMock("../cli/command-secret-targets.js", () => ({
    getStatusCommandSecretTargetIds,
  }));
  vi.doMock("../cli/command-config-resolution.js", () => ({
    resolveCommandConfigWithSecrets: mocks.resolveCommandSecretRefsViaGateway,
  }));
  vi.doMock("../agents/memory-search.js", () => ({
    resolveMemorySearchConfig,
  }));

  if (!options.fastJson) {
    vi.doMock("../cli/progress.js", () => ({
      withProgress: vi.fn(async (_opts, run) => await run({ setLabel: vi.fn(), tick: vi.fn() })),
    }));
    vi.doMock("./status-all/channels.js", () => ({
      buildChannelsTable: mocks.buildChannelsTable,
    }));
    vi.doMock("./status.scan.runtime.js", () => ({
      statusScanRuntime: {
        buildChannelsTable: mocks.buildChannelsTable,
        collectChannelStatusIssues: vi.fn(() => []),
      },
    }));
  }

  vi.doMock("../config/paths.js", async () => {
    const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
    return {
      ...actual,
      resolveConfigPath: mocks.resolveConfigPath,
    };
  });

  vi.doMock("../cli/command-secret-gateway.js", () => ({
    resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
  }));
  vi.doMock("./status.update.js", () => createStatusUpdateModuleMock(mocks));
  vi.doMock("./status.agent-local.js", () => createStatusAgentLocalModuleMock(mocks));
  vi.doMock("./status.summary.js", () => createStatusSummaryModuleMock(mocks));
  vi.doMock("../infra/os-summary.js", () => createStatusOsSummaryModuleMock());
  vi.doMock("./status.scan.deps.runtime.js", () => createStatusScanDepsRuntimeModuleMock(mocks));
  vi.doMock("../gateway/call.js", () => createStatusGatewayCallModuleMock(mocks));
  vi.doMock("../gateway/probe.js", () => ({
    probeGateway: mocks.probeGateway,
  }));
  vi.doMock("../gateway/probe-target.js", () => ({
    resolveGatewayProbeTarget: mocks.resolveGatewayProbeTarget,
  }));
  vi.doMock("./status.gateway-probe.js", () => createStatusGatewayProbeModuleMock(mocks));
  vi.doMock("../gateway/connection-details.js", () => ({
    buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
    buildGatewayConnectionDetailsWithResolvers: mocks.buildGatewayConnectionDetails,
  }));
  vi.doMock("../process/exec.js", () => createStatusExecModuleMock());
  vi.doMock("../cli/plugin-registry.js", () => createStatusPluginRegistryModuleMock(mocks));
  vi.doMock("../plugins/status.js", () => createStatusPluginStatusModuleMock(mocks));

  if (options.fastJson) {
    return await import("./status.scan.fast-json.js");
  }
  return await import("./status.scan.js");
}

export function createStatusScanConfig<T extends object = OpenClawConfig>(
  overrides: T = {} as T,
): OpenClawConfig & T {
  return {
    session: {},
    gateway: {},
    ...overrides,
  } as OpenClawConfig & T;
}

export function createStatusSummary(
  options: {
    linkChannel?: { linked: boolean };
    byAgent?: unknown[];
  } = {},
) {
  return {
    linkChannel: options.linkChannel,
    tasks: {
      total: 0,
      active: 0,
      terminal: 0,
      failures: 0,
      byStatus: {
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      },
      byRuntime: {
        subagent: 0,
        acp: 0,
        cli: 0,
        cron: 0,
      },
    },
    sessions: {
      count: 0,
      paths: [],
      defaults: {},
      recent: [],
      ...(Object.prototype.hasOwnProperty.call(options, "byAgent")
        ? { byAgent: options.byAgent ?? [] }
        : {}),
    },
  };
}

function createStatusUpdateResult() {
  return {
    installKind: "git",
    git: null,
    registry: null,
  };
}

function createStatusAgentLocalStatuses() {
  return {
    defaultId: "main",
    agents: [],
  };
}

function createStatusGatewayConnection() {
  return {
    url: "ws://127.0.0.1:18789",
    urlSource: "default",
  };
}

function createStatusGatewayProbeFailure() {
  return {
    ok: false,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: null,
    error: "timeout",
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  };
}

export function createStatusMemorySearchConfig(): OpenClawConfig {
  return createStatusScanConfig({
    agents: {
      defaults: {
        memorySearch: {
          provider: "local",
          local: { modelPath: "/tmp/model.gguf" },
          fallback: "none",
        },
      },
    },
  });
}

export function createStatusMemorySearchManager() {
  return {
    manager: {
      probeVectorAvailability: vi.fn(async () => true),
      status: vi.fn(() => ({ files: 0, chunks: 0, dirty: false })),
      close: vi.fn(async () => {}),
    },
  };
}

export function applyStatusScanDefaults(
  mocks: StatusScanSharedMocks,
  options: {
    hasConfiguredChannels?: boolean;
    sourceConfig?: OpenClawConfig;
    resolvedConfig?: OpenClawConfig;
    summary?: ReturnType<typeof createStatusSummary>;
    update?: ReturnType<typeof createStatusUpdateResult> | false;
    gatewayProbe?: ReturnType<typeof createStatusGatewayProbeFailure> | false;
    memoryManager?: ReturnType<typeof createStatusMemorySearchManager>;
  } = {},
) {
  const sourceConfig = options.sourceConfig ?? createStatusScanConfig();
  const resolvedConfig = options.resolvedConfig ?? sourceConfig;

  mocks.hasPotentialConfiguredChannels.mockReturnValue(options.hasConfiguredChannels ?? false);
  mocks.readBestEffortConfig.mockResolvedValue(sourceConfig);
  mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
    resolvedConfig,
    diagnostics: [],
  });
  mocks.getAgentLocalStatuses.mockResolvedValue(createStatusAgentLocalStatuses());
  mocks.getStatusSummary.mockResolvedValue(options.summary ?? createStatusSummary());
  mocks.buildGatewayConnectionDetails.mockReturnValue(createStatusGatewayConnection());
  mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
    auth: {},
    warning: undefined,
  });
  mocks.ensurePluginRegistryLoaded.mockImplementation(() => {});
  mocks.buildPluginCompatibilityNotices.mockReturnValue([]);

  if (options.update !== false) {
    mocks.getUpdateCheckResult.mockResolvedValue(options.update ?? createStatusUpdateResult());
  }

  if (options.gatewayProbe !== false) {
    mocks.probeGateway.mockResolvedValue(options.gatewayProbe ?? createStatusGatewayProbeFailure());
  }

  if (options.memoryManager) {
    mocks.getMemorySearchManager.mockResolvedValue(options.memoryManager);
  }
}

export async function withTemporaryEnv(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
) {
  const previousEntries = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previousEntries)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
