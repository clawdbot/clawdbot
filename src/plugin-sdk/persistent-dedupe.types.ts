import type { FileLockOptions } from "./file-lock.js";

type PersistentDedupeBaseOptions = {
  /** Milliseconds a recorded key remains recent; `0` keeps keys until cache pruning. */
  ttlMs: number;
  /** Maximum process-local cache entries used before consulting SQLite. */
  memoryMaxSize: number;
  onDiskError?: (error: unknown) => void;
};

/** Configuration for a SQLite plugin-state dedupe namespace cache. */
export type PersistentDedupePluginStateOptions = PersistentDedupeBaseOptions & {
  /** Plugin id that owns the persisted dedupe namespace. */
  pluginId: string;
  /** Prefix for persisted plugin-state namespaces; defaults to `persistent-dedupe`. */
  namespacePrefix?: string;
  /** Maximum persisted entries retained per namespace. */
  stateMaxEntries: number;
  /** Test/runtime env used to resolve the shared OpenClaw state database. */
  env?: NodeJS.ProcessEnv;
  resolveFilePath?: undefined;
  fileMaxEntries?: undefined;
  lockOptions?: undefined;
};

/** Legacy path-shaped configuration. Paths now name SQLite namespaces, not JSON files. */
export type PersistentDedupeLegacyPathOptions = PersistentDedupeBaseOptions & {
  pluginId?: undefined;
  stateMaxEntries?: undefined;
  namespacePrefix?: undefined;
  /** Maximum persisted entries retained per legacy namespace. */
  fileMaxEntries: number;
  /** Maps a namespace to the retired JSON path; used only to derive a stable SQLite namespace. */
  resolveFilePath: (namespace: string) => string;
  /** Test/runtime env used to resolve the shared OpenClaw state database. */
  env?: NodeJS.ProcessEnv;
  /** @deprecated File locks are ignored because persistence is SQLite-backed. */
  lockOptions?: Partial<FileLockOptions>;
};

/** Configuration for a persisted dedupe namespace cache. */
export type PersistentDedupeOptions =
  | PersistentDedupePluginStateOptions
  | PersistentDedupeLegacyPathOptions;

/** Per-call options used when checking or recording a dedupe key. */
export type PersistentDedupeCheckOptions = {
  /** Logical bucket for the key; omitted/blank values use `global`. */
  namespace?: string;
  /** Test or replay timestamp override used for TTL checks and writes. */
  now?: number;
  /** Per-call disk error hook, overriding the helper-level hook. */
  onDiskError?: (error: unknown) => void;
};

/** Disk-backed dedupe guard that records recently seen keys per namespace. */
export type PersistentDedupe = {
  /** Returns true only when the key was not recently seen and was recorded for future checks. */
  checkAndRecord: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  /** Checks memory/disk recency without recording a new timestamp. */
  hasRecent: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  /** Removes a recorded key from process memory and persisted storage. */
  forget: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  /** Loads recent disk entries into memory for one namespace and returns the loaded count. */
  warmup: (namespace?: string, onError?: (error: unknown) => void) => Promise<number>;
  /** Clears only process-local memory; persisted namespace files are left intact. */
  clearMemory: () => void;
  /** Returns the current process-local cache size. */
  memorySize: () => number;
};

/** Claim attempt result for dedupe flows that need in-flight ownership. */
export type ClaimableDedupeClaimResult =
  | { kind: "claimed" }
  | { kind: "duplicate" }
  | { kind: "inflight"; pending: Promise<boolean> };

/** Options for a claimable dedupe guard, either persistent or memory-only. */
export type ClaimableDedupeOptions =
  | PersistentDedupePluginStateOptions
  | PersistentDedupeLegacyPathOptions
  | {
      ttlMs: number;
      memoryMaxSize: number;
      pluginId?: undefined;
      stateMaxEntries?: undefined;
      namespacePrefix?: undefined;
      env?: undefined;
      resolveFilePath?: undefined;
      fileMaxEntries?: undefined;
      lockOptions?: undefined;
      onDiskError?: undefined;
    };

/** Dedupe guard that lets one caller own a key while others wait or detect duplicates. */
export type ClaimableDedupe = {
  /** Starts ownership of a key, reports duplicates, or returns the active claim's pending result. */
  claim: (
    key: string,
    options?: PersistentDedupeCheckOptions,
  ) => Promise<ClaimableDedupeClaimResult>;
  /** Records a claimed key as handled and resolves any waiters with the recorded result. */
  commit: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  /** Releases an active claim without recording it, rejecting waiters with the supplied error. */
  release: (
    key: string,
    options?: {
      namespace?: string;
      error?: unknown;
    },
  ) => void;
  /** Checks whether the key is recent without claiming or committing it. */
  hasRecent: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  /** Removes an active or committed key from memory and persisted storage when supported. */
  forget?: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  /** Warms persistent storage into memory when configured; memory-only guards return zero. */
  warmup: (namespace?: string, onError?: (error: unknown) => void) => Promise<number>;
  /** Clears process-local caches and in-memory persistent state. */
  clearMemory: () => void;
  /** Returns the current process-local cache size. */
  memorySize: () => number;
};
