import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { ensureBinary } from "./binaries.js";

const originalPlatform = process.platform;

describe("ensureBinary", () => {
  afterEach(() => {
    // Restore original platform after each test
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
    });
  });

  describe("on Unix", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", {
        value: "linux",
      });
    });

    it("passes through when binary exists", async () => {
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
    });

    it("logs and exits when missing", async () => {
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

  describe("on Windows", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", {
        value: "win32",
      });
    });

    it("passes through when binary exists", async () => {
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
      expect(exec).toHaveBeenCalledWith("where", ["node"]);
    });

    it("logs and exits when missing", async () => {
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
});
