// Uninstall command tests cover cleanup flow, prompts, and runtime messages.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupCommandLogMessages,
  createCleanupCommandRuntime,
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
  resetCleanupCommandMocks,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

const gatewayService = vi.hoisted(() => ({
  label: "LaunchAgent",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  isLoaded: vi.fn(async () => false),
  stop: vi.fn(async () => {}),
  uninstall: vi.fn(async () => {}),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => gatewayService,
}));

const { uninstallCommand } = await import("./uninstall.js");

describe("uninstallCommand", () => {
  const runtime = createCleanupCommandRuntime();

  beforeEach(() => {
    resetCleanupCommandMocks();
    silenceCleanupCommandRuntime(runtime);
    gatewayService.isLoaded.mockResolvedValue(false);
    gatewayService.stop.mockResolvedValue(undefined);
    gatewayService.uninstall.mockResolvedValue(undefined);
  });

  it.each([
    { loadProbe: true, expectedStops: 1 },
    { loadProbe: false, expectedStops: 0 },
    { loadProbe: new Error("launchctl unavailable"), expectedStops: 0 },
  ])(
    "uninstalls the service definition when the load probe returns $loadProbe",
    async ({ loadProbe, expectedStops }) => {
      if (loadProbe instanceof Error) {
        gatewayService.isLoaded.mockRejectedValueOnce(loadProbe);
      } else {
        gatewayService.isLoaded.mockResolvedValueOnce(loadProbe);
      }

      await uninstallCommand(runtime, {
        service: true,
        yes: true,
        nonInteractive: true,
      });

      expect(gatewayService.stop).toHaveBeenCalledTimes(expectedStops);
      expect(gatewayService.uninstall).toHaveBeenCalledOnce();
      if (loadProbe instanceof Error) {
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("continuing with uninstall"),
        );
      }
    },
  );

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
