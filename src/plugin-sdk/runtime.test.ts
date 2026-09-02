/**
 * Tests plugin SDK runtime exports, logging wrappers, and runtime env helpers.
 */
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { resolveRuntimeEnv } from "./runtime.js";

describe("resolveRuntimeEnv", () => {
  it("returns provided runtime when present", () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    const resolved = resolveRuntimeEnv({ runtime, logger });

    expect(resolved).toBe(runtime);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("creates logger-backed runtime when runtime is missing", () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    const resolved = resolveRuntimeEnv({ logger });
    resolved.log?.("hello %s", "world");
    resolved.error?.("bad %d", 7);
    resolved.writeStdout("plain");
    resolved.writeJson({ ok: true });

    expect(logger.info).toHaveBeenCalledWith("hello world");
    expect(logger.error).toHaveBeenCalledWith("bad 7");
    expect(logger.info).toHaveBeenCalledWith("plain");
    expect(logger.info).toHaveBeenCalledWith('{\n  "ok": true\n}');
  });
});
