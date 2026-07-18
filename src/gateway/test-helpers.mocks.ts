// Gateway integration test module mocks.
// Centralizes Vitest mock wiring for agent, channel, plugin, and runtime seams.
import path from "node:path";
import { vi } from "vitest";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  agentCommand,
  cronIsolatedRun,
  embeddedRunMock,
  type GetReplyFromConfigFn,
  getGatewayTestHoistedState,
  agentDiscoveryMock,
  sessionStoreSaveDelayMs,
  testTailnetIPv4,
  testTailscaleWhois,
  type RunBtwSideQuestionFn,
} from "./test-helpers.runtime-state.js";

const gatewayTestHoisted = getGatewayTestHoistedState();

function createEmbeddedRunMockExports() {
  return {
    compactEmbeddedAgentSession: (...args: unknown[]) =>
      embeddedRunMock.compactEmbeddedAgentSession(...args),
    isEmbeddedAgentRunActive: (sessionId: string) => embeddedRunMock.activeIds.has(sessionId),
    abortEmbeddedAgentRun: (sessionId: string) => {
      embeddedRunMock.abortCalls.push(sessionId);
      return embeddedRunMock.activeIds.has(sessionId);
    },
    waitForEmbeddedAgentRunEnd: async (sessionId: string, timeoutMs?: number | null) => {
      if (timeoutMs === null) {
        embeddedRunMock.endWaitCalls.push(sessionId);
        return await new Promise<boolean>((resolve) => {
          embeddedRunMock.endWaiters.set(sessionId, resolve);
        });
      }
      embeddedRunMock.waitCalls.push(sessionId);
      const ended = embeddedRunMock.waitResults.get(sessionId) ?? true;
      if (ended) {
        embeddedRunMock.endWaiters.get(sessionId)?.(true);
      } else if (embeddedRunMock.resolveEndBeforeTimeoutIds.delete(sessionId)) {
        embeddedRunMock.endWaiters.get(sessionId)?.(true);
      }
      return ended;
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

vi.mock("../agents/agent-model-discovery.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-model-discovery.js")>(
    "../agents/agent-model-discovery.js",
  );
  const modelSessions = await vi.importActual<typeof import("../agents/sessions/index.js")>(
    "../agents/sessions/index.js",
  );

  const createActualRegistry = (...args: Parameters<typeof actual.discoverModels>) => {
    const modelsFile = path.join(args[1], "models.json");
    const Registry = modelSessions.ModelRegistry as unknown as {
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
      if (!agentDiscoveryMock.enabled) {
        this.actualRegistry = createActualRegistry(authStorage as never, path.dirname(modelsFile));
      }
    }

    getAll() {
      if (!agentDiscoveryMock.enabled) {
        return this.actualRegistry?.getAll() ?? [];
      }
      agentDiscoveryMock.discoverCalls += 1;
      return agentDiscoveryMock.models as Array<{ provider?: string; id?: string }>;
    }

    getAvailable() {
      if (!agentDiscoveryMock.enabled) {
        return this.actualRegistry?.getAvailable() ?? [];
      }
      return agentDiscoveryMock.models as Array<{ provider?: string; id?: string }>;
    }

    find(provider: string, modelId: string) {
      if (!agentDiscoveryMock.enabled) {
        return this.actualRegistry?.find(provider, modelId);
      }
      return (agentDiscoveryMock.models as Array<{ provider?: string; id?: string }>).find(
        (model) => model.provider === provider && model.id === modelId,
      );
    }
  }

  return {
    ...actual,
    discoverModels: (authStorage: Parameters<typeof actual.discoverModels>[0], agentDir: string) =>
      new MockModelRegistry(authStorage, path.join(agentDir, "models.json")),
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
        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });
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

vi.mock("../agents/embedded-agent.js", async () => {
  return await importEmbeddedRunMockModule<typeof import("../agents/embedded-agent.js")>(
    "../agents/embedded-agent.js",
  );
});

vi.mock("/src/agents/embedded-agent.js", async () => {
  return await importEmbeddedRunMockModule<typeof import("../agents/embedded-agent.js")>(
    "../agents/embedded-agent.js",
  );
});

vi.mock("../agents/embedded-agent-runner/runs.js", async () => {
  return await importEmbeddedRunMockModule<
    typeof import("../agents/embedded-agent-runner/runs.js")
  >("../agents/embedded-agent-runner/runs.js", { includeActiveCount: true });
});

vi.mock("/src/agents/embedded-agent-runner/runs.js", async () => {
  return await importEmbeddedRunMockModule<
    typeof import("../agents/embedded-agent-runner/runs.js")
  >("../agents/embedded-agent-runner/runs.js", { includeActiveCount: true });
});

vi.mock("../commands/health.js", () => ({
  getHealthSnapshot: vi.fn().mockResolvedValue({ ok: true, stub: true }),
}));
vi.mock("../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommand,
  agentCommandFromGatewayIngress: agentCommand,
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
process.env.OPENCLAW_SKIP_CHANNELS = "1";
process.env.OPENCLAW_SKIP_CRON = "1";
