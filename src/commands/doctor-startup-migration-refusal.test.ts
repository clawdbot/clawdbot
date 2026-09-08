import { describe, expect, it, vi } from "vitest";
import { resolveGatewayStartupMaintenanceReason } from "../cli/gateway-cli/startup-maintenance.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "../state/openclaw-state-db-schema-migration-required.js";
import { throwStartupMigrationRefusal } from "./doctor-startup-migration-refusal.js";

describe("startup refusal handoff", () => {
  it("preserves maintenance classification after the preflight exit", () => {
    const cause = new OpenClawStateDatabaseSchemaMigrationRequiredError(
      "audit-events-v2",
      "/synthetic/state/openclaw.sqlite",
    );
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let refusal: unknown;
    try {
      throwStartupMigrationRefusal("Startup admission failed.", cause);
    } catch (error) {
      refusal = error;
    } finally {
      output.mockRestore();
    }
    expect(resolveGatewayStartupMaintenanceReason(refusal)).toBe("state database schema migration");
  });
});
