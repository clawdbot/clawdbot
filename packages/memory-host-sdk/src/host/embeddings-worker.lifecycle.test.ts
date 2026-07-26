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

it("drains failed construction clients before forking another worker", async () => {
  const failedChild = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    disconnect: vi.fn(function (this: { connected: boolean }) {
      this.connected = false;
    }),
    kill: vi.fn(function (this: EventEmitter, _signal?: NodeJS.Signals) {
      queueMicrotask(() => this.emit("error", new Error("kill failed")));
      return false;
    }),
    send: vi.fn(function (
      this: EventEmitter,
      message: { id: number; type: string },
      callback: (err?: Error | null) => void,
    ) {
      callback();
      queueMicrotask(() =>
        this.emit(
          "message",
          message.type === "initialize"
            ? { id: message.id, ok: false, error: "initialization failed" }
            : { id: message.id, ok: true },
        ),
      );
      return true;
    }),
  });
  const replacementChild = Object.assign(new EventEmitter(), {
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
  forkMock.mockReturnValueOnce(failedChild).mockReturnValueOnce(replacementChild);
  const options = { config: {} as never, provider: "local", model: "", fallback: "none" };

  await expect(
    createLocalEmbeddingWorkerProvider(options, { workerScriptPath: "/mock/worker.cjs" }),
  ).rejects.toThrow("initialization failed");
  expect(forkMock).toHaveBeenCalledTimes(1);

  failedChild.kill.mockImplementationOnce(function (
    this: typeof failedChild,
    signal: NodeJS.Signals = "SIGTERM",
  ) {
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  });
  const provider = await createLocalEmbeddingWorkerProvider(options, {
    workerScriptPath: "/mock/worker.cjs",
  });
  expect(forkMock).toHaveBeenCalledTimes(2);

  await expect(provider.close?.()).resolves.toBeUndefined();
});

it("retries failed construction cleanup without another provider creation", async () => {
  const failedChild = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    disconnect: vi.fn(function (this: { connected: boolean }) {
      this.connected = false;
    }),
    kill: vi.fn(function (this: EventEmitter, _signal?: NodeJS.Signals) {
      queueMicrotask(() => this.emit("error", new Error("kill failed")));
      return false;
    }),
    send: vi.fn(function (
      this: EventEmitter,
      message: { id: number; type: string },
      callback: (err?: Error | null) => void,
    ) {
      callback();
      queueMicrotask(() =>
        this.emit(
          "message",
          message.type === "initialize"
            ? { id: message.id, ok: false, error: "initialization failed" }
            : { id: message.id, ok: true },
        ),
      );
      return true;
    }),
  });
  forkMock.mockReturnValue(failedChild);

  await expect(
    createLocalEmbeddingWorkerProvider(
      { config: {} as never, provider: "local", model: "", fallback: "none" },
      { workerScriptPath: "/mock/worker.cjs" },
    ),
  ).rejects.toThrow("initialization failed");
  expect(forkMock).toHaveBeenCalledTimes(1);

  failedChild.kill.mockImplementationOnce(function (
    this: typeof failedChild,
    signal: NodeJS.Signals = "SIGTERM",
  ) {
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  });
  await vi.waitFor(() => expect(failedChild.kill).toHaveBeenCalledTimes(3), { timeout: 2_000 });

  expect(forkMock).toHaveBeenCalledTimes(1);
  expect(failedChild.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"], ["SIGTERM"]]);
});

it("retries failed provider close without another owner call", async () => {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    disconnect: vi.fn(function (this: { connected: boolean }) {
      this.connected = false;
    }),
    kill: vi.fn(function (this: EventEmitter, _signal?: NodeJS.Signals) {
      queueMicrotask(() => this.emit("error", new Error("kill failed")));
      return false;
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

  await expect(provider.close?.()).rejects.toThrow("did not exit after SIGKILL");
  child.kill.mockImplementationOnce(function (
    this: typeof child,
    signal: NodeJS.Signals = "SIGTERM",
  ) {
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  });
  await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(3), { timeout: 2_000 });

  expect(forkMock).toHaveBeenCalledTimes(1);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"], ["SIGTERM"]]);
});
