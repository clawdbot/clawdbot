import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { backupCaptureFinalCommand } from "./backup-capture-final.js";

describe("backup capture-final command", () => {
  it("returns the structured request failure for oversized input", async () => {
    const runtime = createRuntimeCapture();

    const result = await backupCaptureFinalCommand(runtime, "x".repeat(1024 * 1024 + 1));

    expect(result).toEqual({
      version: "openclaw-final-recovery-point-result/v1",
      ok: false,
      code: "final-capture.request-invalid",
      disposition: "quarantine",
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(runtime.logs[0]!)).toEqual(result);
  });
});

function createRuntimeCapture() {
  const logs: string[] = [];
  const exit = vi.fn<RuntimeEnv["exit"]>();
  return {
    logs,
    log(value: unknown) {
      logs.push(String(value));
    },
    error: vi.fn(),
    exit,
  };
}
