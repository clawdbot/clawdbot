import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { vi } from "vitest";
import { CodexAppServerClient } from "./client.js";

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
