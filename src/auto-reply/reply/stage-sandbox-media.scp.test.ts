import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCP_STDERR_TAIL_CHARS, testing } from "./stage-sandbox-media.js";

const hasUnpairedUtf16Surrogate = (text: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

describe("scpFile", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  function createChild() {
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), { kill, stderr });
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    return { child, kill, stderr };
  }

  it("keeps child close authoritative when stderr emits an error", async () => {
    const { child, kill, stderr } = createChild();

    const resultPromise = testing.scpFile("host", "/remote/path", "/local/path");

    expect(() => stderr.emit("error", new Error("stderr EPIPE"))).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
    child.emit("close", 0);

    await expect(resultPromise).resolves.toBeUndefined();
  });

  it("includes the stderr stream error when scp exits unsuccessfully", async () => {
    const { child, stderr } = createChild();

    const resultPromise = testing.scpFile("host", "/remote/path", "/local/path");
    stderr.emit("error", new Error("stderr EPIPE"));
    child.emit("close", 1);

    await expect(resultPromise).rejects.toThrow("scp failed (1): stderr EPIPE");
  });

  it("surfaces UTF-16 safe scp stderr when transfer fails with emoji at tail boundary", async () => {
    const { child, stderr } = createChild();
    // Place the retained tail window on the emoji's low surrogate so raw slicing
    // would keep a lone surrogate half before the thrown error is built.
    const lowSurrogateTailStart = 100;
    const padding = "n".repeat(lowSurrogateTailStart - 1);
    const recent = "🤖" + "n".repeat(SCP_STDERR_TAIL_CHARS - 5) + "fail";

    const resultPromise = testing.scpFile("host", "/remote/path", "/local/path");
    stderr.emit("data", padding);
    stderr.emit("data", recent);
    child.emit("close", 1);

    let message = "";
    try {
      await resultPromise;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^scp failed \(1\):/);
    expect(message).toContain("fail");
    expect(message).not.toContain("🤖");
    expect(hasUnpairedUtf16Surrogate(message)).toBe(false);
  });

  it("does not terminate scp again when spawning fails", async () => {
    const { child, kill } = createChild();

    const resultPromise = testing.scpFile("host", "/remote/path", "/local/path");
    child.emit("error", new Error("spawn failed"));

    await expect(resultPromise).rejects.toThrow("spawn failed");
    expect(kill).not.toHaveBeenCalled();
  });
});
