/**
 * Codex app-server agent harness registration and lazy runtime boundaries.
 */
import type {
  AgentHarness,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
  ContextEngineHostCapability,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  CodexAppServerListModelsOptions,
  CodexAppServerModel,
  CodexAppServerModelListResult,
} from "./src/app-server/models.js";
import type { CodexAppServerBindingStore } from "./src/app-server/session-binding.js";

const DEFAULT_CODEX_HARNESS_PROVIDER_IDS = new Set(["codex", "openai"]);
const SHARED_CODEX_APP_SERVER_CLIENT_DISPOSER = Symbol.for("openclaw.codexAppServerClientDisposer");
const CODEX_APP_SERVER_CONTEXT_ENGINE_HOST_CAPABILITIES = [
  "bootstrap",
  "assemble-before-prompt",
  "after-turn",
  "maintain",
  "compact",
  "runtime-llm-complete",
  "thread-bootstrap-projection",
] as const satisfies readonly ContextEngineHostCapability[];

/** Public model-listing types exposed for Codex app-server catalog callers. */
export type { CodexAppServerListModelsOptions, CodexAppServerModel, CodexAppServerModelListResult };

type CodexAppServerAgentHarness = AgentHarness & {
  compactAfterContextEngine?(
    params: AgentHarnessCompactParams,
  ): Promise<AgentHarnessCompactResult | undefined>;
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
export function createCodexAppServerAgentHarness(options: {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
  resolveConfig?: () => OpenClawConfig | undefined;
  bindingStore: CodexAppServerBindingStore;
}): AgentHarness {
  const harnessRuntimeId = options?.id ?? "codex";
  const normalizedHarnessRuntimeId = harnessRuntimeId.trim().toLowerCase();
  const providerIds = new Set(
    [...(options?.providerIds ?? DEFAULT_CODEX_HARNESS_PROVIDER_IDS)].map((id) =>
      id.trim().toLowerCase(),
    ),
  );
  const harness: CodexAppServerAgentHarness = {
    id: harnessRuntimeId,
    label: options?.label ?? "Codex agent harness",
    delegatedExecutionPluginIds: ["voice-call"],
    contextEngineHostCapabilities: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST_CAPABILITIES,
    deliveryDefaults: {
      sourceVisibleReplies: "message_tool",
    },
    authBootstrap: "harness",
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
        };
      }
      const preparedAuth = ctx.modelProvider?.preparedAuth;
      const runtimePolicy = ctx.modelProvider?.runtimePolicy;
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
      } else if (ctx.modelProvider && provider !== "codex") {
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
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
        nativeHookRelay: { enabled: true },
      });
    },
    runSideQuestion: async (params) => {
      const { runCodexAppServerSideQuestion } = await import("./src/app-server/side-question.js");
      return runCodexAppServerSideQuestion(params, {
        bindingStore: options.bindingStore,
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
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
    compactAfterContextEngine: async (params) => {
      const { maybeCompactCodexAppServerSession } = await import("./src/app-server/compact.js");
      return maybeCompactCodexAppServerSession(params, {
        bindingStore: options.bindingStore,
        pluginConfig: options?.resolvePluginConfig?.() ?? options?.pluginConfig,
        allowNonManualNativeRequest: true,
      });
    },
    reset: async (params) => {
      if (params.sessionId) {
        const { reclaimCurrentCodexSessionGeneration, sessionBindingIdentity } =
          await import("./src/app-server/session-binding.js");
        const identity = sessionBindingIdentity({
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        });
        let retired = await options.bindingStore.retireSessionGeneration(identity);
        if (retired === "conflict") {
          const reclaimed = await reclaimCurrentCodexSessionGeneration({
            bindingStore: options.bindingStore,
            identity,
            config: options.resolveConfig?.(),
          });
          if (reclaimed) {
            retired = await options.bindingStore.retireSessionGeneration(identity);
          }
        }
        if (retired === "conflict") {
          throw new Error(
            `Codex binding generation changed before session ${params.sessionId} could reset`,
          );
        }
      }
    },
    dispose: disposeSharedCodexAppServerClients,
  };
  return harness;
}
