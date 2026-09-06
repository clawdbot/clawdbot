/**
 * Appends raw embedded-agent stream payloads for diagnostics when enabled.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { appendRegularFile } from "../infra/fs-safe.js";

let rawStreamReady = false;

function isRawStreamEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_RAW_STREAM);
}

function resolveRawStreamPath(): string {
  return (
    process.env.OPENCLAW_RAW_STREAM_PATH?.trim() ||
    path.join(resolveStateDir(), "logs", "raw-stream.jsonl")
  );
}

export function appendRawStream(createPayload: () => Record<string, unknown>) {
  if (!isRawStreamEnabled()) {
    return;
  }
  const rawStreamPath = resolveRawStreamPath();
  if (!rawStreamReady) {
    rawStreamReady = true;
    try {
      fs.mkdirSync(path.dirname(rawStreamPath), { recursive: true });
    } catch {
      // ignore raw stream mkdir failures
    }
  }
  try {
    // Evaluate and serialize before the async append while the message snapshot is current.
    void appendRegularFile({
      filePath: rawStreamPath,
      content: `${JSON.stringify(createPayload())}\n`,
      rejectSymlinkParents: true,
    }).catch(() => {
      // Raw diagnostics are best-effort; filesystem failures must not terminate agent runs.
    });
  } catch {
    // JSON serialization can fail synchronously, for example with cyclic payloads.
  }
}
