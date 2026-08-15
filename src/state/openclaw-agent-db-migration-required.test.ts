import { describe, expect, it } from "vitest";
import {
  findOpenClawAgentDatabaseMediaMigrationRequiredError,
  OpenClawAgentDatabaseMediaMigrationRequiredError,
} from "./openclaw-agent-db-migration-required.js";

describe("agent database media migration error classification", () => {
  it("recognizes a rehydrated exact migration error through its cause chain", () => {
    const original = new OpenClawAgentDatabaseMediaMigrationRequiredError(
      "/tmp/openclaw-agent.sqlite",
      14,
    );
    const rehydrated = new Error("startup failed", {
      cause: new Error(original.message),
    });

    expect(findOpenClawAgentDatabaseMediaMigrationRequiredError(rehydrated)).toMatchObject({
      pathname: "/tmp/openclaw-agent.sqlite",
      schemaVersion: 14,
    });
  });

  it("does not classify similar operator guidance as the migration error", () => {
    expect(
      findOpenClawAgentDatabaseMediaMigrationRequiredError(
        new Error("OpenClaw agent database is outdated; run openclaw doctor --fix to migrate it."),
      ),
    ).toBeUndefined();
  });
});
