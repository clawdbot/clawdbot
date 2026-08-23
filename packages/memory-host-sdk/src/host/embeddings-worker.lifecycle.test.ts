// Memory Host SDK tests cover embedding worker process ownership edge cases.
import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const forkMock = vi.hoisted(() => vi.fn());
const accessMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, fork: forkMock };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, default: { ...actual, access: accessMock }, access: accessMock };
});

import { createLocalEmbeddingWorkerProvider } from "./embeddings-worker.js";

type WorkerMessage = { id: number; type?: string; text?: string };
type WorkerReply = { id: number; ok: boolean; value?: number[]; error?: string };
type MockWorkerChild = EventEmitter & {
  connected: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  disconnect: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

const LOCAL_PROVIDER_OPTIONS = {
  config: {} as never,
  provider: "local",
  model: "",
  fallback: "none",
} as const;

function createMockWorkerChild(
  options: {
    onKill?: (child: MockWorkerChild, signal: NodeJS.Signals) => boolean;
    onMessage?: (message: WorkerMessage, child: MockWorkerChild) => WorkerReply | null;
  } = {},
): MockWorkerChild {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    disconnect: vi.fn(),
    kill: vi.fn(),
    send: vi.fn(),
  }) as MockWorkerChild;
  child.disconnect.mockImplementation(() => {
    child.connected = false;
  });
  child.kill.mockImplementation((signal: NodeJS.Signals = "SIGTERM") => {
    if (options.onKill) {
      return options.onKill(child, signal);
    }
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  });
  child.send.mockImplementation(
    (message: WorkerMessage, callback: (err?: Error | null) => void) => {
      callback();
      const customReply = options.onMessage?.(message, child);
      const reply = customReply === undefined ? { id: message.id, ok: true } : customReply;
      if (reply) {
        queueMicrotask(() => child.emit("message", reply));
      }
      return true;
    },
  );
  return child;
}

function failWorkerKill(child: MockWorkerChild): boolean {
  queueMicrotask(() => child.emit("error", new Error("kill failed")));
  return false;
}

beforeEach(() => {
  forkMock.mockReset();
  accessMock.mockReset().mockRejectedValue(new Error("missing"));
});

it("forks workers through a stable Homebrew Node path", async () => {
  const originalExecPath = process.execPath;
  Object.defineProperty(process, "execPath", {
    configurable: true,
    value: "/opt/homebrew/Cellar/node/26.5.0/bin/node",
  });
  accessMock.mockImplementation(async (candidate: string) => {
    if (candidate === "/opt/homebrew/opt/node/bin/node") {
      return;
    }
    throw new Error("missing");
  });
  const child = createMockWorkerChild();
  forkMock.mockReturnValue(child);

  try {
    const provider = await createLocalEmbeddingWorkerProvider(LOCAL_PROVIDER_OPTIONS, {
      workerScriptPath: "/mock/worker.cjs",
    });

    expect(forkMock).toHaveBeenCalledWith(
      "/mock/worker.cjs",
      [],
      expect.objectContaining({ execPath: "/opt/homebrew/opt/node/bin/node" }),
    );
    await expect(provider.close?.()).resolves.toBeUndefined();
  } finally {
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: originalExecPath,
    });
  }
});

it("keeps an active worker alive when a queued embedding request is aborted", async () => {
  let completeActiveRequest: (() => void) | undefined;
  const child = createMockWorkerChild({
    onMessage: (message, emitter) => {
      if (message.type === "embedQuery" && message.text === "active") {
        completeActiveRequest = () => {
          emitter.emit("message", { id: message.id, ok: true, value: [1, 0] });
        };
        return null;
      }
      return {
        id: message.id,
        ok: true,
        ...(message.type === "embedQuery" ? { value: [0, 1] } : {}),
      };
    },
  });
  forkMock.mockReturnValue(child);
  const provider = await createLocalEmbeddingWorkerProvider(LOCAL_PROVIDER_OPTIONS, {
    workerScriptPath: "/mock/worker.cjs",
  });
  const activeRequest = provider.embedQuery("active");
  await vi.waitFor(() => expect(completeActiveRequest).toBeDefined());

  const controller = new AbortController();
  const queuedRequest = provider.embedQuery("queued", { signal: controller.signal });
  controller.abort(new Error("queued embedding cancelled"));

  await expect(queuedRequest).rejects.toThrow("queued embedding cancelled");
  expect(child.send).toHaveBeenCalledTimes(2);
  expect(child.kill).not.toHaveBeenCalled();

  completeActiveRequest?.();
  await expect(activeRequest).resolves.toEqual([1, 0]);
  await expect(provider.embedQuery("after cancellation")).resolves.toEqual([0, 1]);

  expect(forkMock).toHaveBeenCalledTimes(1);
  expect(child.send).toHaveBeenCalledTimes(3);
  expect(child.kill).not.toHaveBeenCalled();
  await expect(provider.close?.()).resolves.toBeUndefined();
});

it("terminates a disconnected live worker without forking a replacement", async () => {
  const child = createMockWorkerChild();
  forkMock.mockReturnValue(child);
  const provider = await createLocalEmbeddingWorkerProvider(LOCAL_PROVIDER_OPTIONS, {
    workerScriptPath: "/mock/worker.cjs",
  });
  child.connected = false;

  await expect(provider.close?.()).resolves.toBeUndefined();

  expect(forkMock).toHaveBeenCalledTimes(1);
  expect(child.send).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
});

it("drains failed construction clients before forking another worker", async () => {
  const failedChild = createMockWorkerChild({
    onKill: failWorkerKill,
    onMessage: (message) =>
      message.type === "initialize"
        ? { id: message.id, ok: false, error: "initialization failed" }
        : { id: message.id, ok: true },
  });
  const replacementChild = createMockWorkerChild();
  forkMock.mockReturnValueOnce(failedChild).mockReturnValueOnce(replacementChild);

  await expect(
    createLocalEmbeddingWorkerProvider(LOCAL_PROVIDER_OPTIONS, {
      workerScriptPath: "/mock/worker.cjs",
    }),
  ).rejects.toThrow("initialization failed");
  expect(forkMock).toHaveBeenCalledTimes(1);

  failedChild.kill.mockImplementationOnce((signal: NodeJS.Signals = "SIGTERM") => {
    failedChild.signalCode = signal;
    queueMicrotask(() => failedChild.emit("close", null, signal));
    return true;
  });
  const provider = await createLocalEmbeddingWorkerProvider(LOCAL_PROVIDER_OPTIONS, {
    workerScriptPath: "/mock/worker.cjs",
  });
  expect(forkMock).toHaveBeenCalledTimes(2);

  await expect(provider.close?.()).resolves.toBeUndefined();
});

it("retries failed construction cleanup without another provider creation", async () => {
  const failedChild = createMockWorkerChild({
    onKill: failWorkerKill,
    onMessage: (message) =>
      message.type === "initialize"
        ? { id: message.id, ok: false, error: "initialization failed" }
        : { id: message.id, ok: true },
  });
  forkMock.mockReturnValue(failedChild);

  await expect(
    createLocalEmbeddingWorkerProvider(LOCAL_PROVIDER_OPTIONS, {
      workerScriptPath: "/mock/worker.cjs",
    }),
  ).rejects.toThrow("initialization failed");
  expect(forkMock).toHaveBeenCalledTimes(1);

  failedChild.kill.mockImplementationOnce((signal: NodeJS.Signals = "SIGTERM") => {
    failedChild.signalCode = signal;
    queueMicrotask(() => failedChild.emit("close", null, signal));
    return true;
  });
  await vi.waitFor(() => expect(failedChild.kill).toHaveBeenCalledTimes(3), { timeout: 2_000 });

  expect(forkMock).toHaveBeenCalledTimes(1);
  expect(failedChild.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"], ["SIGTERM"]]);
});

it("retries failed provider close without another owner call", async () => {
  const child = createMockWorkerChild({ onKill: failWorkerKill });
  forkMock.mockReturnValue(child);
  const provider = await createLocalEmbeddingWorkerProvider(LOCAL_PROVIDER_OPTIONS, {
    workerScriptPath: "/mock/worker.cjs",
  });

  await expect(provider.close?.()).rejects.toThrow("did not exit after SIGKILL");
  child.kill.mockImplementationOnce((signal: NodeJS.Signals = "SIGTERM") => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  });
  await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(3), { timeout: 2_000 });

  expect(forkMock).toHaveBeenCalledTimes(1);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"], ["SIGTERM"]]);
});
