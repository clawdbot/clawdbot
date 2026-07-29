import {
  expandEnvNormalizationKeys,
  normalizeZaiEnv,
  resolveEnvNormalizationKeys,
} from "../infra/env.js";
// Defines environment-variable config metadata and preservation rules.
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { containsEnvVarReference } from "./env-substitution.js";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "./future-version-guard.js";
import type { OpenClawConfig } from "./types.js";

function isBlockedConfigEnvVar(key: string): boolean {
  return (
    key.toUpperCase() === ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV ||
    key.toUpperCase() === "OPENCLAW_INCLUDE_ROOTS" ||
    isDangerousHostEnvVarName(key) ||
    isDangerousHostEnvOverrideVarName(key)
  );
}

/** Returns whether a config-controlled environment entry is safe to apply at runtime. */
export function isConfigRuntimeEnvVarAllowed(key: string, value: string): boolean {
  return Boolean(value.trim()) && !isBlockedConfigEnvVar(key) && !containsEnvVarReference(value);
}

function collectConfigEnvVarsByTarget(cfg?: OpenClawConfig): Record<string, string> {
  const envConfig = cfg?.env;
  if (!envConfig) {
    return {};
  }

  const entries: Record<string, string> = {};

  if (envConfig.vars) {
    for (const [rawKey, value] of Object.entries(envConfig.vars)) {
      if (typeof value !== "string" || !value.trim()) {
        continue;
      }
      const key = normalizeEnvVarKey(rawKey, { portable: true });
      if (!key) {
        continue;
      }
      if (!isConfigRuntimeEnvVarAllowed(key, value)) {
        continue;
      }
      entries[key] = value;
    }
  }

  for (const [rawKey, value] of Object.entries(envConfig)) {
    if (rawKey === "shellEnv" || rawKey === "vars") {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    if (!isConfigRuntimeEnvVarAllowed(key, value)) {
      continue;
    }
    entries[key] = value;
  }

  return entries;
}

function findCaseInsensitiveEnvKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (Object.hasOwn(env, key)) {
    return key;
  }
  const upperKey = key.toUpperCase();
  return Object.keys(env).find((candidate) => candidate.toUpperCase() === upperKey);
}

type EnvSnapshotEntry = {
  key: string;
  value: string | undefined;
};

function envSnapshotKey(key: string): string {
  return process.platform === "win32" ? key.toUpperCase() : key;
}

function snapshotEnvByPlatformKey(
  env: Readonly<Record<string, string | undefined>>,
): Map<string, EnvSnapshotEntry> {
  // Windows has one logical slot per case-insensitive key. Retain its exact spelling so
  // publication and rollback can compare-and-swap the slot without losing the original key.
  const snapshot = new Map<string, EnvSnapshotEntry>();
  for (const [key, value] of Object.entries(env)) {
    const platformKey = envSnapshotKey(key);
    if (!snapshot.has(platformKey)) {
      snapshot.set(platformKey, { key, value });
    }
  }
  return snapshot;
}

function envSnapshotEntriesEqual(
  left: EnvSnapshotEntry | undefined,
  right: EnvSnapshotEntry | undefined,
): boolean {
  return left?.key === right?.key && left?.value === right?.value;
}

function replaceEnvSnapshotEntry(
  env: NodeJS.ProcessEnv,
  current: EnvSnapshotEntry | undefined,
  next: EnvSnapshotEntry | undefined,
): void {
  if (current) {
    delete env[current.key];
  }
  if (next?.value !== undefined) {
    env[next.key] = next.value;
  }
}

export function cloneEnvWithPlatformSemantics(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cloned = { ...env } as NodeJS.ProcessEnv;
  if (process.platform !== "win32") {
    return cloned;
  }
  // A plain spread loses Windows process.env's case-insensitive lookup and assignment semantics.
  return new Proxy(cloned, {
    deleteProperty(target, property) {
      if (typeof property !== "string") {
        return Reflect.deleteProperty(target, property);
      }
      const key = findCaseInsensitiveEnvKey(target, property);
      return key ? Reflect.deleteProperty(target, key) : true;
    },
    get(target, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(target, property, receiver);
      }
      const key = findCaseInsensitiveEnvKey(target, property);
      return key ? target[key] : Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property !== "string") {
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
      const key = findCaseInsensitiveEnvKey(target, property);
      if (!key) {
        return undefined;
      }
      return {
        configurable: true,
        enumerable: true,
        value: target[key],
        writable: true,
      };
    },
    has(target, property) {
      return typeof property === "string"
        ? findCaseInsensitiveEnvKey(target, property) !== undefined
        : Reflect.has(target, property);
    },
    set(target, property, value) {
      if (typeof property !== "string") {
        return Reflect.set(target, property, value);
      }
      target[findCaseInsensitiveEnvKey(target, property) ?? property] = value as string | undefined;
      return true;
    },
  });
}

/** Collects config env vars safe to inject into runtime process environments. */
export function collectConfigRuntimeEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  return collectConfigEnvVarsByTarget(cfg);
}

/** Collects config env vars safe to persist into managed service environments. */
export function collectConfigServiceEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  // Runtime and service envs intentionally share filtering until a target-specific contract exists.
  return collectConfigEnvVarsByTarget(cfg);
}

/** Builds a cloned environment with config env vars applied without mutating the base env. */
export function createConfigRuntimeEnv(
  cfg: OpenClawConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = cloneEnvWithPlatformSemantics(baseEnv);
  applyConfigEnvVars(cfg, env);
  return env;
}

/** Config-owned runtime env staged for one acceptance transaction. */
export type ConfigRuntimeEnvPublication = (() => void) & {
  commit: () => void;
};

export type PreparedConfigRuntimeEnv = {
  env: NodeJS.ProcessEnv;
  publish: () => ConfigRuntimeEnvPublication;
};

type PublishedConfigRuntimeEnvState = {
  generation: number;
  ownedEnv: Readonly<Record<string, string>>;
  sourceConfig: OpenClawConfig | null;
};

type PublishedConfigRuntimeEnvChange = {
  before: EnvSnapshotEntry | undefined;
  after: EnvSnapshotEntry | undefined;
  preparedBefore: EnvSnapshotEntry | undefined;
};

type PendingConfigRuntimeEnvPublication = {
  epoch: number;
  previous: PendingConfigRuntimeEnvPublication | null;
  previousState: PublishedConfigRuntimeEnvState;
  changes: ReadonlyMap<string, PublishedConfigRuntimeEnvChange>;
  committed: boolean;
  rollbackRequested: boolean;
};

let publishedConfigRuntimeEnvState: PublishedConfigRuntimeEnvState = {
  generation: 0,
  ownedEnv: {},
  sourceConfig: null,
};
let publishedConfigRuntimeEnvEpoch = 0;
// Only uncommitted publications stay linked. Commit severs the chain so successful reloads
// cannot retain superseded rollback state, while overlapping failures can still unwind in order.
let pendingConfigRuntimeEnvPublication: PendingConfigRuntimeEnvPublication | null = null;

function applyPublishedConfigRuntimeEnvRollback(
  publication: PendingConfigRuntimeEnvPublication,
): void {
  for (const [key, change] of publication.changes) {
    const currentEntry = snapshotEnvByPlatformKey(process.env).get(key);
    if (!envSnapshotEntriesEqual(currentEntry, change.after)) {
      continue;
    }
    replaceEnvSnapshotEntry(process.env, currentEntry, change.before);
  }
  publishedConfigRuntimeEnvState = {
    generation: publishedConfigRuntimeEnvState.generation + 1,
    ownedEnv: publication.previousState.ownedEnv,
    sourceConfig: publication.previousState.sourceConfig,
  };
}

function isPendingConfigRuntimeEnvPublication(
  publication: PendingConfigRuntimeEnvPublication,
): boolean {
  let current = pendingConfigRuntimeEnvPublication;
  while (current) {
    if (current === publication) {
      return true;
    }
    current = current.previous;
  }
  return false;
}

function unwindRequestedConfigRuntimeEnvPublications(): void {
  while (pendingConfigRuntimeEnvPublication?.rollbackRequested) {
    const publication = pendingConfigRuntimeEnvPublication;
    applyPublishedConfigRuntimeEnvRollback(publication);
    const previous = publication.previous;
    if (!previous || previous.committed) {
      pendingConfigRuntimeEnvPublication = null;
      return;
    }
    pendingConfigRuntimeEnvPublication = previous;
  }
}

export function getPublishedConfigRuntimeEnvState(): PublishedConfigRuntimeEnvState {
  return publishedConfigRuntimeEnvState;
}

export function collectConfigRuntimeEnvOwnership(
  sourceConfig: OpenClawConfig,
  before: Readonly<Record<string, string | undefined>>,
  after: Readonly<Record<string, string | undefined>>,
  options: { replacedLowerPrecedenceKeys?: readonly string[] } = {},
): Record<string, string> {
  const ownedEnv: Record<string, string> = {};
  // Equal bytes cannot reveal that config replaced a lower-precedence layer.
  // Carry the apply-time replacement signal so later reloads can remove that owned value.
  const replacedLowerPrecedenceKeys = new Set(
    (options.replacedLowerPrecedenceKeys ?? []).map(envSnapshotKey),
  );
  for (const [key, value] of Object.entries(collectConfigRuntimeEnvVars(sourceConfig))) {
    for (const normalizedKey of resolveEnvNormalizationKeys(key)) {
      const afterKey = findCaseInsensitiveEnvKey(after, normalizedKey);
      if (!afterKey || after[afterKey] !== value) {
        continue;
      }
      const beforeKey = findCaseInsensitiveEnvKey(before, normalizedKey);
      if (
        beforeKey &&
        before[beforeKey] === value &&
        !replacedLowerPrecedenceKeys.has(envSnapshotKey(afterKey))
      ) {
        continue;
      }
      ownedEnv[afterKey] = value;
    }
  }
  return ownedEnv;
}

function filterConfigRuntimeEnvOwnership(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  ownedEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const allowedValues = new Map<string, Set<string>>();
  for (const [key, value] of Object.entries(collectConfigRuntimeEnvVars(sourceConfig))) {
    for (const normalizedKey of resolveEnvNormalizationKeys(key)) {
      const values = allowedValues.get(normalizedKey) ?? new Set<string>();
      values.add(value);
      allowedValues.set(normalizedKey, values);
    }
  }
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(ownedEnv)) {
    const normalizedKey = resolveEnvNormalizationKeys(key)[0] ?? key;
    const actualKey = findCaseInsensitiveEnvKey(env, key);
    if (actualKey && env[actualKey] === value && allowedValues.get(normalizedKey)?.has(value)) {
      filtered[actualKey] = value;
    }
  }
  return filtered;
}

export function initializePublishedConfigRuntimeEnv(
  sourceConfig: OpenClawConfig,
  options: {
    ownedEnv?: Readonly<Record<string, string>>;
    preserveExistingOwnership?: boolean;
  } = {},
): void {
  const ownedEnv = filterConfigRuntimeEnvOwnership(
    sourceConfig,
    process.env,
    options.preserveExistingOwnership
      ? { ...publishedConfigRuntimeEnvState.ownedEnv, ...options.ownedEnv }
      : (options.ownedEnv ?? {}),
  );
  publishedConfigRuntimeEnvState = {
    generation: publishedConfigRuntimeEnvState.generation + 1,
    ownedEnv,
    sourceConfig,
  };
  publishedConfigRuntimeEnvEpoch += 1;
  pendingConfigRuntimeEnvPublication = null;
}

export function resetPublishedConfigRuntimeEnv(): void {
  publishedConfigRuntimeEnvState = { generation: 0, ownedEnv: {}, sourceConfig: null };
  publishedConfigRuntimeEnvEpoch += 1;
  pendingConfigRuntimeEnvPublication = null;
}

/** Removes the active config-owned layer from an isolated read environment. */
export function createConfigRuntimeEnvBase(
  activeConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    ownedEnv?: Readonly<Record<string, string>>;
    preservedKeys?: ReadonlySet<string>;
  } = {},
): NodeJS.ProcessEnv {
  const isolated = cloneEnvWithPlatformSemantics(env);
  const ownedEnv = filterConfigRuntimeEnvOwnership(
    activeConfig,
    env,
    options.ownedEnv ?? (env === process.env ? publishedConfigRuntimeEnvState.ownedEnv : {}),
  );
  for (const [key, ownedValue] of Object.entries(ownedEnv)) {
    if (options.preservedKeys?.has(key.toUpperCase())) {
      continue;
    }
    if (isolated[key] === ownedValue) {
      delete isolated[key];
    }
  }
  return isolated;
}

/** Prepares a config-owned env layer without mutating the live process. */
export function prepareConfigRuntimeEnv(params: {
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  previousOwnedEnv?: Readonly<Record<string, string>>;
}): PreparedConfigRuntimeEnv {
  const targetEnv = params.env ?? process.env;
  const before = snapshotEnvByPlatformKey(targetEnv);
  const preparedEnv = createConfigRuntimeEnvBase(
    params.previousConfig,
    targetEnv,
    params.previousOwnedEnv ? { ownedEnv: params.previousOwnedEnv } : {},
  );
  const base = { ...preparedEnv } as Record<string, string | undefined>;
  applyConfigEnvVars(params.nextConfig, preparedEnv);
  const after = { ...preparedEnv } as Record<string, string | undefined>;
  const afterByPlatformKey = snapshotEnvByPlatformKey(after);
  const preparedOwnedEnv = collectConfigRuntimeEnvOwnership(params.nextConfig, base, after);

  return {
    env: preparedEnv,
    publish: () => {
      const processPublication = targetEnv === process.env;
      const previousPublishedState = publishedConfigRuntimeEnvState;
      const previousPublication = processPublication ? pendingConfigRuntimeEnvPublication : null;
      const published = new Map<string, PublishedConfigRuntimeEnvChange>();
      const keys = new Set([
        ...before.keys(),
        ...afterByPlatformKey.keys(),
        ...(previousPublication?.changes.keys() ?? []),
      ]);
      for (const key of keys) {
        const beforeEntry = before.get(key);
        const afterEntry = afterByPlatformKey.get(key);
        const currentEntry = snapshotEnvByPlatformKey(targetEnv).get(key);
        const previousChange = previousPublication?.changes.get(key);
        const continuesPreviousPublication =
          previousChange !== undefined &&
          envSnapshotEntriesEqual(currentEntry, previousChange.after) &&
          envSnapshotEntriesEqual(beforeEntry, previousChange.preparedBefore);
        const appliesToPreparedSnapshot =
          !envSnapshotEntriesEqual(beforeEntry, afterEntry) &&
          envSnapshotEntriesEqual(currentEntry, beforeEntry);
        if (!continuesPreviousPublication && !appliesToPreparedSnapshot) {
          continue;
        }
        published.set(key, {
          before: currentEntry,
          after: afterEntry,
          preparedBefore: beforeEntry,
        });
        if (!envSnapshotEntriesEqual(currentEntry, afterEntry)) {
          replaceEnvSnapshotEntry(targetEnv, currentEntry, afterEntry);
        }
      }
      const publicationGeneration = processPublication
        ? publishedConfigRuntimeEnvState.generation + 1
        : null;
      const publicationEpoch = publishedConfigRuntimeEnvEpoch;
      let processPublicationState: PendingConfigRuntimeEnvPublication | null = null;
      if (publicationGeneration !== null) {
        const ownedEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(preparedOwnedEnv)) {
          const platformKey = envSnapshotKey(key);
          const currentEntry = snapshotEnvByPlatformKey(targetEnv).get(platformKey);
          const preparedEntry = afterByPlatformKey.get(platformKey);
          const previousOwnedKey = findCaseInsensitiveEnvKey(previousPublishedState.ownedEnv, key);
          if (
            currentEntry?.value === value &&
            envSnapshotEntriesEqual(currentEntry, preparedEntry) &&
            (published.has(platformKey) ||
              (previousOwnedKey !== undefined &&
                previousPublishedState.ownedEnv[previousOwnedKey] === value))
          ) {
            ownedEnv[currentEntry.key] = value;
          }
        }
        publishedConfigRuntimeEnvState = {
          generation: publicationGeneration,
          ownedEnv,
          sourceConfig: params.nextConfig,
        };
        processPublicationState = {
          epoch: publicationEpoch,
          previous: previousPublication,
          previousState: previousPublishedState,
          changes: published,
          committed: false,
          rollbackRequested: false,
        };
        pendingConfigRuntimeEnvPublication = processPublicationState;
      }
      let active = true;
      const rollback = (() => {
        if (!active) {
          return;
        }
        active = false;
        if (processPublicationState) {
          if (processPublicationState.epoch !== publishedConfigRuntimeEnvEpoch) {
            return;
          }
          processPublicationState.rollbackRequested = true;
          if (!isPendingConfigRuntimeEnvPublication(processPublicationState)) {
            return;
          }
          unwindRequestedConfigRuntimeEnvPublications();
          return;
        }
        for (const [key, publication] of published) {
          const currentEntry = snapshotEnvByPlatformKey(targetEnv).get(key);
          if (!envSnapshotEntriesEqual(currentEntry, publication.after)) {
            continue;
          }
          replaceEnvSnapshotEntry(targetEnv, currentEntry, publication.before);
        }
      }) as ConfigRuntimeEnvPublication;
      rollback.commit = () => {
        if (!active) {
          return;
        }
        active = false;
        if (!processPublicationState) {
          return;
        }
        processPublicationState.committed = true;
        processPublicationState.rollbackRequested = false;
        processPublicationState.previous = null;
        if (pendingConfigRuntimeEnvPublication === processPublicationState) {
          pendingConfigRuntimeEnvPublication = null;
        }
      };
      return rollback;
    },
  };
}

/** Applies config env vars to an environment without overwriting existing non-empty values. */
export function applyConfigEnvVars(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    lowerPrecedenceEnv?: Readonly<Record<string, string>>;
    onLowerPrecedenceKeysReplaced?: (keys: readonly string[]) => void;
  } = {},
): void {
  const entries = collectConfigRuntimeEnvVars(cfg);
  const lowerPrecedenceEntries = Object.entries(options.lowerPrecedenceEnv ?? {});
  const normalizeKey = (key: string) => (process.platform === "win32" ? key.toUpperCase() : key);
  const lowerPrecedenceEnv = new Map(
    lowerPrecedenceEntries.map(([key, value]) => [normalizeKey(key), value]),
  );
  const configEnvKeys = expandEnvNormalizationKeys(Object.keys(entries));
  const configValuesByKey = new Map<string, Set<string>>();
  for (const [key, value] of Object.entries(entries)) {
    for (const normalizedKey of resolveEnvNormalizationKeys(key)) {
      const values = configValuesByKey.get(normalizedKey) ?? new Set<string>();
      values.add(value);
      configValuesByKey.set(normalizedKey, values);
    }
  }
  const higherPrecedenceValues = new Map<string, string>();
  for (const key of Object.keys(entries)) {
    const normalizedKeys = resolveEnvNormalizationKeys(key);
    const winningValue = normalizedKeys
      .map((normalizedKey) => [normalizedKey, env[normalizedKey]] as const)
      .find(
        ([normalizedKey, currentValue]) =>
          currentValue?.trim() &&
          lowerPrecedenceEnv.get(normalizedKey) !== currentValue &&
          !configValuesByKey.get(normalizedKey)?.has(currentValue),
      )?.[1];
    if (winningValue !== undefined) {
      for (const normalizedKey of normalizedKeys) {
        higherPrecedenceValues.set(normalizedKey, winningValue);
      }
    }
  }
  const replacedLowerPrecedenceKeys: string[] = [];
  for (const [key, value] of lowerPrecedenceEntries) {
    if (configEnvKeys.has(normalizeKey(key)) && env[key] === value) {
      delete env[key];
      replacedLowerPrecedenceKeys.push(key);
    }
  }
  if (replacedLowerPrecedenceKeys.length > 0) {
    options.onLowerPrecedenceKeysReplaced?.(replacedLowerPrecedenceKeys);
  }
  for (const [key, value] of Object.entries(entries)) {
    const higherPrecedenceValue = higherPrecedenceValues.get(normalizeKey(key));
    if (higherPrecedenceValue !== undefined) {
      env[key] = higherPrecedenceValue;
      continue;
    }
    const currentValue = env[key];
    if (currentValue?.trim() && lowerPrecedenceEnv.get(normalizeKey(key)) !== currentValue) {
      continue;
    }
    // Skip values containing unresolved ${VAR} references — applyConfigEnvVars runs
    // before env substitution, so these would pollute process.env with literal placeholders
    // (e.g. process.env.OPENCLAW_GATEWAY_TOKEN = "${VAULT_TOKEN}") which downstream auth
    // resolution would accept as valid credentials.
    if (containsEnvVarReference(value)) {
      continue;
    }
    env[key] = value;
  }
  normalizeZaiEnv(env);
}
