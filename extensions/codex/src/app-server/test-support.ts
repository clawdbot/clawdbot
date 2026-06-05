/**
 * Shared Codex app-server test helpers for model fixtures and in-memory client
 * transports.
 */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { Model } from "openclaw/plugin-sdk/llm";
import { vi } from "vitest";
import { CodexAppServerClient } from "./client.js";

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
export function createClientHarness() {
  const stdout = new PassThrough();
  const writes: string[] = [];
  let stdinDestroyed = false;
  let exitEmitted = false;
  let emitProcessExit: () => void = () => undefined;
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
    if (!exitEmitted) {
      exitEmitted = true;
      // Let stdin surface pipe errors before the harness emits the fake child exit.
      // Otherwise close-reason tests can race EPIPE against a synthetic clean exit.
      setImmediate(emitProcessExit);
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
    send(message: unknown) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}
