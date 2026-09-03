// Uninstall command tests cover cleanup flow, prompts, and runtime messages.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupCommandLogMessages,
  cleanupCommandErrorMessages,
  createCleanupCommandRuntime,
  gatewayService,
  removePath,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
  resetCleanupCommandMocks,
  setCleanupNixMode,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

const clackMocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(),
  multiselect: vi.fn(),
}));

vi.mock("@clack/prompts", () => clackMocks);

const { uninstallCommand } = await import("./uninstall.js");

describe("uninstallCommand", () => {
  const runtime = createCleanupCommandRuntime();

  beforeEach(() => {
    resetCleanupCommandMocks();
    silenceCleanupCommandRuntime(runtime);
    clackMocks.confirm.mockResolvedValue(true);
    clackMocks.isCancel.mockReturnValue(false);
    clackMocks.multiselect.mockImplementation(
      async (options: { initialValues?: string[] }) => options.initialValues ?? [],
    );
  });

  it("defaults bare interactive uninstall to gateway service only", async () => {
    await uninstallCommand(runtime, { yes: true, dryRun: true });

    expect(clackMocks.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ initialValues: ["service"] }),
    );
    expect(cleanupCommandLogMessages(runtime)).toContain("[dry-run] remove gateway service");
    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
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

  it("attempts app cleanup when service teardown blocks local data", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    gatewayService.stop.mockRejectedValue(new Error("stop failed"));
    try {
      await expect(
        uninstallCommand(runtime, { all: true, yes: true, nonInteractive: true }),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(removePath).toHaveBeenCalledWith(
        "/Applications/OpenClaw.app",
        runtime,
        expect.any(Object),
      );
      expect(cleanupCommandErrorMessages(runtime)).toContain(
        "State and workspace cleanup blocked because gateway service teardown failed.",
      );
    } finally {
      platform.mockRestore();
    }
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

  it("cleans retired workspace state without removing state-only workspaces", async () => {
    await uninstallCommand(runtime, {
      state: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: true,
      preserveWorkspace: true,
    });
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

    await expect(
      uninstallCommand(runtime, {
        state: true,
        workspace: true,
        yes: true,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: false,
      removeStateRows: true,
    });
  });

  it.each([
    {
      failure: "returns failures",
      arrange: () => removeWorkspaceDirs.mockResolvedValueOnce(["retired state failed"]),
    },
    {
      failure: "throws",
      arrange: () => removeWorkspaceDirs.mockRejectedValueOnce(new Error("retired state failed")),
    },
  ])(
    "continues state and app cleanup when retired workspace cleanup $failure",
    async ({ arrange }) => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      arrange();
      try {
        await expect(
          uninstallCommand(runtime, {
            state: true,
            app: true,
            yes: true,
            nonInteractive: true,
          }),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });

        expect(removeStateAndLinkedPaths).toHaveBeenCalledOnce();
        expect(removePath).toHaveBeenCalledWith(
          "/Applications/OpenClaw.app",
          runtime,
          expect.any(Object),
        );
        expect(cleanupCommandErrorMessages(runtime).join("\n")).toContain("retired state");
      } finally {
        platform.mockRestore();
      }
    },
  );

  it("fails when workspace cleanup returns failures", async () => {
    removeWorkspaceDirs.mockResolvedValueOnce(["/tmp/.openclaw/workspace"]);
    await expect(
      uninstallCommand(runtime, { workspace: true, yes: true, nonInteractive: true }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(cleanupCommandErrorMessages(runtime)).toContain(
      "Workspace cleanup incomplete: /tmp/.openclaw/workspace",
    );
  });

  it("blocks workspace cleanup after a thrown state ownership failure", async () => {
    removeStateAndLinkedPaths.mockRejectedValueOnce(new Error("state is live"));

    await expect(
      uninstallCommand(runtime, {
        state: true,
        workspace: true,
        yes: true,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
    expect(cleanupCommandErrorMessages(runtime)).toContain(
      "Workspace cleanup blocked because state cleanup could not safely complete.",
    );
  });

  it("reports app cleanup failure and non-macOS inapplicability", async () => {
    const platform = vi.spyOn(process, "platform", "get");
    platform.mockReturnValue("darwin");
    removePath.mockResolvedValueOnce({ ok: false });
    await expect(
      uninstallCommand(runtime, { app: true, yes: true, nonInteractive: true }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    resetCleanupCommandMocks();
    silenceCleanupCommandRuntime(runtime);
    platform.mockReturnValue("linux");
    await uninstallCommand(runtime, { app: true, yes: true, nonInteractive: true });
    expect(cleanupCommandLogMessages(runtime)).toContain(
      "macOS app cleanup is not applicable on this platform.",
    );
    platform.mockRestore();
  });
});
