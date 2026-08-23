import { beforeEach, expect, it, vi } from "vitest";
import { parkManagedUpdateSuccessor } from "./managed-update-successor.js";

const parkLaunchd = vi.fn(async () => true);
const parkSystemd = vi.fn(async () => {});

vi.mock("../daemon/launchd-stop.js", () => ({
  parkCurrentLaunchAgentForMaintenance: () => parkLaunchd(),
}));
vi.mock("../daemon/systemd-lifecycle.js", () => ({
  parkCurrentSystemdServiceForMaintenance: () => parkSystemd(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  parkLaunchd.mockResolvedValue(true);
});

it("dispatches only to an identified native successor owner", async () => {
  await parkManagedUpdateSuccessor("launchd");
  expect(parkLaunchd).toHaveBeenCalledOnce();

  await parkManagedUpdateSuccessor("systemd");
  expect(parkSystemd).toHaveBeenCalledOnce();

  await parkManagedUpdateSuccessor("schtasks");
  await expect(parkManagedUpdateSuccessor(null)).rejects.toThrow("an unmanaged gateway");
  await expect(parkManagedUpdateSuccessor("external")).rejects.toThrow(
    "an externally supervised gateway",
  );

  parkLaunchd.mockResolvedValueOnce(false);
  await expect(parkManagedUpdateSuccessor("launchd")).rejects.toThrow(
    "current LaunchAgent identity is unavailable",
  );
});
