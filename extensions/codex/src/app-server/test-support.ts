/**
 * Shared Codex app-server test helpers for model fixtures and in-memory client
 * transports.
 */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { Model } from "openclaw/plugin-sdk/llm";
import { vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerClientFactory, CodexAppServerClientOptions } from "./shared-client.js";

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

/** Creates an in-memory Codex app-server client harness with writable stdout frames. */
export function createClientHarness(options: { autoEmitExit?: boolean } = {}) {
  const stdout = new PassThrough();
  const writes: string[] = [];
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
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => unknown;
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
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
    killed: false,
    kill: vi.fn((_signal?: NodeJS.Signals) => {
      process.killed = true;
    }),
  });
  emitProcessExit = () => {
    process.emit("exit", 0, null);
  };
  const client = CodexAppServerClient.fromTransportForTests(process);
  return {
    client,
    process,
    writes,
    get stdinDestroyed() {
      return stdinDestroyed;
    },
    emitExit,
    send(message: unknown) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}
