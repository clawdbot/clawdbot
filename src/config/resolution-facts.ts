import type { EnvSubstitutionWarning } from "./env-substitution.js";
import { coerceSecretRef, DEFAULT_SECRET_PROVIDER_ALIAS, type SecretRef } from "./types.secrets.js";

/** `null` means this value has not passed through authoritative config env substitution. */
export type ConfigResolutionFacts = ReadonlySet<string> | null;

const configResolutionFacts = new WeakMap<object, ReadonlySet<string>>();
type ConfigEnvSecretRefFact = Readonly<{
  ref: SecretRef;
  state: "pending" | "resolved";
}>;

const envSecretRefsByFacts = new WeakMap<
  ReadonlySet<string>,
  ReadonlyMap<string, ConfigEnvSecretRefFact>
>();

export function createConfigResolutionFacts(
  warnings: readonly EnvSubstitutionWarning[],
  pendingEnvSecretRefs: ReadonlyMap<string, string> = new Map(),
  envProvider: string | undefined = DEFAULT_SECRET_PROVIDER_ALIAS,
  resolvedEnvSecretRefs: ReadonlyMap<string, string> = new Map(),
): ReadonlySet<string> {
  const facts = new Set(warnings.map(({ configPath }) => configPath));
  const provider = envProvider?.trim() || DEFAULT_SECRET_PROVIDER_ALIAS;
  if (pendingEnvSecretRefs.size > 0 || resolvedEnvSecretRefs.size > 0) {
    const envSecretRefs = new Map<string, ConfigEnvSecretRefFact>();
    for (const [path, id] of pendingEnvSecretRefs) {
      envSecretRefs.set(path, {
        ref: { source: "env", provider, id },
        state: "pending",
      });
    }
    for (const [path, id] of resolvedEnvSecretRefs) {
      envSecretRefs.set(path, {
        ref: { source: "env", provider, id },
        state: "resolved",
      });
    }
    envSecretRefsByFacts.set(facts, envSecretRefs);
  }
  return facts;
}

export function setConfigResolutionFacts(target: unknown, facts: ConfigResolutionFacts): void {
  if (!target || typeof target !== "object") {
    return;
  }
  if (facts === null) {
    configResolutionFacts.delete(target);
    return;
  }
  configResolutionFacts.set(target, facts);
}

export function getConfigResolutionFacts(target: unknown): ConfigResolutionFacts {
  return target && typeof target === "object" ? (configResolutionFacts.get(target) ?? null) : null;
}

export function copyConfigResolutionFacts(source: unknown, target: unknown): void {
  setConfigResolutionFacts(target, getConfigResolutionFacts(source));
}

export function cloneConfigWithResolutionFacts<T>(value: T): T {
  const cloned = structuredClone(value);
  copyConfigResolutionFacts(value, cloned);
  return cloned;
}

export function copyConfigResolutionFactsExcept(
  source: unknown,
  target: unknown,
  paths: readonly string[],
): void {
  const facts = getConfigResolutionFacts(source);
  if (facts === null) {
    setConfigResolutionFacts(target, null);
    return;
  }
  const envSecretRefs = envSecretRefsByFacts.get(facts);
  if (
    paths.length === 0 ||
    !paths.some((path) => facts.has(path) || envSecretRefs?.has(path) === true)
  ) {
    setConfigResolutionFacts(target, facts);
    return;
  }
  const remaining = new Set(facts);
  paths.forEach((path) => remaining.delete(path));
  if (envSecretRefs) {
    const remainingEnvSecretRefs = new Map(envSecretRefs);
    paths.forEach((path) => remainingEnvSecretRefs.delete(path));
    if (remainingEnvSecretRefs.size > 0) {
      envSecretRefsByFacts.set(remaining, remainingEnvSecretRefs);
    }
  }
  setConfigResolutionFacts(target, remaining);
}

type SerializedConfigResolutionFacts = Readonly<{
  unresolvedPaths: readonly string[];
  envSecretRefs: readonly (readonly [string, ConfigEnvSecretRefFact])[];
}> | null;

/** Captures loader provenance as deterministic data for a prepared worker generation. */
export function serializeConfigResolutionFacts(target: unknown): SerializedConfigResolutionFacts {
  const facts = getConfigResolutionFacts(target);
  return facts === null
    ? null
    : {
        unresolvedPaths: [...facts].toSorted(),
        envSecretRefs: [...(envSecretRefsByFacts.get(facts) ?? [])].toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
      };
}

/** Restores known-empty facts too: absence would reparse decoded literals as references. */
export function restoreConfigResolutionFacts(
  target: unknown,
  data: SerializedConfigResolutionFacts,
): void {
  if (data === null) {
    setConfigResolutionFacts(target, null);
    return;
  }
  const facts = new Set(data.unresolvedPaths);
  if (data.envSecretRefs.length > 0) {
    envSecretRefsByFacts.set(facts, new Map(data.envSecretRefs));
  }
  setConfigResolutionFacts(target, facts);
}

export function hasUnresolvedConfigPath(target: unknown, path: string): boolean {
  return getConfigResolutionFacts(target)?.has(path) === true;
}

/** Returns only a still-pending reference recorded from the authored config source. */
export function getAuthoredConfigSecretRef(target: unknown, path: string): SecretRef | null {
  const facts = getConfigResolutionFacts(target);
  const fact = facts ? envSecretRefsByFacts.get(facts)?.get(path) : undefined;
  return fact?.state === "pending" ? fact.ref : null;
}

/** Returns the env source of a value that config substitution already materialized. */
export function getResolvedConfigEnvSecretRef(target: unknown, path: string): SecretRef | null {
  const facts = getConfigResolutionFacts(target);
  const fact = facts ? envSecretRefsByFacts.get(facts)?.get(path) : undefined;
  return fact?.state === "resolved" ? fact.ref : null;
}

/** Reads inline references from authored facts and structured references from their values. */
export function resolveConfigSecretRef(params: {
  config: unknown;
  path: string;
  value: unknown;
  defaults?: Parameters<typeof coerceSecretRef>[1];
}): SecretRef | null {
  return typeof params.value === "string" && getConfigResolutionFacts(params.config) !== null
    ? getAuthoredConfigSecretRef(params.config, params.path)
    : coerceSecretRef(params.value, params.defaults);
}

export function hasUnresolvedConfigPathInSubtree(target: unknown, path: string): boolean {
  const facts = getConfigResolutionFacts(target);
  if (facts === null) {
    return false;
  }
  for (const candidate of facts) {
    if (
      candidate === path ||
      candidate.startsWith(`${path}.`) ||
      candidate.startsWith(`${path}[`)
    ) {
      return true;
    }
  }
  return false;
}
