// CLI adapter for the bounded agent-database rehearsal JSON contract.
import fsp from "node:fs/promises";
import path from "node:path";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { AgentDatabaseRehearsalError, runAgentDatabaseRehearsal } from "./agents.db-rehearsal.js";

const REHEARSAL_REQUEST_MAX_BYTES = 256 * 1024;
type RehearsalMode = "inventory" | "migrate" | "read-only";

function fail(code: string, message: string): never {
  throw new AgentDatabaseRehearsalError(code, message);
}

async function readRequestSource(source: string, stdin: AsyncIterable<unknown>): Promise<unknown> {
  let raw: Buffer;
  if (source === "-") {
    raw = await readByteStreamWithLimit(stdin, {
      maxBytes: REHEARSAL_REQUEST_MAX_BYTES,
      onOverflow: ({ maxBytes }) =>
        new AgentDatabaseRehearsalError("request-too-large", `request exceeds ${maxBytes} bytes.`),
    });
  } else {
    const file = await fsp.open(path.resolve(source), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        fail("request-unavailable", "request source must be a regular file.");
      }
      if (stat.size > REHEARSAL_REQUEST_MAX_BYTES) {
        fail("request-too-large", `request exceeds ${REHEARSAL_REQUEST_MAX_BYTES} bytes.`);
      }
      raw = await readFileDescriptorBounded(file.fd, REHEARSAL_REQUEST_MAX_BYTES);
    } finally {
      await file.close();
    }
  }
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return fail("invalid-json", "request source is not valid JSON.");
  }
}

export async function agentsDatabaseRehearsalCommand(
  options: { request: string },
  runtime: RuntimeEnv,
  deps: { stdin?: AsyncIterable<unknown> } = {},
): Promise<void> {
  let mode: RehearsalMode | undefined;
  try {
    const value = await readRequestSource(options.request, deps.stdin ?? process.stdin);
    mode =
      isRecord(value) && typeof value.mode === "string" ? (value.mode as RehearsalMode) : undefined;
    writeRuntimeJson(runtime, await runAgentDatabaseRehearsal(value), 0);
  } catch (error) {
    const typed =
      error instanceof AgentDatabaseRehearsalError
        ? error
        : new AgentDatabaseRehearsalError("rehearsal-failed", formatErrorMessage(error));
    writeRuntimeJson(
      runtime,
      {
        schemaVersion: 1,
        ok: false,
        ...(mode ? { mode } : {}),
        code: typed.code,
        message: typed.message,
        ...(typed.unsupportedPluginPersistence
          ? { unsupportedPluginPersistence: typed.unsupportedPluginPersistence }
          : {}),
      },
      0,
    );
    runtime.exit(1, { resetStream: process.stderr });
  }
}
