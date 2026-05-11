import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { Api, Model } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import { CodexAppServerClient } from "./client.js";

export function createCodexTestModel(provider = "openai-codex", input = ["text"]): Model<Api> {
  return {
    id: "gpt-5.4-codex",
    name: "gpt-5.4-codex",
    provider,
    api: "openai-codex-responses",
    input,
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_000,
  } as Model<Api>;
}

export function createClientHarness() {
  const stdout = new PassThrough();
  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
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
    send(message: unknown) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}
