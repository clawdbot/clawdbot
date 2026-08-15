// Tests bundled binary discovery and version command helpers.
import { describe, expect, it, vi } from "vitest";
import type { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { ensureBinary } from "./binaries.js";

describe("ensureBinary", () => {
  it("passes through when the binary exists", async () => {
    const exec: typeof runExec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
    });
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await ensureBinary("node", exec, runtime);

    expect(exec).toHaveBeenCalledWith("which", ["node"]);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("logs and exits when the binary is missing", async () => {
    const exec: typeof runExec = vi.fn().mockRejectedValue(new Error("missing"));
    const error = vi.fn();
    const exit = vi.fn(() => {
      throw new Error("exit");
    });

    await expect(ensureBinary("ghost", exec, { log: vi.fn(), error, exit })).rejects.toThrow(
      "exit",
    );
    expect(error).toHaveBeenCalledWith("Missing required binary: ghost. Please install it.");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
