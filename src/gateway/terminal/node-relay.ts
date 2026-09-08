import { NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS } from "../../infra/node-commands.js";
import { BoundedBuffer } from "../../shared/bounded-buffer.js";
import type { NodeRegistry, NodeInvokeResult } from "../node-registry.js";
import type { TerminalBackend, TerminalBackendExit } from "./backend.js";
import { surrogateSafeTail } from "./output-ring.js";

const DATA_INPUT_CHUNK_BYTES = 2 * 1024;
const MAX_PENDING_DATA_CHARS = 512 * 1024;

function parseExit(result: NodeInvokeResult): TerminalBackendExit {
  if (!result.ok) {
    const code = result.error?.code ?? "NODE_INVOKE_FAILED";
    const message = result.error?.message ?? "node terminal invoke failed";
    return { error: `${code}: ${message}` };
  }
  try {
    const raw =
      result.payloadJSON ??
      (result.payload === undefined ? undefined : JSON.stringify(result.payload));
    if (!raw) {
      return { exitCode: 0 };
    }
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { exitCode: 0 };
    }
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}),
      ...(typeof record.signal === "number" ? { signal: record.signal } : {}),
    };
  } catch {
    return { error: "node terminal returned an invalid exit result" };
  }
}

function splitInput(data: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < data.length; index += 1) {
    const codePoint = data.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const char = String.fromCodePoint(codePoint);
    const size = Buffer.byteLength(char, "utf8");
    if (bytes > 0 && bytes + size > DATA_INPUT_CHUNK_BYTES) {
      chunks.push(data.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += size;
    if (char.length === 2) {
      index += 1;
    }
  }
  if (start < data.length) {
    chunks.push(data.slice(start));
  }
  return chunks;
}

export async function createNodeRelayBackend(params: {
  registry: NodeRegistry;
  nodeId: string;
  expectedConnId: string;
  expectedPairingGeneration?: string;
  isDispatchAuthorized: () => boolean;
  command: string;
  params: Record<string, unknown>;
}): Promise<TerminalBackend> {
  let resolveDispatchReady!: (invokeId: string) => void;
  const dispatchReady = new Promise<string>((resolve) => {
    resolveDispatchReady = resolve;
  });
  let dataCallback: ((data: string) => void) | undefined;
  let exitCallback: ((exit: TerminalBackendExit) => void) | undefined;
  const pendingData = new BoundedBuffer<string>(
    MAX_PENDING_DATA_CHARS,
    { mode: "drop-oldest", fit: surrogateSafeTail },
    (chunk) => chunk.length,
  );
  let pendingExit: TerminalBackendExit | undefined;
  const abort = new AbortController();
  const result = params.registry
    .invoke({
      nodeId: params.nodeId,
      expectedConnId: params.expectedConnId,
      ...(params.expectedPairingGeneration
        ? { expectedPairingGeneration: params.expectedPairingGeneration }
        : {}),
      isDispatchAuthorized: params.isDispatchAuthorized,
      command: params.command,
      params: params.params,
      timeoutMs: 0,
      idleTimeoutMs: NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
      signal: abort.signal,
      onDispatchReady: resolveDispatchReady,
      onProgress: (chunk) => {
        if (!chunk) {
          return;
        }
        if (dataCallback) {
          dataCallback(chunk);
        } else {
          // Registration should be immediate, but bound this gap; repaint recovers after drops.
          pendingData.push(chunk);
        }
      },
    })
    .then(parseExit)
    .catch((error: unknown): TerminalBackendExit => ({
      error: error instanceof Error ? error.message : String(error),
    }))
    .then((exit) => {
      if (exitCallback) {
        exitCallback(exit);
      } else {
        pendingExit = exit;
      }
      return exit;
    });
  // Pairing-generation validation is asynchronous. Open only after the exact
  // admitted connection is dispatch-ready; a pre-dispatch failure wins instead.
  const activeInvokeId = await Promise.race([
    dispatchReady,
    result.then((exit) => {
      throw new Error(exit.error ?? "failed to start node terminal invoke");
    }),
  ]);
  const send = (payload: unknown) => params.registry.sendInvokeInput(activeInvokeId, payload);
  return {
    write(data) {
      for (const chunk of splitInput(data)) {
        send({ kind: "data", data: chunk });
      }
    },
    resize(cols, rows) {
      send({ kind: "resize", cols, rows });
    },
    // Node host pauses its PTY around each awaited progress write; this relay
    // has no local PTY or transport-level pause operation to control.
    pause() {},
    resume() {},
    kill() {
      abort.abort();
    },
    onData(callback) {
      dataCallback = callback;
      for (const chunk of pendingData.drain()) {
        callback(chunk);
      }
    },
    onExit(callback) {
      exitCallback = callback;
      if (pendingExit) {
        const exit = pendingExit;
        pendingExit = undefined;
        callback(exit);
      }
    },
  };
}
