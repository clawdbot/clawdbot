import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import {
  prepareModelRuntimeSnapshot,
  type PreparedModelRuntimeSnapshot,
} from "../prepared-model-runtime.js";
import { resolveModelAsync } from "./model.js";

type ModelResolution = Awaited<ReturnType<typeof resolveModelAsync>>;

/** Resolves embedded-run models through discovery first, then the prepared static catalog. */
export async function resolveTieredModel(params: {
  provider: string;
  fallbackProvider?: string;
  modelId: string;
  agentDir: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  authProfileId?: string;
  authProfileMode?: AuthProfileCredential["type"] | "aws-sdk";
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  staticCatalogOwnsTransport?: boolean;
}): Promise<{ provider: string; resolution: ModelResolution }> {
  const providers =
    params.fallbackProvider && params.fallbackProvider !== params.provider
      ? [params.provider, params.fallbackProvider]
      : [params.provider];
  let firstResolution: ModelResolution | undefined;
  const resolveCandidates = async (options: Parameters<typeof resolveModelAsync>[4]) => {
    for (const provider of providers) {
      const resolution = await resolveModelAsync(
        provider,
        params.modelId,
        params.agentDir,
        params.config,
        options,
      );
      firstResolution ??= resolution;
      if (resolution.model) {
        return { provider, resolution };
      }
    }
    return undefined;
  };
  const firstTier = await resolveCandidates({
    skipAgentDiscovery: true,
    allowBundledStaticCatalogFallback: params.staticCatalogOwnsTransport,
    preferBundledStaticCatalogTransport: params.staticCatalogOwnsTransport,
    preparedModelRuntime: params.preparedModelRuntime,
    workspaceDir: params.workspaceDir,
    authProfileId: params.authProfileId,
    authProfileMode: params.authProfileMode,
  });
  if (firstTier) {
    return firstTier;
  }
  if (params.staticCatalogOwnsTransport) {
    return {
      provider: params.fallbackProvider ?? params.provider,
      resolution: firstResolution!,
    };
  }
  const config = params.config ?? {};
  const preparedModelRuntime =
    params.preparedModelRuntime ??
    (await prepareModelRuntimeSnapshot({
      config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    }));
  return (
    (await resolveCandidates({
      ...preparedModelRuntime.createStores(),
      workspaceDir: params.workspaceDir,
      authProfileId: params.authProfileId,
      authProfileMode: params.authProfileMode,
      allowBundledStaticCatalogFallback: true,
      preparedModelRuntime,
    })) ?? {
      provider: params.fallbackProvider ?? params.provider,
      resolution: firstResolution!,
    }
  );
}
