// Regression tests for code-mode child stderr stream errors in Tool Search.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_TOOL_STDERR_TAIL_BYTES } from "./sessions/tools/limits.js";

type MockSpawnChild = EventEmitter & {
  stderr?: EventEmitter & { setEncoding?: (enc: string) => void };
  send?: (message: unknown, callback?: (error?: Error | null) => void) => boolean;
  connected?: boolean;
  kill?: (signal?: string) => void;
};

function createMockSpawnChild() {
  const child = new EventEmitter() as MockSpawnChild;
  const stderr = new EventEmitter() as NonNullable<MockSpawnChild["stderr"]>;
  stderr.setEncoding = vi.fn();
  child.stderr = stderr;
  child.connected = true;
  child.kill = vi.fn();
  child.send = vi.fn(() => true);
  return { child, stderr };
}

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: vi.fn() as unknown as typeof import("node:child_process").spawn },
  );
});

const spawnMock = vi.mocked(spawn);
let toolSearch: typeof import("./tool-search.js");
let toolSearchRuntime: typeof import("./tool-search-runtime.js");
let testing: (typeof import("./tool-search.test-support.js"))["testing"];

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  await expect(promise).rejects.toBeInstanceOf(Error);
  return promise.then(
    () => "",
    (error: unknown) => {
      if (!(error instanceof Error)) {
        throw error;
      }
      return error.message;
    },
  );
}

describe("tool-search code-mode stream errors", () => {
  beforeAll(async () => {
    toolSearch = await import("./tool-search.js");
    toolSearchRuntime = await import("./tool-search-runtime.js");
    testing = (await import("./tool-search.test-support.js")).testing;
  });

  afterEach(() => vi.useRealTimers());

  function startChild(signal?: AbortSignal) {
    const { child, stderr } = createMockSpawnChild();
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);
    const config = { ...toolSearch.resolveToolSearchConfig({}), codeTimeoutMs: 1000 };
    const runtime = new toolSearchRuntime.ToolSearchRuntime({}, config);
    const promise = testing.runCodeModeChild({
      code: "return 7;",
      config,
      logs: [],
      parentToolCallId: "stderr-lifecycle",
      runtime,
      signal,
    });
    const settled = vi.fn();
    void promise.then(settled, settled);
    return { child, stderr, promise, settled, runtime };
  }

  it("rejects stderr errors and leaves the unused stdout unpiped", async () => {
    const { child, stderr, promise } = startChild();
    const failure = rejectedMessage(promise);
    stderr.emit("error", new Error("stderr read failed"));
    expect(await failure).toBe("stderr read failed");
    expect(spawnMock.mock.calls.at(-1)?.[2]).toMatchObject({
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("discloses preview loss below the retention cap without splitting a surrogate pair", async () => {
    const { child, stderr, promise } = startChild();
    const failure = rejectedMessage(promise);
    stderr.emit("data", `${"a".repeat(500)}😀${"a".repeat(499)}`);
    child.emit("exit", 1, null);
    stderr.emit("close");
    child.emit("close", 1, null);
    const message = await failure;
    expect(message).toContain(
      `: ${"a".repeat(499)} [504 UTF-8 bytes omitted from the trimmed stderr preview]`,
    );
    expect(message).not.toContain("retention cap");
    expect(message).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it.each([false, true])(
    "waits for child close with stderr-first=%s and reports both losses",
    async (stderrFirst) => {
      const { child, stderr, promise, settled } = startChild();
      const failure = rejectedMessage(promise);
      const early = `HEAD_${"é".repeat(400)}`;
      const late = `${"z".repeat(SESSION_TOOL_STDERR_TAIL_BYTES)}_TAIL`;
      stderr.emit("data", early);
      if (stderrFirst) {
        stderr.emit("data", late);
        stderr.emit("close");
      }
      child.emit("exit", 1, null);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      if (!stderrFirst) {
        stderr.emit("data", late);
        stderr.emit("close");
      }
      child.emit("close", 1, null);
      const message = await failure;
      expect(message).toContain("_TAIL");
      expect(message).not.toContain("HEAD_");
      expect(message).toContain(
        `${Buffer.byteLength(early + late) - SESSION_TOOL_STDERR_TAIL_BYTES} UTF-8 bytes of earlier stderr discarded at the ${SESSION_TOOL_STDERR_TAIL_BYTES}-byte retention cap`,
      );
      expect(message).toContain(
        `${SESSION_TOOL_STDERR_TAIL_BYTES - 500} UTF-8 bytes omitted from the trimmed stderr preview`,
      );
    },
  );

  it("keeps short stderr readable without a loss notice", async () => {
    const { child, stderr, promise } = startChild();
    const failure = rejectedMessage(promise);
    stderr.emit("data", "  short stderr note\n");
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    expect(await failure).toBe("tool_search_code child exited with 1: short stderr note");
  });

  it.each([true, false])(
    "settles IPC result ok=%s without waiting for exit or stderr close",
    async (ok) => {
      const { child, promise } = startChild();
      const outcome = ok
        ? expect(promise).resolves.toBe(7)
        : expect(promise).rejects.toThrow("guest failed");
      child.emit("message", { type: "result", ok, value: 7, error: "guest failed" });
      await outcome;
      expect(child.kill).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "preserves clean-exit IPC grace with stderr-first=%s",
    async (stderrFirst) => {
      vi.useFakeTimers();
      const { child, stderr, promise, settled } = startChild();
      if (stderrFirst) {
        stderr.emit("close");
      }
      child.emit("exit", 0, null);
      if (!stderrFirst) {
        stderr.emit("close");
      }
      child.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).not.toHaveBeenCalled();
      child.emit("message", { type: "result", ok: true, value: 7 });
      await expect(promise).resolves.toBe(7);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects a result-less clean exit after 250ms even if stderr never closes", async () => {
    vi.useFakeTimers();
    const { child, promise, settled } = startChild();
    const failure = rejectedMessage(promise);
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await failure).toBe("tool_search_code child exited with 0");
  });

  it.each(["abort", "timeout"])(
    "preserves %s while a failed child is waiting for stream closure",
    async (kind) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const { child, promise } = startChild(controller.signal);
      const failure = rejectedMessage(promise);
      child.emit("exit", 1, null);
      if (kind === "abort") {
        controller.abort();
      } else {
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(await failure).toBe(
        kind === "abort" ? "tool_search_code aborted" : "tool_search_code timed out",
      );
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    },
  );

  it.each([
    "failed-exit",
    "clean-exit",
    "result-success",
    "result-error",
    "stderr-error",
    "spawn-error",
    "abort",
    "timeout",
  ])("cancels an already-started bridge when settling %s", async (terminal) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const reason = new Error("operator cancelled this run");
    const { child, stderr, promise, runtime } = startChild(parent.signal);
    const outcome = promise.then(
      (value) => value,
      (error: unknown) => error,
    );
    let bridgeSignal: AbortSignal | undefined;
    const aborted = vi.fn();
    const call = vi.spyOn(runtime, "call").mockImplementation(async (_id, _input, options) => {
      bridgeSignal = options?.signal;
      await new Promise<void>((resolve) => {
        bridgeSignal?.addEventListener(
          "abort",
          () => {
            aborted();
            resolve();
          },
          { once: true },
        );
      });
      throw bridgeSignal?.reason;
    });
    const request = { type: "bridge", id: "pending", method: "call", args: ["fixture", {}] };
    child.emit("message", request);
    expect(call).toHaveBeenCalledOnce();
    expect(bridgeSignal?.aborted).toBe(false);
    if (terminal === "failed-exit") {
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
    } else if (terminal === "clean-exit") {
      child.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(250);
    } else if (terminal.startsWith("result-")) {
      child.emit("message", {
        type: "result",
        ok: terminal === "result-success",
        value: 7,
        error: "guest failed",
      });
    } else if (terminal === "stderr-error") {
      stderr.emit("error", new Error("stderr failed"));
    } else if (terminal === "spawn-error") {
      child.emit("error", new Error("spawn failed"));
    } else if (terminal === "abort") {
      parent.abort(reason);
    } else {
      await vi.advanceTimersByTimeAsync(1000);
    }
    const result = await outcome;
    if (terminal === "result-success") {
      expect(result).toBe(7);
    } else {
      expect(result).toBeInstanceOf(Error);
    }
    expect(bridgeSignal?.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledOnce();
    if (terminal === "abort") {
      expect(bridgeSignal?.reason).toBe(reason);
    }
    if (terminal === "timeout") {
      expect(bridgeSignal?.reason).toMatchObject({ message: "tool_search_code timed out" });
    }
    child.emit("message", request);
    child.emit("close", 1, null);
    parent.abort(reason);
    await vi.advanceTimersByTimeAsync(1000);
    expect(call).toHaveBeenCalledOnce();
    expect(aborted).toHaveBeenCalledOnce();
    expect(child.send).toHaveBeenCalledTimes(1); // Initial run only; no reply after settlement.
    expect(vi.getTimerCount()).toBe(0);
  });
});
