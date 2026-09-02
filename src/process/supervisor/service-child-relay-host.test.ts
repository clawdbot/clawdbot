import { Duplex } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { createStubChild, firstMockArg } from "./adapters/child.test-support.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorPayload,
} from "./service-child-protocol.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";

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
});

async function createRelay(platform: "linux" | "win32") {
  platformMock = mockProcessPlatform(platform);
  const stub = createStubChild();
  stub.child.unref = vi.fn();
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
      control.emit("data", encodeServiceChildMessage(message));
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
  emit({ type: "root-result", code: 0, signal: null });
  if (platform === "win32") {
    emit({ type: "output-end", stream: "stdout" });
    emit({ type: "output-end", stream: "stderr" });
  } else {
    stub.child.stdout?.emit("end");
    stub.child.stderr?.emit("end");
  }
  const close = () => {
    control.destroy();
    stub.disconnectMock();
    stub.emitExit(0);
  };
  cleanups.push(close);
  return { adapter, cancellations, emit, close };
}

describe.each(["linux", "win32"] as const)("service closing authority (%s)", (platform) => {
  it.each(["after receipt", "before receipt"])(
    "preserves confirmed extinction when cancellation starts %s",
    async (order) => {
      const { adapter, cancellations, emit, close } = await createRelay(platform);
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
      const { adapter, cancellations, close } = await createRelay(platform);
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
    },
  );
});
