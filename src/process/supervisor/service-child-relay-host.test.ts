import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as childAdapter from "./adapters/child.js";
import { createStubChild, firstMockArg } from "./adapters/child.test-support.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorPayload,
} from "./service-child-protocol.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";
import { createProcessSupervisor } from "./supervisor.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

let platformMock: ReturnType<typeof mockProcessPlatform> | undefined;
const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  await nextTurn();
  platformMock?.mockRestore();
  platformMock = undefined;
  mocks.spawn.mockReset();
  vi.restoreAllMocks();
});

async function createRelay(platform: "linux" | "darwin" | "win32") {
  platformMock = mockProcessPlatform(platform);
  const groupProbe = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("synthetic missing process group"), { code: "ESRCH" });
  });
  const stub = createStubChild();
  const cancellations: Array<(error: Error) => void> = [];
  // Keep channel closure independently controlled from cancellation write completion.
  const control = new Duplex({
    autoDestroy: false,
    read() {},
    write(_chunk, _encoding, callback) {
      cancellations.push(callback);
    },
  });
  Object.defineProperty(stub.child, "stdio", {
    value: [stub.child.stdin, stub.child.stdout, stub.child.stderr, control],
    configurable: true,
  });
  if (platform === "win32") {
    stub.child.stdout = null;
    stub.child.stderr = null;
  }
  mocks.spawn.mockReturnValue(stub.child);
  const starting = createServiceChildRelayAdapter({
    command: "synthetic-command",
    args: [],
    stdinMode: "pipe-closed",
    oomScoreWrapperSelected: false,
    ...(platform === "win32" ? { windowsShellCommand: "synthetic-command" } : {}),
  });
  const start = firstMockArg(stub.sendMock, "service start");
  if (!isRecord(start) || typeof start.generation !== "string") {
    throw new Error("Expected an admitted service generation");
  }
  const generation = start.generation;
  let sequence = 0;
  const emit = (payload: ServiceChildAnchorPayload) => {
    const message = { ...payload, generation, sequence: ++sequence };
    if (platform === "win32") {
      stub.child.emit("message", message);
    } else {
      control.push(Buffer.from(encodeServiceChildMessage(message)));
    }
  };
  emit({ type: "ready", commandPid: 1234, anchorPid: 1235 });
  const adapter = await starting;
  if (platform === "win32") {
    stub.sendMock.mockImplementation((_message, ...args) => {
      const callback = args.find(
        (value): value is (error: Error) => void => typeof value === "function",
      );
      if (!callback) {
        throw new Error("Expected a cancellation delivery callback");
      }
      cancellations.push(callback);
      return true;
    });
  }
  const endOutput = () => {
    if (platform === "win32") {
      emit({ type: "output-end", stream: "stdout" });
      emit({ type: "output-end", stream: "stderr" });
    } else {
      stub.child.stdout?.emit("end");
      stub.child.stderr?.emit("end");
    }
  };
  const completeRoot = () => {
    emit({ type: "root-result", code: 0, signal: null });
    endOutput();
  };
  const closeControl = () => control.destroy();
  const exitRelay = () => {
    stub.disconnectMock();
    stub.emitExit(0);
  };
  const close = () => {
    closeControl();
    exitRelay();
  };
  const floodControl = (chunk: string | Buffer) => {
    control.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };
  const controlEncoding = () => control.readableEncoding;
  const killSpy = vi.spyOn(stub.child, "kill");
  cleanups.push(close);
  return {
    adapter,
    cancellations,
    emit,
    completeRoot,
    endOutput,
    close,
    closeControl,
    exitRelay,
    floodControl,
    controlEncoding,
    killSpy,
    groupProbe,
  };
}

function createWritableRelayChild() {
  const stub = createStubChild();
  const control = new Duplex({
    autoDestroy: false,
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  Object.defineProperty(stub.child, "stdio", {
    value: [stub.child.stdin, stub.child.stdout, stub.child.stderr, control],
    configurable: true,
  });
  mocks.spawn.mockReturnValue(stub.child);
  return { ...stub, control };
}

it.each([
  { name: "construction aborts before ready", deferredStart: false },
  { name: "deferred start delivery fails after abort", deferredStart: true },
])("reports cleanup uncertainty when $name", async ({ deferredStart }) => {
  platformMock = mockProcessPlatform("linux");
  const stub = createWritableRelayChild();
  const startCallbacks: Array<(error: Error | null) => void> = [];
  if (deferredStart) {
    stub.sendMock.mockImplementation((_message, ...args) => {
      const callback = args.findLast(
        (value): value is (error: Error | null) => void => typeof value === "function",
      );
      if (!callback) {
        throw new Error("Expected a start delivery callback");
      }
      startCallbacks.push(callback);
      return true;
    });
  }
  const abort = new AbortController();
  const starting = createServiceChildRelayAdapter({
    command: "synthetic-command",
    args: [],
    stdinMode: "pipe-closed",
    oomScoreWrapperSelected: false,
    abortSignal: abort.signal,
  });
  await nextTurn();
  expect(stub.killMock).not.toHaveBeenCalled();
  if (deferredStart) {
    expect(startCallbacks).toHaveLength(1);
  }

  abort.abort();
  const rejected = expect(starting).rejects.toThrow("service child cleanup identity lost");
  if (deferredStart) {
    startCallbacks[0]!(new Error("synthetic start delivery failed"));
  }
  await rejected;
  expect(stub.killMock).toHaveBeenCalledWith("SIGKILL");
  await nextTurn();
  stub.control.destroy();
  stub.emitExit(null, "SIGKILL");
});

it.each(["linux", "win32"] as const)(
  "keeps rejected construction ownership failures visible to supervisor joins (%s)",
  async (platform) => {
    platformMock = mockProcessPlatform(platform);
    const stub = createWritableRelayChild();
    const supervisor = createProcessSupervisor();
    const scopeKey = "scope:rejected-construction";
    const cleanupScope = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
    const pending = supervisor.spawn({
      runId: "rejected-construction",
      mode: "anchored-shell",
      command: "synthetic-command",
      scopeKey,
    });
    await nextTurn();
    supervisor.cancel("rejected-construction");
    const run = await pending;
    await expect(run.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
    const outcomes = Promise.allSettled([cleanupScope(), supervisor.shutdown()]);
    stub.control.destroy();
    stub.disconnectMock();
    stub.emitExit(null, "SIGKILL");

    for (const outcome of await outcomes) {
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("service child cleanup identity lost"),
        }),
      });
    }
    await expect(cleanupScope()).rejects.toThrow("cleanup identity lost");
    await expect(supervisor.shutdown()).rejects.toThrow("cleanup identity lost");
  },
);

it("refreshes the supervisor deadline from text-only Windows Job output", async () => {
  const { adapter, emit, completeRoot, close } = await createRelay("win32");
  vi.spyOn(childAdapter, "createChildAdapter").mockResolvedValue(adapter);
  const nowSpy = vi.spyOn(performance, "now").mockReturnValue(10_000);
  const supervisor = createProcessSupervisor();
  const run = await supervisor.spawn({
    mode: "anchored-shell",
    command: "synthetic-command",
    noOutputTimeoutMs: 1_000,
  });
  try {
    nowSpy.mockReturnValue(10_800);
    emit({ type: "output", stream: "stdout", chunk: "still running" });
    nowSpy.mockReturnValue(11_600);
    completeRoot();
    await expect(run.wait()).resolves.toMatchObject({
      reason: "exit",
      noOutputTimedOut: false,
      stdout: "still running",
    });
  } finally {
    completeRoot();
    emit({ type: "closing", reason: "lineage-closed" });
    close();
    await run.wait();
    await run.waitForExtinction!();
    await supervisor.shutdown();
  }
});

it.each([
  { label: "ASCII", chunk: "x".repeat(64 * 1024), overflow: "x" },
  { label: "multibyte UTF-8", chunk: "é".repeat(32 * 1024), overflow: "é" },
])("caps an accumulated $label control line by wire bytes", async ({ chunk, overflow }) => {
  const { adapter, floodControl, killSpy, close } = await createRelay("linux");
  const rejectedWait = expect(adapter.wait()).rejects.toThrow(
    "control pipe pending line exceeded cap",
  );
  const rejectedExtinction = expect(adapter.waitForExtinction()).rejects.toThrow(
    "control pipe pending line exceeded cap",
  );
  for (let index = 0; index < 4; index += 1) {
    floodControl(chunk);
  }
  expect(killSpy).not.toHaveBeenCalled();
  floodControl(overflow);
  await rejectedWait;
  await rejectedExtinction;
  expect(killSpy).toHaveBeenCalledWith("SIGKILL");
  close();
});

it.each([
  { label: "ASCII", chunk: "x".repeat(64 * 1024), overflow: "x" },
  { label: "multibyte UTF-8", chunk: "é".repeat(32 * 1024), overflow: "é" },
])("caps a completed $label control line before decoding", async ({ chunk, overflow }) => {
  const { adapter, floodControl, controlEncoding, killSpy, close } = await createRelay("linux");
  const parseSpy = vi.spyOn(JSON, "parse");
  expect(controlEncoding()).toBeNull();
  floodControl(`${chunk.repeat(4)}${overflow}\n`);
  await expect(adapter.wait()).rejects.toThrow("control pipe pending line exceeded cap");
  await expect(adapter.waitForExtinction()).rejects.toThrow(
    "control pipe pending line exceeded cap",
  );
  expect(parseSpy).not.toHaveBeenCalled();
  expect(killSpy).toHaveBeenCalledWith("SIGKILL");
  close();
});

it("bounds the newline search before inspecting an oversized control frame", async () => {
  const { adapter, floodControl, killSpy, close } = await createRelay("linux");
  const frame = Buffer.alloc(256 * 1024 + 2, 0x78);
  frame[frame.length - 1] = 0x0a;
  const fullFrameSearch = vi.spyOn(frame, "indexOf");

  floodControl(frame);

  await expect(adapter.wait()).rejects.toThrow("control pipe pending line exceeded cap");
  await expect(adapter.waitForExtinction()).rejects.toThrow(
    "control pipe pending line exceeded cap",
  );
  expect(fullFrameSearch).not.toHaveBeenCalled();
  expect(killSpy).toHaveBeenCalledWith("SIGKILL");
  close();
});

describe.each(["linux", "win32"] as const)("service closing authority (%s)", (platform) => {
  it.each([false, true])(
    "keeps root knowledge independent of failed extinction (root observed=%s)",
    async (rootObserved) => {
      const { adapter, completeRoot, close } = await createRelay(platform);
      adapter.kill("SIGTERM");
      if (rootObserved) {
        completeRoot();
      }
      await nextTurn();
      close();
      await expect(adapter.waitForExtinction()).rejects.toThrow("cleanup identity lost");
      if (rootObserved) {
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
      } else {
        await expect(adapter.wait()).rejects.toThrow("cleanup identity lost");
      }
    },
  );

  it("publishes root exit before output drain and replays it to late observers", async () => {
    const { adapter, emit, completeRoot, close } = await createRelay(platform);
    const onExit = vi.fn();
    adapter.onExit(onExit);
    emit({ type: "root-result", code: 0, signal: null });
    // POSIX stream delivery is asynchronous; the observer itself runs within
    // the root-result handler, independently of output completion.
    if (platform === "linux") {
      await nextTurn();
    }
    expect(onExit).toHaveBeenCalledExactlyOnceWith(0, null);
    const lateExit = vi.fn();
    adapter.onExit(lateExit);
    expect(lateExit).toHaveBeenCalledExactlyOnceWith(0, null);
    completeRoot();
    await adapter.wait();
    emit({ type: "closing", reason: "lineage-closed" });
    close();
    await adapter.waitForExtinction();
  });

  it.each(["after receipt", "before receipt"])(
    "preserves confirmed extinction when cancellation starts %s",
    async (order) => {
      const { adapter, cancellations, emit, completeRoot, close } = await createRelay(platform);
      completeRoot();
      await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
      const extinction = adapter.waitForExtinction();
      const settled = vi.fn();
      void extinction.then(settled, settled);
      if (order === "after receipt") {
        emit({ type: "closing", reason: "lineage-closed" });
        adapter.kill();
        expect(cancellations).toHaveLength(0);
      } else {
        adapter.kill();
        expect(cancellations).toHaveLength(1);
        emit({ type: "closing", reason: "lineage-closed" });
        cancellations[0]!(new Error("synthetic closed control channel"));
      }
      await nextTurn();
      expect(settled).not.toHaveBeenCalled();
      close();
      await expect(extinction).resolves.toBeUndefined();
      await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    },
  );

  it.each(["failed cancellation", "channel close"])(
    "rejects %s without an authoritative closing receipt",
    async (fault) => {
      const { adapter, cancellations, completeRoot, close } = await createRelay(platform);
      const onError = vi.fn();
      adapter.onError(onError);
      completeRoot();
      const rejected = expect(adapter.waitForExtinction()).rejects.toThrow(
        "service child cleanup identity lost",
      );
      if (fault === "failed cancellation") {
        adapter.kill();
        cancellations[0]!(new Error("synthetic closed control channel"));
      } else {
        close();
      }
      await rejected;
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("cleanup identity lost") }),
        "process",
      );
    },
  );
});

it("drains output after losing cleanup authority without erasing the observed root", async () => {
  const { adapter, emit, endOutput, close } = await createRelay("linux");
  adapter.kill("SIGTERM");
  emit({ type: "root-result", code: 23, signal: null });
  await nextTurn();
  const root = adapter.wait();
  const settled = vi.fn();
  void root.then(settled, settled);
  close();
  await expect(adapter.waitForExtinction()).rejects.toThrow("cleanup identity lost");
  expect(settled).not.toHaveBeenCalled();
  endOutput();
  await expect(root).resolves.toEqual({ code: 23, signal: null });
});

it("waits for relay reaping before observing POSIX group extinction", async () => {
  const { adapter, completeRoot, emit, closeControl, exitRelay, groupProbe } =
    await createRelay("darwin");
  groupProbe.mockImplementation(() => {
    throw Object.assign(new Error("synthetic unreaped anchor group"), { code: "EPERM" });
  });
  completeRoot();
  await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
  emit({ type: "closing", reason: "lineage-closed" });
  await nextTurn();
  const settled = vi.fn();
  const extinction = adapter.waitForExtinction();
  void extinction.then(settled, settled);

  closeControl();
  await nextTurn();
  expect(settled).not.toHaveBeenCalled();
  expect(groupProbe).not.toHaveBeenCalled();

  groupProbe.mockImplementation(() => {
    throw Object.assign(new Error("synthetic reaped anchor group"), { code: "ESRCH" });
  });
  exitRelay();
  await expect(extinction).resolves.toBeUndefined();
  expect(groupProbe).toHaveBeenCalledExactlyOnceWith(-1235, 0);
});

it("does not renew the group disappearance deadline after joining the relay", async () => {
  const { adapter, completeRoot, emit, closeControl, exitRelay, groupProbe } =
    await createRelay("darwin");
  const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
  groupProbe.mockReturnValue(true);
  completeRoot();
  await adapter.wait();
  emit({ type: "closing", reason: "lineage-closed" });
  await nextTurn();
  const settled = vi.fn();
  void adapter.waitForExtinction().then(settled, settled);

  closeControl();
  await nextTurn();
  expect(groupProbe).not.toHaveBeenCalled();
  now.mockReturnValue(10_000 + GRACEFUL_CANCEL_TIMEOUT_MS);
  exitRelay();
  await nextTurn();

  expect(settled).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      message: expect.stringContaining("owned process group remained after its anchor closed"),
    }),
  );
  expect(groupProbe).toHaveBeenCalledExactlyOnceWith(-1235, 0);
});

it("bounds relay reaping by the original graceful cleanup deadline", async () => {
  const { adapter, completeRoot, emit, closeControl, groupProbe } = await createRelay("darwin");
  completeRoot();
  await adapter.wait();
  emit({ type: "closing", reason: "lineage-closed" });
  await nextTurn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const rejected = expect(adapter.waitForExtinction()).rejects.toThrow(
      "service child relay did not exit before cleanup deadline",
    );
    closeControl();
    await nextTurn();
    await vi.advanceTimersByTimeAsync(GRACEFUL_CANCEL_TIMEOUT_MS);
    await rejected;
    expect(groupProbe).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.each(["EPERM", "EIO", "still present"])(
  "keeps graceful cleanup uncertain when the kernel group is %s",
  async (failure) => {
    const { adapter, completeRoot, emit, close, groupProbe } = await createRelay("linux");
    const cause =
      failure === "still present"
        ? undefined
        : Object.assign(new Error(`synthetic ${failure}`), { code: failure });
    groupProbe.mockImplementation(() => {
      if (cause) {
        throw cause;
      }
      return true;
    });
    completeRoot();
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    emit({ type: "closing", reason: "lineage-closed" });
    await nextTurn();
    // Exhaust the bounded observation window without waiting on real process time.
    vi.spyOn(Date, "now").mockReturnValueOnce(10_000).mockReturnValue(15_000);
    close();
    await expect(adapter.waitForExtinction()).rejects.toThrow("owned process group");
    await expect(adapter.waitForExtinction()).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && error.cause === cause,
    );
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    expect(groupProbe).toHaveBeenCalledWith(-1235, 0);
    expect(groupProbe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  },
);

it("retains extinction ownership until the kernel group disappears", async () => {
  const { adapter, completeRoot, emit, close, groupProbe } = await createRelay("linux");
  groupProbe.mockReturnValueOnce(true);
  completeRoot();
  await adapter.wait();
  const settled = vi.fn();
  const extinction = adapter.waitForExtinction().then(settled);
  emit({ type: "closing", reason: "lineage-closed" });
  await nextTurn();
  expect(groupProbe).not.toHaveBeenCalled();
  close();
  await nextTurn();
  expect(settled).not.toHaveBeenCalled();
  await extinction;
  expect(groupProbe.mock.calls).toEqual([
    [-1235, 0],
    [-1235, 0],
  ]);
});
