// Reset command tests cover cleanup runtime behavior, workspace state, and reset prompts.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupCommandLogMessages,
  createCleanupCommandRuntime,
  gatewayService,
  listAgentSessionDirs,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
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

  it.each([
    {
      failure: "inspection fails",
      arrange: () => gatewayService.isLoaded.mockRejectedValue(new Error("inspection failed")),
    },
    {
      failure: "stop fails",
      arrange: () => gatewayService.stop.mockRejectedValue(new Error("stop failed")),
    },
  ])("preserves user data when gateway $failure", async ({ arrange }) => {
    arrange();

    await expect(
      resetCommand(runtime, {
        scope: "full",
        yes: true,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
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

  it("does not reopen workspace state after full state removal", async () => {
    await resetCommand(runtime, {
      scope: "full",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: true,
      removeStateRows: false,
    });
  });

  it("removes workspace rows when full state removal fails", async () => {
    removeStateAndLinkedPaths.mockResolvedValueOnce(false);

    await resetCommand(runtime, {
      scope: "full",
      yes: true,
      nonInteractive: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: false,
      removeStateRows: true,
    });
  });

  it("continues a scoped reset when session directory inspection fails", async () => {
    listAgentSessionDirs.mockRejectedValueOnce(new Error("permission denied"));

    await expect(
      resetCommand(runtime, {
        scope: "config+creds+sessions",
        yes: true,
        nonInteractive: true,
      }),
    ).resolves.toBeUndefined();

    expect(runtime.error).toHaveBeenCalledWith(
      "Failed to inspect session directories: Error: permission denied",
    );
  });
});
