/**
 * Codex app-server agent harness registration and lazy runtime boundaries.
 */
import type {
  AgentHarnessV2,
  AgentHarnessNativeCompaction,
  ContextEngineHostCapability,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { runHostPreparedIsolatedCompletion } from "openclaw/plugin-sdk/simple-completion-runtime";
import { readCodexRuntimeModelId } from "./src/app-server/model-runtime.js";
import type { CodexAppServerBindingStore } from "./src/app-server/session-binding.js";
import type { CodexSessionCatalogControlFactory } from "./src/session-catalog-types.js";

// `codex` is legacy input only until Part 2 doctor migration rewrites stored refs.
// New runtime identity uses the `openai` provider.
const DEFAULT_CODEX_HARNESS_PROVIDER_IDS = new Set(["codex", "openai"]);
const SHARED_CODEX_APP_SERVER_CLIENT_DISPOSER = Symbol.for("openclaw.codexAppServerClientDisposer");
// Audited against @openai/codex 0.150.1 (rust-v0.150.1). These exact denies
// either have no Codex-native equivalent or are enforced by the harness. Keep
// the list positive and conservative: an omitted tool isolates the native surface.
const CODEX_TOOL_POLICY_SAFE_DENY_NAMES = [
  "web_fetch",
  "x_search",
  "memory_search",
  "memory_get",
  "dashboard",
  "canvas",
  "show_widget",
  "message",
  "heartbeat_respond",
  "automations",
  "gateway",
  "skill_workshop",
  "image_generate",
  "music_generate",
  "video_generate",
  "tts",
] as const;
const CODEX_APP_SERVER_CONTEXT_ENGINE_HOST_CAPABILITIES = [
  "bootstrap",
  "assemble-before-prompt",
  "after-turn",
  "maintain",
  "compact",
  "runtime-llm-complete",
  "thread-bootstrap-projection",
] as const satisfies readonly ContextEngineHostCapability[];

type CodexAppServerAgentHarnessOptions = {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
  resolveConfig?: () => OpenClawConfig | undefined;
  runtime?: PluginRuntime;
  bindingStore: CodexAppServerBindingStore;
  sessionCatalogControlFactory?: CodexSessionCatalogControlFactory;
};

async function disposeSharedCodexAppServerClients(): Promise<void> {
  const dispose = (
    globalThis as typeof globalThis & {
      [SHARED_CODEX_APP_SERVER_CLIENT_DISPOSER]?: () => Promise<void>;
    }
  )[SHARED_CODEX_APP_SERVER_CLIENT_DISPOSER];
  await dispose?.();
}

/**
 * Creates the Codex app-server harness used for attempts, side questions,
 * compaction, reset, and disposal.
 */
export function createCodexAppServerAgentHarness(
  options: CodexAppServerAgentHarnessOptions,
): AgentHarnessV2 {
  const harnessRuntimeId = options?.id ?? "codex";
  const normalizedHarnessRuntimeId = harnessRuntimeId.trim().toLowerCase();
  const providerIds = new Set(
    [...(options?.providerIds ?? DEFAULT_CODEX_HARNESS_PROVIDER_IDS)].map((id) =>
      id.trim().toLowerCase(),
    ),
  );
  const sessionCatalogControlFactory = options.sessionCatalogControlFactory;
  const sessionRuntime = options.runtime;
  let modelCatalog:
    | ReturnType<
        typeof import("./src/app-server/model-catalog.js").createCodexAppServerModelCatalog
      >
    | undefined;
  let disposed = false;
  const resolveAttemptPluginConfig = (config: OpenClawConfig | undefined) =>
    resolvePluginConfigObject(config, "codex") ??
    options.resolvePluginConfig?.() ??
    options.pluginConfig;
  const harness: AgentHarnessV2 = {
    id: harnessRuntimeId,
    label: options?.label ?? "Codex agent harness",
    autoSelection: { providerIds: [...providerIds] },
    cloudPlacement: {
      mode: "remote-exec",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v2"],
        consumesWorkerSlot: false,
      },
    },
    delegatedExecutionPluginIds: ["voice-call"],
    contextEngineHostCapabilities: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST_CAPABILITIES,
    conversationToolPolicySupport: "exact",
    conversationToolPolicySafeDenyTools: CODEX_TOOL_POLICY_SAFE_DENY_NAMES,
    deliveryDefaults: {
      visibleReplies: "message_tool",
    },
    authBootstrap: "harness",
    ...(sessionCatalogControlFactory && sessionRuntime
      ? {
          sessionFork: {
            upstreamKinds: ["codex-app-server"] as const,
            fork: async (params) => {
              const { forkCodexUpstreamSession } =
                await import("./src/app-server/upstream-session-fork.js");
              return await forkCodexUpstreamSession(params, {
                bindingStore: options.bindingStore,
                controlFactory: sessionCatalogControlFactory,
                harnessRuntimeId,
                resolveConfig: options.resolveConfig,
                runtime: sessionRuntime,
              });
            },
          },
        }
      : {}),
    authBinding: {
      fingerprint: async (params) => {
        const { fingerprintCodexAppServerAuthBinding } =
          await import("./src/app-server/auth-binding.js");
        return fingerprintCodexAppServerAuthBinding(params);
      },
    },
    runtimeArtifact: {
      validate: async (binding) => {
        const { validateCodexAppServerRuntimeArtifact } =
          await import("./src/app-server/runtime-artifact.js");
        return validateCodexAppServerRuntimeArtifact(binding);
      },
    },
    fetchUsageSnapshot: async (ctx) => {
      const { fetchCodexAppServerUsageSnapshot } = await import("./src/app-server/usage.js");
      return await fetchCodexAppServerUsageSnapshot(ctx, {
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
      });
    },
    loadModelCatalog: async (params) => {
      const { createCodexAppServerModelCatalog } =
        await import("./src/app-server/model-catalog.js");
      if (disposed) {
        return [];
      }
      modelCatalog ??= createCodexAppServerModelCatalog(harnessRuntimeId);
      return await modelCatalog.load(params, resolveAttemptPluginConfig(params.config));
    },
    readModelCatalogReadiness: (params) =>
      modelCatalog?.read(params, resolveAttemptPluginConfig(params.config)),
    loadMcpToolCatalog: async (params) => {
      const { loadCodexEffectiveMcpCatalog } =
        await import("./src/app-server/effective-mcp-catalog.js");
      return await loadCodexEffectiveMcpCatalog(params, { bindingStore: options.bindingStore });
    },
    supports: (ctx) => {
      const provider = ctx.provider.trim().toLowerCase();
      if (!providerIds.has(provider)) {
        return {
          supported: false,
          reason: `provider is not one of: ${[...providerIds].toSorted().join(", ")}`,
        };
      }
      if (ctx.modelProvider?.requestTransportOverrides === "present") {
        return {
          supported: false,
          reason: "Codex cannot reproduce authored request transport overrides",
          fallbackRuntime: "openclaw",
        };
      }
      const preparedAuth = ctx.modelProvider?.preparedAuth;
      const runtimePolicy = ctx.modelProvider?.runtimePolicy;
      // Codex owns discovery and auth for new first-party models. Only trust that
      // native account when no authored transport or host credential is involved.
      const nativeAccountOwnsUnobservedModel =
        provider === "openai" &&
        ctx.requestedRuntime === "codex" &&
        Boolean(ctx.modelId?.trim()) &&
        (preparedAuth === undefined || preparedAuth.source === "harness") &&
        preparedAuth?.mode === undefined &&
        preparedAuth?.requirement === undefined &&
        ctx.modelProvider?.api === undefined &&
        ctx.modelProvider?.baseUrl === undefined &&
        ctx.modelProvider?.azureApiVersion === undefined &&
        ctx.modelProvider?.request === undefined;
      if (runtimePolicy) {
        const compatible = runtimePolicy.compatibleIds.some(
          (id) => id.trim().toLowerCase() === normalizedHarnessRuntimeId,
        );
        if (!compatible) {
          return {
            supported: false,
            reason: "Codex cannot reproduce the prepared provider route",
          };
        }
      } else if (ctx.modelProvider && provider !== "codex" && !nativeAccountOwnsUnobservedModel) {
        return {
          supported: false,
          reason: "provider route compatibility with Codex is not declared",
        };
      }
      if (preparedAuth?.requirement === "subscription") {
        const reproducibleSubscription =
          preparedAuth.source === "profile" &&
          (preparedAuth.mode === "oauth" || preparedAuth.mode === "token");
        if (!reproducibleSubscription) {
          return {
            supported: false,
            reason: "Codex subscription auth requires a prepared OAuth or token profile",
          };
        }
      } else if (preparedAuth?.requirement === "api-key") {
        const reproducibleApiKey =
          preparedAuth.source !== "none" &&
          preparedAuth.source !== "harness" &&
          (preparedAuth.mode === "api-key" || preparedAuth.mode === "api_key");
        if (!reproducibleApiKey) {
          return {
            supported: false,
            reason: "Codex Platform auth requires a prepared API key",
          };
        }
      }
      return { supported: true, priority: 100 };
    },
    runAttempt: async (params) => {
      // Keep app-server runtime code behind lazy imports so plugin discovery and
      // cold provider catalog reads do not pull in the whole Codex runtime.
      const { runCodexAppServerAttempt } = await import("./src/app-server/run-attempt.js");
      return runCodexAppServerAttempt(params, {
        bindingStore: options.bindingStore,
        pluginConfig: resolveAttemptPluginConfig(params.config),
        runtime: sessionRuntime,
        runtimeModelId: readCodexRuntimeModelId(params.model, params.modelId),
        nativeHookRelay: { enabled: true },
      });
    },
    runIsolatedCompletionV2: async (params) => {
      if (params.authorization.owner === "host") {
        return runHostPreparedIsolatedCompletion(params);
      }
      const { runCodexIsolatedCompletion } =
        await import("./src/app-server/isolated-completion.js");
      return runCodexIsolatedCompletion(params, {
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
      });
    },
    runIsolatedCompletion: async (params) => {
      // Keep the deprecated V1 contract on its exact host-prepared transport.
      // V2 owns native Codex auth and zero-tool attestation above.
      return runHostPreparedIsolatedCompletion({
        ...params,
        authorization: {
          owner: "host",
          model: params.model,
          auth: params.auth,
          sourceAuthFingerprint: params.sourceAuthFingerprint,
        },
      });
    },
    finalizeSettledTurn: async (params) => {
      const { runCodexSettledTurnFinalization } =
        await import("./src/app-server/settled-turn-finalizer.js");
      return runCodexSettledTurnFinalization(params, {
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
      });
    },
    runSideQuestion: async (params) => {
      const { runCodexAppServerSideQuestion } = await import("./src/app-server/side-question.js");
      return runCodexAppServerSideQuestion(params, {
        bindingStore: options.bindingStore,
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
        runtime: sessionRuntime,
        runtimeModelId: readCodexRuntimeModelId(params.runtimeModel, params.model),
        nativeHookRelay: { enabled: true },
      });
    },
    compact: async (params) => {
      const { maybeCompactCodexAppServerSession } = await import("./src/app-server/compact.js");
      return maybeCompactCodexAppServerSession(params, {
        bindingStore: options.bindingStore,
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
      });
    },
    withSessionDeletion: async (params, run) => {
      const { withCodexAppServerSessionDeletion } =
        await import("./src/app-server/session-retirement.js");
      params.assertCurrent();
      return withCodexAppServerSessionDeletion(options.bindingStore, params, run);
    },
    reset: async (params) => {
      if (params.sessionId && params.reason !== "deleted") {
        const [
          { reclaimCurrentCodexSessionGeneration, sessionBindingIdentity },
          { retireCodexAppServerSessionGeneration },
        ] = await Promise.all([
          import("./src/app-server/session-binding.js"),
          import("./src/app-server/session-retirement.js"),
        ]);
        const identity = sessionBindingIdentity({
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        });
        const resetGeneration = () =>
          retireCodexAppServerSessionGeneration({
            bindingStore: options.bindingStore,
            identity,
            mode: "reset",
          });
        let reset = await resetGeneration();
        if (reset === "conflict") {
          const reclaimed = await reclaimCurrentCodexSessionGeneration({
            bindingStore: options.bindingStore,
            identity,
            config: options.resolveConfig?.(),
          });
          if (reclaimed) {
            reset = await resetGeneration();
          }
        }
        if (reset === "conflict") {
          throw new Error(
            `Codex binding generation changed before session ${params.sessionId} could reset`,
          );
        }
      }
    },
    dispose: async () => {
      disposed = true;
      modelCatalog?.dispose();
      await disposeSharedCodexAppServerClients();
    },
  };
  return harness;
}

/** Creates the private native-compaction bridge registered in host-owned capability state. */
export function createCodexAppServerNativeCompaction(
  options: Pick<
    CodexAppServerAgentHarnessOptions,
    "bindingStore" | "pluginConfig" | "resolvePluginConfig"
  >,
): AgentHarnessNativeCompaction {
  return async (params) => {
    const { maybeCompactCodexAppServerSession } = await import("./src/app-server/compact.js");
    return maybeCompactCodexAppServerSession(params, {
      bindingStore: options.bindingStore,
      pluginConfig: options.resolvePluginConfig?.() ?? options.pluginConfig,
      allowNonManualNativeRequest: true,
      nativeCompactionRequest: params.nativeCompactionRequest,
    });
  };
}
