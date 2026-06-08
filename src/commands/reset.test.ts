// Reset command tests cover cleanup runtime behavior, workspace attestations, and reset prompts.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupCommandLogMessages,
  createCleanupCommandRuntime,
  clearExistingSqliteSessionStore,
  removeWorkspaceAttestationPaths,
  resetCleanupCommandMocks,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

describe("resetCommand", () => {
  const runtime = createCleanupCommandRuntime();
  let resetCommand: typeof import("./reset.js").resetCommand;

  beforeAll(async () => {
    ({ resetCommand } = await import("./reset.js"));
  });

  beforeEach(() => {
    resetCleanupCommandMocks();
    silenceCleanupCommandRuntime(runtime);
  });

  it("recommends creating a backup before state-destructive reset scopes", async () => {
    await resetCommand(runtime, {
      scope: "config+creds+sessions",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      cleanupCommandLogMessages(runtime).some((message) =>
        message.includes("openclaw backup create"),
      ),
    ).toBe(true);
  });

  it("does not recommend backup for config-only reset", async () => {
    await resetCommand(runtime, {
      scope: "config",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      cleanupCommandLogMessages(runtime).some((message) =>
        message.includes("openclaw backup create"),
      ),
    ).toBe(false);
  });

  it("clears SQLite-backed session metadata before removing session directories", async () => {
    await resetCommand(runtime, {
      scope: "config+creds+sessions",
      yes: true,
      nonInteractive: true,
    });

    expect(clearExistingSqliteSessionStore).toHaveBeenCalledWith(
      "/tmp/.openclaw/agents/main/sessions/sessions.json",
      { compact: true },
    );
  });

  it("removes workspace attestations during full reset", async () => {
    await resetCommand(runtime, {
      scope: "full",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeWorkspaceAttestationPaths).toHaveBeenCalledWith(
      ["/tmp/.openclaw/workspace"],
      runtime,
      { dryRun: true },
    );
  });
});
