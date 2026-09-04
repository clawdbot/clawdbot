import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { prepareHostedStopExecutor } from "./hosted-stop-executor.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) {
    close();
  }
  spawn.mockReset();
});

function executorChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    // Signalling deliberately does not deliver close; the OS owns completion.
    kill: vi.fn(() => true),
  });
  spawn.mockReturnValueOnce(child);
  const close = () => {
    child.signalCode = "SIGKILL";
    child.emit("close", null, "SIGKILL");
  };
  cleanups.push(close);
  return { child, close };
}

describe("native executor cleanup ownership", () => {
  it.each(["abort", "spawn error"])("joins close after preparation %s", async (fault) => {
    const { child, close } = executorChild();
    const abort = new AbortController();
    let settled = false;
    const preparation = prepareHostedStopExecutor({
      command: ["native-stop"],
      env: {},
      signal: abort.signal,
      assertCurrent: () => {},
    });
    const failure = preparation.catch((error: unknown) => {
      settled = true;
      return error;
    });
    if (fault === "abort") {
      abort.abort();
    } else {
      child.emit("error", new Error("native spawn failed"));
    }
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    close();
    expect(await failure).toBeInstanceOf(Error);
  });

  it("joins both cancelled placement discovery and the original child close", async () => {
    const { child, close } = executorChild();
    const abort = new AbortController();
    const placement = createDeferredCore();
    const inspecting = createDeferredCore();
    let settled = false;
    const preparation = prepareHostedStopExecutor({
      command: ["native-stop"],
      env: {},
      signal: abort.signal,
      assertCurrent: () => {},
      verifyPlacement: () => {
        inspecting.resolve();
        return placement.promise;
      },
    });
    const failure = preparation.catch((error: unknown) => {
      settled = true;
      return error;
    });
    child.stdout.write("123\n");
    await inspecting.promise;
    abort.abort();
    close();
    await Promise.resolve();
    expect(settled).toBe(false);
    placement.resolve();
    expect(await failure).toBeInstanceOf(Error);
  });

  it("fences a committed executor immediately but does not retire it until close", async () => {
    const { child, close } = executorChild();
    const preparation = prepareHostedStopExecutor({
      command: ["native-stop"],
      env: {},
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    child.stdout.write("123\n");
    const executor = await preparation;
    const nativeResult = executor.execute(() => {});
    let retired = false;
    const retirement = executor.dispose().then(() => {
      retired = true;
    });
    expect(() => executor.execute(() => {})).toThrow("no longer available");
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await Promise.resolve();
    expect(retired).toBe(false);
    close();
    await retirement;
    await expect(nativeResult).resolves.toMatchObject({ disposition: "uncertain" });
  });
});
