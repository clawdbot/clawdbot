// Daemon response tests cover normalized daemon command response shapes.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";
import { createDaemonActionContext, installDaemonServiceAndEmit } from "./response.js";

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

describe("daemon install verification", () => {
  function createInstallParams(isLoaded: GatewayService["isLoaded"]) {
    const service = {
      label: "systemd user",
      loadedText: "enabled",
      notLoadedText: "disabled",
      isLoaded,
    } as GatewayService;
    return {
      serviceNoun: "Gateway",
      service,
      warnings: [],
      emit: vi.fn(),
      fail: vi.fn(),
      install: vi.fn(async () => {}),
    };
  }

  it("fails install when service-manager verification throws", async () => {
    const params = createInstallParams(
      vi.fn(async () => {
        throw new Error("manager access denied");
      }),
    );

    await installDaemonServiceAndEmit(params);

    expect(params.fail).toHaveBeenCalledWith(
      "Gateway install verification failed: Error: manager access denied",
      undefined,
    );
    expect(params.emit).not.toHaveBeenCalled();
  });

  it("fails install when the service is not loaded after installation", async () => {
    const params = createInstallParams(vi.fn(async () => false));

    await installDaemonServiceAndEmit(params);

    expect(params.fail).toHaveBeenCalledWith(
      "Gateway install verification failed: service is not enabled.",
    );
    expect(params.emit).not.toHaveBeenCalled();
  });

  it("emits success only after the service-manager verification succeeds", async () => {
    const params = createInstallParams(vi.fn(async () => true));

    await installDaemonServiceAndEmit(params);

    expect(params.fail).not.toHaveBeenCalled();
    expect(params.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        result: "installed",
        service: expect.objectContaining({ loaded: true }),
      }),
    );
  });
});
