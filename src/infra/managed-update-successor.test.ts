import { expect, it, vi } from "vitest";
import { parkManagedUpdateSuccessor } from "./managed-update-successor.js";

const parkLaunchd = vi.fn(async () => true);
const parkSystemd = vi.fn(async () => {});

vi.mock("../daemon/launchd-stop.js", () => ({
  parkCurrentLaunchAgentForMaintenance: () => parkLaunchd(),
}));
vi.mock("../daemon/systemd-lifecycle.js", () => ({
  parkCurrentSystemdServiceForMaintenance: () => parkSystemd(),
}));

it("dispatches managed successor parking by supervisor family", async () => {
  await parkManagedUpdateSuccessor("launchd");
  expect(parkLaunchd).toHaveBeenCalledOnce();
  vi.clearAllMocks();
  await parkManagedUpdateSuccessor("systemd");
  expect(parkSystemd).toHaveBeenCalledOnce();
  vi.clearAllMocks();
  await parkManagedUpdateSuccessor("schtasks");
  await parkManagedUpdateSuccessor("external");
  await parkManagedUpdateSuccessor(null);
  expect(parkLaunchd).not.toHaveBeenCalled();
  expect(parkSystemd).not.toHaveBeenCalled();

  parkLaunchd.mockResolvedValueOnce(false);
  await expect(parkManagedUpdateSuccessor("launchd")).rejects.toThrow(
    "current LaunchAgent identity is unavailable",
  );
});
