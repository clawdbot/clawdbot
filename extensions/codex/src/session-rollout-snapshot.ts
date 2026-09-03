import { lstat } from "node:fs/promises";
import path from "node:path";
import { constants, createZstdDecompress } from "node:zlib";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const CHUNK_BYTES = 64 * 1024;
const META_BYTES = 1024 * 1024;
const COMPRESSED_BYTES = 8 * 1024 * 1024;
const DEADLINE_MS = 5_000;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function parseMetadata(line: Buffer, threadId: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(utf8Decoder.decode(line));
  if (
    !isRecord(parsed) ||
    parsed.type !== "session_meta" ||
    !isRecord(parsed.payload) ||
    parsed.payload.id !== threadId
  ) {
    throw new Error("Codex rollout does not belong to the bound thread");
  }
  return parsed.payload;
}

/** Read immutable metadata while pinning the entire rollout against concurrent writers. */
export async function readCodexRolloutSnapshot(params: {
  sessionsRoot: string;
  rolloutPath: string;
  threadId: string;
  assertCurrent: () => void;
}) {
  const deadline = Date.now() + DEADLINE_MS;
  const check = () => {
    params.assertCurrent();
    if (Date.now() >= deadline) {
      throw new Error("Codex rollout metadata observation timed out");
    }
  };
  check();
  const rootStat = await lstat(params.sessionsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Codex rollout root is not a verified local directory");
  }
  const safeRoot = await root(params.sessionsRoot, {
    hardlinks: "reject",
    symlinks: "reject",
    maxBytes: Number.MAX_SAFE_INTEGER,
  });
  const plain = params.rolloutPath.endsWith(".zst")
    ? params.rolloutPath.slice(0, -4)
    : params.rolloutPath;
  let selected = plain;
  let opened: Awaited<ReturnType<typeof safeRoot.open>>;
  try {
    opened = await safeRoot.open(path.relative(params.sessionsRoot, selected));
  } catch (error) {
    if (!isRecord(error) || (error.code !== "not-found" && error.code !== "ENOENT")) {
      throw error;
    }
    selected = `${plain}.zst`;
    opened = await safeRoot.open(path.relative(params.sessionsRoot, selected));
  }
  try {
    check();
    const snapshot = opened.stat;
    const unchanged = (stat: typeof snapshot) =>
      stat.dev === snapshot.dev &&
      stat.ino === snapshot.ino &&
      stat.size === snapshot.size &&
      stat.mtimeMs === snapshot.mtimeMs &&
      stat.ctimeMs === snapshot.ctimeMs &&
      stat.nlink === 1;
    if (!snapshot.size) {
      throw new Error("Codex rollout metadata is incomplete");
    }
    const compressed = selected.endsWith(".zst");
    if (compressed && snapshot.size > COMPRESSED_BYTES) {
      throw new Error("Compressed Codex rollout exceeds the observation limit");
    }
    const input = opened.handle.createReadStream({
      autoClose: false,
      highWaterMark: CHUNK_BYTES,
      end: snapshot.size - 1,
    });
    // Only the first line is decoded; its cap bounds output independently of the
    // compressed input cap and the decoder's 32 MiB window.
    const decoder = compressed
      ? createZstdDecompress({
          chunkSize: CHUNK_BYTES,
          params: { [constants.ZSTD_d_windowLogMax]: 25 },
        })
      : undefined;
    if (decoder) {
      input.on("error", (error) => decoder.destroy(error));
      input.pipe(decoder);
    }
    const reader = decoder ?? input;
    const timer = setTimeout(
      () => reader.destroy(new Error("Codex rollout metadata observation timed out")),
      Math.max(1, deadline - Date.now()),
    );
    let metadata: Record<string, unknown> | undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      // Keep the descriptor and iterator's error listener alive through fstat;
      // the deadline can destroy the stream while that check is pending.
      for await (const chunk of reader) {
        check();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const newline = bytes.indexOf(10);
        const prefix = newline < 0 ? bytes : bytes.subarray(0, newline);
        total += prefix.length;
        if (total > META_BYTES) {
          throw new Error("Codex rollout metadata exceeds the observation limit");
        }
        chunks.push(prefix);
        if (newline >= 0) {
          metadata = parseMetadata(Buffer.concat(chunks), params.threadId);
          if (!unchanged(await opened.handle.stat())) {
            throw new Error("Codex rollout changed during metadata observation");
          }
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      reader.destroy();
      input.destroy();
    }
    if (!metadata) {
      throw new Error("Codex rollout metadata is incomplete");
    }
    const assertUnchanged = async () => {
      params.assertCurrent();
      if (selected !== plain) {
        try {
          await lstat(plain);
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") {
            throw error;
          }
          // Only absence preserves the exact plain/compressed selection.
          return await verifySelected();
        }
        throw new Error("Codex rollout selection changed during metadata observation");
      }
      await verifySelected();
    };
    const verifySelected = async () => {
      params.assertCurrent();
      const currentRoot = await lstat(params.sessionsRoot);
      const fresh = await safeRoot.open(path.relative(params.sessionsRoot, selected));
      try {
        const stat = fresh.stat;
        if (
          !unchanged(stat) ||
          currentRoot.isSymbolicLink() ||
          currentRoot.ino !== rootStat.ino ||
          currentRoot.dev !== rootStat.dev
        ) {
          throw new Error("Codex rollout changed during metadata observation");
        }
      } finally {
        await fresh.handle.close();
      }
      params.assertCurrent();
    };
    await assertUnchanged();
    check();
    return { metadata, assertUnchanged };
  } finally {
    await opened.handle.close();
  }
}
