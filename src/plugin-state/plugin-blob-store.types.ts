// Public plugin blob-store contracts. Stores are scoped by plugin id and namespace.
export type PluginBlobEntryInfo<TMetadata> = {
  key: string;
  metadata: TMetadata;
  sizeBytes: number;
  createdAt: number;
  expiresAt?: number;
};

export type PluginBlobEntry<TMetadata> = PluginBlobEntryInfo<TMetadata> & {
  bytes: Uint8Array;
};

export type PluginBlobStore<TMetadata> = {
  register(
    key: string,
    bytes: Uint8Array,
    metadata: TMetadata,
    opts?: { ttlMs?: number },
  ): Promise<void>;
  registerIfAbsent(
    key: string,
    bytes: Uint8Array,
    metadata: TMetadata,
    opts?: { ttlMs?: number },
  ): Promise<boolean>;
  lookup(key: string): Promise<PluginBlobEntry<TMetadata> | undefined>;
  entries(): Promise<PluginBlobEntryInfo<TMetadata>[]>;
  delete(key: string): Promise<boolean>;
  deleteExpiredKey(key: string): Promise<PluginBlobEntryInfo<TMetadata> | undefined>;
  deleteExpired(): Promise<PluginBlobEntryInfo<TMetadata>[]>;
  clear(): Promise<void>;
};

export type PluginBlobOverflowPolicy = "evict-oldest" | "reject-new";

export type OpenBlobStoreOptions = {
  namespace: string;
  maxEntries: number;
  maxBytesPerEntry: number;
  maxBytesPerNamespace: number;
  overflowPolicy?: PluginBlobOverflowPolicy;
  defaultTtlMs?: number;
};

export type PluginBlobStoreErrorCode =
  | "PLUGIN_BLOB_OPEN_FAILED"
  | "PLUGIN_BLOB_WRITE_FAILED"
  | "PLUGIN_BLOB_READ_FAILED"
  | "PLUGIN_BLOB_CORRUPT"
  | "PLUGIN_BLOB_LIMIT_EXCEEDED"
  | "PLUGIN_BLOB_INVALID_INPUT";

export type PluginBlobStoreOperation =
  | "open"
  | "register"
  | "lookup"
  | "delete"
  | "entries"
  | "clear"
  | "sweep";

export class PluginBlobStoreError extends Error {
  readonly code: PluginBlobStoreErrorCode;
  readonly operation: PluginBlobStoreOperation;
  readonly path?: string;

  constructor(
    message: string,
    options: {
      code: PluginBlobStoreErrorCode;
      operation: PluginBlobStoreOperation;
      path?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "PluginBlobStoreError";
    this.code = options.code;
    this.operation = options.operation;
    if (options.path) {
      this.path = options.path;
    }
  }
}
