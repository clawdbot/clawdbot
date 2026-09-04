import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";

type ResolveModelAsync = (typeof import("./embedded-agent-runner/model.js"))["resolveModelAsync"];

const resolveModelAsyncDefault: ResolveModelAsync = async (...args) => {
  const { resolveModelAsync } = await import("./embedded-agent-runner/model.js");
  return await resolveModelAsync(...args);
};

type ImageCompressionPolicyDeps = {
  resolveModelAsync: ResolveModelAsync;
};

async function resolvePolicyWithHooks(params: {
  cfg?: OpenClawConfig;
  deps: ImageCompressionPolicyDeps;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  skipProviderRuntimeHooks: boolean;
}): Promise<ImageCompressionModelPolicy> {
  try {
    const resolved = await params.deps.resolveModelAsync(
      params.provider,
      params.model,
      params.agentDir,
      params.cfg,
      {
        allowBundledStaticCatalogFallback: true,
        skipProviderRuntimeHooks: params.skipProviderRuntimeHooks,
        skipAgentDiscovery: true,
        workspaceDir: params.workspaceDir,
        ...(params.preparedModelRuntime
          ? { preparedModelRuntime: params.preparedModelRuntime }
          : {}),
      },
    );
    // SAFETY: model resolution preserves provider runtime fields on its narrower Model result.
    return (resolved.model as ProviderRuntimeModel | undefined)?.mediaInput?.image ?? {};
  } catch {
    return {};
  }
}

/** Resolves the authoritative image limits for one selected provider/model. */
export async function resolveImageCompressionModelPolicy(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  deps?: Partial<ImageCompressionPolicyDeps>;
}): Promise<ImageCompressionModelPolicy> {
  const deps: ImageCompressionPolicyDeps = {
    resolveModelAsync: params.deps?.resolveModelAsync ?? resolveModelAsyncDefault,
  };
  const staticPolicy = await resolvePolicyWithHooks({
    ...params,
    deps,
    skipProviderRuntimeHooks: true,
  });
  if (typeof staticPolicy.maxSidePx === "number" || typeof staticPolicy.maxPixels === "number") {
    return staticPolicy;
  }
  // Catalog augmentation governs row discovery, not model normalization. Missing
  // limits still need the selected provider's hooks; explicit static values win.
  return {
    ...(await resolvePolicyWithHooks({
      ...params,
      deps,
      skipProviderRuntimeHooks: false,
    })),
    ...staticPolicy,
  };
}
