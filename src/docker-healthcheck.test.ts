import { describe, expect, it, vi } from "vitest";
import { probeDockerGatewayHealth } from "./docker-healthcheck.js";

describe("Docker healthcheck", () => {
  it("probes the active Gateway lock port used by --port", async () => {
    const getRuntimeConfig = vi.fn(() => ({ gateway: { port: 19002 } }));
    const resolveGatewayPort = vi.fn(() => 19003);
    const fetch = vi.fn(async () => ({ ok: true }) as Response);

    await expect(
      probeDockerGatewayHealth({
        env: { OPENCLAW_GATEWAY_PORT: "19001" },
        fetch,
        getRuntimeConfig,
        readActiveGatewayLockPort: vi.fn(async () => 19000),
        resolveGatewayPort,
      }),
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:19000/healthz");
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
  ])(
    "probes the canonical $name port when no active lock exists",
    async ({ env, config, expected }) => {
      const fetch = vi.fn(async () => ({ ok: true }) as Response);

      await expect(
        probeDockerGatewayHealth({
          env,
          fetch,
          getRuntimeConfig: () => config,
          readActiveGatewayLockPort: vi.fn(async () => undefined),
        }),
      ).resolves.toBe(true);
      expect(fetch).toHaveBeenCalledWith(`http://127.0.0.1:${expected}/healthz`);
    },
  );

  it("probes the configured port when the active lock cannot be read", async () => {
    const fetch = vi.fn(async () => ({ ok: true }) as Response);

    await expect(
      probeDockerGatewayHealth({
        env: {},
        fetch,
        getRuntimeConfig: () => ({ gateway: { port: 19002 } }),
        readActiveGatewayLockPort: vi.fn(async () => {
          throw new Error("lock unavailable");
        }),
        resolveGatewayPort: (config) => config.gateway?.port ?? 18789,
      }),
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:19002/healthz");
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
