//#region packages/web-content-core/src/provider-runtime-shared.d.ts
type WebProviderConfigSource = {
  tools?: {
    web?: {
      search?: unknown;
      fetch?: unknown;
    };
  };
};
type RuntimeWebProviderMetadata = {
  providerConfigured?: string;
  selectedProvider?: string;
};
type ProviderWithCredential = {
  envVars: string[];
  authProviderId?: string;
  requiresCredential?: boolean;
};
type WebContentProcessEnv = Record<string, string | undefined>;
declare function resolveWebProviderConfig(cfg: WebProviderConfigSource | undefined, kind: "search" | "fetch"): Record<string, unknown> | undefined;
declare function readWebProviderEnvValue(envVars: string[], processEnv?: WebContentProcessEnv): string | undefined;
declare function providerRequiresCredential(provider: Pick<ProviderWithCredential, "requiresCredential">): boolean;
declare function hasWebProviderEntryCredential<TProvider extends ProviderWithCredential, TConfigSource extends WebProviderConfigSource, TConfig extends Record<string, unknown> | undefined>(params: {
  provider: TProvider;
  config: TConfigSource | undefined;
  toolConfig: TConfig;
  resolveRawValue: (params: {
    provider: TProvider;
    config: TConfigSource | undefined;
    toolConfig: TConfig;
  }) => unknown;
  resolveFallbackRawValue?: (params: {
    provider: TProvider;
    config: TConfigSource | undefined;
    toolConfig: TConfig;
  }) => unknown;
  resolveEnvValue: (params: {
    provider: TProvider;
    configuredEnvVarId?: string;
  }) => string | undefined;
  resolveProviderAuthValue?: (providerId: string) => boolean;
}): boolean;
declare function resolveWebProviderDefinition<TProvider extends {
  id: string;
}, TConfigSource extends WebProviderConfigSource, TConfig extends Record<string, unknown> | undefined, TRuntimeMetadata extends RuntimeWebProviderMetadata, TDefinition>(params: {
  config: TConfigSource | undefined;
  toolConfig: TConfig;
  runtimeMetadata: TRuntimeMetadata | undefined;
  sandboxed?: boolean;
  providerId?: string;
  providers: TProvider[];
  resolveEnabled: (params: {
    toolConfig: TConfig;
    sandboxed?: boolean;
  }) => boolean;
  resolveAutoProviderId: (params: {
    config: TConfigSource | undefined;
    toolConfig: TConfig;
    providers: TProvider[];
  }) => string;
  resolveFallbackProviderId?: (params: {
    config: TConfigSource | undefined;
    toolConfig: TConfig;
    providers: TProvider[];
    providerId: string;
  }) => string | undefined;
  createTool: (params: {
    provider: TProvider;
    config: TConfigSource | undefined;
    toolConfig: TConfig;
    runtimeMetadata: TRuntimeMetadata | undefined;
  }) => TDefinition | null;
}): {
  provider: TProvider;
  definition: TDefinition;
} | null;
//#endregion
export { WebProviderConfigSource, hasWebProviderEntryCredential, providerRequiresCredential, readWebProviderEnvValue, resolveWebProviderConfig, resolveWebProviderDefinition };