import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { createUpdateProgress } from "./progress.js";

describe("update progress", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports redirected progress before completion and preserves stdout failures", () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const { progress, stop } = createUpdateProgress(true);
    const step = { name: "build", command: "pnpm build", index: 0, total: 1 };
    try {
      progress.onStepStart?.(step);
      expect(log).toHaveBeenCalledWith("Building...");
      progress.onStepComplete?.({
        ...step,
        durationMs: 1200,
        exitCode: 1,
        stdoutTail: "Build type error",
      });
      expect(log.mock.calls.flat().join("\n")).toContain("Build type error");
    } finally {
      stop();
      if (tty) {
        Object.defineProperty(process.stdout, "isTTY", tty);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });

  it("keeps progress silent when JSON output owns stdout", () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const { progress, stop } = createUpdateProgress(false);
    const step = { name: "build", command: "pnpm build", index: 0, total: 1 };
    progress.onStepStart?.(step);
    progress.onStepComplete?.({ ...step, durationMs: 1, exitCode: 0 });
    stop();
    expect(log).not.toHaveBeenCalled();
  });
});
