import { lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { constants, createZstdDecompress } from "node:zlib";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const CHUNK_BYTES = 64 * 1024;
const RECORD_BYTES = 1024 * 1024;
const SCAN_BYTES = 8 * 1024 * 1024;
const DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const DEADLINE_MS = 5_000;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function scalar(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 256) {
    throw new Error("Codex rollout has an invalid model or provider selection");
  }
  return value;
}

function record(line: Buffer): { type: string; payload: Record<string, unknown> } {
  if (!line.length || line.length > RECORD_BYTES) {
    throw new Error("Codex rollout record exceeds the observation limit");
  }
  const parsed: unknown = JSON.parse(utf8Decoder.decode(line));
  if (!isRecord(parsed) || typeof parsed.type !== "string" || !isRecord(parsed.payload)) {
    throw new Error("Codex rollout contains an incomplete record");
  }
  return { type: parsed.type, payload: parsed.payload };
}

/** Observe settings only; rollback changes history, never the native scalar selection. */
function observation(parsed: ReturnType<typeof record>, threadId: string) {
  const payload = parsed.payload;
  if (parsed.type === "session_meta") {
    if (typeof payload.id !== "string") {
      throw new Error("Codex rollout metadata is missing its thread identity");
    }
    return payload.id === threadId ? { provider: scalar(payload.model_provider) } : {};
  }
  if (parsed.type === "turn_context") {
    return { model: scalar(payload.model) };
  }
  if (parsed.type === "event_msg" && payload.type === "thread_settings_applied") {
    if (!isRecord(payload.thread_settings)) {
      throw new Error("Codex rollout settings are incomplete");
    }
    return {
      model: scalar(payload.thread_settings.model),
      provider: scalar(payload.thread_settings.model_provider_id),
    };
  }
  return {};
}

async function readExtent(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  for (let offset = 0; offset < length;) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
    if (!bytesRead) {
      throw new Error("Codex rollout changed during model observation");
    }
    offset += bytesRead;
  }
  return buffer;
}

/** Latest durable selection at one verified local rollout snapshot, not live-memory state. */
export async function readCodexRolloutSelection(params: {
  sessionsRoot: string;
  rolloutPath: string;
  threadId: string;
  assertCurrent: () => void;
}) {
  const deadline = Date.now() + DEADLINE_MS;
  const check = () => {
    params.assertCurrent();
    if (Date.now() >= deadline) {
      throw new Error("Codex rollout model observation timed out");
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
    let metadata: Record<string, unknown> | undefined;
    let model: string | undefined;
    let provider: string | undefined;
    const header = (parsed: ReturnType<typeof record>) => {
      if (parsed.type !== "session_meta" || parsed.payload.id !== params.threadId) {
        throw new Error("Codex rollout does not belong to the bound thread");
      }
      scalar(parsed.payload.model_provider);
      metadata = parsed.payload;
    };
    if (selected.endsWith(".zst")) {
      if (snapshot.size === 0 || snapshot.size > SCAN_BYTES) {
        throw new Error("Compressed Codex rollout exceeds the observation limit");
      }
      const input = opened.handle.createReadStream({
        autoClose: false,
        highWaterMark: CHUNK_BYTES,
        end: snapshot.size - 1,
      });
      const decoder = createZstdDecompress({
        chunkSize: CHUNK_BYTES,
        params: { [constants.ZSTD_d_windowLogMax]: 25 },
      });
      const timer = setTimeout(
        () => decoder.destroy(new Error("Codex rollout observation timed out")),
        Math.max(1, deadline - Date.now()),
      );
      input.on("error", (error) => decoder.destroy(error));
      const forward = input.pipe(decoder);
      let tail: Buffer = Buffer.alloc(0);
      let total = 0;
      try {
        for await (const chunk of forward) {
          check();
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.length;
          if (total > DECOMPRESSED_BYTES) {
            throw new Error("Decompressed Codex rollout exceeds the observation limit");
          }
          tail = Buffer.concat([tail, bytes]);
          let newline: number;
          while ((newline = tail.indexOf(10)) >= 0) {
            const parsed = record(tail.subarray(0, newline));
            if (!metadata) {
              header(parsed);
            }
            const value = observation(parsed, params.threadId);
            model = value.model ?? model;
            provider = value.provider ?? provider;
            tail = tail.subarray(newline + 1);
          }
          if (tail.length > RECORD_BYTES) {
            throw new Error("Codex rollout record exceeds the observation limit");
          }
        }
        if (tail.length) {
          throw new Error("Codex rollout has an incomplete trailing record");
        }
      } finally {
        clearTimeout(timer);
        if (!input.readableEnded) {
          input.destroy();
        }
        decoder.destroy();
      }
    } else {
      let first = Buffer.alloc(0);
      for (let offset = 0; offset < snapshot.size && first.length <= RECORD_BYTES;) {
        check();
        const bytes = await readExtent(
          opened.handle,
          offset,
          Math.min(CHUNK_BYTES, snapshot.size - offset),
        );
        offset += bytes.length;
        first = Buffer.concat([first, bytes]);
        const newline = first.indexOf(10);
        if (newline >= 0) {
          header(record(first.subarray(0, newline)));
          break;
        }
      }
      if (!metadata) {
        throw new Error("Codex rollout metadata is incomplete or oversized");
      }
      let end = snapshot.size;
      let scanned = 0;
      let tail: Buffer = Buffer.alloc(0);
      while (end > 0 && (!model || !provider)) {
        check();
        const length = Math.min(CHUNK_BYTES, end, SCAN_BYTES - scanned);
        if (!length) {
          throw new Error("Codex rollout model observation exhausted its scan budget");
        }
        end -= length;
        const bytes = await readExtent(opened.handle, end, length);
        if (!scanned) {
          if (bytes.at(-1) !== 10) {
            throw new Error("Codex rollout has an incomplete trailing record");
          }
          tail = bytes.subarray(0, -1);
        } else {
          tail = Buffer.concat([bytes, tail]);
        }
        scanned += length;
        for (;;) {
          const newline = tail.lastIndexOf(10);
          if (newline < 0 && (end !== 0 || tail.length === 0)) {
            break;
          }
          const value = observation(record(tail.subarray(newline + 1)), params.threadId);
          model ??= value.model;
          provider ??= value.provider;
          tail = newline < 0 ? Buffer.alloc(0) : tail.subarray(0, newline);
          if (model && provider) {
            break;
          }
        }
        if (tail.length > RECORD_BYTES) {
          throw new Error("Codex rollout record exceeds the observation limit");
        }
      }
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
        throw new Error("Codex rollout selection changed during model observation");
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
          stat.dev !== snapshot.dev ||
          stat.ino !== snapshot.ino ||
          stat.size !== snapshot.size ||
          stat.mtimeMs !== snapshot.mtimeMs ||
          stat.ctimeMs !== snapshot.ctimeMs ||
          stat.nlink !== 1 ||
          currentRoot.isSymbolicLink() ||
          currentRoot.ino !== rootStat.ino ||
          currentRoot.dev !== rootStat.dev
        ) {
          throw new Error("Codex rollout changed during model observation");
        }
      } finally {
        await fresh.handle.close();
      }
      params.assertCurrent();
    };
    const descriptor = await opened.handle.stat();
    if (
      descriptor.dev !== snapshot.dev ||
      descriptor.ino !== snapshot.ino ||
      descriptor.size !== snapshot.size ||
      descriptor.mtimeMs !== snapshot.mtimeMs ||
      descriptor.ctimeMs !== snapshot.ctimeMs ||
      descriptor.nlink !== 1
    ) {
      throw new Error("Codex rollout changed during model observation");
    }
    await assertUnchanged();
    check();
    if (!model || !provider || !metadata) {
      throw new Error("Codex rollout has no complete durable model selection");
    }
    return { model, modelProvider: provider, metadata, assertUnchanged };
  } finally {
    await opened.handle.close();
  }
}
