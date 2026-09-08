// Gateway integration test module mocks.
// Centralizes Vitest mock wiring for agent, channel, plugin, and runtime seams.
import path from "node:path";
import { vi } from "vitest";
import { withReplyDispatcher } from "../auto-reply/dispatch-dispatcher.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  agentCommandMock,
  cronIsolatedRun,
  embeddedRunMock,
  type GetReplyFromConfigFn,
  getGatewayTestHoistedState,
  agentDiscoveryMock,
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
    isEmbeddedAgentRunInProgress: (sessionId: string) => embeddedRunMock.activeIds.has(sessionId),
    resolveEmbeddedAgentRunProgressState: (sessionId: string) =>
      embeddedRunMock.activeIds.has(sessionId) ? "running" : undefined,
    resolveEmbeddedAgentSessionProgressState: (sessionId: string) =>
      embeddedRunMock.activeIds.has(sessionId) ? "running" : undefined,
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
        embeddedRunMock.activeIds.delete(sessionId);
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
): Promise<TModule> {
  const actual = await vi.importActual<TModule>(actualPath);
  return {
    ...actual,
    ...createEmbeddedRunMockExports(),
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
    dispatchInboundMessageWithProjectedDispatcher: (
      ...args: Parameters<typeof actual.dispatchInboundMessageWithProjectedDispatcher>
    ) => {
      const impl = gatewayTestHoisted.dispatchInboundMessage.getMockImplementation();
      if (!impl) {
        return actual.dispatchInboundMessageWithProjectedDispatcher(...args);
      }
      const [params] = args;
      const { dispatcherOptions, ...dispatchParams } = params;
      const dispatcher = createReplyDispatcher(dispatcherOptions);
      // The override bypasses dispatchInboundMessage's dispatcher lifecycle ownership.
      return withReplyDispatcher({
        dispatcher,
        run: () =>
          gatewayTestHoisted.dispatchInboundMessage({
            ...dispatchParams,
            dispatcher,
          }) as ReturnType<typeof actual.dispatchInboundMessageWithProjectedDispatcher>,
      });
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
    readTailscaleWhoisIdentity: async (
      ip: string,
      _exec: unknown,
      opts?: { timeoutMs?: number; cacheTtlMs?: number; errorTtlMs?: number },
    ) => {
      testTailscaleWhois.calls.push({ ip, opts });
      return testTailscaleWhois.value;
    },
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  const { createGatewayConfigOverrides } = await import("./test-helpers.config-runtime.js");
  return Object.defineProperties(
    { ...actual },
    Object.getOwnPropertyDescriptors(createGatewayConfigOverrides(actual)),
  );
});

vi.mock("../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
  // The config facade re-exports IO; waiting for it here can deadlock a fresh module graph.
  const { createGatewayConfigOverrides } = await import("./test-helpers.config-runtime.js");
  const configMock = createGatewayConfigOverrides(actual);
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
  >("../agents/embedded-agent-runner/runs.js");
});

vi.mock("/src/agents/embedded-agent-runner/runs.js", async () => {
  return await importEmbeddedRunMockModule<
    typeof import("../agents/embedded-agent-runner/runs.js")
  >("../agents/embedded-agent-runner/runs.js");
});

vi.mock("../agents/embedded-agent-runner/active-run-projections.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../agents/embedded-agent-runner/active-run-projections.js")
  >()),
  getActiveEmbeddedRunCount: () => embeddedRunMock.activeIds.size,
}));

vi.mock("/src/agents/embedded-agent-runner/active-run-projections.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../agents/embedded-agent-runner/active-run-projections.js")
  >()),
  getActiveEmbeddedRunCount: () => embeddedRunMock.activeIds.size,
}));

vi.mock("./health/collector.js", () => ({
  collectGatewayHealthSnapshot: vi.fn().mockResolvedValue({ ok: true, stub: true }),
}));
vi.mock("../status/summary.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommand: agentCommandMock,
  agentCommandFromGatewayIngress: agentCommandMock,
  agentCommandFromIngress: agentCommandMock,
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
vi.mock("../auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    gatewayTestHoisted.getReplyFromConfig(...args),
  prewarmConfigDrivenReplyRuntime: vi.fn(async () => {}),
}));
vi.mock("/src/auto-reply/reply/get-reply-from-config.runtime.js", () => ({
  getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
    gatewayTestHoisted.getReplyFromConfig(...args),
  prewarmConfigDrivenReplyRuntime: vi.fn(async () => {}),
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
vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "1");
vi.stubEnv("OPENCLAW_SKIP_CRON", "1");
