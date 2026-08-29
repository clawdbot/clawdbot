import path from "node:path";
import { createZstdDecompress } from "node:zlib";
import { root as openSafeFilesystemRoot } from "openclaw/plugin-sdk/file-access-runtime";
import {
  isJsonObject,
  type CodexThread,
  type JsonObject,
  type JsonValue,
} from "./app-server/protocol.js";

const MAX_SESSION_META_BYTES = 1024 * 1024;
const SESSION_META_READ_CHUNK_BYTES = 64 * 1024;
const MAX_PROVENANCE_CACHE_ENTRIES = 20_000;

const provenanceByPath = new Map<string, boolean>();

function cacheProvenance(key: string, value: boolean): void {
  provenanceByPath.delete(key);
  provenanceByPath.set(key, value);
  while (provenanceByPath.size > MAX_PROVENANCE_CACHE_ENTRIES) {
    const oldest = provenanceByPath.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    provenanceByPath.delete(oldest);
  }
}

/** Undefined means the metadata line is not durable enough to cache yet. */
export async function readCodexSessionMeta(
  sessionsRoot: string,
  rolloutPath: string,
  threadId: string,
): Promise<JsonObject | null | undefined> {
  let safeRoot: Awaited<ReturnType<typeof openSafeFilesystemRoot>>;
  try {
    safeRoot = await openSafeFilesystemRoot(sessionsRoot, {
      hardlinks: "reject",
      maxBytes: Number.MAX_SAFE_INTEGER,
      symlinks: "reject",
    });
  } catch {
    return undefined;
  }
  const candidates = rolloutPath.endsWith(".zst")
    ? [rolloutPath, rolloutPath.slice(0, -".zst".length)]
    : [rolloutPath, `${rolloutPath}.zst`];
  for (const candidate of candidates) {
    let opened: Awaited<ReturnType<typeof safeRoot.open>>;
    try {
      opened = await safeRoot.open(path.relative(sessionsRoot, candidate));
    } catch {
      continue;
    }
    const input = opened.handle.createReadStream({
      autoClose: false,
      highWaterMark: SESSION_META_READ_CHUNK_BYTES,
    });
    const reader = candidate.endsWith(".zst") ? input.pipe(createZstdDecompress()) : input;
    try {
      const chunks: Buffer[] = [];
      let bytesReadTotal = 0;
      let line: string | undefined;
      for await (const value of reader) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const remaining = MAX_SESSION_META_BYTES - bytesReadTotal;
        if (remaining <= 0) {
          break;
        }
        const bounded = chunk.subarray(0, remaining);
        bytesReadTotal += bounded.length;
        const newline = bounded.indexOf(0x0a);
        chunks.push(newline >= 0 ? bounded.subarray(0, newline) : bounded);
        if (newline >= 0) {
          line = Buffer.concat(chunks).toString("utf8");
          break;
        }
      }
      if (!line) {
        continue;
      }
      let parsed: JsonValue;
      try {
        // SAFETY: JSON.parse without a reviver returns JSON shapes; envelope/id checks follow.
        parsed = JSON.parse(line) as JsonValue;
      } catch {
        continue;
      }
      if (
        !isJsonObject(parsed) ||
        parsed.type !== "session_meta" ||
        !isJsonObject(parsed.payload)
      ) {
        return null;
      }
      const payload = parsed.payload;
      return payload.id === threadId ? payload : null;
    } catch {
      continue;
    } finally {
      reader.destroy();
      input.destroy();
      await opened.handle.close().catch(() => undefined);
    }
  }
  return undefined;
}

/**
 * Codex 0.147 reports OpenClaw app-server rollouts as `vscode`, so the rollout's
 * immutable session metadata is the authoritative historical provenance.
 */
export async function isOpenClawManagedCodexThread(
  thread: CodexThread,
  localSessionsRoot: string | undefined,
): Promise<boolean> {
  const rolloutPath = typeof thread.path === "string" ? thread.path.trim() : "";
  if (!localSessionsRoot || !rolloutPath) {
    return false;
  }
  const cacheKey = `${localSessionsRoot}\0${rolloutPath}`;
  const cached = provenanceByPath.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const metadata = await readCodexSessionMeta(localSessionsRoot, rolloutPath, thread.id);
  const managed = metadata === undefined ? undefined : metadata?.originator === "openclaw";
  // A missing or still-being-written rollout must not become a permanent false
  // negative. Newly created sessions are additionally covered by the durable
  // ownership store, while a completed metadata line can be cached safely.
  if (managed !== undefined) {
    cacheProvenance(cacheKey, managed);
  }
  return managed ?? false;
}
