import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
}));

vi.mock("./driver-artifacts.js", () => ({
  verifyInstalledCuaDriverArtifacts: mocks.verify,
}));

import { CUA_DRIVER_ARTIFACT_CHECK_ID, registerCuaDriverDoctorChecks } from "./doctor.js";

describe("CUA Driver doctor check", () => {
  beforeEach(() => {
    mocks.verify.mockReset();
  });

  it("returns the typed artifact failure with the operator repair", async () => {
    mocks.verify.mockReturnValue({
      ok: false,
      code: "COMPUTER_DRIVER_VERSION_MISMATCH",
      diagnostic: "COMPUTER_DRIVER_VERSION_MISMATCH: expected 0.20.0. Fix: reinstall OpenClaw.",
      fixHint: "Reinstall OpenClaw.",
    });
    let check: HealthCheck | undefined;
    registerCuaDriverDoctorChecks({
      registerHealthCheck(value) {
        check = value;
      },
    });

    expect(check?.id).toBe(CUA_DRIVER_ARTIFACT_CHECK_ID);
    await expect(check?.detect({} as never)).resolves.toEqual([
      expect.objectContaining({
        checkId: CUA_DRIVER_ARTIFACT_CHECK_ID,
        severity: "error",
        message: expect.stringContaining("COMPUTER_DRIVER_VERSION_MISMATCH"),
        fixHint: "Reinstall OpenClaw.",
      }),
    ]);
  });
});
