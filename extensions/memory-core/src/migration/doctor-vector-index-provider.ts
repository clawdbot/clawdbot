import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createVectorIndexProviderDiagnostic,
  type InspectConfiguredProvider,
  type InspectConfiguredProviderStartup,
} from "./doctor-vector-index-provider-diagnostic.js";

async function resolveConfiguredProviderOptions(params: Parameters<InspectConfiguredProvider>[0]) {
  const [{ resolveAgentConfig }, foundation] = await Promise.all([
    import("openclaw/plugin-sdk/agent-runtime"),
    import("openclaw/plugin-sdk/memory-core-host-engine-foundation"),
  ]);
  const settings = foundation.resolveMemorySearchConfig(params.config, params.agentId);
  if (!settings || settings.provider === "none") {
    return null;
  }
  const providerState = await import("../memory/manager-provider-state.js");
  const configuredAgentDir = resolveAgentConfig(params.config, params.agentId)?.agentDir?.trim();
  return {
    settings,
    options: {
      config: params.config,
      agentDir: configuredAgentDir
        ? foundation.resolveUserPath(configuredAgentDir, params.env)
        : path.dirname(params.agentDatabasePath),
      ...providerState.resolveMemoryPrimaryProviderRequest({ settings }),
    },
  };
}

const inspectConfiguredProvider: InspectConfiguredProvider = async (params) => {
  let resolved: Awaited<ReturnType<typeof resolveConfiguredProviderOptions>>;
  try {
    resolved = await resolveConfiguredProviderOptions(params);
  } catch (error) {
    return {
      provider: params.config.memory?.search?.provider ?? "openai",
      reason: formatErrorMessage(error),
    };
  }
  if (!resolved) {
    return null;
  }
  const embeddings = await import("../memory/embeddings.js");
  try {
    const result = await embeddings.createEmbeddingProvider(resolved.options);
    await result.provider?.close?.();
    return result.provider
      ? null
      : {
          provider: resolved.settings.provider,
          reason: result.providerUnavailableReason ?? "provider did not initialize",
        };
  } catch (error) {
    return { provider: resolved.settings.provider, reason: formatErrorMessage(error) };
  }
};

const inspectConfiguredProviderStartup: InspectConfiguredProviderStartup = async (params) => {
  let resolved: Awaited<ReturnType<typeof resolveConfiguredProviderOptions>>;
  try {
    resolved = await resolveConfiguredProviderOptions(params);
  } catch (error) {
    return { status: "indeterminate", reason: formatErrorMessage(error) };
  }
  if (!resolved) {
    return { status: "ready" };
  }
  const embeddings = await import("../memory/embeddings.js");
  return await embeddings.inspectEmbeddingProviderStartupPrerequisites(resolved.options);
};

export const vectorIndexProviderDiagnostic = createVectorIndexProviderDiagnostic(
  inspectConfiguredProvider,
  inspectConfiguredProviderStartup,
);
