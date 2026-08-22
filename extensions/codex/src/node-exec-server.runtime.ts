/** Owns approved, connection-bound Codex exec-server processes on paired nodes. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { killProcessTree } from "openclaw/plugin-sdk/process-runtime";
import { sanitizeEnvVars } from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import {
  isManagedCodexDesktopCommand,
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
} from "./app-server/managed-binary.js";
import { createStdioTransport } from "./app-server/transport-stdio.js";
import { closeCodexAppServerTransportAndWait } from "./app-server/transport.js";

const MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_EXEC_SERVER_STDERR_BYTES = 4 * 1024;
const CODEX_EXEC_SERVER_TERMINATION_GRACE_MS = 1_000;
const CODEX_EXEC_SERVER_REAP_TIMEOUT_MS = 5_000;
const NODE_EXEC_SERVER_PLATFORM_ENVIRONMENT =
  /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR)$/iu;

type CodexNodeExecProcessOwner = {
  terminate: () => Promise<void>;
};

function validateNodeExecServerMessage(message: Uint8Array): Buffer {
  if (message.byteLength === 0 || message.byteLength > MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES) {
    throw new Error("Codex exec-server JSON-RPC message exceeds its 64 MiB limit.");
  }
  const encoded = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  if (encoded.includes(0x0a) || encoded.includes(0x0d)) {
    throw new Error("Codex exec-server JSON-RPC frames must contain exactly one message.");
  }
  let decoded: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Codex exec-server received malformed UTF-8 or JSON-RPC.");
  }
  if (
    !isRecord(decoded) ||
    (decoded.jsonrpc !== undefined && decoded.jsonrpc !== "2.0") ||
    (typeof decoded.method !== "string" &&
      !("id" in decoded && ("result" in decoded || "error" in decoded)))
  ) {
    throw new Error("Codex exec-server received an invalid JSON-RPC message.");
  }
  return encoded;
}

function nodeExecServerAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex node exec-server connection closed.");
}

function writeNodeExecServerMessage(
  child: ChildProcessWithoutNullStreams,
  message: Buffer,
  signal: AbortSignal,
): Promise<void> | void {
  if (signal.aborted) {
    throw nodeExecServerAbortError(signal);
  }
  const payload = Buffer.concat([message, Buffer.from("\n")]);
  if (!child.stdin.write(payload)) {
    return once(child.stdin, "drain", { signal }).then(() => undefined);
  }
}

async function relayNodeExecServerOutput(
  child: ChildProcessWithoutNullStreams,
  send: (message: Uint8Array) => Promise<void>,
): Promise<void> {
  let fragments: Buffer[] = [];
  let pendingBytes = 0;
  for await (const rawChunk of child.stdout) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const fragment = chunk.subarray(offset, newline === -1 ? chunk.byteLength : newline);
      const nextLength = pendingBytes + fragment.byteLength;
      if (nextLength > MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES + 1) {
        throw new Error("Codex exec-server stdout message exceeds its 64 MiB limit.");
      }
      if (fragment.byteLength > 0) {
        fragments.push(fragment);
      }
      pendingBytes = nextLength;
      if (newline === -1) {
        if (
          pendingBytes > MAX_CODEX_EXEC_SERVER_MESSAGE_BYTES &&
          fragment[fragment.byteLength - 1] !== 0x0d
        ) {
          throw new Error("Codex exec-server stdout message exceeds its 64 MiB limit.");
        }
        break;
      }
      const trailing = fragments.at(-1);
      if (trailing?.[trailing.byteLength - 1] === 0x0d) {
        pendingBytes -= 1;
        if (trailing.byteLength === 1) {
          fragments.pop();
        } else {
          fragments[fragments.length - 1] = trailing.subarray(0, trailing.byteLength - 1);
        }
      }
      const pending =
        fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments, pendingBytes);
      const message = validateNodeExecServerMessage(pending);
      fragments = [];
      pendingBytes = 0;
      await send(message);
      offset = newline + 1;
    }
  }
  if (pendingBytes > 0) {
    throw new Error("Codex exec-server stdout ended with an unterminated JSON-RPC message.");
  }
}

function createNodeExecServerProcessOwner(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): CodexNodeExecProcessOwner {
  let termination: Promise<void> | undefined;
  return {
    terminate: () =>
      (termination ??= (async () => {
        // The shared transport closes only the root on Windows; taskkill /T
        // owns its descendants before that root can disappear.
        if (process.platform === "win32" && child.pid) {
          killProcessTree(child.pid, { graceMs: CODEX_EXEC_SERVER_TERMINATION_GRACE_MS });
        }
        const exited = await closeCodexAppServerTransportAndWait(child, {
          forceKillDelayMs: CODEX_EXEC_SERVER_TERMINATION_GRACE_MS,
          exitTimeoutMs: CODEX_EXEC_SERVER_REAP_TIMEOUT_MS,
        });
        if (!exited) {
          throw new Error("Codex node exec-server process tree did not terminate.");
        }
        await closed;
      })()),
  };
}

/** Runs the one-connection paired-node exec-server after lightweight command admission. */
export async function runCodexNodeExecServer(params: {
  workspaceDir: string;
  io: OpenClawPluginNodeHostCommandIo;
  activeProcesses: Set<() => Promise<void>>;
  onFrameReceiver: (receiver: (message: Uint8Array) => Promise<void> | void) => void;
}): Promise<string> {
  const { io } = params;
  const frames = io.frames;
  if (!frames) {
    throw new Error("Codex node exec-server requires duplex frames.");
  }
  const cwd = params.workspaceDir;
  let writes: Promise<void> | undefined;
  let rejectDisconnected!: (error: Error) => void;
  const disconnected = new Promise<never>((_resolve, reject) => {
    rejectDisconnected = reject;
  });
  void disconnected.catch(() => {});
  const onAbort = () => {
    const error = nodeExecServerAbortError(io.signal);
    rejectDisconnected(error);
  };
  io.signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (io.signal.aborted) {
      throw nodeExecServerAbortError(io.signal);
    }
    return await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "codex-node-exec-server-" },
      async ({ dir }) => {
        const codexHome = path.join(dir, ".codex");
        // Codex canonicalizes CODEX_HOME during startup and rejects missing directories.
        await mkdir(codexHome, { recursive: true, mode: 0o700 });
        const resolved = await resolveManagedCodexAppServerStartOptions({
          transport: "stdio",
          command: "codex",
          commandSource: "managed",
          managedCommandOrder: "package-first",
          args: ["exec-server", "--listen", "stdio"],
          headers: {},
        });
        const native = resolveManagedCodexNativeCommand(resolved.command);
        if (!native || isManagedCodexDesktopCommand(resolved.command)) {
          throw new Error("Codex node exec-server requires the pinned managed package binary.");
        }
        // The exec-server needs platform/locale basics, never provider, forge,
        // cloud, SSH-agent, XDG, or runtime-injection state from its node host.
        const baseEnv = sanitizeEnvVars(process.env, {
          strictMode: true,
          customAllowedPatterns: [NODE_EXEC_SERVER_PLATFORM_ENVIRONMENT],
        }).allowed;
        if (io.signal.aborted) {
          throw nodeExecServerAbortError(io.signal);
        }
        const child = createStdioTransport(
          {
            transport: "stdio",
            command: native,
            commandSource: "resolved-managed",
            args: resolved.args,
            headers: {},
            cwd,
            env: {
              HOME: dir,
              CODEX_HOME: codexHome,
              ...(process.platform === "win32" ? { USERPROFILE: dir } : {}),
            },
            clearEnv: ["NODE_OPTIONS"],
          },
          baseEnv,
        );
        child.stdin.on("error", (error) => {
          rejectDisconnected(error);
        });
        let stderr = Buffer.alloc(0);
        child.stderr.on("data", (chunk: Buffer | string) => {
          const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const bounded = next.subarray(-MAX_CODEX_EXEC_SERVER_STDERR_BYTES);
          stderr = Buffer.concat([stderr, bounded]).subarray(-MAX_CODEX_EXEC_SERVER_STDERR_BYTES);
        });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            child.once("close", (code, signal) => resolve({ code, signal }));
          },
        );
        child.once("error", (error) => {
          rejectDisconnected(error);
        });
        const owner = createNodeExecServerProcessOwner(child, closed);
        params.activeProcesses.add(owner.terminate);
        const output = relayNodeExecServerOutput(child, frames.send.bind(frames));
        void output.catch((error: unknown) => {
          rejectDisconnected(error instanceof Error ? error : new Error(String(error)));
        });
        try {
          if (io.signal.aborted) {
            throw nodeExecServerAbortError(io.signal);
          }
          // Registration publishes framed readiness; avoid promising it before
          // the child and every cleanup/error owner can consume incoming frames.
          params.onFrameReceiver((message) => {
            const encoded = validateNodeExecServerMessage(message);
            const operation = writes
              ? writes.then(() => writeNodeExecServerMessage(child, encoded, io.signal))
              : writeNodeExecServerMessage(child, encoded, io.signal);
            if (!operation) {
              return undefined;
            }
            const observed = operation.catch(() => {});
            writes = observed;
            void observed.then(() => {
              if (writes === observed) {
                writes = undefined;
              }
            });
            return operation;
          });
          const outcome = await Promise.race([closed, disconnected]);
          const diagnostic = stderr.toString("utf8").trim();
          throw new Error(
            `Codex node exec-server exited (code ${outcome.code ?? "none"}, signal ${outcome.signal ?? "none"})${diagnostic ? `: ${diagnostic}` : "."}`,
          );
        } finally {
          await owner.terminate();
          params.activeProcesses.delete(owner.terminate);
          await Promise.allSettled([output, ...(writes ? [writes] : [])]);
        }
      },
    );
  } finally {
    io.signal.removeEventListener("abort", onAbort);
  }
}
