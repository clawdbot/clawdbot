// Launchd recovery tests cover daemon recovery behavior for macOS launchd services.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const launchAgentPlistExists = vi.hoisted(() => vi.fn());
const repairLaunchAgentBootstrap = vi.hoisted(() => vi.fn());

vi.mock("../../daemon/launchd.js", () => ({
  launchAgentPlistExists: (env: Record<string, string | undefined>) => launchAgentPlistExists(env),
  repairLaunchAgentBootstrap: (args: { env?: Record<string, string | undefined> }) =>
    repairLaunchAgentBootstrap(args),
}));

let recoverInstalledLaunchAgent: typeof import("./launchd-recovery.js").recoverInstalledLaunchAgent;
let LAUNCH_AGENT_RECOVERY_MESSAGE: typeof import("./launchd-recovery.js").LAUNCH_AGENT_RECOVERY_MESSAGE;

describe("recoverInstalledLaunchAgent", () => {
  beforeAll(async () => {
    ({ recoverInstalledLaunchAgent, LAUNCH_AGENT_RECOVERY_MESSAGE } =
      await import("./launchd-recovery.js"));
  });

  beforeEach(() => {
    launchAgentPlistExists.mockReset();
    repairLaunchAgentBootstrap.mockReset();
    launchAgentPlistExists.mockResolvedValue(false);
    repairLaunchAgentBootstrap.mockResolvedValue({ ok: true, status: "repaired" });
  });

  it("returns null outside macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    await expect(recoverInstalledLaunchAgent({ result: "started" })).resolves.toBeNull();
    expect(launchAgentPlistExists).not.toHaveBeenCalled();
  });

  it("returns null when the LaunchAgent plist is missing", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    launchAgentPlistExists.mockResolvedValue(false);

    await expect(recoverInstalledLaunchAgent({ result: "started" })).resolves.toBeNull();
    expect(repairLaunchAgentBootstrap).not.toHaveBeenCalled();
  });

  it("returns a loaded recovery result when bootstrap repair succeeds", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    launchAgentPlistExists.mockResolvedValue(true);

    await expect(recoverInstalledLaunchAgent({ result: "restarted" })).resolves.toEqual({
      result: "restarted",
      loaded: true,
      message: LAUNCH_AGENT_RECOVERY_MESSAGE,
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
});
