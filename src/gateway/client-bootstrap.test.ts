// Gateway client bootstrap tests keep URL override provenance wired into shared
// auth resolution so CLI and env callers authenticate against the intended target.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";

type AuthResolutionParams = Parameters<typeof resolveGatewayCredentialsWithSecretInputs>[0];

const mockState = vi.hoisted(() => ({
  buildGatewayConnectionDetails: vi.fn(),
  loadGatewayTlsRuntime: vi.fn(),
  resolveGatewayCredentialsWithSecretInputs: vi.fn(),
}));

vi.mock("../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: (...args: unknown[]) => mockState.loadGatewayTlsRuntime(...args),
}));

vi.mock("./connection-details.js", () => ({
  buildGatewayConnectionDetailsWithResolvers: (...args: unknown[]) =>
    mockState.buildGatewayConnectionDetails(...args),
}));

vi.mock("./credentials-secret-inputs.js", () => ({
  resolveGatewayCredentialsWithSecretInputs: (...args: unknown[]) =>
    mockState.resolveGatewayCredentialsWithSecretInputs(...args),
}));
const { resolveGatewayClientBootstrap } = await import("./client-bootstrap.js");

function expectLastAuthResolutionParams(expected: {
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
}) {
  const [params] = mockState.resolveGatewayCredentialsWithSecretInputs.mock.calls.at(-1) ?? [];
  if (params === undefined) {
    throw new Error("Expected shared auth resolution to be called");
  }
  const authParams = params as AuthResolutionParams;
  expect(authParams.env).toBe(process.env);
  expect(authParams.urlOverride).toBe(expected.urlOverride);
  expect(authParams.urlOverrideSource).toBe(expected.urlOverrideSource);
}

describe("resolveGatewayClientBootstrap", () => {
  beforeEach(() => {
    mockState.buildGatewayConnectionDetails.mockReset();
    mockState.loadGatewayTlsRuntime.mockReset();
    mockState.loadGatewayTlsRuntime.mockResolvedValue({
      enabled: false,
      required: false,
    });
    mockState.resolveGatewayCredentialsWithSecretInputs.mockReset();
    mockState.resolveGatewayCredentialsWithSecretInputs.mockResolvedValue({
      token: undefined,
      password: undefined,
    });
  });

  it("passes cli override context into shared auth resolution", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValueOnce({
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
    expectLastAuthResolutionParams({
      urlOverride: "wss://override.example/ws",
      urlOverrideSource: "cli",
    });
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

    expectLastAuthResolutionParams({
      urlOverride: undefined,
      urlOverrideSource: undefined,
    });
  });

  it("returns the local TLS fingerprint for config-derived WSS clients", async () => {
    const tlsConfig = { enabled: true };
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://127.0.0.1:18789",
      urlSource: "local loopback",
    });
    mockState.loadGatewayTlsRuntime.mockResolvedValue({
      enabled: true,
      required: true,
      fingerprintSha256: "sha256:local",
    });

    const result = await resolveGatewayClientBootstrap({
      config: { gateway: { tls: tlsConfig } } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBe("sha256:local");
    expect(mockState.loadGatewayTlsRuntime).toHaveBeenCalledWith(tlsConfig);
  });

  it.each([
    {
      url: "wss://gateway.example/ws",
      urlSource: "config gateway.remote.url",
    },
    {
      url: "wss://override.example/ws",
      urlSource: "env OPENCLAW_GATEWAY_URL",
    },
  ])("returns the configured remote pin for $urlSource", async ({ url, urlSource }) => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({ url, urlSource });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example/ws",
            tlsFingerprint: "sha256:remote",
          },
        },
      } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBe("sha256:remote");
    expect(mockState.loadGatewayTlsRuntime).not.toHaveBeenCalled();
  });

  it("does not inherit the configured remote pin for CLI URL overrides", async () => {
    const url = "wss://override.example/ws";
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url,
      urlSource: "cli --url",
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example/ws",
            tlsFingerprint: "sha256:remote",
          },
        },
      } as never,
      gatewayUrl: url,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBeUndefined();
    expect(mockState.loadGatewayTlsRuntime).not.toHaveBeenCalled();
  });

  it("preserves the configured remote pin so plaintext targets fail closed", async () => {
    const url = "ws://127.0.0.1:18789";
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url,
      urlSource: "config gateway.remote.url",
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url,
            tlsFingerprint: "sha256:remote",
          },
        },
      } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBe("sha256:remote");
    expect(mockState.loadGatewayTlsRuntime).not.toHaveBeenCalled();
  });

  it("uses the local pin when remote mode falls back to the configured local gateway", async () => {
    const tlsConfig = { enabled: true };
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://127.0.0.1:18789",
      urlSource: "missing gateway.remote.url (fallback local)",
    });
    mockState.loadGatewayTlsRuntime.mockResolvedValue({
      enabled: true,
      required: true,
      fingerprintSha256: "sha256:local",
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          tls: tlsConfig,
          remote: { tlsFingerprint: "sha256:remote" },
        },
      } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBe("sha256:local");
    expect(mockState.loadGatewayTlsRuntime).toHaveBeenCalledWith(tlsConfig);
  });
});
