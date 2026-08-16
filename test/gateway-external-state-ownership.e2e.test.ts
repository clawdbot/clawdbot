import { describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

describe("Gateway external shared-state ownership", () => {
  it("refuses unmarked startup and accepts the external supervisor marker", async () => {
    const instance = await createOpenClawTestInstance({
      name: "gateway-external-state-owner",
      env: { OPENCLAW_SUPERVISOR_MODE: "external" },
      startTimeoutMs: 30_000,
    });
    try {
      const claim = await instance.cli([
        "database",
        "ownership",
        "claim",
        "--manager",
        "gateway-supervisor",
        "--json",
      ]);
      expect(claim.code, claim.stderr).toBe(0);
      const claimed = JSON.parse(claim.stdout) as {
        databasePath: string;
        ownership: { managerId: string };
        status: string;
      };
      expect(claimed).toMatchObject({
        status: "external",
        ownership: { managerId: "gateway-supervisor" },
      });
      const preflight = await instance.cli([
        "database",
        "preflight",
        claimed.databasePath,
        "--json",
      ]);
      expect(preflight.code, preflight.stderr).toBe(0);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        schema: "openclaw.state-schema-preflight.v1",
        status: "exact",
        requiresWrite: false,
      });
      const unreadable = await instance.cli([
        "database",
        "preflight",
        `${instance.stateDir}/missing.sqlite`,
        "--json",
      ]);
      expect(unreadable.code).toBe(1);
      expect(JSON.parse(unreadable.stdout)).toMatchObject({
        schema: "openclaw.state-schema-preflight.v1",
        status: "indeterminate",
      });
      const status = await instance.cli(["database", "ownership", "status", "--json"]);
      expect(status.code, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        status: "external",
        ownership: { managerId: "gateway-supervisor" },
      });
      const conflictingClaim = await instance.cli([
        "database",
        "ownership",
        "claim",
        "--manager",
        "replacement-manager",
        "--json",
      ]);
      expect(conflictingClaim.code).toBe(1);
      expect(JSON.parse(conflictingClaim.stdout)).toMatchObject({
        error: expect.stringContaining("already claimed by external manager gateway-supervisor"),
      });

      delete instance.env.OPENCLAW_SUPERVISOR_MODE;
      await expect(instance.startGateway()).rejects.toThrow(/gateway-supervisor/u);
      expect(instance.logs()).toMatch(/OPENCLAW_SUPERVISOR_MODE=external/u);

      instance.env.OPENCLAW_SUPERVISOR_MODE = "external";
      await instance.startGateway();
      expect(instance.child).toBeDefined();
    } finally {
      await instance.cleanup();
    }
  });
});
