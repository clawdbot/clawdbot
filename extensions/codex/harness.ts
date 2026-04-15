import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import { maybeCompactCodexAppServerSession } from "./src/app-server/compact.js";
import { listCodexAppServerModels } from "./src/app-server/models.js";
import type {
  CodexAppServerListModelsOptions,
  CodexAppServerModel,
  CodexAppServerModelListResult,
} from "./src/app-server/models.js";
import { runCodexAppServerAttempt } from "./src/app-server/run-attempt.js";
import { clearCodexAppServerBinding } from "./src/app-server/session-binding.js";
import { clearSharedCodexAppServerClient } from "./src/app-server/shared-client.js";

const DEFAULT_CODEX_HARNESS_PROVIDER_IDS = new Set(["codex"]);

export type { CodexAppServerListModelsOptions, CodexAppServerModel, CodexAppServerModelListResult };
export { listCodexAppServerModels };

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
    runAttempt: (params) =>
      runCodexAppServerAttempt(params, { pluginConfig: options?.pluginConfig }),
    compact: (params) =>
      maybeCompactCodexAppServerSession(params, { pluginConfig: options?.pluginConfig }),
    reset: async (params) => {
      if (params.sessionFile) {
        await clearCodexAppServerBinding(params.sessionFile);
      }
    },
    dispose: () => {
      clearSharedCodexAppServerClient();
    },
  };
}
