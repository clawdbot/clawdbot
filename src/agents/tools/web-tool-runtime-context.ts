import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveManifestContractOwnerPluginId } from "../../plugins/plugin-registry.js";
import { getActiveRuntimeWebToolsMetadata } from "../../secrets/runtime-web-tools-state.js";
import type {
  RuntimeWebFetchMetadata,
  RuntimeWebSearchMetadata,
} from "../../secrets/runtime-web-tools.types.js";
import { getActiveSecretsRuntimeSnapshot } from "../../secrets/runtime.js";

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
  return !resolveManifestContractOwnerPluginId({
    contract: resolveWebProviderContract(params.kind),
    value: params.providerSelectionId,
    origin: "bundled",
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
  const runtimeMetadata = (activeWebTools?.[params.kind] ?? params.capturedRuntimeMetadata) as
    | TMetadata
    | undefined;
  const config =
    params.lateBindRuntimeConfig === true
      ? (getActiveSecretsRuntimeSnapshot()?.config ?? params.capturedConfig)
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
