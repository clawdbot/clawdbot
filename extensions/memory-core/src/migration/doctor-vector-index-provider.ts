import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createVectorIndexProviderDiagnostic,
  type InspectConfiguredProvider,
} from "./doctor-vector-index-provider-diagnostic.js";

// sqlite-runtime re-exports the agent-db/kysely graph; keep it lazy so doctor
// enumeration does not cold-load it with this closure.
const inspectConfiguredProvider: InspectConfiguredProvider = async (params) => {
  const [{ resolveAgentConfig }, foundation] = await Promise.all([
    import("openclaw/plugin-sdk/agent-runtime"),
    import("openclaw/plugin-sdk/memory-core-host-engine-foundation"),
  ]);
  let settings: ReturnType<typeof foundation.resolveMemorySearchConfig>;
  try {
    settings = foundation.resolveMemorySearchConfig(params.config, params.agentId);
  } catch (error) {
    return {
      provider: params.config.memory?.search?.provider ?? "openai",
      reason: formatErrorMessage(error),
    };
  }
  if (!settings || settings.provider === "none") {
    return null;
  }
  const [embeddings, providerState] = await Promise.all([
    import("../memory/embeddings.js"),
    import("../memory/manager-provider-state.js"),
  ]);
  try {
    const configuredAgentDir = resolveAgentConfig(params.config, params.agentId)?.agentDir?.trim();
    const result = await embeddings.createEmbeddingProvider({
      config: params.config,
      agentDir: configuredAgentDir
        ? foundation.resolveUserPath(configuredAgentDir, params.env)
        : path.dirname(params.agentDatabasePath),
      ...providerState.resolveMemoryPrimaryProviderRequest({ settings }),
    });
    await result.provider?.close?.();
    return result.provider
      ? null
      : {
          provider: settings.provider,
          reason: result.providerUnavailableReason ?? "provider did not initialize",
        };
  } catch (error) {
    return { provider: settings.provider, reason: formatErrorMessage(error) };
  }
};

export const vectorIndexProviderDiagnostic =
  createVectorIndexProviderDiagnostic(inspectConfiguredProvider);
