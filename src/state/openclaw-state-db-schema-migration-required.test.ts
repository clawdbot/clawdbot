import { describe, expect, it } from "vitest";
import {
  findOpenClawStateDatabaseSchemaMigrationRequiredError,
  OpenClawStateDatabaseSchemaMigrationRequiredError,
} from "./openclaw-state-db-schema-migration-required.js";

describe("state database schema migration error classification", () => {
  it("recognizes a rehydrated exact migration error through its cause chain", () => {
    const original = new OpenClawStateDatabaseSchemaMigrationRequiredError(
      "agent-databases-composite-primary-key",
      "/tmp/openclaw.sqlite",
    );
    const rehydrated = new Error("startup failed", {
      cause: new Error(original.message),
    });

    expect(findOpenClawStateDatabaseSchemaMigrationRequiredError(rehydrated)).toMatchObject({
      kind: "agent-databases-composite-primary-key",
      pathname: "/tmp/openclaw.sqlite",
    });
  });

  it("recognizes an exact instance of the typed error", () => {
    const original = new OpenClawStateDatabaseSchemaMigrationRequiredError(
      "audit-events-v2",
      "/tmp/openclaw.sqlite",
    );

    expect(findOpenClawStateDatabaseSchemaMigrationRequiredError(original)).toBe(original);
  });

  it("does not classify similar operator guidance as the migration error", () => {
    expect(
      findOpenClawStateDatabaseSchemaMigrationRequiredError(
        new Error(
          "OpenClaw state database /tmp/openclaw.sqlite is stale; run openclaw doctor --fix.",
        ),
      ),
    ).toBeUndefined();
  });

  it("does not classify the agent DB media migration error", () => {
    // Ensure the state-DB classifier does not accidentally match agent-DB messages.
    expect(
      findOpenClawStateDatabaseSchemaMigrationRequiredError(
        new Error(
          "OpenClaw agent database /tmp/openclaw-agent.sqlite uses schema version 5; run openclaw doctor --fix to migrate persisted media before using it.",
        ),
      ),
    ).toBeUndefined();
  });
});
