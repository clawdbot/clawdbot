import path from "node:path";
import { vi } from "vitest";
import {
  getTestPluginRegistry,
  resetTestPluginRegistry,
  setTestPluginRegistry,
} from "./test-helpers.plugin-registry.js";
import {
  agentCommand,
  cronIsolatedRun,
  dispatchInboundMessageMock,
  embeddedRunMock,
  type GetReplyFromConfigFn,
  getReplyFromConfig,
  getGatewayTestHoistedState,
  mockGetReplyFromConfigOnce,
  piSdkMock,
  runBtwSideQuestion,
  sendWhatsAppMock,
  sessionStoreSaveDelayMs,
  setTestConfigRoot,
  testIsNixMode,
  testState,
  testTailnetIPv4,
  testTailscaleWhois,
  type RunBtwSideQuestionFn,
} from "./test-helpers.runtime-state.js";

export { getTestPluginRegistry, resetTestPluginRegistry, setTestPluginRegistry };
export {
  agentCommand,
  cronIsolatedRun,
  dispatchInboundMessageMock,
  embeddedRunMock,
  getReplyFromConfig,
  mockGetReplyFromConfigOnce,
  piSdkMock,
  runBtwSideQuestion,
  sendWhatsAppMock,
  sessionStoreSaveDelayMs,
  setTestConfigRoot,
  testIsNixMode,
  testState,
  testTailnetIPv4,
  testTailscaleWhois,
};

const gatewayTestHoisted = getGatewayTestHoistedState();

function createEmbeddedRunMockExports() {
  return {
    compactEmbeddedPiSession: (...args: unknown[]) =>
      embeddedRunMock.compactEmbeddedPiSession(...args),
    isEmbeddedPiRunActive: (sessionId: string) => embeddedRunMock.activeIds.has(sessionId),
    abortEmbeddedPiRun: (sessionId: string) => {
      embeddedRunMock.abortCalls.push(sessionId);
      return embeddedRunMock.activeIds.has(sessionId);
    },
    waitForEmbeddedPiRunEnd: async (sessionId: string) => {
      embeddedRunMock.waitCalls.push(sessionId);
      return embeddedRunMock.waitResults.get(sessionId) ?? true;
    },
  };
}

async function importEmbeddedRunMockModule<TModule extends object>(
  actualPath: string,
  opts?: { includeActiveCount?: boolean },
): Promise<TModule> {
  const actual = await vi.importActual<TModule>(actualPath);
  return {
    ...actual,
    ...createEmbeddedRunMockExports(),
    ...(opts?.includeActiveCount
      ? { getActiveEmbeddedRunCount: () => embeddedRunMock.activeIds.size }
      : {}),
  };
}

function createDispatchInboundMessageMockExports(
  actual: typeof import("../auto-reply/dispatch.js"),
): typeof import("../auto-reply/dispatch.js") {
  return {
    ...actual,
    dispatchInboundMessage: (...args: Parameters<typeof actual.dispatchInboundMessage>) => {
      const impl = gatewayTestHoisted.dispatchInboundMessage.getMockImplementation();
      return impl
        ? (gatewayTestHoisted.dispatchInboundMessage(...args) as ReturnType<
            typeof actual.dispatchInboundMessage
          >)
        : actual.dispatchInboundMessage(...args);
    },
  };
}

vi.mock("../agents/pi-model-discovery.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/pi-model-discovery.js")>(
    "../agents/pi-model-discovery.js",
  );

  const createActualRegistry = (...args: Parameters<typeof actual.discoverModels>) => {
    const modelsFile = path.join(args[1], "models.json");
    const Registry = actual.ModelRegistry as unknown as {
      create?: (
        authStorage: unknown,
        modelsFile: string,
      ) => {
        getAll: () => Array<{ provider?: string; id?: string }>;
        getAvailable: () => Array<{ provider?: string; id?: string }>;
        find: (provider: string, modelId: string) => unknown;
      };
      new (
        authStorage: unknown,
        modelsFile: string,
      ): {
        getAll: () => Array<{ provider?: string; id?: string }>;
        getAvailable: () => Array<{ provider?: string; id?: string }>;
        find: (provider: string, modelId: string) => unknown;
      };
    };
    if (typeof Registry.create === "function") {
      return Registry.create(args[0], modelsFile);
    }
    return new Registry(args[0], modelsFile);
  };

  class MockModelRegistry {
    private readonly actualRegistry?: ReturnType<typeof createActualRegistry>;

    constructor(authStorage: unknown, modelsFile: string) {
      if (!piSdkMock.enabled) {
        this.actualRegistry = createActualRegistry(authStorage as never, path.dirname(modelsFile));
      }
    }

    getAll() {
      if (!piSdkMock.enabled) {
        return this.actualRegistry?.getAll() ?? [];
      }
      piSdkMock.discoverCalls += 1;
      return piSdkMock.models as Array<{ provider?: string; id?: string }>;
    }

    getAvailable() {
      if (!piSdkMock.enabled) {
        return this.actualRegistry?.getAvailable() ?? [];
      }
      return piSdkMock.models as Array<{ provider?: string; id?: string }>;
    }

    find(provider: string, modelId: string) {
      if (!piSdkMock.enabled) {
        return this.actualRegistry?.find(provider, modelId);
      }
      return (piSdkMock.models as Array<{ provider?: string; id?: string }>).find(
        (model) => model.provider === provider && model.id === modelId,
      );
    }
  }

  return {
    ...actual,
    ModelRegistry: MockModelRegistry,
  };
});

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: (...args: unknown[]) =>
    (cronIsolatedRun as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => testTailnetIPv4.value,
  pickPrimaryTailnetIPv6: () => undefined,
}));

vi.mock("../infra/tailscale.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/tailscale.js")>("../infra/tailscale.js");
  return {
    ...actual,
    readTailscaleWhoisIdentity: async () => testTailscaleWhois.value,
  };
});

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    saveSessionStore: vi.fn(async (storePath: string, store: unknown) => {
      const delay = sessionStoreSaveDelayMs.value;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return actual.saveSessionStore(storePath, store as never);
    }),
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const { createGatewayConfigModuleMock } = await import("./test-helpers.config-runtime.js");
  return createGatewayConfigModuleMock(actual);
});

vi.mock("../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
  const configActual =
    await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const { createGatewayConfigModuleMock } = await import("./test-helpers.config-runtime.js");
  const configMock = createGatewayConfigModuleMock(configActual);
  const createConfigIO = vi.fn(() => ({
    ...actual.createConfigIO(),
    getRuntimeConfig: configMock.getRuntimeConfig,
    readConfigFileSnapshot: configMock.readConfigFileSnapshot,
    readConfigFileSnapshotWithPluginMetadata: configMock.readConfigFileSnapshotWithPluginMetadata,
    readConfigFileSnapshotForWrite: configMock.readConfigFileSnapshotForWrite,
    writeConfigFile: configMock.writeConfigFile,
  }));
  return {
    ...actual,
    createConfigIO,
    getRuntimeConfig: configMock.getRuntimeConfig,
    readConfigFileSnapshot: configMock.readConfigFileSnapshot,
    readConfigFileSnapshotWithPluginMetadata: configMock.readConfigFileSnapshotWithPluginMetadata,
    readConfigFileSnapshotForWrite: configMock.readConfigFileSnapshotForWrite,
    writeConfigFile: configMock.writeConfigFile,
  };
});

vi.mock("../agents/pi-embedded.js", async () => {
  return await importEmbeddedRunMockModule<typeof import("../agents/pi-embedded.js")>(
    "../agents/pi-embedded.js",
  );
});

vi.mock("/src/agents/pi-embedded.js", async () => {
  return await importEmbeddedRunMockModule<typeof import("../agents/pi-embedded.js")>(
    "../agents/pi-embedded.js",
  );
});

vi.mock("../agents/pi-embedded-runner/runs.js", async () => {
  return await importEmbeddedRunMockModule<typeof import("../agents/pi-embedded-runner/runs.js")>(
    "../agents/pi-embedded-runner/runs.js",
    { includeActiveCount: true },
  );
});

vi.mock("/src/agents/pi-embedded-runner/runs.js", async () => {
  return await importEmbeddedRunMockModule<typeof import("../agents/pi-embedded-runner/runs.js")>(
    "../agents/pi-embedded-runner/runs.js",
    { includeActiveCount: true },
  );
});

vi.mock("../commands/health.js", () => ({
  getHealthSnapshot: vi.fn().mockResolvedValue({ ok: true, stub: true }),
}));
vi.mock("../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommand,
  agentCommandFromIngress: agentCommand,
}));
vi.mock("../agents/btw.js", () => ({
  runBtwSideQuestion: (...args: Parameters<RunBtwSideQuestionFn>) =>
    gatewayTestHoisted.runBtwSideQuestion(...args),
}));
vi.mock("/src/agents/btw.js", () => ({
  runBtwSideQuestion: (...args: Parameters<RunBtwSideQuestionFn>) =>
    gatewayTestHoisted.runBtwSideQuestion(...args),
}));
vi.mock("../auto-reply/dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../auto-reply/dispatch.js")>(
    "../auto-reply/dispatch.js",
  );
  return createDispatchInboundMessageMockExports(actual);
});
vi.mock("/src/auto-reply/dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../auto-reply/dispatch.js")>(
    "../auto-reply/dispatch.js",
  );
  return createDispatchInboundMessageMockExports(actual);
});
vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    gatewayTestHoisted.getReplyFromConfig(...args),
}));

vi.mock("/src/auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    gatewayTestHoisted.getReplyFromConfig(...args),
}));
vi.mock("../auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    gatewayTestHoisted.getReplyFromConfig(...args),
}));
vi.mock("/src/auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    gatewayTestHoisted.getReplyFromConfig(...args),
}));
vi.mock("../cli/deps.js", async () => {
  const actual = await vi.importActual<typeof import("../cli/deps.js")>("../cli/deps.js");
  const base = actual.createDefaultDeps();
  return {
    ...actual,
    createDefaultDeps: () => ({
      ...base,
      sendMessageWhatsApp: (...args: unknown[]) =>
        (gatewayTestHoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
    }),
  };
});

vi.mock("../plugins/loader.js", async () => {
  const actual =
    await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
  return {
    ...actual,
    loadOpenClawPlugins: () => getTestPluginRegistry(),
  };
});
vi.mock("../plugins/runtime/runtime-web-channel-plugin.js", () => ({
  sendWebChannelMessage: (...args: unknown[]) =>
    (gatewayTestHoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
}));
vi.mock("/src/plugins/runtime/runtime-web-channel-plugin.js", () => ({
  sendWebChannelMessage: (...args: unknown[]) =>
    (gatewayTestHoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
}));

process.env.OPENCLAW_SKIP_CHANNELS = "1";
process.env.OPENCLAW_SKIP_CRON = "1";
