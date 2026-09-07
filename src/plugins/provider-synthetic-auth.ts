import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ProviderResolveSyntheticAuthContext,
  ProviderSyntheticAuthResult,
} from "./provider-external-auth.types.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";

type ScopeOptions = {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  preparationOwner?: object;
};
type PreparedResult = ProviderSyntheticAuthResult | null;
type Entry = {
  result?: PreparedResult;
  pending: Map<AbortSignal | undefined, Promise<PreparedResult>>;
};
type PrepareSyntheticAuth = NonNullable<ProviderPlugin["prepareSyntheticAuth"]>;

export type PreparedSyntheticAuthFact = Readonly<{
  providerRef: string;
  result: PreparedResult;
}>;
export type PreparedSyntheticAuthFacts = readonly PreparedSyntheticAuthFact[];

type Scope = {
  resolvers: WeakMap<PrepareSyntheticAuth, Map<string, Entry>>;
  restored?: ReadonlyMap<string, PreparedSyntheticAuthFact>;
};
const scopes = new WeakMap<object, WeakMap<object, Map<string | undefined, Scope>>>();
const restoredConfigs = new WeakSet<object>();

function scopeFor(config: object | undefined, options: ScopeOptions, create = false) {
  if (!config) {
    return undefined;
  }
  // Each capture owner has one fixed config; it must never reopen a closed worker scope.
  const owner = restoredConfigs.has(config) ? config : (options.preparationOwner ?? config);
  let environments = scopes.get(owner);
  if (!environments && create) {
    environments = new WeakMap();
    scopes.set(owner, environments);
  }
  const env = options.env ?? process.env;
  let workspaces = environments?.get(env);
  if (!workspaces && create) {
    workspaces = new Map();
    environments?.set(env, workspaces);
  }
  let scope = workspaces?.get(options.workspaceDir);
  if (!scope && create) {
    scope = { resolvers: new WeakMap() };
    workspaces?.set(options.workspaceDir, scope);
  }
  return scope;
}

/** Captured resolver outcomes are authoritative before a worker loads any provider implementation. */
export function readPreparedSyntheticAuthFact(
  context: ProviderResolveSyntheticAuthContext,
  options: ScopeOptions = {},
): PreparedSyntheticAuthFact | undefined {
  const scope = scopeFor(context.config, options);
  if (context.config && restoredConfigs.has(context.config) && !scope?.restored) {
    throw new Error("Prepared synthetic auth environment or workspace does not match");
  }
  return scope?.restored?.get(normalizeProviderId(context.provider));
}

/** Read-only workers receive a closed generation: missing facts never start external work. */
export function restorePreparedSyntheticAuthFacts(
  config: object,
  facts: PreparedSyntheticAuthFacts,
  options: ScopeOptions = {},
): void {
  const scope = scopeFor(config, options, true)!;
  restoredConfigs.add(config);
  scope.restored = new Map(facts.map((fact) => [normalizeProviderId(fact.providerRef), fact]));
}

export function resolveSyntheticAuthWithProvider(
  provider: ProviderPlugin,
  context: ProviderResolveSyntheticAuthContext,
  options: ScopeOptions = {},
): ProviderSyntheticAuthResult | undefined {
  const captured = readPreparedSyntheticAuthFact(context, options);
  if (captured) {
    return captured.result ?? undefined;
  }
  if (!provider.prepareSyntheticAuth) {
    return provider.resolveSyntheticAuth?.(context) ?? undefined;
  }
  const scope = scopeFor(context.config, options);
  if (scope?.restored) {
    throw new Error(`Prepared synthetic auth is missing for ${context.provider}`);
  }
  return (
    scope?.resolvers.get(provider.prepareSyntheticAuth)?.get(normalizeProviderId(context.provider))
      ?.result ?? undefined
  );
}

export async function prepareSyntheticAuthWithProvider(
  provider: ProviderPlugin,
  context: ProviderResolveSyntheticAuthContext,
  options: ScopeOptions & { signal?: AbortSignal } = {},
): Promise<ProviderSyntheticAuthResult | undefined> {
  options.signal?.throwIfAborted();
  const captured = readPreparedSyntheticAuthFact(context, options);
  if (captured) {
    return captured.result ?? undefined;
  }
  if (!provider.prepareSyntheticAuth) {
    return provider.resolveSyntheticAuth?.(context) ?? undefined;
  }
  const scope = scopeFor(context.config, options, true);
  if (scope?.restored) {
    throw new Error(`Prepared synthetic auth is missing for ${context.provider}`);
  }
  const ref = normalizeProviderId(context.provider);
  // Registry attribution wraps descriptors; the executable hook identifies the
  // implementation whose result belongs to this config/env/workspace scope.
  const prepare = provider.prepareSyntheticAuth;
  let entries = scope?.resolvers.get(prepare);
  if (!entries && scope) {
    entries = new Map();
    scope.resolvers.set(prepare, entries);
  }
  const current: Entry = entries?.get(ref) ?? { pending: new Map() };
  entries?.set(ref, current);
  let result = current.result;
  if (result === undefined) {
    // Completed facts are shared, but each in-flight probe belongs to its cancellation scope.
    let pending = current.pending.get(options.signal);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => {
          options.signal?.throwIfAborted();
          return prepare({ ...context, env: options.env, signal: options.signal });
        })
        .then((prepared) => {
          options.signal?.throwIfAborted();
          return (current.result = prepared ? Object.freeze({ ...prepared }) : null);
        })
        .finally(() => {
          current.pending.delete(options.signal);
        });
      current.pending.set(options.signal, pending);
    }
    result = await pending;
  }
  options.signal?.throwIfAborted();
  return result ?? undefined;
}
