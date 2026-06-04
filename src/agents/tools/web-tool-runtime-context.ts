import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveManifestContractOwnerPluginId } from "../../plugins/plugin-registry.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { getActiveRuntimeWebToolsMetadata } from "../../secrets/runtime-web-tools-state.js";
import type {
  RuntimeWebFetchMetadata,
  RuntimeWebSearchMetadata,
} from "../../secrets/runtime-web-tools.types.js";

/**
 * Resolves late-bound runtime context for web fetch/search tools.
 *
 * Tools can capture config at construction time, but secret/provider setup may
 * change before execution; late binding reads the active runtime snapshots.
 */
type WebProviderKind = "fetch" | "search";

type WebProviderRuntimeMetadata = RuntimeWebFetchMetadata | RuntimeWebSearchMetadata;

type WebProviderContract = "webFetchProviders" | "webSearchProviders";

type ResolvedWebToolRuntimeContext<TMetadata extends WebProviderRuntimeMetadata> = {
  config?: OpenClawConfig;
  preferRuntimeProviders: boolean;
  runtimeMetadata?: TMetadata;
};

function resolveConfiguredWebProviderId(
  config: OpenClawConfig | undefined,
  kind: WebProviderKind,
): string {
  const provider = config?.tools?.web?.[kind]?.provider;
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

function resolveRuntimeWebProviderId(metadata: WebProviderRuntimeMetadata | undefined): string {
  return metadata?.selectedProvider ?? metadata?.providerConfigured ?? "";
}

function resolveWebProviderContract(kind: WebProviderKind): WebProviderContract {
  return kind === "fetch" ? "webFetchProviders" : "webSearchProviders";
}

function shouldPreferRuntimeProviders(params: {
  config?: OpenClawConfig;
  kind: WebProviderKind;
  providerSelectionId: string;
}): boolean {
  if (!params.providerSelectionId) {
    return true;
  }
  // Built-in providers are handled by core; plugin-owned selections should route through plugins.
  return !resolveManifestContractOwnerPluginId({
    contract: resolveWebProviderContract(params.kind),
    value: params.providerSelectionId,
    ...(params.kind === "fetch" ? { origin: "bundled" as const } : {}),
    config: params.config,
  });
}

function resolveWebToolRuntimeContext<TMetadata extends WebProviderRuntimeMetadata>(params: {
  capturedConfig?: OpenClawConfig;
  capturedRuntimeMetadata?: TMetadata;
  kind: WebProviderKind;
  lateBindRuntimeConfig?: boolean;
}): ResolvedWebToolRuntimeContext<TMetadata> {
  const activeWebTools =
    params.lateBindRuntimeConfig === true ? getActiveRuntimeWebToolsMetadata() : null;
  // Late-bound metadata wins over constructor-captured metadata for long-lived tool instances.
  const runtimeMetadata = (activeWebTools?.[params.kind] ?? params.capturedRuntimeMetadata) as
    | TMetadata
    | undefined;
  const config =
    params.lateBindRuntimeConfig === true
      ? (getActiveSecretsRuntimeConfigSnapshot()?.config ?? params.capturedConfig)
      : params.capturedConfig;
  const providerSelectionId =
    resolveRuntimeWebProviderId(runtimeMetadata) ||
    resolveConfiguredWebProviderId(config, params.kind);
  return {
    config,
    preferRuntimeProviders: shouldPreferRuntimeProviders({
      config,
      kind: params.kind,
      providerSelectionId,
    }),
    runtimeMetadata,
  };
}

/** Resolves runtime provider context for the web_search tool. */
export function resolveWebSearchToolRuntimeContext(params: {
  config?: OpenClawConfig;
  lateBindRuntimeConfig?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): ResolvedWebToolRuntimeContext<RuntimeWebSearchMetadata> & {
  runtimeWebSearch?: RuntimeWebSearchMetadata;
} {
  const resolved = resolveWebToolRuntimeContext({
    capturedConfig: params.config,
    capturedRuntimeMetadata: params.runtimeWebSearch,
    kind: "search",
    lateBindRuntimeConfig: params.lateBindRuntimeConfig,
  });
  return {
    config: resolved.config,
    preferRuntimeProviders: resolved.preferRuntimeProviders,
    runtimeMetadata: resolved.runtimeMetadata,
    runtimeWebSearch: resolved.runtimeMetadata,
  };
}

/** Resolves runtime provider context for the web_fetch tool. */
export function resolveWebFetchToolRuntimeContext(params: {
  config?: OpenClawConfig;
  lateBindRuntimeConfig?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
}): ResolvedWebToolRuntimeContext<RuntimeWebFetchMetadata> & {
  runtimeWebFetch?: RuntimeWebFetchMetadata;
} {
  const resolved = resolveWebToolRuntimeContext({
    capturedConfig: params.config,
    capturedRuntimeMetadata: params.runtimeWebFetch,
    kind: "fetch",
    lateBindRuntimeConfig: params.lateBindRuntimeConfig,
  });
  return {
    config: resolved.config,
    preferRuntimeProviders: resolved.preferRuntimeProviders,
    runtimeMetadata: resolved.runtimeMetadata,
    runtimeWebFetch: resolved.runtimeMetadata,
  };
}
