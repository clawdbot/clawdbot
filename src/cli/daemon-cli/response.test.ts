// Daemon response tests cover normalized daemon command response shapes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { createDaemonActionContext } from "./response.js";

describe("daemon action JSON hints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies common daemon hint kinds", () => {
    const hints = [
      "openclaw gateway install",
      "Restart the container or the service that manages it for openclaw-demo-container.",
      "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
      "On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.",
      "If you're in a container, run the gateway in the foreground instead of `openclaw gateway`.",
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
    ];
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    createDaemonActionContext({ action: "install", json: true }).emit({ ok: false, hints });

    expect(writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "install",
        hints,
        hintItems: [
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
        ],
      }),
    );
  });
});
