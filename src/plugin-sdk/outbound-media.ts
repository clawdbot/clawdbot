// Outbound media helpers normalize plugin media attachments before channel delivery.
import { randomBytes } from "node:crypto";
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

export type HostedOutboundMediaStore = {
  prepareUrl: (params: {
    mediaUrl: string;
    routePath: string;
    publicBaseUrl: string;
    maxBytes: number;
    proxyUrl?: string;
  }) => Promise<string>;
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
  chunkRowsPerEntryBudget?: number;
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

function resolveHostedOutboundMediaMetadataTtlMs(ttlMs: number): number {
  return ttlMs + Math.min(ttlMs, HOSTED_OUTBOUND_MEDIA_METADATA_TTL_GRACE_MS);
}

function isFutureHostedOutboundMediaExpiry(expiresAt: unknown, nowMs: number): expiresAt is number {
  return typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) && expiresAt > nowMs;
}

function createHostedOutboundMediaMetaRecord(params: {
  id: string;
  routePath: string;
  token: string;
  contentType?: string;
  expiresAt: number;
  chunkCount: number;
  byteLength: number;
}): HostedOutboundMediaMetaRecord {
  return {
    id: params.id,
    routePath: params.routePath,
    token: params.token,
    ...(params.contentType ? { contentType: params.contentType } : {}),
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
  const meta = await metadataStore.lookup(buildHostedOutboundMediaMetaKey(id));
  await metadataStore.delete(buildHostedOutboundMediaMetaKey(id));
  const chunkCount = meta?.chunkCount ?? knownChunkCount;
  if (chunkCount == null) {
    return;
  }
  for (let index = 0; index < chunkCount; index += 1) {
    await chunkStore.delete(buildHostedOutboundMediaChunkKey(id, index));
  }
}

export function createHostedOutboundMediaStore(
  options: CreateHostedOutboundMediaStoreOptions,
): HostedOutboundMediaStore {
  const rawChunkBytes = options.rawChunkBytes ?? DEFAULT_HOSTED_OUTBOUND_MEDIA_RAW_CHUNK_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_HOSTED_OUTBOUND_MEDIA_MAX_ENTRIES;
  const chunkRowsPerEntryBudget =
    options.chunkRowsPerEntryBudget ?? DEFAULT_HOSTED_OUTBOUND_MEDIA_CHUNK_ROWS_PER_ENTRY_BUDGET;
  const maxChunkRows = options.maxChunkRows ?? maxEntries * chunkRowsPerEntryBudget;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("hosted outbound media maxEntries must be a positive integer");
  }
  if (!Number.isSafeInteger(maxChunkRows) || maxChunkRows < 1) {
    throw new Error("hosted outbound media maxChunkRows must be a positive integer");
  }
  const createId = options.createId ?? createHostedOutboundMediaId;
  const createToken = options.createToken ?? createHostedOutboundMediaToken;

  async function deleteEntry(id: string): Promise<void> {
    await deleteHostedOutboundMediaRows(id, options.metadataStore, options.chunkStore);
  }

  async function deleteEntryRows(id: string, chunkCount: number): Promise<void> {
    await deleteHostedOutboundMediaRows(id, options.metadataStore, options.chunkStore, chunkCount);
  }

  async function cleanupExpired(nowMs = Date.now()): Promise<void> {
    for (const row of await options.metadataStore.entries()) {
      if (!isFutureHostedOutboundMediaExpiry(row.value.expiresAt, nowMs)) {
        await deleteEntry(row.value.id);
      }
    }
  }

  async function pruneForCapacity(incomingChunkCount: number): Promise<void> {
    const rows = await options.metadataStore.entries();
    const validRows = rows.filter(
      (row) => Number.isSafeInteger(row.value.chunkCount) && row.value.chunkCount > 0,
    );
    const validKeys = new Set(validRows.map((row) => row.key));
    const orderedRows = validRows.toSorted(
      (a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key),
    );
    const invalidRows = rows.filter((row) => !validKeys.has(row.key));
    for (const row of invalidRows) {
      await deleteEntry(row.value.id);
    }

    let entryCount = orderedRows.length;
    let chunkCount = orderedRows.reduce((total, row) => total + row.value.chunkCount, 0);
    for (const row of orderedRows) {
      if (entryCount < maxEntries && chunkCount + incomingChunkCount <= maxChunkRows) {
        break;
      }
      await deleteEntry(row.value.id);
      entryCount -= 1;
      chunkCount -= row.value.chunkCount;
    }
  }

  return {
    async prepareUrl(params) {
      await cleanupExpired();
      const expiresAt = options.resolveExpiresAtMs(options.ttlMs);
      if (expiresAt === undefined) {
        throw new Error("hosted outbound media expiry could not be resolved");
      }
      const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
        maxBytes: params.maxBytes,
        ...(params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}),
      });
      const id = createId();
      const token = createToken();
      const metadataTtlMs = resolveHostedOutboundMediaMetadataTtlMs(options.ttlMs);
      const chunkCount = Math.max(1, Math.ceil(media.buffer.byteLength / rawChunkBytes));
      if (chunkCount > maxChunkRows) {
        throw new Error(
          `hosted outbound media exceeds SQLite chunk row limit (${chunkCount}/${maxChunkRows})`,
        );
      }
      await pruneForCapacity(chunkCount);
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
            { ttlMs: options.ttlMs },
          );
        }
        await options.metadataStore.register(
          buildHostedOutboundMediaMetaKey(id),
          createHostedOutboundMediaMetaRecord({
            id,
            routePath: params.routePath,
            token,
            contentType: media.contentType,
            expiresAt,
            chunkCount,
            byteLength: media.buffer.byteLength,
          }),
          { ttlMs: metadataTtlMs },
        );
      } catch (error) {
        await deleteEntryRows(id, chunkCount);
        throw error;
      }
      return `${params.publicBaseUrl}${params.routePath}${id}?token=${token}`;
    },
    async read(id, nowMs = Date.now()) {
      const meta = await options.metadataStore.lookup(buildHostedOutboundMediaMetaKey(id));
      if (!meta) {
        return null;
      }
      if (!isFutureHostedOutboundMediaExpiry(meta.expiresAt, nowMs)) {
        await deleteEntry(id);
        return null;
      }
      const chunks: Buffer[] = [];
      for (let index = 0; index < meta.chunkCount; index += 1) {
        const chunk = await options.chunkStore.lookup(buildHostedOutboundMediaChunkKey(id, index));
        if (!chunk || chunk.id !== id || chunk.index !== index) {
          await deleteEntry(id);
          return null;
        }
        chunks.push(Buffer.from(chunk.dataBase64, "base64"));
      }
      return {
        metadata: createHostedOutboundMediaMetadata(meta),
        buffer: Buffer.concat(chunks, meta.byteLength),
      };
    },
    delete: deleteEntry,
    cleanupExpired,
    async clear() {
      await Promise.all([options.metadataStore.clear(), options.chunkStore.clear()]);
    },
  };
}
