import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { backupRestoreAcceptedCommand } from "./backup-restore-accepted.js";

describe("backup restore-accepted command", () => {
  it("returns the structured request failure for oversized input", async () => {
    const runtime = createRuntimeCapture();

    const result = await backupRestoreAcceptedCommand(runtime, "x".repeat(1024 * 1024 + 1));

    expect(result).toEqual({
      version: "openclaw-restored-recovery-point-result/v1",
      ok: false,
      code: "restored-admission.request-invalid",
      disposition: "quarantine",
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(runtime.logs[0]!)).toEqual(result);
  });
});

function createRuntimeCapture(): RuntimeEnv & { logs: string[]; exit: ReturnType<typeof vi.fn> } {
  const logs: string[] = [];
  return {
    logs,
    log(value) {
      logs.push(String(value));
    },
    error: vi.fn(),
    exit: vi.fn(),
  };
}
