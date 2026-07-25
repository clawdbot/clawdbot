// Memory Host SDK tests cover embedding worker process ownership edge cases.
import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const forkMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    fork: forkMock,
  };
});

import { createLocalEmbeddingWorkerProvider } from "./embeddings-worker.js";

beforeEach(() => {
  forkMock.mockReset();
});

it("terminates a disconnected live worker without forking a replacement", async () => {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    disconnect: vi.fn(function (this: { connected: boolean }) {
      this.connected = false;
    }),
    kill: vi.fn(function (
      this: EventEmitter & { signalCode: NodeJS.Signals | null },
      signal: NodeJS.Signals,
    ) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit("close", null, signal));
      return true;
    }),
    send: vi.fn(function (
      this: EventEmitter,
      message: { id: number },
      callback: (err?: Error | null) => void,
    ) {
      callback();
      queueMicrotask(() => this.emit("message", { id: message.id, ok: true }));
      return true;
    }),
  });
  forkMock.mockReturnValue(child);
  const provider = await createLocalEmbeddingWorkerProvider(
    { config: {} as never, provider: "local", model: "", fallback: "none" },
    { workerScriptPath: "/mock/worker.cjs" },
  );
  child.connected = false;

  await expect(provider.close?.()).resolves.toBeUndefined();

  expect(forkMock).toHaveBeenCalledTimes(1);
  expect(child.send).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
});
