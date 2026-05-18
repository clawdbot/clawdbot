import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  CodexAppServerListModelsOptions,
  CodexAppServerModel,
  CodexAppServerModelListResult,
} from "./src/app-server/models.js";

const DEFAULT_CODEX_HARNESS_PROVIDER_IDS = new Set(["codex"]);

export type { CodexAppServerListModelsOptions, CodexAppServerModel, CodexAppServerModelListResult };

export function createCodexAppServerAgentHarness(options?: {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  pluginConfig?: unknown;
}): AgentHarness {
  const providerIds = new Set(
    [...(options?.providerIds ?? DEFAULT_CODEX_HARNESS_PROVIDER_IDS)].map((id) =>
      id.trim().toLowerCase(),
    ),
  );
  return {
    id: options?.id ?? "codex",
    label: options?.label ?? "Codex agent harness",
    deliveryDefaults: {
      sourceVisibleReplies: "message_tool",
    },
    supports: (ctx) => {
      const provider = ctx.provider.trim().toLowerCase();
      if (providerIds.has(provider)) {
        return { supported: true, priority: 100 };
      }
      return {
        supported: false,
        reason: `provider is not one of: ${[...providerIds].toSorted().join(", ")}`,
      };
    },
    runAttempt: async (params) => {
      const { runCodexAppServerAttempt } = await import("./src/app-server/run-attempt.js");
      return runCodexAppServerAttempt(params, {
        pluginConfig: options?.pluginConfig,
        nativeHookRelay: { enabled: true },
      });
    },
    runSideQuestion: async (params) => {
      const { runCodexAppServerSideQuestion } = await import("./src/app-server/side-question.js");
      return runCodexAppServerSideQuestion(params, {
        pluginConfig: options?.pluginConfig,
        nativeHookRelay: { enabled: true },
      });
    },
    compact: async (params) => {
      const { maybeCompactCodexAppServerSession } = await import("./src/app-server/compact.js");
      return maybeCompactCodexAppServerSession(params, { pluginConfig: options?.pluginConfig });
    },
    reset: async (params) => {
      if (params.sessionFile) {
        const { clearCodexAppServerBinding } = await import("./src/app-server/session-binding.js");
        await clearCodexAppServerBinding(params.sessionFile);
      }
    },
    dispose: async () => {
      const { clearSharedCodexAppServerClientAndWait } =
        await import("./src/app-server/shared-client.js");
      await clearSharedCodexAppServerClientAndWait();
    },
  };
}
