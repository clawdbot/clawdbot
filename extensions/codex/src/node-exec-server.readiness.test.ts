import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setManagedCodexPluginRoot } from "./app-server/managed-binary.js";
import * as transport from "./app-server/transport-stdio.js";
import { runCodexNodeExecServer } from "./node-exec-server.runtime.js";

// Pinned Codex 0.153.4 transport.rs emits this line before entering its stdio loop.
const READY = " INFO codex_exec_server::server::transport: codex-exec-server listening on stdio\n";
const fixture = `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.stderr !== undefined) process.stderr.write(Buffer.from(message.stderr, 'base64'));
  else if (message.exit !== undefined) process.exit(message.exit);
  else if (message.method === 'initialize') process.stdout.write(JSON.stringify({id: message.id, result: {sessionId: 'fixture'}}) + '\\n');
});
`;

beforeEach(() => setManagedCodexPluginRoot(fileURLToPath(new URL("../", import.meta.url))));
afterEach(() => {
  setManagedCodexPluginRoot(undefined);
  vi.restoreAllMocks();
});

async function startFixture(readyBeforeRegistrationReturns = false) {
  const controller = new AbortController();
  const receiver = vi.fn();
  const send = vi.fn(async (_message: Uint8Array) => {});
  const assertExecAuthorized = vi.fn();
  const activeProcesses = new Set<() => Promise<void>>();
  const io = {
    signal: controller.signal,
    emitChunk: async () => {},
    onInput: () => {},
    frames: { send, onMessage: () => () => {} },
  } satisfies OpenClawPluginNodeHostCommandIo;
  let resolveChild!: (child: ChildProcessWithoutNullStreams) => void;
  const childCreated = new Promise<ChildProcessWithoutNullStreams>((resolve) => {
    resolveChild = resolve;
  });
  let privateHome: string | undefined;
  const create = transport.createStdioTransport;
  vi.spyOn(transport, "createStdioTransport").mockImplementation(
    async (options, env, current, onSpawn) => {
      privateHome = options.env?.HOME;
      let earlyMarker: Promise<unknown> | undefined;
      const child = await create(
        { ...options, command: process.execPath, args: ["-e", fixture] },
        env,
        current,
        (spawned) => {
          onSpawn?.(spawned);
          if (readyBeforeRegistrationReturns) {
            earlyMarker = once(spawned.stderr, "data");
            spawned.once("spawn", () => {
              spawned.stdin.write(
                JSON.stringify({ stderr: Buffer.from(READY).toString("base64") }) + "\n",
              );
            });
          }
        },
      );
      await earlyMarker;
      resolveChild(child);
      return child;
    },
  );
  const invocation = runCodexNodeExecServer({
    workspaceDir: process.cwd(),
    io,
    activeProcesses,
    assertExecAuthorized,
    onFrameReceiver: receiver,
  });
  const outcome = invocation.catch((error: unknown) => error);
  const child = await Promise.race([
    childCreated,
    invocation.then(() => {
      throw new Error("fixture exited before spawn");
    }),
  ]);
  const stderr = async (text: string) => {
    const delivered = once(child.stderr, "data");
    child.stdin.write(JSON.stringify({ stderr: Buffer.from(text).toString("base64") }) + "\n");
    await delivered;
  };
  return {
    child,
    controller,
    receiver,
    send,
    assertExecAuthorized,
    activeProcesses,
    outcome,
    stderr,
    async cleanup() {
      controller.abort(new Error("fixture cleanup"));
      await outcome;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(activeProcesses.size).toBe(0);
      expect(privateHome).toBeDefined();
      await expect(access(privateHome!)).rejects.toThrow();
    },
  };
}

describe("Codex node native readiness", () => {
  it("retains native readiness emitted before process registration returns", async () => {
    const harness = await startFixture(true);
    try {
      await vi.waitFor(() => expect(harness.receiver).toHaveBeenCalledOnce());
    } finally {
      await harness.cleanup();
    }
  });
  it("withholds the carrier until the fragmented native-ready line and preserves the first initialize", async () => {
    const harness = await startFixture();
    try {
      await harness.stderr("loading native runtime\n");
      expect(harness.receiver).not.toHaveBeenCalled();
      for (const fragment of [READY.slice(0, 18), READY.slice(18, -1)]) {
        await harness.stderr(fragment);
        expect(harness.receiver).not.toHaveBeenCalled();
      }
      await harness.stderr("\n");
      await vi.waitFor(() => expect(harness.receiver).toHaveBeenCalledOnce());
      const receive = harness.receiver.mock.calls[0]![0] as (
        message: Buffer,
      ) => Promise<void> | void;
      await receive(Buffer.from(JSON.stringify({ id: 1, method: "initialize", params: {} })));
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledOnce());
      expect(JSON.parse(Buffer.from(harness.send.mock.calls[0]![0]).toString())).toEqual({
        id: 1,
        result: { sessionId: "fixture" },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it.each(["abort", "authority revoked", "early exit", "oversized line"])(
    "does not publish readiness after %s",
    async (failure) => {
      const harness = await startFixture();
      try {
        await harness.stderr("loading native runtime\n");
        expect(harness.receiver).not.toHaveBeenCalled();
        if (failure === "abort") {
          harness.controller.abort(new Error("startup canceled"));
        }
        if (failure === "authority revoked") {
          harness.assertExecAuthorized.mockImplementation(() => {
            throw new Error("authority revoked");
          });
          await harness.stderr(READY);
        }
        if (failure === "early exit") {
          harness.child.stdin.end(JSON.stringify({ exit: 7 }) + "\n");
        }
        if (failure === "oversized line") {
          await harness.stderr("x".repeat(4097));
        }
        const error = await harness.outcome;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/canceled|revoked|exited|diagnostic/i);
        expect(harness.receiver).not.toHaveBeenCalled();
      } finally {
        await harness.cleanup();
      }
    },
  );
});
