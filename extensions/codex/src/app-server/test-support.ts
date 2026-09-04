/**
 * Shared Codex app-server test helpers for model fixtures and in-memory client
 * transports.
 */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { Model } from "openclaw/plugin-sdk/llm";
import { expect, vi } from "vitest";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { isJsonObject } from "./protocol.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
  type CodexAppServerClientFactory,
  type CodexAppServerClientOptions,
} from "./shared-client.js";

/** Minimal deterministic host terminal observer for Codex harness tests. */
export function createCodexTestToolTerminalObserver(): NonNullable<
  EmbeddedRunAttemptParams["observeToolTerminal"]
> {
  let lastToolError: ReturnType<
    NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]>
  >["lastToolError"];

  return (observation) => {
    const record =
      typeof observation.arguments === "object" && observation.arguments !== null
        ? (observation.arguments as Record<string, unknown>)
        : {};
    const action = typeof record.action === "string" ? record.action : undefined;
    const mutation = observation.nativeMutation ?? {
      mutatingAction: observation.toolName === "message" && action === "send",
      replaySafe: !(observation.toolName === "message" && action === "send"),
    };
    const executionStarted = observation.executionStarted !== false;
    if (observation.outcome === "failure") {
      const mutatingAction = executionStarted && mutation.mutatingAction;
      lastToolError = {
        toolName: observation.toolName,
        ...(observation.meta ? { meta: observation.meta } : {}),
        ...observation.failure,
        mutatingAction,
      };
    } else if (lastToolError?.toolName === observation.toolName) {
      lastToolError = undefined;
    }
    return {
      ...(lastToolError ? { lastToolError } : {}),
      executionStarted,
      ...(Object.keys(record).length > 0 ? { executedArguments: record } : {}),
      sideEffectEvidence: executionStarted && !mutation.replaySafe,
      effectReceipt: {
        state: !executionStarted
          ? "uncertain"
          : mutation.replaySafe
            ? observation.outcome === "success"
              ? "read_completed"
              : "failed_no_effect"
            : mutation.mutatingAction && observation.outcome === "success"
              ? "mutation_committed"
              : "uncertain",
      },
    };
  };
}

export { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";

/** Positional naked-client injection contract confined to tests. */
export type CodexTestAppServerClientFactory = (
  startOptions?: CodexAppServerClientOptions["startOptions"],
  authProfileId?: string,
  agentDir?: string,
  config?: CodexAppServerClientOptions["config"],
  options?: CodexAppServerClientOptions,
) => Promise<CodexAppServerClient>;

/** Adapts a positional test factory to the production options-object contract. */
export function adaptCodexTestClientFactory(
  factory: CodexTestAppServerClientFactory,
): CodexAppServerClientFactory {
  return (options) =>
    factory(
      options?.startOptions,
      options?.authProfileId ?? undefined,
      options?.agentDir,
      options?.config,
      options,
    );
}

/** Builds a representative Codex-capable model fixture for app-server tests. */
export function createCodexTestModel(provider = "openai", input = ["text"]): Model {
  return {
    id: "gpt-5.4-codex",
    name: "gpt-5.4-codex",
    provider,
    api: "openai-chatgpt-responses",
    input,
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_000,
  } as Model;
}

export async function waitForHarnessRequest(
  harness: ReturnType<typeof createClientHarness>,
  method: string,
  startIndex = 0,
): Promise<{ id: number | string; params?: unknown }> {
  let request: { id?: number | string; method?: string; params?: unknown } | undefined;
  await vi.waitFor(
    () => {
      request = harness.writes
        .slice(startIndex)
        .map(
          (write) =>
            JSON.parse(write) as { id?: number | string; method?: string; params?: unknown },
        )
        .find((message) => message.method === method);
      expect(
        request?.id,
        `expected ${method} after write ${startIndex}; observed ${JSON.stringify(
          harness.writes
            .slice(startIndex)
            .map((write) => (JSON.parse(write) as { method: string }).method),
        )}`,
      ).toBeDefined();
    },
    { interval: 1, timeout: 5_000 },
  );
  if (request?.id === undefined) {
    throw new Error(`Codex harness did not write ${method}`);
  }
  return { id: request.id, params: request.params };
}

/** Creates an in-memory Codex app-server client harness with writable stdout frames. */
export function createClientHarness(
  options: {
    autoEmitExit?: boolean;
    onWrite?: (line: string, send: (message: unknown) => void) => void;
  } = {},
) {
  const stdout = new PassThrough();
  const writes: string[] = [];
  const writeEvents = new EventEmitter();
  let stdinDestroyed = false;
  let exitEmitted = false;
  let emitProcessExit: () => void = () => undefined;
  const emitExit = () => {
    if (!exitEmitted) {
      exitEmitted = true;
      emitProcessExit();
    }
  };
  type HarnessProcess = EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => unknown;
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
      writeEvents.emit("write");
      options.onWrite?.(chunk.toString(), (message) =>
        stdout.write(`${JSON.stringify(message)}\n`),
      );
    },
  });
  const destroyStdin = stdin.destroy.bind(stdin);
  stdin.destroy = ((error?: Error) => {
    stdinDestroyed = true;
    const result = destroyStdin(error);
    if (!exitEmitted && options.autoEmitExit !== false) {
      // Let stdin surface pipe errors before the harness emits the fake child exit.
      // Otherwise close-reason tests can race EPIPE against a synthetic clean exit.
      setImmediate(emitExit);
    }
    return result;
  }) as typeof stdin.destroy;
  const process: HarnessProcess = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: vi.fn((_signal?: NodeJS.Signals) => {
      process.killed = true;
    }),
  });
  emitProcessExit = () => {
    process.emit("exit", 0, null);
  };
  // Record terminal state before client observers, including direct error/signal exits.
  // Otherwise later closeAndWait calls wait for an exit that already happened.
  process.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    exitEmitted = true;
    process.exitCode = code;
    process.signalCode = signal;
    stdin.destroy();
    // Let exit observers run before output reaches EOF.
    queueMicrotask(() => {
      for (const output of [stdout, process.stderr]) {
        output.end();
        output.resume();
      }
    });
  });
  const client = CodexAppServerClient.fromTransportForTests(process);
  return {
    client,
    process,
    writes,
    async waitForWrite(index: number): Promise<string> {
      if (writes[index] !== undefined) {
        return writes[index];
      }
      return await new Promise<string>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          writeEvents.off("write", onWrite);
        };
        const onWrite = () => {
          if (writes[index] !== undefined) {
            cleanup();
            resolve(writes[index]);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for app-server harness write ${index}`));
        }, 1_000);
        writeEvents.on("write", onWrite);
      });
    },
    get stdinDestroyed() {
      return stdinDestroyed;
    },
    emitExit,
    send(message: unknown) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}

/** External transport replies with a real initialize handshake and shared-client lease. */
export async function withLeasedCodexTestClient<T>(params: {
  agentDir: string;
  request: (method: string, params?: unknown) => Promise<unknown>;
  run: (client: CodexAppServerClient) => Promise<T>;
}): Promise<T> {
  const harness = createClientHarness({
    onWrite: (line, send) => {
      const message: unknown = JSON.parse(line);
      if (
        !isJsonObject(message) ||
        typeof message.method !== "string" ||
        message.id === undefined
      ) {
        return;
      }
      const result =
        message.method === "initialize"
          ? Promise.resolve({
              userAgent: "codex-cli/0.151.0",
              codexHome: resolveCodexAppServerHomeDir(params.agentDir),
            })
          : params.request(message.method, message.params);
      void result.then(
        (value) => send({ id: message.id, result: value }),
        (error: unknown) =>
          send({
            id: message.id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
    },
  });
  const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
  try {
    const client = await getLeasedSharedCodexAppServerClient({
      startOptions: resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { command: process.execPath, args: ["app-server"] } },
        codexConfigToml: null,
        requirementsToml: null,
      }).start,
      agentDir: params.agentDir,
      authProfileId: null,
    });
    try {
      return await params.run(client);
    } finally {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  } finally {
    start.mockRestore();
    await harness.client.closeAndWait();
  }
}
