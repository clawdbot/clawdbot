// Daemon response tests cover normalized daemon command response shapes.
import { describe, expect, it } from "vitest";
import { buildDaemonHintItems } from "./response.js";

describe("buildDaemonHintItems", () => {
  it("classifies common daemon hint kinds", () => {
    expect(
      buildDaemonHintItems([
        "openclaw gateway install",
        "Restart the container or the service that manages it for openclaw-demo-container.",
        "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
        "On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.",
        "If you're in a container, run the gateway in the foreground instead of `openclaw gateway`.",
        "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
      ]),
    ).toEqual([
      { kind: "install", text: "openclaw gateway install" },
      {
        kind: "container-restart",
        text: "Restart the container or the service that manages it for openclaw-demo-container.",
      },
      {
        kind: "systemd-unavailable",
        text: "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
      },
      {
        kind: "systemd-headless",
        text: "On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.",
      },
      {
        kind: "container-foreground",
        text: "If you're in a container, run the gateway in the foreground instead of `openclaw gateway`.",
      },
      {
        kind: "wsl-systemd",
        text: "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
      },
    ]);
  });
});
