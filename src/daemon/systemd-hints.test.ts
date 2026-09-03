// Systemd hint tests cover Linux daemon setup guidance.
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  isSystemdUnavailableDetail,
  renderSystemdErrorHints,
  renderSystemdUnavailableHints,
} from "./systemd-hints.js";

describe("isSystemdUnavailableDetail", () => {
  it("matches systemd unavailable error details", () => {
    expect(
      isSystemdUnavailableDetail("systemctl --user unavailable: Failed to connect to bus"),
    ).toBe(true);
    expect(isSystemdUnavailableDetail("systemctl --user unavailable: ENOMEDIUM")).toBe(true);
    expect(
      isSystemdUnavailableDetail(
        "systemctl --user unavailable: Failed to connect to bus: Permission denied",
      ),
    ).toBe(true);
    expect(
      isSystemdUnavailableDetail(
        "systemctl not available; systemd user services are required on Linux.",
      ),
    ).toBe(true);
    expect(isSystemdUnavailableDetail("permission denied")).toBe(false);
  });
});

describe("renderSystemdUnavailableHints", () => {
  it("renders WSL2-specific recovery hints", () => {
    expect(renderSystemdUnavailableHints({ wsl: true })).toEqual([
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
      "Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
      "Verify: systemctl --user status",
    ]);
  });

  it("renders generic Linux recovery hints outside WSL", () => {
    expect(renderSystemdUnavailableHints({ kind: "generic_unavailable" })).toEqual([
      "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
      `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`,
    ]);
  });

  it("adds headless recovery hints only for user bus/session failures", () => {
    expect(renderSystemdUnavailableHints({ kind: "user_bus_unavailable" })).toEqual([
      "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
      "On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.",
      "Also ensure XDG_RUNTIME_DIR is set: `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, then retry.",
      "If `/run/user/$(id -u)/bus` is missing, install the D-Bus user session bus (Debian/Ubuntu: `sudo apt-get install dbus-user-session`), then run `systemctl --user daemon-reload && systemctl --user start dbus.socket`.",
      `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`,
    ]);
  });

  it("renders hints only for classified Linux service-manager errors", async () => {
    const userBusError = new Error(
      "Effective systemd service command could not be inspected: Failed to connect to user scope bus via local transport: No such file or directory",
    );
    await withMockedPlatform("linux", async () => {
      await expect(renderSystemdErrorHints(userBusError)).resolves.toEqual(
        expect.arrayContaining([expect.stringContaining("dbus-user-session")]),
      );
      await expect(
        renderSystemdErrorHints(new Error("inspection-secret-canary")),
      ).resolves.toBeUndefined();
    });
    await withMockedPlatform("darwin", async () => {
      await expect(renderSystemdErrorHints(userBusError)).resolves.toBeUndefined();
    });
  });

  it("skips headless recovery hints when container context is known", () => {
    const env = { OPENCLAW_CONTAINER_HINT: "sandbox" };
    expect(
      renderSystemdUnavailableHints({
        kind: "user_bus_unavailable",
        env,
      }),
    ).toEqual([
      "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
      `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway", env)}\`.`,
    ]);
  });
});
