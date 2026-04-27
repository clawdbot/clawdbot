import { describe, expect, it } from "vitest";
import {
  classifySystemdUnavailableDetail,
  isSystemctlMissingDetail,
  isSystemdUserBusUnavailableDetail,
} from "./systemd-unavailable.js";

describe("classifySystemdUnavailableDetail", () => {
  it("classifies missing systemctl details", () => {
    expect(isSystemctlMissingDetail("spawn systemctl ENOENT")).toBe(true);
    expect(classifySystemdUnavailableDetail("systemctl not available")).toBe("missing_systemctl");
  });

  it("classifies user bus/session failures", () => {
    expect(
      isSystemdUserBusUnavailableDetail(
        "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
      ),
    ).toBe(true);
    expect(
      classifySystemdUnavailableDetail(
        "systemctl --user unavailable: Failed to connect to bus: No medium found",
      ),
    ).toBe("user_bus_unavailable");
    expect(
      classifySystemdUnavailableDetail(
        "systemctl --user unavailable: Failed to connect to bus: Permission denied",
      ),
    ).toBe("user_bus_unavailable");
  });

  it("classifies generic systemd-unavailable details", () => {
    expect(
      classifySystemdUnavailableDetail("System has not been booted with systemd as init system"),
    ).toBe("generic_unavailable");
    expect(classifySystemdUnavailableDetail("not supported on this host")).toBe(
      "generic_unavailable",
    );
  });

  it("returns null for unrelated details", () => {
    expect(classifySystemdUnavailableDetail("permission denied")).toBeNull();
  });
});
