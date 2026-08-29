import type { EnvSubstitutionWarning } from "./env-substitution.js";
import { coerceSecretRef, DEFAULT_SECRET_PROVIDER_ALIAS, type SecretRef } from "./types.secrets.js";

/** `null` means this value has not passed through authoritative config env substitution. */
export type ConfigResolutionFacts = ReadonlySet<string> | null;

const configResolutionFacts = new WeakMap<object, ReadonlySet<string>>();
const authoredSecretRefsByFacts = new WeakMap<
  ReadonlySet<string>,
  ReadonlyMap<string, SecretRef>
>();

export function createConfigResolutionFacts(
  warnings: readonly EnvSubstitutionWarning[],
  pendingEnvSecretRefs: ReadonlyMap<string, string> = new Map(),
  envProvider: string | undefined = DEFAULT_SECRET_PROVIDER_ALIAS,
): ReadonlySet<string> {
  const facts = new Set(warnings.map(({ configPath }) => configPath));
  if (pendingEnvSecretRefs.size > 0) {
    const provider = envProvider?.trim() || DEFAULT_SECRET_PROVIDER_ALIAS;
    authoredSecretRefsByFacts.set(
      facts,
      new Map(
        [...pendingEnvSecretRefs].map(([path, id]) => [
          path,
          { source: "env", provider, id } satisfies SecretRef,
        ]),
      ),
    );
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
  const authoredSecretRefs = authoredSecretRefsByFacts.get(facts);
  if (
    paths.length === 0 ||
    !paths.some((path) => facts.has(path) || authoredSecretRefs?.has(path) === true)
  ) {
    setConfigResolutionFacts(target, facts);
    return;
  }
  const remaining = new Set(facts);
  paths.forEach((path) => remaining.delete(path));
  if (authoredSecretRefs) {
    const remainingAuthoredSecretRefs = new Map(authoredSecretRefs);
    paths.forEach((path) => remainingAuthoredSecretRefs.delete(path));
    if (remainingAuthoredSecretRefs.size > 0) {
      authoredSecretRefsByFacts.set(remaining, remainingAuthoredSecretRefs);
    }
  }
  setConfigResolutionFacts(target, remaining);
}

export function hasUnresolvedConfigPath(target: unknown, path: string): boolean {
  return getConfigResolutionFacts(target)?.has(path) === true;
}

/** Returns only a still-pending reference recorded from the authored config source. */
export function getAuthoredConfigSecretRef(target: unknown, path: string): SecretRef | null {
  const facts = getConfigResolutionFacts(target);
  return facts ? (authoredSecretRefsByFacts.get(facts)?.get(path) ?? null) : null;
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
