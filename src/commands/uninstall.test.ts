// Uninstall command tests cover cleanup flow, prompts, and runtime messages.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupCommandLogMessages,
  createCleanupCommandRuntime,
  gatewayService,
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
  resetCleanupCommandMocks,
  setCleanupNixMode,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

const removeCompletionInstall = vi.hoisted(() => vi.fn());

vi.mock("../cli/completion-runtime.js", () => ({ removeCompletionInstall }));

const { uninstallCommand } = await import("./uninstall.js");

describe("uninstallCommand", () => {
  const runtime = createCleanupCommandRuntime();

  beforeEach(() => {
    resetCleanupCommandMocks();
    removeCompletionInstall.mockReset().mockResolvedValue([]);
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
    {
      failure: "service removal fails",
      arrange: () => gatewayService.uninstall.mockRejectedValue(new Error("uninstall failed")),
    },
  ])("preserves user data when gateway $failure", async ({ arrange }) => {
    arrange();

    await expect(
      uninstallCommand(runtime, {
        all: true,
        yes: true,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
    expect(prepareLegacyWorkspaceStateReset).not.toHaveBeenCalled();
    expect(cleanupCommandLogMessages(runtime)).not.toContain(
      "CLI still installed. Remove via npm/pnpm if desired.",
    );
  });

  it("preserves user data when Nix owns service lifecycle", async () => {
    setCleanupNixMode(true);

    await expect(
      uninstallCommand(runtime, {
        all: true,
        yes: true,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(gatewayService.isLoaded).not.toHaveBeenCalled();
    expect(gatewayService.stop).not.toHaveBeenCalled();
    expect(gatewayService.uninstall).not.toHaveBeenCalled();
    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
  });

  it("still removes service registration after a failed gateway stop", async () => {
    gatewayService.stop.mockRejectedValue(new Error("listener still active"));

    await expect(
      uninstallCommand(runtime, {
        service: true,
        yes: true,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(gatewayService.uninstall).toHaveBeenCalledOnce();
  });

  it("removes requested data after successful gateway teardown", async () => {
    await uninstallCommand(runtime, {
      all: true,
      yes: true,
      nonInteractive: true,
    });

    expect(gatewayService.stop).toHaveBeenCalledOnce();
    expect(gatewayService.uninstall).toHaveBeenCalledOnce();
    expect(removeStateAndLinkedPaths).toHaveBeenCalledOnce();
    expect(removeWorkspaceDirs).toHaveBeenCalledOnce();
  });

  it("removes an unloaded service definition before deleting user data", async () => {
    gatewayService.isLoaded.mockResolvedValue(false);

    await uninstallCommand(runtime, {
      all: true,
      yes: true,
      nonInteractive: true,
    });

    expect(gatewayService.stop).not.toHaveBeenCalled();
    expect(gatewayService.uninstall).toHaveBeenCalledOnce();
    expect(removeStateAndLinkedPaths).toHaveBeenCalledOnce();
    expect(removeWorkspaceDirs).toHaveBeenCalledOnce();
  });

  it("recommends creating a backup before removing state or workspaces", async () => {
    await uninstallCommand(runtime, {
      state: true,
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

  it("does not recommend backup for service-only uninstall", async () => {
    await uninstallCommand(runtime, {
      service: true,
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

  it("preserves workspace dirs during state-only uninstall", async () => {
    await uninstallCommand(runtime, {
      state: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeStateAndLinkedPaths).toHaveBeenCalledWith(
      expect.any(Object),
      runtime,
      expect.objectContaining({
        dryRun: true,
        preservePaths: ["/tmp/.openclaw/workspace"],
      }),
    );
  });

  it("removes completion profile entries before state and honors dry-run", async () => {
    removeCompletionInstall.mockResolvedValueOnce(["/tmp/.bashrc"]);

    await uninstallCommand(runtime, {
      state: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeCompletionInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        onProfileError: expect.any(Function),
      }),
    );
    expect(cleanupCommandLogMessages(runtime)).toContain(
      "[dry-run] remove OpenClaw completion from /tmp/.bashrc",
    );
    expect(removeCompletionInstall.mock.invocationCallOrder[0]).toBeLessThan(
      removeStateAndLinkedPaths.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("continues state cleanup when completion profile cleanup fails", async () => {
    removeCompletionInstall.mockRejectedValueOnce(
      new Error("EACCES: permission denied, open '/tmp/.bashrc'"),
    );

    await uninstallCommand(runtime, {
      state: true,
      yes: true,
      nonInteractive: true,
    });

    expect(removeStateAndLinkedPaths).toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("State cleanup will continue"),
    );
  });

  it("does not remove completion entries without state cleanup", async () => {
    await uninstallCommand(runtime, {
      workspace: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeCompletionInstall).not.toHaveBeenCalled();
  });

  it("previews retired workspace files during state-only uninstall", async () => {
    removeLegacyWorkspaceStateForReset.mockResolvedValueOnce({
      removedPaths: ["/tmp/.openclaw/workspace/openclaw-workspace-state.json"],
      warnings: [],
    });

    await uninstallCommand(runtime, {
      state: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(prepareLegacyWorkspaceStateReset).toHaveBeenCalledWith("/tmp/.openclaw/workspace");
    expect(removeLegacyWorkspaceStateForReset).toHaveBeenCalledWith(
      { workspaceDir: "/tmp/.openclaw/workspace" },
      { dryRun: true },
    );
    expect(cleanupCommandLogMessages(runtime)).toContain(
      "[dry-run] remove /tmp/.openclaw/workspace/openclaw-workspace-state.json",
    );
  });

  it("does not preserve workspace dirs when workspace removal is selected", async () => {
    await uninstallCommand(runtime, {
      state: true,
      workspace: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeStateAndLinkedPaths).toHaveBeenCalledWith(
      expect.any(Object),
      runtime,
      expect.objectContaining({
        dryRun: true,
        preservePaths: [],
      }),
    );
  });

  it("removes workspace state rows during workspace-only uninstall", async () => {
    await uninstallCommand(runtime, {
      workspace: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: true,
      removeStateRows: true,
    });
  });

  it("does not reopen workspace state after state and workspace uninstall", async () => {
    await uninstallCommand(runtime, {
      state: true,
      workspace: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: true,
      removeStateRows: false,
    });
  });

  it("removes workspace rows when combined state removal fails", async () => {
    removeStateAndLinkedPaths.mockResolvedValueOnce(false);

    await uninstallCommand(runtime, {
      state: true,
      workspace: true,
      yes: true,
      nonInteractive: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: false,
      removeStateRows: true,
    });
  });
});
