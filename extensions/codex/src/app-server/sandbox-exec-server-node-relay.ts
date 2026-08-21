import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { sanitizeEnvVars } from "openclaw/plugin-sdk/sandbox";
import { formatErrorMessage, redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { RawData, WebSocket } from "ws";
import type { CodexNodeExecServerLease } from "./sandbox-exec-server/types.js";

const CODEX_NODE_EXEC_SERVER_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const CODEX_NODE_EXEC_SERVER_MAX_FAILURE_DETAIL_CHARS = 240;
const nodeExecServerTextDecoder = new TextDecoder("utf-8", { fatal: true });

/** Relays one authorized, single-use Codex exec-server channel without interpreting its protocol. */
export async function startCodexNodeExecServerRelay(params: {
  lease: CodexNodeExecServerLease;
  socket: WebSocket;
}): Promise<void> {
  const { channel } = params.lease;
  const { socket } = params;
  let closed = false;
  const { promise: finished, resolve: finish } = createDeferred<void>();
  let unsubscribe = () => {};

  const closeBoth = (code = 1001, reason = "execution channel closed") => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe();
    if (!params.lease.closed) {
      params.lease.closed = true;
      channel.close();
    }
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      socket.close(code, reason);
    }
    finish();
  };

  const failUnexpectedly = (code: number, reason: string, cause?: unknown) => {
    if (!closed && !params.lease.closed) {
      const detail =
        cause === undefined
          ? ""
          : `: ${truncateUtf16Safe(
              redactSensitiveText(formatErrorMessage(cause), { mode: "tools" }),
              CODEX_NODE_EXEC_SERVER_MAX_FAILURE_DETAIL_CHARS,
            )}`;
      params.lease.onDisconnected?.(
        new Error(
          `Codex paired execution device disconnected; start a fresh attempt. (${reason}${detail})`,
        ),
      );
    }
    closeBoth(code, reason);
  };

  socket.once("close", () => failUnexpectedly(1001, "execution socket closed"));
  socket.once("error", () => failUnexpectedly(1011, "execution socket failed"));
  void channel.closed.then(
    () => failUnexpectedly(1001, "execution device disconnected"),
    (error: unknown) => failUnexpectedly(1011, "execution device failed", error),
  );

  let toNode = Promise.resolve();
  socket.on("message", (data: RawData) => {
    if (closed) {
      return;
    }
    // Stop reading the app-server socket until node-carrier backpressure clears.
    socket.pause();
    toNode = toNode
      .then(async () => {
        const frame = normalizeCodexExecServerFrame(data);
        await channel.send(sanitizeCodexExecServerRequest(frame));
        if (!closed) {
          socket.resume();
        }
      })
      .catch((error: unknown) => {
        failUnexpectedly(error instanceof RangeError ? 1009 : 1007, "invalid execution message");
      });
  });

  unsubscribe = channel.onMessage(async (message) => {
    if (closed) {
      return;
    }
    try {
      const frame = normalizeCodexExecServerFrame(message);
      validateCodexExecServerMessage(frame);
      await new Promise<void>((resolve, reject) => {
        socket.send(frame, { binary: false }, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } catch (error) {
      failUnexpectedly(error instanceof RangeError ? 1009 : 1007, "invalid device message");
    }
  });

  await finished;
}

function normalizeCodexExecServerFrame(data: RawData | Uint8Array): Buffer {
  const frame = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data);
  if (frame.length > CODEX_NODE_EXEC_SERVER_MAX_MESSAGE_BYTES) {
    throw new RangeError("Codex exec-server message exceeds its 64 MiB limit.");
  }
  if (frame.includes(10) || frame.includes(13)) {
    throw new Error("Codex exec-server messages must occupy exactly one stdio line.");
  }
  return frame;
}

function validateCodexExecServerMessage(frame: Buffer): Record<string, unknown> {
  const parsed: unknown = JSON.parse(nodeExecServerTextDecoder.decode(frame));
  if (!isRecord(parsed)) {
    throw new Error("Codex exec-server message must be a JSON object.");
  }
  return parsed;
}

function sanitizeCodexExecServerRequest(frame: Buffer): Buffer {
  const request = validateCodexExecServerMessage(frame);
  if (request.method !== "process/start") {
    return frame;
  }
  if (!isRecord(request.params)) {
    throw new Error("Codex process/start params must be an object.");
  }
  sanitizeCodexExecServerEnvironment(request.params, "env");
  if (request.params.envPolicy !== undefined) {
    if (!isRecord(request.params.envPolicy)) {
      throw new Error("Codex process/start envPolicy must be an object.");
    }
    sanitizeCodexExecServerEnvironment(request.params.envPolicy, "set");
  }
  return normalizeCodexExecServerFrame(Buffer.from(JSON.stringify(request)));
}

function sanitizeCodexExecServerEnvironment(
  record: Record<string, unknown>,
  key: "env" | "set",
): void {
  const environment = record[key];
  if (environment === undefined) {
    return;
  }
  if (!isRecord(environment)) {
    throw new Error(`Codex process/start ${key} must be an object.`);
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") {
      throw new Error(`Codex process/start ${key} values must be strings.`);
    }
    values[name] = value;
  }
  record[key] = sanitizeEnvVars(values).allowed;
}
