// Non-interactive daemon install tests cover gateway service planning, token resolution, and systemd handling.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { installGatewayDaemonNonInteractive } from "./daemon-install.js";

const buildGatewayInstallPlan = vi.hoisted(() => vi.fn());
const gatewayInstallErrorHint = vi.hoisted(() => vi.fn(() => "hint"));
const resolveGatewayInstallToken = vi.hoisted(() => vi.fn());
const serviceInstall = vi.hoisted(() => vi.fn(async () => {}));
const serviceReadCommand = vi.hoisted(() => vi.fn());
const ensureSystemdUserLingerNonInteractive = vi.hoisted(() => vi.fn(async () => {}));
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
}));

vi.mock("../../gateway-install-token.js", () => ({
  resolveGatewayInstallToken,
}));

vi.mock("../../../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    install: serviceInstall,
    readCommand: serviceReadCommand,
  })),
}));

vi.mock("../../../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable,
}));

vi.mock("../../daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  isGatewayDaemonRuntime: vi.fn(() => true),
}));

vi.mock("../../systemd-linger.js", () => ({
  ensureSystemdUserLingerNonInteractive,
}));

describe("installGatewayDaemonNonInteractive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceReadCommand.mockResolvedValue(null);
    isSystemdUserServiceAvailable.mockResolvedValue(true);
    resolveGatewayInstallToken.mockResolvedValue({
      warnings: [],
    });
    buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {},
    });
  });

  it("preserves stored heap controls without passing plaintext tokens for SecretRef-managed install", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const managedDefinition = {
      programArguments: [
        "/usr/bin/node",
        "--max-old-space-size=24576",
        "--require=/tmp/service-preload.js",
        "/usr/local/bin/openclaw",
        "gateway",
      ],
      environment: { NODE_OPTIONS: "--max-heap-size=32768", UNRELATED: "not-persisted" },
    };
    const existingCommand = {
      programArguments: ["/operator/drop-in-wrapper", "gateway"],
      environment: { NODE_OPTIONS: "--max-old-space-size=1024" },
      managedDefinition,
      managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
    };
    serviceReadCommand.mockResolvedValue(existingCommand);

    await installGatewayDaemonNonInteractive({
      nextConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_GATEWAY_TOKEN",
            },
          },
        },
      } as OpenClawConfig,
      opts: { installDaemon: true },
      runtime,
      port: 18789,
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        existingCommand,
      }),
    );
    expect(buildGatewayInstallPlan.mock.calls[0]?.[0]).not.toHaveProperty("existingEnvironment");
    expect(
      "token" in
        expectDefined(
          buildGatewayInstallPlan.mock.calls[0],
          "buildGatewayInstallPlan.mock.calls[0] test invariant",
        )[0],
    ).toBe(false);
    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });

  it("forwards Bun as the explicit daemon runtime", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await installGatewayDaemonNonInteractive({
      nextConfig: {} as OpenClawConfig,
      opts: { installDaemon: true, daemonRuntime: "bun" },
      runtime,
      port: 18789,
    });

    expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "bun" }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("aborts with actionable error when SecretRef is unresolved", async () => {
    resolveGatewayInstallToken.mockResolvedValue({
      unavailableReason: "gateway.auth.token SecretRef is configured but unresolved (boom).",
      warnings: [],
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await installGatewayDaemonNonInteractive({
      nextConfig: {} as OpenClawConfig,
      opts: { installDaemon: true },
      runtime,
      port: 18789,
    });

    expect(runtime.error.mock.calls).toEqual([
      [
        "Gateway install blocked: gateway.auth.token SecretRef is configured but unresolved (boom). Fix gateway auth config/token input and rerun setup.",
      ],
    ]);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(buildGatewayInstallPlan).not.toHaveBeenCalled();
    expect(serviceInstall).not.toHaveBeenCalled();
  });

  it("returns a skipped result when Linux user systemd is unavailable", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const originalPlatform = process.platform;

    isSystemdUserServiceAvailable.mockResolvedValue(false);
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });

    try {
      const result = await installGatewayDaemonNonInteractive({
        nextConfig: {} as OpenClawConfig,
        opts: { installDaemon: true },
        runtime,
        port: 18789,
      });

      expect(result).toEqual({
        installed: false,
        skippedReason: "systemd-user-unavailable",
      });
      expect(runtime.log.mock.calls).toEqual([
        [
          "Systemd user services are unavailable; skipping service install. Use a direct shell run (`openclaw gateway run`) or rerun without --install-daemon on this session.",
        ],
      ]);
      expect(buildGatewayInstallPlan).not.toHaveBeenCalled();
      expect(serviceInstall).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });
});
