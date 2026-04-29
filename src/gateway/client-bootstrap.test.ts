import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  buildGatewayConnectionDetails: vi.fn(),
  resolveGatewayConnectionAuth: vi.fn(),
}));

vi.mock("./call.js", () => ({
  buildGatewayConnectionDetails: (...args: unknown[]) =>
    mockState.buildGatewayConnectionDetails(...args),
}));

vi.mock("./connection-auth.js", () => ({
  resolveGatewayConnectionAuth: (...args: unknown[]) =>
    mockState.resolveGatewayConnectionAuth(...args),
}));

const { resolveGatewayClientBootstrap, resolveGatewayUrlOverrideSource } =
  await import("./client-bootstrap.js");

describe("resolveGatewayUrlOverrideSource", () => {
  it("maps override url sources only", () => {
    expect(resolveGatewayUrlOverrideSource("cli --url")).toBe("cli");
    expect(resolveGatewayUrlOverrideSource("env OPENCLAW_GATEWAY_URL")).toBe("env");
    expect(resolveGatewayUrlOverrideSource("config gateway.remote.url")).toBeUndefined();
  });
});

describe("resolveGatewayClientBootstrap", () => {
  beforeEach(() => {
    mockState.buildGatewayConnectionDetails.mockReset();
    mockState.resolveGatewayConnectionAuth.mockReset();
    mockState.resolveGatewayConnectionAuth.mockResolvedValue({
      token: undefined,
      password: undefined,
    });
  });

  it("passes cli override context into shared auth resolution", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://override.example/ws",
      urlSource: "cli --url",
    });

    const result = await resolveGatewayClientBootstrap({
      config: {} as never,
      gatewayUrl: "wss://override.example/ws",
      env: process.env,
    });

    expect(result).toEqual({
      url: "wss://override.example/ws",
      urlSource: "cli --url",
      preauthHandshakeTimeoutMs: undefined,
      auth: {
        token: undefined,
        password: undefined,
      },
    });
    expect(mockState.resolveGatewayConnectionAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        env: process.env,
        urlOverride: "wss://override.example/ws",
        urlOverrideSource: "cli",
      }),
    );
  });

  it("does not mark config-derived urls as overrides", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://gateway.example/ws",
      urlSource: "config gateway.remote.url",
    });

    await resolveGatewayClientBootstrap({
      config: {} as never,
      env: process.env,
    });

    expect(mockState.resolveGatewayConnectionAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        env: process.env,
        urlOverride: undefined,
        urlOverrideSource: undefined,
      }),
    );
  });

  it("carries configured preauth handshake timeout for GatewayClient callers", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
    });

    const result = await resolveGatewayClientBootstrap({
      config: { gateway: { handshakeTimeoutMs: 30_000 } } as never,
      env: process.env,
    });

    expect(result.preauthHandshakeTimeoutMs).toBe(30_000);
  });
});
