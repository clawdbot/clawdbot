import { describe, expect, it, vi } from "vitest";
import { probeDockerGatewayHealth, resolveDockerHealthcheckPort } from "./docker-healthcheck.js";

describe("Docker healthcheck", () => {
  it("prefers the active Gateway lock port used by --port", async () => {
    const getRuntimeConfig = vi.fn(() => ({ gateway: { port: 19002 } }));
    const resolveGatewayPort = vi.fn(() => 19003);

    await expect(
      resolveDockerHealthcheckPort({
        env: { OPENCLAW_GATEWAY_PORT: "19001" },
        getRuntimeConfig,
        readActiveGatewayLockPort: vi.fn(async () => 19000),
        resolveGatewayPort,
      }),
    ).resolves.toBe(19000);
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(resolveGatewayPort).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "environment",
      env: { OPENCLAW_GATEWAY_PORT: "19001" },
      config: { gateway: { port: 19002 } },
      expected: 19001,
    },
    {
      name: "config",
      env: {},
      config: { gateway: { port: 19002 } },
      expected: 19002,
    },
  ])("falls back to the canonical $name port", async ({ env, config, expected }) => {
    await expect(
      resolveDockerHealthcheckPort({
        env,
        getRuntimeConfig: () => config,
        readActiveGatewayLockPort: vi.fn(async () => undefined),
      }),
    ).resolves.toBe(expected);
  });

  it("falls back to config when the active lock cannot be read", async () => {
    await expect(
      resolveDockerHealthcheckPort({
        env: {},
        getRuntimeConfig: () => ({ gateway: { port: 19002 } }),
        readActiveGatewayLockPort: vi.fn(async () => {
          throw new Error("lock unavailable");
        }),
        resolveGatewayPort: (config) => config.gateway?.port ?? 18789,
      }),
    ).resolves.toBe(19002);
  });

  it("probes the unauthenticated liveness endpoint on the resolved port", async () => {
    const fetch = vi.fn(async () => ({ ok: true }) as Response);

    await expect(
      probeDockerGatewayHealth({
        env: {},
        fetch,
        getRuntimeConfig: () => ({ gateway: { port: 19002 } }),
        readActiveGatewayLockPort: vi.fn(async () => 19000),
        resolveGatewayPort: vi.fn(() => 19002),
      }),
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:19000/healthz");
  });

  it("reports an unsuccessful or unreachable liveness endpoint as unhealthy", async () => {
    const baseDeps = {
      env: {},
      getRuntimeConfig: () => ({ gateway: { port: 19002 } }),
      readActiveGatewayLockPort: vi.fn(async () => 19000),
      resolveGatewayPort: vi.fn(() => 19002),
    };

    await expect(
      probeDockerGatewayHealth({
        ...baseDeps,
        fetch: vi.fn(async () => ({ ok: false }) as Response),
      }),
    ).resolves.toBe(false);
    await expect(
      probeDockerGatewayHealth({
        ...baseDeps,
        fetch: vi.fn(async () => {
          throw new Error("connection refused");
        }),
      }),
    ).resolves.toBe(false);
  });
});
