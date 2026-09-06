// Gateway client bootstrap tests keep URL override provenance wired into shared
// auth resolution so CLI and env callers authenticate against the intended target.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { inspectGatewayTlsCertificate } from "../infra/tls/gateway.js";
import type { buildGatewayConnectionDetailsWithResolvers } from "./connection-details.js";
import type { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";

type AuthResolutionParams = Parameters<typeof resolveGatewayCredentialsWithSecretInputs>[0];

const mockState = vi.hoisted(() => ({
  buildGatewayConnectionDetails: vi.fn<typeof buildGatewayConnectionDetailsWithResolvers>(),
  inspectGatewayTlsCertificate: vi.fn<typeof inspectGatewayTlsCertificate>(),
  resolveGatewayCredentialsWithSecretInputs:
    vi.fn<typeof resolveGatewayCredentialsWithSecretInputs>(),
}));

vi.mock("../infra/tls/gateway.js", () => ({
  inspectGatewayTlsCertificate: mockState.inspectGatewayTlsCertificate,
}));

vi.mock("./connection-details.js", () => ({
  buildGatewayConnectionDetailsWithResolvers: mockState.buildGatewayConnectionDetails,
}));

vi.mock("./credentials-secret-inputs.js", () => ({
  resolveGatewayCredentialsWithSecretInputs: mockState.resolveGatewayCredentialsWithSecretInputs,
}));
const { resolveGatewayClientBootstrap } = await import("./client-bootstrap.js");

const LOCAL_TLS_FINGERPRINT = "ab".repeat(32);
const REMOTE_TLS_FINGERPRINT = "cd".repeat(32);

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
    mockState.inspectGatewayTlsCertificate.mockReset();
    mockState.inspectGatewayTlsCertificate.mockResolvedValue({
      ok: false,
      error: "gateway tls is disabled",
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
      message: "Gateway target: wss://override.example/ws",
    });

    const result = await resolveGatewayClientBootstrap({
      config: {} as never,
      gatewayUrl: "wss://override.example/ws",
      env: process.env,
    });

    expect(result).toEqual({
      url: "wss://override.example/ws",
      urlSource: "cli --url",
      connectionDetails: {
        url: "wss://override.example/ws",
        urlSource: "cli --url",
        message: "Gateway target: wss://override.example/ws",
      },
      urlOverrideSource: "cli",
      deviceAuthScope: "wss://override.example/ws",
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
      message: "Gateway target: wss://gateway.example/ws",
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
      message: "Gateway target: wss://127.0.0.1:18789",
    });
    mockState.inspectGatewayTlsCertificate.mockResolvedValue({
      ok: true,
      value: { cert: "public-certificate", fingerprintSha256: LOCAL_TLS_FINGERPRINT },
    });

    const result = await resolveGatewayClientBootstrap({
      config: { gateway: { tls: tlsConfig } } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBe(LOCAL_TLS_FINGERPRINT);
    expect(mockState.inspectGatewayTlsCertificate).toHaveBeenCalledWith(tlsConfig);
  });

  it("reuses local auth without pinning an exact public-origin target to the local certificate", async () => {
    const publicUrl = "wss://gateway.example/openclaw";
    const tlsConfig = { enabled: true };
    mockState.buildGatewayConnectionDetails
      .mockReturnValueOnce({
        url: publicUrl,
        urlSource: "cli --url",
        message: `Gateway target: ${publicUrl}`,
      })
      .mockReturnValueOnce({
        url: "wss://127.0.0.1:18789",
        urlSource: "local loopback",
        message: "Gateway target: wss://127.0.0.1:18789",
      });
    mockState.inspectGatewayTlsCertificate.mockResolvedValue({
      ok: true,
      value: { cert: "public-certificate", fingerprintSha256: LOCAL_TLS_FINGERPRINT },
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "local",
          publicOrigin: "https://gateway.example",
          controlUi: { basePath: "/openclaw" },
          tls: tlsConfig,
          auth: { mode: "token", token: "configured-token" },
        },
      } as never,
      gatewayUrl: publicUrl,
      authPolicy: "interactive",
      allowConfiguredAuthForExactTarget: true,
      env: process.env,
    });

    expect(result.auth.token).toBe("configured-token");
    expect(result.tlsFingerprint).toBeUndefined();
    expect(mockState.inspectGatewayTlsCertificate).not.toHaveBeenCalled();
  });

  it("retains the local certificate pin for an exact direct-local target", async () => {
    const localUrl = "wss://127.0.0.1:18789/openclaw";
    const tlsConfig = { enabled: true };
    mockState.buildGatewayConnectionDetails
      .mockReturnValueOnce({
        url: localUrl,
        urlSource: "cli --url",
        message: `Gateway target: ${localUrl}`,
      })
      .mockReturnValueOnce({
        url: "wss://127.0.0.1:18789",
        urlSource: "local loopback",
        message: "Gateway target: wss://127.0.0.1:18789",
      });
    mockState.inspectGatewayTlsCertificate.mockResolvedValue({
      ok: true,
      value: { cert: "public-certificate", fingerprintSha256: LOCAL_TLS_FINGERPRINT },
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "local",
          controlUi: { basePath: "/openclaw" },
          tls: tlsConfig,
          auth: { mode: "token", token: "configured-token" },
        },
      } as never,
      gatewayUrl: localUrl,
      explicitAuth: { token: "explicit-token" },
      authPolicy: "interactive",
      allowConfiguredAuthForExactTarget: true,
      env: process.env,
    });

    expect(result.auth.token).toBe("explicit-token");
    expect(result.tlsFingerprint).toBe(LOCAL_TLS_FINGERPRINT);
    expect(mockState.inspectGatewayTlsCertificate).toHaveBeenCalledWith(tlsConfig);
  });

  it("prefers direct-local TLS ownership when publicOrigin resolves to the same URL", async () => {
    const localUrl = "wss://127.0.0.1:18789/openclaw";
    const tlsConfig = { enabled: true };
    mockState.buildGatewayConnectionDetails
      .mockReturnValueOnce({
        url: localUrl,
        urlSource: "cli --url",
        message: `Gateway target: ${localUrl}`,
      })
      .mockReturnValueOnce({
        url: "wss://127.0.0.1:18789",
        urlSource: "local loopback",
        message: "Gateway target: wss://127.0.0.1:18789",
      });
    mockState.inspectGatewayTlsCertificate.mockResolvedValue({
      ok: true,
      value: { cert: "public-certificate", fingerprintSha256: LOCAL_TLS_FINGERPRINT },
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "local",
          publicOrigin: "https://127.0.0.1:18789",
          controlUi: { basePath: "/openclaw" },
          tls: tlsConfig,
          auth: { mode: "token", token: "configured-token" },
        },
      } as never,
      gatewayUrl: localUrl,
      authPolicy: "interactive",
      allowConfiguredAuthForExactTarget: true,
      env: process.env,
    });

    expect(result.auth.token).toBe("configured-token");
    expect(result.tlsFingerprint).toBe(LOCAL_TLS_FINGERPRINT);
    expect(mockState.inspectGatewayTlsCertificate).toHaveBeenCalledWith(tlsConfig);
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
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url,
      urlSource,
      message: `Gateway target: ${url}`,
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example/ws",
            tlsFingerprint: `sha256:${REMOTE_TLS_FINGERPRINT.toUpperCase()}`,
          },
        },
      } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBe(REMOTE_TLS_FINGERPRINT);
    expect(mockState.inspectGatewayTlsCertificate).not.toHaveBeenCalled();
  });

  it("does not inherit the configured remote pin for CLI URL overrides", async () => {
    const url = "wss://override.example/ws";
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url,
      urlSource: "cli --url",
      message: `Gateway target: ${url}`,
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example/ws",
            tlsFingerprint: `sha256:${REMOTE_TLS_FINGERPRINT}`,
          },
        },
      } as never,
      gatewayUrl: url,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBeUndefined();
    expect(mockState.inspectGatewayTlsCertificate).not.toHaveBeenCalled();
  });

  it("preserves the configured remote pin so plaintext targets fail closed", async () => {
    const url = "ws://127.0.0.1:18789";
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url,
      urlSource: "config gateway.remote.url",
      message: `Gateway target: ${url}`,
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url,
            tlsFingerprint: `sha256:${REMOTE_TLS_FINGERPRINT}`,
          },
        },
      } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBe(REMOTE_TLS_FINGERPRINT);
    expect(mockState.inspectGatewayTlsCertificate).not.toHaveBeenCalled();
  });

  it("uses the local pin when remote mode falls back to the configured local gateway", async () => {
    const tlsConfig = { enabled: true };
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://127.0.0.1:18789",
      urlSource: "missing gateway.remote.url (fallback local)",
      message: "Gateway target: wss://127.0.0.1:18789",
    });
    mockState.inspectGatewayTlsCertificate.mockResolvedValue({
      ok: true,
      value: { cert: "public-certificate", fingerprintSha256: LOCAL_TLS_FINGERPRINT },
    });

    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          tls: tlsConfig,
          remote: { tlsFingerprint: `sha256:${REMOTE_TLS_FINGERPRINT}` },
        },
      } as never,
      env: process.env,
    });

    expect(result.tlsFingerprint).toBe(LOCAL_TLS_FINGERPRINT);
    expect(mockState.inspectGatewayTlsCertificate).toHaveBeenCalledWith(tlsConfig);
  });

  it("rejects an invalid explicit TLS fingerprint", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://gateway.example/ws",
      urlSource: "cli --url",
      message: "Gateway target: wss://gateway.example/ws",
    });

    await expect(
      resolveGatewayClientBootstrap({
        config: {} as never,
        gatewayUrl: "wss://gateway.example/ws",
        explicitTlsFingerprint: "sha256:abc123",
        env: process.env,
      }),
    ).rejects.toThrow("Invalid TLS fingerprint");
  });
});
