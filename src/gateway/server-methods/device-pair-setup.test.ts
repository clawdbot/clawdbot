/**
 * Tests the device.pair.setupCode gateway method: it produces a connect setup
 * code + QR for non-terminal clients and never leaks the gateway credential.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolvePairingSetupFromConfig: vi.fn(),
  encodePairingSetupCode: vi.fn(),
  renderQrPngDataUrl: vi.fn(),
  runCommandWithTimeout: vi.fn(),
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
};

describe("device.pair.setupCode", () => {
  beforeEach(() => {
    mocks.resolvePairingSetupFromConfig.mockReset();
    mocks.encodePairingSetupCode.mockReset();
    mocks.renderQrPngDataUrl.mockReset();
    mocks.runCommandWithTimeout.mockReset();
  });

  it("returns the setup code, QR data URL, and only an auth label", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockResolvedValue("data:image/png;base64,qr");

    const { options, respond } = createOptions({});
    await devicePairSetupHandlers["device.pair.setupCode"](options);

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(payload).toEqual({
      setupCode: "SETUP-CODE-XYZ",
      qrDataUrl: "data:image/png;base64,qr",
      gatewayUrl: "wss://gw.example:8443",
      gatewayUrls: ["wss://gw.example:8443", "ws://192.168.1.20:18789"],
      auth: "token",
      urlSource: "remote",
    });
    // The bootstrap token only lives inside the (opaque) setup code, never as a field.
    expect(JSON.stringify(payload)).not.toContain("boot-123");
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
    await devicePairSetupHandlers["device.pair.setupCode"](options);

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
    await devicePairSetupHandlers["device.pair.setupCode"](options);

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
    await devicePairSetupHandlers["device.pair.setupCode"](options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ publicUrl: undefined, preferRemoteUrl: true }),
    );
  });

  it("omits the QR when includeQr is false", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");

    const { options, respond } = createOptions({ includeQr: false });
    await devicePairSetupHandlers["device.pair.setupCode"](options);

    expect(mocks.renderQrPngDataUrl).not.toHaveBeenCalled();
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.qrDataUrl).toBeUndefined();
    expect(payload.setupCode).toBe("SETUP-CODE-XYZ");
  });

  it("requests a node-only bootstrap profile for companion setup", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");

    const { options } = createOptions({ includeQr: false, bootstrapProfile: "node" });
    await devicePairSetupHandlers["device.pair.setupCode"](options);

    expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        bootstrapProfile: { roles: ["node"], scopes: [] },
      }),
    );
  });

  it("omits an oversized QR but still returns the setup code", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    // Exceed the result schema's qrDataUrl bound (16_384) so the response stays valid.
    mocks.renderQrPngDataUrl.mockResolvedValue(`data:image/png;base64,${"a".repeat(20_000)}`);

    const { options, respond } = createOptions({});
    await devicePairSetupHandlers["device.pair.setupCode"](options);

    const [ok, payload] = respond.mock.calls[0];
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
    await devicePairSetupHandlers["device.pair.setupCode"](options);

    const [ok, payload, error] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.message).toContain("Gateway auth is not configured");
    expect(mocks.encodePairingSetupCode).not.toHaveBeenCalled();
  });

  it("rejects unknown params before touching pairing helpers", async () => {
    const { options, respond } = createOptions({ bogus: true });
    await devicePairSetupHandlers["device.pair.setupCode"](options);

    const [ok] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(mocks.resolvePairingSetupFromConfig).not.toHaveBeenCalled();
  });

  it("keeps the setup code when optional QR rendering throws", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockRejectedValue(new Error("qr boom"));

    const { options, respond } = createOptions({});
    await devicePairSetupHandlers["device.pair.setupCode"](options);

    const [ok, payload, error] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.setupCode).toBe("SETUP-CODE-XYZ");
    expect(payload.qrDataUrl).toBeUndefined();
    expect(error).toBeUndefined();
  });
});
