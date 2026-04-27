import { describe, expect, it } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { isSystemdUnavailableDetail, renderSystemdUnavailableHints } from "./systemd-hints.js";

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
      `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`,
    ]);
  });

  it("skips headless recovery hints when container context is known", () => {
    expect(
      renderSystemdUnavailableHints({
        kind: "user_bus_unavailable",
        container: true,
      }),
    ).toEqual([
      "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
      `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`,
    ]);
  });
});
