import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStubChild } from "./child.test-support.js";

const { spawnWithFallbackMock, signalProcessTreeMock } = vi.hoisted(() => ({
  spawnWithFallbackMock: vi.fn(),
  signalProcessTreeMock: vi.fn<typeof import("../../kill-tree.js").signalProcessTree>(),
}));

vi.mock("../../spawn-utils.js", () => ({
  spawnWithFallback: spawnWithFallbackMock,
}));

vi.mock("../../kill-tree.js", () => ({
  signalProcessTree: signalProcessTreeMock,
}));

vi.mock("../service-child-relay-host.js", () => ({
  createServiceChildRelayAdapter: vi.fn(),
}));

describe("createChildAdapter secret-delivery abort", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  let createChildAdapter: typeof import("./child.js").createChildAdapter;

  beforeEach(async () => {
    vi.resetModules();
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    ({ createChildAdapter } = await import("./child.js"));
    spawnWithFallbackMock.mockReset();
    signalProcessTreeMock.mockReset().mockImplementation((_pid, _signal, options) => {
      options?.onComplete?.();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("preserves startup failure when a worker error arrives during secret delivery", async () => {
    const { child, killMock, emitClose } = createStubChild();
    killMock.mockImplementation(() => {
      setImmediate(() => emitClose(null, "SIGKILL"));
      return true;
    });
    const deliveryError = new Error("secret delivery failed");
    const secretStream = new Writable({
      write(_chunk, _encoding, callback) {
        child.emit("error", new Error("worker IPC failed"));
        setImmediate(() => callback(deliveryError));
      },
    });
    Object.defineProperty(child, "stdio", {
      value: [child.stdin, child.stdout, child.stderr, secretStream, null],
      configurable: true,
    });
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const transient = Buffer.from("synthetic-secret");

    await expect(
      createChildAdapter({
        argv: ["node", "worker"],
        ownedWorker: true,
        secretInput: { fd: 3, createData: () => transient },
      }),
    ).rejects.toBe(deliveryError);
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
    expect(transient.equals(Buffer.alloc(transient.length))).toBe(true);
  });

  it("withholds input and secret bytes when request authority retires during spawn", async () => {
    const { child, killMock, emitClose } = createStubChild();
    const startup = createDeferred<{ child: typeof child; usedFallback: boolean }>();
    const secretStream = new PassThrough();
    const secretBytes = vi.fn();
    secretStream.on("data", secretBytes);
    Object.defineProperty(child, "stdio", {
      value: [child.stdin, child.stdout, child.stderr, secretStream],
      configurable: true,
    });
    const input = vi.spyOn(child.stdin!, "write");
    const createData = vi.fn(() => Buffer.from("synthetic-selected-secret"));
    spawnWithFallbackMock.mockReturnValueOnce(startup.promise);
    const retired = new Error("request authority retired during spawn");
    let current = true;
    const run = createChildAdapter({
      argv: ["agent-cli", "--prompt"],
      input: "private prompt",
      secretInput: { fd: 3, createData },
      assertCurrent: () => {
        if (!current) {
          throw retired;
        }
      },
    });
    const outcome = Promise.allSettled([run]);
    expect(spawnWithFallbackMock).toHaveBeenCalledOnce();
    current = false;
    startup.resolve({ child, usedFallback: false });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(killMock).toHaveBeenCalledWith("SIGKILL");
      emitClose(null, "SIGKILL");
      expect(await outcome).toEqual([{ status: "rejected", reason: retired }]);
      expect(createData).not.toHaveBeenCalled();
      expect(secretBytes).not.toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
    } finally {
      emitClose(0);
      secretStream.destroy();
      child.removeAllListeners();
    }
  });

  it("does not signal a retired child when secret delivery fails after close", async () => {
    const { child, emitClose, killMock } = createStubChild();
    const deliveryError = new Error("secret delivery failed after child close");
    const secretStream = new Writable({
      write(_chunk, _encoding, callback) {
        emitClose(0);
        setImmediate(() => callback(deliveryError));
      },
    });
    Object.defineProperty(child, "stdio", {
      value: [child.stdin, child.stdout, child.stderr, secretStream],
      configurable: true,
    });
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });

    await expect(
      createChildAdapter({
        argv: ["synthetic-command"],
        secretInput: { fd: 3, createData: () => Buffer.from("synthetic-secret") },
      }),
    ).rejects.toBe(deliveryError);
    expect(signalProcessTreeMock).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
  });

  it("joins child closure after tree-first cancellation of blocked secret delivery", async () => {
    signalProcessTreeMock.mockImplementationOnce(() => {});
    const { child, killMock, emitClose } = createStubChild();
    const secretStream = new Writable({
      write() {
        // Leave the secret pipe unread so construction stays blocked.
      },
    });
    Object.defineProperty(child, "stdio", {
      value: [child.stdin, child.stdout, child.stderr, secretStream],
      configurable: true,
    });
    spawnWithFallbackMock.mockResolvedValue({
      child,
      usedFallback: false,
    });
    const abort = new AbortController();
    const starting = createChildAdapter({
      argv: ["claude", "-p"],
      stdinMode: "pipe-open",
      secretInput: {
        fd: 3,
        createData: () => Buffer.from("selected-secret"),
      },
      abortSignal: abort.signal,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const outcome = Promise.allSettled([starting]);
    const settled = vi.fn();
    void outcome.then(settled);
    abort.abort();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(signalProcessTreeMock).toHaveBeenCalledWith(
      child.pid,
      "SIGKILL",
      expect.objectContaining({ detached: false }),
    );
    expect(killMock).not.toHaveBeenCalled();
    signalProcessTreeMock.mock.calls[0]?.[2]?.onComplete?.();
    await Promise.resolve();
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
    expect(settled).not.toHaveBeenCalled();

    emitClose(null, "SIGKILL");
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: expect.objectContaining({ message: "secret delivery aborted" }),
      },
    ]);
  });
});
