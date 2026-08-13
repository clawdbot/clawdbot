// Doctor Tailscale tests cover safe migration of shipped external Serve routes.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TailscaleStatusCommandRunner } from "../shared/tailscale-status.js";
import { prepareLegacyTailscaleServeConfigMigration } from "./doctor-tailscale.js";

function serveStatus(
  params: {
    backendPort?: number;
    hostPort?: number;
    path?: string;
    proxyHost?: string;
    funnel?: boolean;
  } = {},
): string {
  const backendPort = params.backendPort ?? 18789;
  const hostPort = params.hostPort ?? 443;
  const host = `mac.tail.ts.net:${hostPort}`;
  return JSON.stringify({
    TCP: { [hostPort]: { HTTPS: true } },
    Web: {
      [host]: {
        Handlers: {
          [params.path ?? "/"]: {
            Proxy: `http://${params.proxyHost ?? "127.0.0.1"}:${backendPort}`,
          },
        },
      },
    },
    ...(params.funnel ? { AllowFunnel: { [host]: true } } : {}),
  });
}

function runner(stdout: string): TailscaleStatusCommandRunner {
  return vi.fn().mockResolvedValue({ code: 0, stdout });
}

describe("prepareLegacyTailscaleServeConfigMigration", () => {
  it("moves the shipped LAN Serve shape to managed ingress", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        port: 18789,
        auth: { mode: "token", token: "secret", allowTailscale: true },
        tailscale: { mode: "off", resetOnExit: true, preserveFunnel: true },
      },
    };

    const result = await prepareLegacyTailscaleServeConfigMigration({
      cfg,
      env: {},
      runCommandWithTimeout: runner(serveStatus()),
    });

    expect(result.config.gateway).toEqual({
      mode: "local",
      bind: "loopback",
      port: 18789,
      auth: { mode: "token", token: "secret", allowTailscale: true },
      tailscale: { mode: "serve", resetOnExit: true },
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("managed Tailscale Serve ingress");
    expect(result.warnings).toEqual([]);
    expect(cfg.gateway?.bind).toBe("lan");
  });

  it.each([
    ["no matching route", {}, "{}"],
    ["Funnel route", {}, serveStatus({ funnel: true })],
    ["non-root route", {}, serveStatus({ path: "/openclaw" })],
    ["non-loopback backend", {}, serveStatus({ proxyHost: "192.0.2.10" })],
    ["different backend port", {}, serveStatus({ backendPort: 19000 })],
    ["non-LAN bind", { bind: "loopback" as const }, serveStatus()],
    ["managed mode", { tailscale: { mode: "serve" as const } }, serveStatus()],
    ["remote Gateway", { mode: "remote" as const }, serveStatus()],
  ])("does not migrate a %s", async (_label, gatewayOverrides, stdout) => {
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        port: 18789,
        auth: { mode: "token", token: "secret" },
        tailscale: { mode: "off" },
        ...gatewayOverrides,
      },
    };

    const result = await prepareLegacyTailscaleServeConfigMigration({
      cfg,
      env: {},
      runCommandWithTimeout: runner(stdout),
    });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });

  it.each([
    [
      "a custom HTTPS port",
      { tailscale: { mode: "off" as const } },
      serveStatus({ hostPort: 8443 }),
    ],
    [
      "a configured Service",
      { tailscale: { mode: "off" as const, serviceName: "svc:openclaw" } },
      serveStatus(),
    ],
    ["authentication disabled", { auth: { mode: "none" as const } }, serveStatus()],
  ])("warns instead of guessing how to migrate %s", async (_label, gatewayOverrides, stdout) => {
    const cfg: OpenClawConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        port: 18789,
        auth: { mode: "token", token: "secret" },
        tailscale: { mode: "off" },
        ...gatewayOverrides,
      },
    };

    const result = await prepareLegacyTailscaleServeConfigMigration({
      cfg,
      env: {},
      runCommandWithTimeout: runner(stdout),
    });

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("not changed");
  });

  it("warns on malformed status but stays quiet when Tailscale is unavailable", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "secret" },
        tailscale: { mode: "off" },
      },
    };
    const unavailable = vi.fn().mockRejectedValue(new Error("missing"));

    const invalidResult = await prepareLegacyTailscaleServeConfigMigration({
      cfg,
      env: {},
      runCommandWithTimeout: runner("not-json"),
    });
    const unavailableResult = await prepareLegacyTailscaleServeConfigMigration({
      cfg,
      env: {},
      runCommandWithTimeout: unavailable,
    });

    expect(invalidResult.warnings.join("\n")).toContain("could not be parsed");
    expect(unavailableResult.warnings).toEqual([]);
  });
});
