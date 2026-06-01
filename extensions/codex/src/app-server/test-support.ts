import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { Model } from "openclaw/plugin-sdk/llm";
import { vi } from "vitest";
import { CodexAppServerClient } from "./client.js";

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

export function createClientHarness() {
  const stdout = new PassThrough();
  const writes: string[] = [];
  let stdinDestroyed = false;
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
  const destroyStdin = stdin.destroy.bind(stdin);
  stdin.destroy = ((error?: Error) => {
    stdinDestroyed = true;
    return destroyStdin(error);
  }) as typeof stdin.destroy;
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(() => {
      process.killed = true;
    }),
  });
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
