import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Memory Core plugin entrypoint registers its OpenClaw integration.
import {
  jsonResult,
  resolveSessionAgentIds,
  type MemoryPluginRuntime,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { configureMemoryCoreDreamingState } from "./src/dreaming-state.js";
import { registerShortTermPromotionDreaming } from "./src/dreaming.js";
import { buildMemoryFlushPlan } from "./src/flush-plan.js";
import {
  buildMemoryPromptSection,
  MEMORY_GET_TOOL_CONTRACT,
  MEMORY_SEARCH_TOOL_CONTRACT,
  resolveMemoryToolContext,
  type MemoryToolContract,
  type MemoryToolOptions,
} from "./src/memory-tool-contract.js";
import type { MemoryCoreAcquireLocalService } from "./src/memory/embedding-local-service.js";
import type { MemoryCoreRuntimeHost } from "./src/memory/runtime-host.js";
import { registerSessionBackfillGatewayMethods } from "./src/session-backfill-gateway.js";

type MemoryToolsModule = typeof import("./src/tools.js");
type StandingIntentToolModule = typeof import("./src/standing-intents-tool.js");

const loadMemoryToolsModule = createLazyRuntimeModule(() => import("./src/tools.js"));
const loadStandingIntentsModule = createLazyRuntimeModule(
  () => import("./src/standing-intents.js"),
);
const loadStandingIntentToolModule = createLazyRuntimeModule(
  () => import("./src/standing-intents-tool.js"),
);

const loadRuntimeProviderModule = createLazyRuntimeModule(
  () => import("./src/runtime-provider.js"),
);

function createLazyMemoryTool(params: {
  options: MemoryToolOptions;
  contract: MemoryToolContract;
  load: (module: MemoryToolsModule, options: MemoryToolOptions) => AnyAgentTool | null;
}): AnyAgentTool | null {
  const initialContext = resolveMemoryToolContext(params.options);
  if (!initialContext) {
    return null;
  }

  let toolPromise: Promise<AnyAgentTool | null> | undefined;
  const loadTool = async () => {
    toolPromise ??= loadMemoryToolsModule().then((module) => params.load(module, params.options));
    return await toolPromise;
  };

  return {
    label: params.contract.label,
    name: params.contract.name,
    description: params.contract.describe(initialContext.sources),
    parameters: params.contract.parameters,
    execute: async (toolCallId, toolParams, signal, onUpdate) => {
      const tool = await loadTool();
      if (!tool) {
        return jsonResult({
          disabled: true,
          unavailable: true,
          error: "memory search unavailable",
        });
      }
      return await tool.execute(toolCallId, toolParams, signal, onUpdate);
    },
  };
}

function createLazyMemorySearchTool(options: MemoryToolOptions): AnyAgentTool | null {
  return createLazyMemoryTool({
    options,
    contract: MEMORY_SEARCH_TOOL_CONTRACT,
    load: (module, loadOptions) => module.createMemorySearchTool(loadOptions),
  });
}

function createLazyMemoryGetTool(options: MemoryToolOptions): AnyAgentTool | null {
  return createLazyMemoryTool({
    options,
    contract: MEMORY_GET_TOOL_CONTRACT,
    load: (module, loadOptions) => module.createMemoryGetTool(loadOptions),
  });
}

function createLazyStandingIntentTool(
  ctx: OpenClawPluginToolContext,
  reportUnavailable: (reason: string) => void,
): AnyAgentTool | null {
  if (ctx.senderIsOwner !== true) {
    return null;
  }
  const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  const provider = ctx.messageChannel?.trim();
  const senderId = ctx.requesterSenderId?.trim();
  if (!cfg) {
    reportUnavailable("runtime config is unavailable for this turn");
    return null;
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIds({
    sessionKey: ctx.sessionKey,
    config: cfg,
    agentId: ctx.agentId,
  });
  let toolPromise: Promise<AnyAgentTool> | undefined;
  const loadTool = async (): Promise<AnyAgentTool> => {
    toolPromise ??= loadStandingIntentToolModule().then((module: StandingIntentToolModule) =>
      module.createStandingIntentTool({
        agentId,
        ...(ctx.sessionId ? { sourceSessionId: ctx.sessionId } : {}),
        ...(ctx.nativeChannelId ? { conversationId: ctx.nativeChannelId } : {}),
        ...(provider ? { provider } : {}),
        ...(ctx.agentAccountId ? { accountId: ctx.agentAccountId } : {}),
        ...(senderId ? { senderId } : {}),
      }),
    );
    return await toolPromise;
  };
  return {
    label: "Standing Intent",
    name: "intent",
    description:
      "Create, list, or explicitly cancel event-conditioned standing intents. A created intent is armed; the system injects the reminder automatically when it triggers. Do not deliver it early or cancel it unless the user asks. Use scheduled tasks for time-based reminders.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "cancel"] },
        id: { type: "string" },
        description: { type: "string" },
        triggerKeywords: { type: "array", items: { type: "string" } },
        scope: {
          type: "string",
          enum: ["conversation", "channel", "anywhere"],
          default: "channel",
        },
        senderScope: {
          type: "string",
          enum: ["sender", "anyone"],
          default: "sender",
        },
        expiresAt: { type: "string" },
        maxFires: { type: "integer", minimum: 1 },
        cooldownSeconds: { type: "integer", minimum: 0 },
        status: {
          type: "string",
          enum: ["pending", "armed", "fired", "done", "cancelled", "expired"],
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (toolCallId, params, signal, onUpdate) => {
      const tool = await loadTool();
      return await tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

function resolveMemoryToolOptions(
  ctx: OpenClawPluginToolContext,
  host: MemoryCoreRuntimeHost,
): MemoryToolOptions {
  const getConfig = ctx.getRuntimeConfig
    ? () => ctx.getRuntimeConfig?.()
    : () => ctx.runtimeConfig ?? ctx.config;
  return {
    config: getConfig(),
    getConfig,
    agentId: ctx.agentId,
    agentSessionKey: ctx.sessionKey,
    sandboxed: ctx.sandboxed,
    oneShotCliRun: ctx.oneShotCliRun,
    conversationRecall: ctx.conversationRecall,
    activeProjectKeys: ctx.activeProjectKeys,
    ...(host.acquireLocalService ? { acquireLocalService: host.acquireLocalService } : {}),
  };
}

function createLazyMemoryRuntime(host: MemoryCoreRuntimeHost): MemoryPluginRuntime {
  return {
    async getMemorySearchManager(params) {
      const { createMemoryRuntime } = await loadRuntimeProviderModule();
      return await createMemoryRuntime(host).getMemorySearchManager(params);
    },
    async authorizeSearchHits(params) {
      const { createMemoryRuntime } = await loadRuntimeProviderModule();
      const runtime = createMemoryRuntime(host);
      if (!runtime.authorizeSearchHits) {
        throw new Error("memory-core runtime search authorization is unavailable");
      }
      return await runtime.authorizeSearchHits(params);
    },
    async classifyWorkspaceMemoryPaths(params) {
      const [{ classifyWorkspaceMemoryPaths }, dreamingState] = await Promise.all([
        import("./src/workspace-path-classifier.js"),
        import("./src/dreaming-state.js"),
      ]);
      if (host.openKeyedStore) {
        dreamingState.configureMemoryCoreDreamingState(host.openKeyedStore);
      }
      return await classifyWorkspaceMemoryPaths(params);
    },
    resolveMemoryBackendConfig(params) {
      return resolveMemoryBackendConfig(params);
    },
    async closeAllMemorySearchManagers() {
      const { memoryRuntime: runtime } = await loadRuntimeProviderModule();
      await runtime.closeAllMemorySearchManagers?.();
    },
    async closeMemorySearchManager(params) {
      const { memoryRuntime: runtime } = await loadRuntimeProviderModule();
      await runtime.closeMemorySearchManager?.(params);
    },
  };
}

export default definePluginEntry({
  id: "memory-core",
  name: "OpenClaw Memory",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  register(api) {
    const acquireLocalService: MemoryCoreAcquireLocalService = (...args) =>
      api.runtime.llm.acquireLocalService(...args);
    const openKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      api.runtime.state.openKeyedStore<T>(options);
    const host = { acquireLocalService, openKeyedStore } satisfies MemoryCoreRuntimeHost;
    configureMemoryCoreDreamingState(openKeyedStore);
    const memoryRuntime = createLazyMemoryRuntime(host);
    registerShortTermPromotionDreaming(api);
    registerSessionBackfillGatewayMethods(api);
    api.registerMemoryCapability({
      deterministicRecallToolName: "memory_search",
      supportsPrivateTranscriptRecall: true,
      promptBuilder: (params) => {
        if (
          !params.availableTools.has("memory_search") &&
          !params.availableTools.has("memory_get")
        ) {
          return [];
        }
        const liveConfig = api.runtime.config?.current ? api.runtime.config.current() : api.config;
        const context = resolveMemoryToolContext({
          // SAFETY: Runtime config is host-validated and this resolver only reads the snapshot.
          config: liveConfig as OpenClawConfig,
          agentId: params.agentId,
          agentSessionKey: params.agentSessionKey,
        });
        return context ? buildMemoryPromptSection({ ...params, sources: context.sources }) : [];
      },
      flushPlanResolver: buildMemoryFlushPlan,
      runtime: memoryRuntime,
      publicArtifacts: {
        async listArtifacts(params) {
          const { listMemoryCorePublicArtifacts } = await import("./src/public-artifacts.js");
          return await listMemoryCorePublicArtifacts(params);
        },
      },
    });

    api.registerTool((ctx) => createLazyMemorySearchTool(resolveMemoryToolOptions(ctx, host)), {
      names: ["memory_search"],
    });

    api.registerTool((ctx) => createLazyMemoryGetTool(resolveMemoryToolOptions(ctx, host)), {
      names: ["memory_get"],
    });

    api.registerTool(
      (ctx) =>
        createLazyStandingIntentTool(ctx, (reason) => {
          api.logger.warn(`memory-core: intent tool unavailable: ${reason}`);
        }),
      { names: ["intent"] },
    );

    api.on("before_prompt_build", async (event, ctx) => {
      if (ctx.trigger !== "user") {
        return undefined;
      }
      try {
        const module = await loadStandingIntentsModule();
        if (!module.isEligibleStandingIntentTurn(ctx)) {
          return undefined;
        }
        const config = (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
        const { sessionAgentId: agentId } = resolveSessionAgentIds({
          sessionKey: ctx.sessionKey,
          config,
          agentId: ctx.agentId,
        });
        const intents = module.matchStandingIntents({
          agentId,
          prompt: event.prompt,
          ...((ctx.channelId ?? ctx.chatId)
            ? { channel: (ctx.channelId ?? ctx.chatId) as string }
            : {}),
          ...((ctx.channel ?? ctx.messageProvider)
            ? { provider: (ctx.channel ?? ctx.messageProvider) as string }
            : {}),
          ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
          ...(ctx.senderId ? { senderId: ctx.senderId } : {}),
        });
        const prependContext = module.buildStandingIntentContext(intents);
        return prependContext ? { prependContext } : undefined;
      } catch (error) {
        api.logger.warn?.(
          `memory-core: standing intent matching failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    });

    api.on(
      "before_agent_reply",
      async (_event, ctx) => {
        if (ctx.trigger !== "heartbeat" && ctx.trigger !== "cron") {
          return undefined;
        }
        try {
          const module = await loadStandingIntentsModule();
          const config = (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
          const { sessionAgentId: agentId } = resolveSessionAgentIds({
            sessionKey: ctx.sessionKey,
            config,
            agentId: ctx.agentId,
          });
          module.sweepStandingIntents({ agentId });
        } catch (error) {
          api.logger.warn?.(
            `memory-core: standing intent maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return undefined;
      },
      { eligibleTriggers: ["heartbeat", "cron"] },
    );

    api.registerCommand({
      name: "dreaming",
      description: "Enable or disable memory dreaming.",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        const { handleDreamingCommand } = await import("./src/dreaming-command.js");
        return await handleDreamingCommand(api, ctx);
      },
    });

    api.registerCli(
      async ({ program }) => {
        const { registerMemoryCli } = await import("./cli.js");
        registerMemoryCli(program, host);
      },
      {
        descriptors: [
          {
            name: "memory",
            description: "Search, inspect, and reindex memory files",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
