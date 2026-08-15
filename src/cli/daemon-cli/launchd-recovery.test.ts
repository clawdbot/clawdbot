// Launchd recovery tests cover daemon recovery behavior for macOS launchd services.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const launchAgentPlistExists = vi.hoisted(() => vi.fn());
const repairLaunchAgentBootstrap = vi.hoisted(() => vi.fn());
const assertNoSystemLaunchDaemonOwnership = vi.hoisted(() => vi.fn());

vi.mock("../../daemon/launchd.js", () => ({
  formatLaunchAgentGuiSessionError: (params: {
    detail: string;
    domain: string;
    actionHint: string;
  }) =>
    [
      `launchctl bootstrap failed: ${params.detail}`,
      `LaunchAgent ${params.actionHint} requires a logged-in macOS GUI session for this user (${params.domain}).`,
    ].join("\n"),
  launchAgentPlistExists: (env: Record<string, string | undefined>) => launchAgentPlistExists(env),
  repairLaunchAgentBootstrap: (args: { env?: Record<string, string | undefined> }) =>
    repairLaunchAgentBootstrap(args),
  resolveLaunchAgentLabel: (env: Record<string, string | undefined>) =>
    env.OPENCLAW_LAUNCHD_LABEL ?? "ai.openclaw.gateway",
}));

vi.mock("../../daemon/launchd-system.js", () => ({
  assertNoSystemLaunchDaemonOwnership: (label: string) =>
    assertNoSystemLaunchDaemonOwnership(label),
}));

let recoverInstalledLaunchAgent: typeof import("./launchd-recovery.js").recoverInstalledLaunchAgent;

describe("recoverInstalledLaunchAgent", () => {
  beforeAll(async () => {
    ({ recoverInstalledLaunchAgent } = await import("./launchd-recovery.js"));
  });

  beforeEach(() => {
    launchAgentPlistExists.mockReset();
    repairLaunchAgentBootstrap.mockReset();
    assertNoSystemLaunchDaemonOwnership.mockReset();
    assertNoSystemLaunchDaemonOwnership.mockResolvedValue(undefined);
    launchAgentPlistExists.mockResolvedValue(false);
    repairLaunchAgentBootstrap.mockResolvedValue({ ok: true, status: "repaired" });
  });

  it("returns null outside macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    await expect(recoverInstalledLaunchAgent({ result: "started" })).resolves.toBeNull();
    expect(launchAgentPlistExists).not.toHaveBeenCalled();
    expect(assertNoSystemLaunchDaemonOwnership).not.toHaveBeenCalled();
  });

  it("returns null when the LaunchAgent plist is missing", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    launchAgentPlistExists.mockResolvedValue(false);

    await expect(recoverInstalledLaunchAgent({ result: "started" })).resolves.toBeNull();
    expect(assertNoSystemLaunchDaemonOwnership).toHaveBeenCalledWith("ai.openclaw.gateway");
    expect(repairLaunchAgentBootstrap).not.toHaveBeenCalled();
  });

  it("returns a loaded recovery result when bootstrap repair succeeds", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    launchAgentPlistExists.mockResolvedValue(true);

    await expect(recoverInstalledLaunchAgent({ result: "restarted" })).resolves.toEqual({
      result: "restarted",
      loaded: true,
      message: "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
    });
    expect(launchAgentPlistExists).toHaveBeenCalledWith(process.env);
    expect(repairLaunchAgentBootstrap).toHaveBeenCalledWith({ env: process.env });
  });

  it("returns null when bootstrap repair fails", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    launchAgentPlistExists.mockResolvedValue(true);
    repairLaunchAgentBootstrap.mockResolvedValue({
      ok: false,
      status: "kickstart-failed",
      detail: "permission denied",
    });

    await expect(recoverInstalledLaunchAgent({ result: "started" })).resolves.toBeNull();
  });

  it("surfaces headless GUI bootstrap failures instead of falling back to unmanaged restart", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    launchAgentPlistExists.mockResolvedValue(true);
    repairLaunchAgentBootstrap.mockResolvedValue({
      ok: false,
      status: "gui-session-unavailable",
      detail: "Bootstrap failed: 125: Domain does not support specified action",
      domain: "gui/501",
    });

    await expect(recoverInstalledLaunchAgent({ result: "restarted" })).rejects.toThrow(
      "requires a logged-in macOS GUI session",
    );
  });

  it("surfaces system ownership even when no user LaunchAgent plist exists", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    launchAgentPlistExists.mockResolvedValue(false);
    assertNoSystemLaunchDaemonOwnership.mockRejectedValue(
      new Error("System LaunchDaemon system/ai.openclaw.gateway owns this label"),
    );

    await expect(recoverInstalledLaunchAgent({ result: "started" })).rejects.toThrow(
      "System LaunchDaemon system/ai.openclaw.gateway owns this label",
    );
    expect(launchAgentPlistExists).not.toHaveBeenCalled();
  });

  it.each(["system-launchdaemon-conflict", "system-launchdaemon-unverifiable"] as const)(
    "preserves typed %s bootstrap failures",
    async (status) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      launchAgentPlistExists.mockResolvedValue(true);
      repairLaunchAgentBootstrap.mockResolvedValue({
        ok: false,
        status,
        detail: "system ownership recovery guidance",
      });

      await expect(recoverInstalledLaunchAgent({ result: "restarted" })).rejects.toThrow(
        "system ownership recovery guidance",
      );
    },
  );
});
