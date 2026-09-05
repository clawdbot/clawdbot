// Outbound media helpers normalize plugin media attachments before channel delivery.
import { randomBytes } from "node:crypto";
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "../media/load-options.js";
import type { PluginStateKeyedStore } from "./plugin-state-runtime.js";
import { loadWebMedia } from "./web-media.js";

/** Media loading policy used before plugin media is handed to channel delivery. */
export type OutboundMediaLoadOptions = {
  /** Maximum allowed media payload size before the load is rejected. */
  maxBytes?: number;
  /** Whether callers may load remote URLs, local files, or both. */
  mediaAccess?: OutboundMediaAccess;
  /** Approved local roots for file/path media; `"any"` disables root restriction. */
  mediaLocalRoots?: readonly string[] | "any";
  /** Optional local file reader used by tests or plugin-specific filesystem adapters. */
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  /** Workspace root used when resolving relative local media paths. */
  workspaceDir?: string;
  /** Explicit proxy URL forwarded to shared outbound media loading policy. */
  proxyUrl?: string;
  /** Fetch implementation for remote media loads. */
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Extra fetch options merged into remote media requests. */
  requestInit?: RequestInit;
  /** Whether shared media loading may optimize image payloads. */
  optimizeImages?: boolean;
  /** Allows explicit proxy DNS behavior to be trusted by the media fetch guard. */
  trustExplicitProxyDns?: boolean;
};

/** Load outbound media from a remote URL or approved local path using the shared web-media policy. */
export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: OutboundMediaLoadOptions = {},
) {
  return await loadWebMedia(
    mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes: options.maxBytes,
      mediaAccess: options.mediaAccess,
      mediaLocalRoots: options.mediaLocalRoots,
      mediaReadFile: options.mediaReadFile,
      workspaceDir: options.workspaceDir,
      proxyUrl: options.proxyUrl,
      fetchImpl: options.fetchImpl,
      requestInit: options.requestInit,
      optimizeImages: options.optimizeImages,
      trustExplicitProxyDns: options.trustExplicitProxyDns,
    }),
  );
}

export type HostedOutboundMediaMetadata = {
  routePath: string;
  token: string;
  contentType?: string;
  fileName?: string;
  expiresAt: number;
  byteLength: number;
};

export type HostedOutboundMediaEntry = {
  metadata: HostedOutboundMediaMetadata;
  buffer: Buffer;
};

export type HostedOutboundMediaMetaRecord = HostedOutboundMediaMetadata & {
  id: string;
  chunkCount: number;
};

export type HostedOutboundMediaChunkRecord = {
  id: string;
  index: number;
  dataBase64: string;
};

/**
 * Capacity handling for hosted media.
 * `"evict-oldest"` is the compatibility default; `"reject-new"` preserves live issued URLs.
 */
export type HostedOutboundMediaOverflowPolicy = "evict-oldest" | "reject-new";

export type HostedOutboundMediaStore = {
  prepareUrl: (params: {
    mediaUrl: string;
    routePath: string;
    publicBaseUrl: string;
    maxBytes: number;
    /** Host-authorized local media access forwarded to the shared outbound loader. */
    mediaAccess?: OutboundMediaAccess;
    proxyUrl?: string;
    requestInit?: RequestInit;
    /** Validate the exact loaded bytes before capability creation or persistence. */
    validateBeforePersist?: (media: {
      buffer: Buffer;
      contentType?: string;
      fileName?: string;
    }) => void | Promise<void>;
  }) => Promise<string>;
  readMetadata: (id: string, nowMs?: number) => Promise<HostedOutboundMediaMetadata | null>;
  read: (id: string, nowMs?: number) => Promise<HostedOutboundMediaEntry | null>;
  delete: (id: string) => Promise<void>;
  cleanupExpired: (nowMs?: number) => Promise<void>;
  clear: () => Promise<void>;
};

export type CreateHostedOutboundMediaStoreOptions = {
  metadataStore: PluginStateKeyedStore<HostedOutboundMediaMetaRecord>;
  chunkStore: PluginStateKeyedStore<HostedOutboundMediaChunkRecord>;
  ttlMs: number;
  resolveExpiresAtMs: (ttlMs: number) => number | undefined;
  createId?: () => string;
  createToken?: () => string;
  rawChunkBytes?: number;
  maxEntries?: number;
  maxChunkRows?: number;
  /** Aggregate live payload budget. Omit only when the backing owner enforces an equivalent cap. */
  maxTotalBytes?: number;
  chunkRowsPerEntryBudget?: number;
  /** Physical retention after logical URL expiry, used to finish already-admitted readers. */
  postExpiryRetentionMs?: number;
  /**
   * Capacity action before storing a new entry. Defaults to `"evict-oldest"`.
   * With `"reject-new"`, configure both backing stores to reject overflow too.
   */
  overflowPolicy?: HostedOutboundMediaOverflowPolicy;
};

const DEFAULT_HOSTED_OUTBOUND_MEDIA_RAW_CHUNK_BYTES = 36 * 1024;
const DEFAULT_HOSTED_OUTBOUND_MEDIA_MAX_ENTRIES = 64;
const DEFAULT_HOSTED_OUTBOUND_MEDIA_CHUNK_ROWS_PER_ENTRY_BUDGET = 512;
const HOSTED_OUTBOUND_MEDIA_METADATA_TTL_GRACE_MS = 60_000;

function createHostedOutboundMediaId(): string {
  return randomBytes(12).toString("hex");
}

function createHostedOutboundMediaToken(): string {
  return randomBytes(24).toString("hex");
}

function buildHostedOutboundMediaMetaKey(id: string): string {
  return `media:${id}:meta`;
}

function buildHostedOutboundMediaChunkKey(id: string, index: number): string {
  return `media:${id}:chunk:${String(index).padStart(4, "0")}`;
}

function parseHostedOutboundMediaMetaKey(key: string): string | undefined {
  const prefix = "media:";
  const suffix = ":meta";
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) {
    return undefined;
  }
  const id = key.slice(prefix.length, -suffix.length);
  return id || undefined;
}

function isFutureHostedOutboundMediaExpiry(expiresAt: unknown, nowMs: number): expiresAt is number {
  return typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > nowMs;
}

function isRetainedHostedOutboundMediaExpiry(
  expiresAt: unknown,
  nowMs: number,
  postExpiryRetentionMs: number,
): expiresAt is number {
  return (
    typeof expiresAt === "number" &&
    Number.isSafeInteger(expiresAt) &&
    (expiresAt > nowMs || nowMs - expiresAt < postExpiryRetentionMs)
  );
}

function createHostedOutboundMediaMetaRecord(params: {
  id: string;
  routePath: string;
  token: string;
  contentType?: string;
  fileName?: string;
  expiresAt: number;
  chunkCount: number;
  byteLength: number;
}): HostedOutboundMediaMetaRecord {
  return {
    id: params.id,
    routePath: params.routePath,
    token: params.token,
    ...(params.contentType ? { contentType: params.contentType } : {}),
    ...(params.fileName ? { fileName: params.fileName } : {}),
    expiresAt: params.expiresAt,
    chunkCount: params.chunkCount,
    byteLength: params.byteLength,
  };
}

function createHostedOutboundMediaMetadata(
  meta: HostedOutboundMediaMetaRecord,
): HostedOutboundMediaMetadata {
  return {
    routePath: meta.routePath,
    token: meta.token,
    ...(meta.contentType ? { contentType: meta.contentType } : {}),
    ...(meta.fileName ? { fileName: meta.fileName } : {}),
    expiresAt: meta.expiresAt,
    byteLength: meta.byteLength,
  };
}

async function deleteHostedOutboundMediaRows(
  id: string,
  metadataStore: PluginStateKeyedStore<HostedOutboundMediaMetaRecord>,
  chunkStore: PluginStateKeyedStore<HostedOutboundMediaChunkRecord>,
  knownChunkCount?: number,
): Promise<void> {
  const metaKey = buildHostedOutboundMediaMetaKey(id);
  const meta = await metadataStore.lookup(metaKey);
  const chunkCount = meta?.chunkCount ?? knownChunkCount;
  if (chunkCount != null) {
    for (let index = 0; index < chunkCount; index += 1) {
      await chunkStore.delete(buildHostedOutboundMediaChunkKey(id, index));
    }
  }
  // Metadata owns chunk cardinality. Delete it last so a failed cleanup can
  // retry remaining rows instead of orphaning capacity with no recovery fact.
  await metadataStore.delete(metaKey);
}

export function createHostedOutboundMediaStore(
  options: CreateHostedOutboundMediaStoreOptions,
): HostedOutboundMediaStore {
  const rawChunkBytes = options.rawChunkBytes ?? DEFAULT_HOSTED_OUTBOUND_MEDIA_RAW_CHUNK_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_HOSTED_OUTBOUND_MEDIA_MAX_ENTRIES;
  const chunkRowsPerEntryBudget =
    options.chunkRowsPerEntryBudget ?? DEFAULT_HOSTED_OUTBOUND_MEDIA_CHUNK_ROWS_PER_ENTRY_BUDGET;
  const maxChunkRows = options.maxChunkRows ?? maxEntries * chunkRowsPerEntryBudget;
  const overflowPolicy = options.overflowPolicy ?? "evict-oldest";
  const postExpiryRetentionMs = options.postExpiryRetentionMs ?? 0;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("hosted outbound media maxEntries must be a positive integer");
  }
  if (!Number.isSafeInteger(maxChunkRows) || maxChunkRows < 1) {
    throw new Error("hosted outbound media maxChunkRows must be a positive integer");
  }
  if (!Number.isSafeInteger(postExpiryRetentionMs) || postExpiryRetentionMs < 0) {
    throw new Error("hosted outbound media postExpiryRetentionMs must be a non-negative integer");
  }
  if (
    options.maxTotalBytes !== undefined &&
    (!Number.isSafeInteger(options.maxTotalBytes) || options.maxTotalBytes < 1)
  ) {
    throw new Error("hosted outbound media maxTotalBytes must be a positive integer");
  }
  if (overflowPolicy !== "evict-oldest" && overflowPolicy !== "reject-new") {
    throw new Error("hosted outbound media overflowPolicy must be evict-oldest or reject-new");
  }
  const createId = options.createId ?? createHostedOutboundMediaId;
  const createToken = options.createToken ?? createHostedOutboundMediaToken;
  const chunkPhysicalTtlMs = options.ttlMs + postExpiryRetentionMs;
  const metadataPhysicalTtlMs =
    options.ttlMs +
    Math.max(
      postExpiryRetentionMs,
      Math.min(options.ttlMs, HOSTED_OUTBOUND_MEDIA_METADATA_TTL_GRACE_MS),
    );
  if (
    !Number.isSafeInteger(chunkPhysicalTtlMs) ||
    chunkPhysicalTtlMs < 1 ||
    !Number.isSafeInteger(metadataPhysicalTtlMs) ||
    metadataPhysicalTtlMs < 1
  ) {
    throw new Error("hosted outbound media physical TTL must be a positive safe integer");
  }
  let capacityMutation = Promise.resolve();
  const activeReaders = new Map<string, number>();
  const deferredDeletes = new Set<string>();
  const deletingEntries = new Set<string>();

  async function withCapacityMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = capacityMutation.then(operation, operation);
    capacityMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  async function deleteEntry(id: string): Promise<boolean> {
    // Deletion revokes the bearer capability immediately, even when an admitted
    // reader keeps the physical rows alive until its stream closes.
    deferredDeletes.add(id);
    if ((activeReaders.get(id) ?? 0) > 0) {
      return false;
    }
    deletingEntries.add(id);
    try {
      await deleteHostedOutboundMediaRows(id, options.metadataStore, options.chunkStore);
      deferredDeletes.delete(id);
      return true;
    } finally {
      deletingEntries.delete(id);
    }
  }

  async function deleteEntryRows(id: string, chunkCount: number): Promise<void> {
    await deleteHostedOutboundMediaRows(id, options.metadataStore, options.chunkStore, chunkCount);
  }

  async function readMetadataRecord(
    id: string,
    nowMs: number,
  ): Promise<HostedOutboundMediaMetaRecord | null> {
    const meta = await options.metadataStore.lookup(buildHostedOutboundMediaMetaKey(id));
    if (!meta) {
      return null;
    }
    if (!isFutureHostedOutboundMediaExpiry(meta.expiresAt, nowMs)) {
      if (!isRetainedHostedOutboundMediaExpiry(meta.expiresAt, nowMs, postExpiryRetentionMs)) {
        await withCapacityMutation(async () => await deleteEntry(id));
      }
      return null;
    }
    return meta;
  }

  async function deleteStoredRow(
    row: Awaited<ReturnType<typeof options.metadataStore.entries>>[number],
  ): Promise<void> {
    const id = parseHostedOutboundMediaMetaKey(row.key);
    if (
      !id ||
      !Number.isSafeInteger(row.value.chunkCount) ||
      row.value.chunkCount < 1 ||
      row.value.chunkCount > maxChunkRows
    ) {
      await options.metadataStore.delete(row.key);
      return;
    }
    await deleteEntry(id);
  }

  async function cleanupExpired(nowMs = Date.now()): Promise<void> {
    await withCapacityMutation(async () => {
      for (const row of await options.metadataStore.entries()) {
        if (
          !isRetainedHostedOutboundMediaExpiry(row.value.expiresAt, nowMs, postExpiryRetentionMs)
        ) {
          await deleteStoredRow(row);
        }
      }
    });
  }

  async function acquireReader(
    id: string,
    nowMs: number,
  ): Promise<{
    meta: HostedOutboundMediaMetaRecord;
    close: () => Promise<void>;
  } | null> {
    // Register before the first await so deletion observes pending SQLite readers
    // without serializing concurrent capability authentication.
    activeReaders.set(id, (activeReaders.get(id) ?? 0) + 1);
    let closed = false;
    const close = async () => {
      if (closed) {
        return;
      }
      closed = true;
      const remaining = (activeReaders.get(id) ?? 1) - 1;
      if (remaining > 0) {
        activeReaders.set(id, remaining);
        return;
      }
      activeReaders.delete(id);
      if (deferredDeletes.has(id)) {
        await withCapacityMutation(async () => await deleteEntry(id));
      }
    };
    if (deferredDeletes.has(id) || deletingEntries.has(id)) {
      await close();
      return null;
    }
    const meta = await readMetadataRecord(id, nowMs);
    if (!meta) {
      await close();
      return null;
    }
    return { meta, close };
  }

  async function pruneForCapacity(
    incomingChunkCount: number,
    incomingByteLength: number,
    nowMs = Date.now(),
  ): Promise<void> {
    if (options.maxTotalBytes !== undefined && incomingByteLength > options.maxTotalBytes) {
      throw new Error(
        `hosted outbound media payload exceeds aggregate byte capacity (${incomingByteLength}/${options.maxTotalBytes} bytes)`,
      );
    }
    const rows = await options.metadataStore.entries();
    const validRows = rows.filter((row) => {
      const id = parseHostedOutboundMediaMetaKey(row.key);
      return (
        id !== undefined &&
        row.value.id === id &&
        Number.isSafeInteger(row.value.chunkCount) &&
        row.value.chunkCount > 0 &&
        row.value.chunkCount <= maxChunkRows &&
        Number.isSafeInteger(row.value.byteLength) &&
        row.value.byteLength >= 0 &&
        isRetainedHostedOutboundMediaExpiry(row.value.expiresAt, nowMs, postExpiryRetentionMs)
      );
    });
    const validKeys = new Set(validRows.map((row) => row.key));
    const orderedRows = validRows.toSorted(
      (a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key),
    );
    const invalidRows = rows.filter((row) => !validKeys.has(row.key));
    for (const row of invalidRows) {
      await deleteStoredRow(row);
    }

    let entryCount = orderedRows.length;
    let chunkCount = orderedRows.reduce((total, row) => total + row.value.chunkCount, 0);
    let totalBytes = orderedRows.reduce((total, row) => total + row.value.byteLength, 0);
    if (
      overflowPolicy === "reject-new" &&
      (entryCount >= maxEntries ||
        chunkCount + incomingChunkCount > maxChunkRows ||
        (options.maxTotalBytes !== undefined &&
          totalBytes + incomingByteLength > options.maxTotalBytes))
    ) {
      throw new Error(
        `hosted outbound media capacity is full (${entryCount}/${maxEntries} entries, ${
          chunkCount + incomingChunkCount
        }/${maxChunkRows} chunk rows, ${totalBytes + incomingByteLength}/${
          options.maxTotalBytes ?? "unbounded"
        } bytes)`,
      );
    }
    for (const row of orderedRows) {
      if (
        entryCount < maxEntries &&
        chunkCount + incomingChunkCount <= maxChunkRows &&
        (options.maxTotalBytes === undefined ||
          totalBytes + incomingByteLength <= options.maxTotalBytes)
      ) {
        break;
      }
      const id = parseHostedOutboundMediaMetaKey(row.key);
      if (!id) {
        continue;
      }
      // Capacity eviction is speculative until a candidate has no admitted
      // readers. Skip active capabilities instead of revoking them on failure.
      if ((activeReaders.get(id) ?? 0) > 0) {
        continue;
      }
      if (await deleteEntry(id)) {
        entryCount -= 1;
        chunkCount -= row.value.chunkCount;
        totalBytes -= row.value.byteLength;
      }
    }
    if (
      entryCount >= maxEntries ||
      chunkCount + incomingChunkCount > maxChunkRows ||
      (options.maxTotalBytes !== undefined &&
        totalBytes + incomingByteLength > options.maxTotalBytes)
    ) {
      throw new Error("hosted outbound media capacity is full while active readers retain entries");
    }
  }

  return {
    async prepareUrl(params) {
      const expiresAt = options.resolveExpiresAtMs(options.ttlMs);
      if (expiresAt === undefined) {
        throw new Error("hosted outbound media expiry could not be resolved");
      }
      const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
        maxBytes: params.maxBytes,
        mediaAccess: params.mediaAccess,
        ...(params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}),
        ...(params.requestInit ? { requestInit: params.requestInit } : {}),
      });
      await params.validateBeforePersist?.(media);
      const id = createId();
      const token = createToken();
      const chunkCount = Math.max(1, Math.ceil(media.buffer.byteLength / rawChunkBytes));
      if (chunkCount > maxChunkRows) {
        throw new Error(
          `hosted outbound media exceeds SQLite chunk row limit (${chunkCount}/${maxChunkRows})`,
        );
      }
      // Capacity check and writes stay serialized per helper instance. Cross-process
      // callers rely on reject-new backing stores so a race cannot evict live URLs.
      return await withCapacityMutation(async () => {
        await pruneForCapacity(chunkCount, media.buffer.byteLength);
        try {
          for (let index = 0; index < chunkCount; index += 1) {
            const chunk = media.buffer.subarray(index * rawChunkBytes, (index + 1) * rawChunkBytes);
            await options.chunkStore.register(
              buildHostedOutboundMediaChunkKey(id, index),
              {
                id,
                index,
                dataBase64: chunk.toString("base64"),
              },
              { ttlMs: chunkPhysicalTtlMs },
            );
          }
          await options.metadataStore.register(
            buildHostedOutboundMediaMetaKey(id),
            createHostedOutboundMediaMetaRecord({
              id,
              routePath: params.routePath,
              token,
              contentType: media.contentType,
              fileName: media.fileName,
              expiresAt,
              chunkCount,
              byteLength: media.buffer.byteLength,
            }),
            { ttlMs: metadataPhysicalTtlMs },
          );
        } catch (error) {
          await deleteEntryRows(id, chunkCount);
          throw error;
        }
        return `${params.publicBaseUrl}${params.routePath}${id}?token=${token}`;
      });
    },
    async readMetadata(id, nowMs = Date.now()) {
      const reader = await acquireReader(id, nowMs);
      if (!reader) {
        return null;
      }
      try {
        return deferredDeletes.has(id) || deletingEntries.has(id)
          ? null
          : createHostedOutboundMediaMetadata(reader.meta);
      } finally {
        await reader.close();
      }
    },
    async read(id, nowMs = Date.now()) {
      const reader = await acquireReader(id, nowMs);
      if (!reader) {
        return null;
      }
      const { close, meta } = reader;
      try {
        const expectedChunkCount = Math.max(1, Math.ceil(meta.byteLength / rawChunkBytes));
        if (
          !Number.isSafeInteger(meta.byteLength) ||
          meta.byteLength < 0 ||
          meta.chunkCount !== expectedChunkCount ||
          meta.chunkCount > maxChunkRows
        ) {
          await withCapacityMutation(async () => await deleteEntry(id));
          return null;
        }
        const buffer = Buffer.allocUnsafe(meta.byteLength);
        let offset = 0;
        for (let index = 0; index < meta.chunkCount; index += 1) {
          const chunk = await options.chunkStore.lookup(
            buildHostedOutboundMediaChunkKey(id, index),
          );
          if (!chunk || chunk.id !== id || chunk.index !== index) {
            await withCapacityMutation(async () => await deleteEntry(id));
            return null;
          }
          const decoded = Buffer.from(chunk.dataBase64, "base64");
          const expectedBytes =
            index === meta.chunkCount - 1
              ? meta.byteLength - rawChunkBytes * (meta.chunkCount - 1)
              : rawChunkBytes;
          if (decoded.byteLength !== expectedBytes) {
            await withCapacityMutation(async () => await deleteEntry(id));
            return null;
          }
          decoded.copy(buffer, offset);
          offset += decoded.byteLength;
        }
        return {
          metadata: createHostedOutboundMediaMetadata(meta),
          buffer,
        };
      } finally {
        await close();
      }
    },
    async delete(id) {
      // Mark the capability before entering the async mutation queue so readers
      // cannot slip in after revocation starts but before SQLite deletion runs.
      deferredDeletes.add(id);
      await withCapacityMutation(async () => await deleteEntry(id));
    },
    cleanupExpired,
    async clear() {
      await withCapacityMutation(
        async () => await Promise.all([options.metadataStore.clear(), options.chunkStore.clear()]),
      );
    },
  };
}

function encodeHostedOutboundMediaFileName(fileName: string): string {
  return encodeURIComponent(fileName).replace(
    /[\x27()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Build download-only response headers for immutable hosted outbound media. */
export function buildHostedOutboundMediaResponseHeaders(
  metadata: Pick<HostedOutboundMediaMetadata, "byteLength" | "contentType" | "fileName">,
  options: { fallbackFileName?: string } = {},
): Record<string, string> {
  const contentType =
    normalizeMimeType(metadata.contentType?.split(";", 1)[0]?.trim()) ?? "application/octet-stream";
  const fileName = sanitizeUntrustedFileName(
    metadata.fileName ?? options.fallbackFileName ?? "attachment.bin",
    "attachment.bin",
  );
  const asciiFallback = fileName.replace(/[^\x20-\x7e]|[%"\\]/g, "_").trim() || "attachment.bin";
  return {
    "Content-Type": contentType,
    "Content-Length": String(metadata.byteLength),
    "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeHostedOutboundMediaFileName(fileName)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
