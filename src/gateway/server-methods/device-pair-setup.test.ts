/**
 * Tests the device.pair.setupCode gateway method: it produces a connect setup
 * code + QR for non-terminal clients and never leaks the gateway credential.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as devicePairingJoinCode from "../../infra/device-pairing-join-code.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolvePairingSetupFromConfig: vi.fn(),
  encodePairingSetupCode: vi.fn(),
  renderQrPngDataUrl: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  readDevicePairSetupCompletion: vi.fn(),
}));

vi.mock("../../pairing/setup-code.js", () => ({
  resolvePairingSetupFromConfig: mocks.resolvePairingSetupFromConfig,
  encodePairingSetupCode: mocks.encodePairingSetupCode,
}));
vi.mock("../../media/qr-image.js", () => ({
  renderQrPngDataUrl: mocks.renderQrPngDataUrl,
}));
vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));
vi.mock("../../infra/device-bootstrap.js", () => ({
  readDevicePairSetupCompletion: mocks.readDevicePairSetupCompletion,
}));

import { devicePairSetupHandlers } from "./device-pair-setup.js";

function createOptions(
  params: Record<string, unknown>,
  config: Record<string, unknown> = {},
): {
  options: GatewayRequestHandlerOptions;
  respond: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn();
  const options = {
    req: { type: "req", id: "req-1", method: "device.pair.setupCode", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeConfig: vi.fn(() => config),
      gatewayTlsFingerprint: "sha256:gateway-leaf",
    },
  } as unknown as GatewayRequestHandlerOptions;
  return { options, respond };
}

const okResolution = {
  ok: true as const,
  payload: {
    url: "wss://gw.example:8443",
    urls: ["wss://gw.example:8443", "ws://192.168.1.20:18789"],
    bootstrapToken: "boot-123",
  },
  authLabel: "token" as const,
  urlSource: "remote",
  access: "full" as const,
  accessDowngraded: false,
  setupId: "setup-123",
  expiresAtMs: 123_456,
};

describe("device.pair.setupCode", () => {
  beforeEach(() => {
    mocks.resolvePairingSetupFromConfig.mockReset();
    mocks.encodePairingSetupCode.mockReset();
    mocks.renderQrPngDataUrl.mockReset();
    mocks.runCommandWithTimeout.mockReset();
    mocks.readDevicePairSetupCompletion.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the setup code, QR data URL, and only an auth label", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockResolvedValue("data:image/png;base64,qr");

    const { options, respond } = createOptions({});
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(payload).toEqual({
      setupId: "setup-123",
      expiresAtMs: 123_456,
      setupCode: "SETUP-CODE-XYZ",
      qrDataUrl: "data:image/png;base64,qr",
      gatewayUrl: "wss://gw.example:8443",
      gatewayUrls: ["wss://gw.example:8443", "ws://192.168.1.20:18789"],
      auth: "token",
      urlSource: "remote",
      access: "full",
    });
    // The setup id is an independent correlator; the bearer remains only in the opaque code.
    expect(JSON.stringify(payload)).not.toContain("boot-123");
    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ localTlsFingerprint: "sha256:gateway-leaf" }),
    );
  });

  it("reports when plaintext transport limits a requested full-access code", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue({
      ...okResolution,
      access: "limited",
      accessDowngraded: true,
    });
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");

    const { options, respond } = createOptions({ includeQr: false });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      access: "limited",
      accessDowngraded: true,
    });
  });

  it("preserves the configured device-pair public URL fallback", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockResolvedValue("data:image/png;base64,qr");

    const { options } = createOptions(
      {},
      {
        plugins: {
          entries: {
            "device-pair": { config: { publicUrl: " wss://gateway.example.com " } },
          },
        },
      },
    );
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ publicUrl: "wss://gateway.example.com" }),
    );
  });

  it("labels an explicit request URL separately from configured fallback", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockResolvedValue("data:image/png;base64,qr");

    const { options, respond } = createOptions({ publicUrl: "wss://request.example.com" });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ publicUrl: "wss://request.example.com" }),
    );
    expect(respond.mock.calls[0]?.[1]?.urlSource).toBe("request.publicUrl");
  });

  it("prefers the remote URL over the configured device-pair fallback", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockResolvedValue("data:image/png;base64,qr");

    const { options } = createOptions(
      { preferRemoteUrl: true },
      {
        plugins: {
          entries: {
            "device-pair": { config: { publicUrl: "wss://plugin.example.com" } },
          },
        },
      },
    );
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ publicUrl: undefined, preferRemoteUrl: true }),
    );
  });

  it("omits the QR when includeQr is false", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");

    const { options, respond } = createOptions({ includeQr: false });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.renderQrPngDataUrl).not.toHaveBeenCalled();
    const [ok, payload] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(true);
    expect(payload.qrDataUrl).toBeUndefined();
    expect(payload.setupCode).toBe("SETUP-CODE-XYZ");
  });

  it("requests a node-only bootstrap profile for companion setup", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");

    const { options } = createOptions({ includeQr: false, bootstrapProfile: "node" });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        bootstrapProfile: { roles: ["node"], scopes: [] },
      }),
    );
  });

  it("mints from a secure fallback and preserves its public context path", async () => {
    const resolution = {
      ...okResolution,
      payload: {
        url: "ws://192.168.1.20:18789/openclaw-gw",
        urls: [
          "ws://192.168.1.20:18789/openclaw-gw",
          "wss://gateway.tailnet.example/public-gateway",
        ],
        bootstrapToken: "boot-123",
        expiresAtMs: 123_456,
      },
    };
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(resolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    // Keep storage substitution test-local: this shard shares a non-isolated worker
    // with the real mint/redeem test, where a leaked module mock creates unbacked codes.
    const registerDevicePairingJoinCode = vi
      .spyOn(devicePairingJoinCode, "registerDevicePairingJoinCode")
      .mockReturnValue("a".repeat(22));

    const { options, respond } = createOptions({ includeQr: false, joinUrl: true });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ bootstrapProfile: { roles: ["node"], scopes: [] } }),
    );
    expect(registerDevicePairingJoinCode).toHaveBeenCalledWith({
      payload: resolution.payload,
      expiresAtMs: resolution.expiresAtMs,
    });
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      joinUrl: `https://gateway.tailnet.example/public-gateway/j/${"a".repeat(22)}`,
    });
  });

  it("requests the limited mobile bootstrap profile when selected", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");

    const { options } = createOptions({ includeQr: false, bootstrapProfile: "limited" });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        bootstrapProfile: {
          roles: ["node", "operator"],
          scopes: [
            "operator.approvals",
            "operator.questions",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
          ],
        },
      }),
    );
  });

  it("omits an oversized QR but still returns the setup code", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    // Exceed the result schema's qrDataUrl bound (16_384) so the response stays valid.
    mocks.renderQrPngDataUrl.mockResolvedValue(`data:image/png;base64,${"a".repeat(20_000)}`);

    const { options, respond } = createOptions({});
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    const [ok, payload] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(true);
    expect(payload.qrDataUrl).toBeUndefined();
    expect(payload.setupCode).toBe("SETUP-CODE-XYZ");
  });

  it("responds with an invalid-request error when setup cannot be resolved", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue({
      ok: false,
      error: "Gateway auth is not configured (no token or password).",
    });

    const { options, respond } = createOptions({});
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    const [ok, payload, error] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.message).toContain("Gateway auth is not configured");
    expect(mocks.encodePairingSetupCode).not.toHaveBeenCalled();
  });

  it("rejects unknown params before touching pairing helpers", async () => {
    const { options, respond } = createOptions({ bogus: true });
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    const [ok] = expectDefined(respond.mock.calls[0], "respond.mock.calls[0] test invariant");
    expect(ok).toBe(false);
    expect(mocks.resolvePairingSetupFromConfig).not.toHaveBeenCalled();
  });

  it("keeps the setup code when optional QR rendering throws", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockRejectedValue(new Error("qr boom"));

    const { options, respond } = createOptions({});
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupCode"],
      'devicePairSetupHandlers["device.pair.setupCode"] test invariant',
    )(options);

    const [ok, payload, error] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(true);
    expect(payload.setupCode).toBe("SETUP-CODE-XYZ");
    expect(payload.qrDataUrl).toBeUndefined();
    expect(error).toBeUndefined();
  });
});

describe("device.pair.setupStatus", () => {
  async function runSetupStatus(params: Record<string, unknown>) {
    const { options, respond } = createOptions(params);
    await expectDefined(
      devicePairSetupHandlers["device.pair.setupStatus"],
      'devicePairSetupHandlers["device.pair.setupStatus"] test invariant',
    )(options);
    return expectDefined(respond.mock.calls[0], "respond.mock.calls[0] test invariant");
  }

  beforeEach(() => {
    mocks.readDevicePairSetupCompletion.mockReset();
  });

  it("returns the recorded completion for the exact setup id", async () => {
    mocks.readDevicePairSetupCompletion.mockResolvedValue({
      setupId: "setup-123",
      deviceId: "device-123",
      deviceName: "Pixel 9",
      access: "full",
      completedAtMs: 1_800_000_000_000,
      deliveryState: "confirmed",
      retainUntilMs: 1_800_000_600_000,
    });

    const [ok, payload, error] = await runSetupStatus({ setupId: "setup-123" });

    expect(mocks.readDevicePairSetupCompletion).toHaveBeenCalledWith({ setupId: "setup-123" });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    // Retention bookkeeping stays server-side; the client sees the event payload only.
    expect(payload).toEqual({
      completion: {
        setupId: "setup-123",
        deviceId: "device-123",
        deviceName: "Pixel 9",
        access: "full",
        ts: 1_800_000_000_000,
      },
    });
  });

  it("returns a recoverable outcome when credential delivery is uncertain", async () => {
    mocks.readDevicePairSetupCompletion.mockResolvedValue({
      setupId: "setup-uncertain",
      deviceId: "device-123",
      access: "limited",
      completedAtMs: 1_800_000_000_000,
      deliveryState: "uncertain",
      retainUntilMs: 1_800_000_600_000,
    });

    const [ok, payload, error] = await runSetupStatus({ setupId: "setup-uncertain" });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(payload).toEqual({
      deliveryUncertain: {
        setupId: "setup-uncertain",
        deviceId: "device-123",
        access: "limited",
        ts: 1_800_000_000_000,
      },
    });
  });

  it("returns an empty result when no completion is recorded", async () => {
    mocks.readDevicePairSetupCompletion.mockResolvedValue(null);

    const [ok, payload] = await runSetupStatus({ setupId: "setup-unknown" });

    expect(ok).toBe(true);
    expect(payload).toEqual({});
  });

  it("rejects unknown params before reading pairing state", async () => {
    const [ok] = await runSetupStatus({ setupId: "setup-123", bogus: true });

    expect(ok).toBe(false);
    expect(mocks.readDevicePairSetupCompletion).not.toHaveBeenCalled();
  });

  it("reports an unavailable error when the completion store throws", async () => {
    mocks.readDevicePairSetupCompletion.mockRejectedValue(new Error("state db locked"));

    const [ok, payload, error] = await runSetupStatus({ setupId: "setup-123" });

    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.message).toContain("state db locked");
  });
});
