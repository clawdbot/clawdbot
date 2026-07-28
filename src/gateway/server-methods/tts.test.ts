/**
 * Tests for text-to-speech gateway methods and provider error envelopes.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { expectGatewayErrorResponse } from "./gateway-response.test-helpers.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  isTtsProviderConfigured: vi.fn((_config: unknown, _provider: string) => true),
  listSpeechProviders: vi.fn(
    (): Array<{
      id: string;
      label: string;
      isConfigured: () => boolean;
      models?: readonly string[];
      voices?: readonly string[];
    }> => [],
  ),
  resolveTtsProviderOrder: vi.fn(() => ["openai"]),
  resolveExplicitTtsOverrides: vi.fn(() => ({})),
  resolveTtsConfig: vi.fn(() => ({ maxTextLength: 4096 })),
  synthesizeSpeech: vi.fn(
    async (): Promise<{
      success: boolean;
      audioBuffer?: Buffer;
      provider?: string;
      outputFormat?: string;
      fileExtension?: string;
      error?: string;
    }> => ({
      success: true,
      audioBuffer: Buffer.from([1, 2, 3]),
      provider: "openai",
      outputFormat: "mp3",
      fileExtension: ".mp3",
    }),
  ),
  textToSpeech: vi.fn(async () => ({
    success: true,
    audioPath: "/tmp/tts.mp3",
    provider: "openai",
    outputFormat: "mp3",
    voiceCompatible: false,
  })),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig:
    mocks.getRuntimeConfig as typeof import("../../config/config.js").getRuntimeConfig,
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: vi.fn(),
  getSpeechProvider: vi.fn(),
  listSpeechProviders: mocks.listSpeechProviders,
}));

vi.mock("../../tts/tts.js", () => ({
  getResolvedSpeechProviderConfig: vi.fn(),
  getTtsPersona: vi.fn(() => undefined),
  getTtsProvider: vi.fn(() => "openai"),
  isTtsEnabled: vi.fn(() => true),
  isTtsProviderConfigured: mocks.isTtsProviderConfigured,
  listTtsPersonas: vi.fn(() => []),
  resolveExplicitTtsOverrides:
    mocks.resolveExplicitTtsOverrides as typeof import("../../tts/tts.js").resolveExplicitTtsOverrides,
  resolveTtsAutoMode: vi.fn(() => false),
  resolveTtsConfig: mocks.resolveTtsConfig,
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts.json"),
  resolveTtsProviderOrder: mocks.resolveTtsProviderOrder,
  setTtsEnabled: vi.fn(),
  setTtsPersona: vi.fn(),
  setTtsProvider: vi.fn(),
  synthesizeSpeech: mocks.synthesizeSpeech,
  textToSpeech: mocks.textToSpeech as typeof import("../../tts/tts.js").textToSpeech,
}));

describe("ttsHandlers", () => {
  beforeEach(() => {
    setActiveDegradedSecretOwners([]);
    mocks.getRuntimeConfig.mockReset();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.isTtsProviderConfigured.mockReset();
    mocks.isTtsProviderConfigured.mockReturnValue(true);
    mocks.listSpeechProviders.mockReset();
    mocks.listSpeechProviders.mockReturnValue([]);
    mocks.resolveTtsProviderOrder.mockReset();
    mocks.resolveTtsProviderOrder.mockReturnValue(["openai"]);
    mocks.resolveExplicitTtsOverrides.mockReset();
    mocks.resolveExplicitTtsOverrides.mockReturnValue({});
    mocks.resolveTtsConfig.mockReset();
    mocks.resolveTtsConfig.mockReturnValue({ maxTextLength: 4096 });
    mocks.synthesizeSpeech.mockReset();
    mocks.synthesizeSpeech.mockResolvedValue({
      success: true,
      audioBuffer: Buffer.from([1, 2, 3]),
      provider: "openai",
      outputFormat: "mp3",
      fileExtension: ".mp3",
    });
    mocks.textToSpeech.mockReset();
    mocks.textToSpeech.mockResolvedValue({
      success: true,
      audioPath: "/tmp/tts.mp3",
      provider: "openai",
      outputFormat: "mp3",
      voiceCompatible: false,
    });
  });

  it.each(["tts.status", "tts.providers"] as const)(
    "%s keeps invalid providers in the catalog as unconfigured",
    async (method) => {
      const invalidProvider = {
        id: "gradium",
        label: "Gradium",
        isConfigured: vi.fn(() => {
          throw new Error("Invalid Gradium baseUrl");
        }),
      };
      mocks.listSpeechProviders.mockReturnValue([invalidProvider]);
      mocks.resolveTtsProviderOrder.mockReturnValue(["openai", "gradium"]);
      mocks.isTtsProviderConfigured.mockImplementation(
        (_config, provider) => provider !== "gradium",
      );
      const { ttsHandlers } = await import("./tts.js");
      const respond = vi.fn();

      await expectDefined(
        ttsHandlers[method],
        `ttsHandlers[${method}] test invariant`,
      )({
        params: {},
        respond,
        context: { getRuntimeConfig: mocks.getRuntimeConfig },
      } as never);

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          [method === "tts.status" ? "providerStates" : "providers"]: [
            expect.objectContaining({ id: "gradium", configured: false }),
          ],
        }),
      );
      expect(invalidProvider.isConfigured).not.toHaveBeenCalled();
    },
  );

  it("returns INVALID_REQUEST when TTS override validation fails", async () => {
    mocks.resolveExplicitTtsOverrides.mockImplementation(() => {
      throw new Error('Unknown TTS provider "bad".');
    });

    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();

    await expectDefined(
      ttsHandlers["tts.convert"],
      'ttsHandlers["tts.convert"] test invariant',
    )({
      params: {
        text: "hello",
        provider: "bad",
      },
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Error: Unknown TTS provider "bad".',
    });
    expect(mocks.textToSpeech).not.toHaveBeenCalled();
  });

  it("tts.speak returns the synthesized clip inline with provider metadata", async () => {
    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();

    await expectDefined(
      ttsHandlers["tts.speak"],
      'ttsHandlers["tts.speak"] test invariant',
    )({
      params: { text: "Hello there." },
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith({ text: "Hello there.", cfg: {} });
    expect(respond).toHaveBeenCalledWith(true, {
      audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
      provider: "openai",
      outputFormat: "mp3",
      mimeType: "audio/mpeg",
      fileExtension: ".mp3",
    });
  });

  it("tts.speak rejects blank text without synthesizing", async () => {
    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();

    await expectDefined(
      ttsHandlers["tts.speak"],
      'ttsHandlers["tts.speak"] test invariant',
    )({
      params: { text: "   " },
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "tts.speak requires text",
    });
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("tts.speak rejects text above the configured max length", async () => {
    mocks.resolveTtsConfig.mockReturnValue({ maxTextLength: 10 });

    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();

    await expectDefined(
      ttsHandlers["tts.speak"],
      'ttsHandlers["tts.speak"] test invariant',
    )({
      params: { text: "This text is definitely too long." },
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "tts.speak text too long (33 chars, max 10)",
    });
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("tts.speak maps synthesis failures to UNAVAILABLE", async () => {
    mocks.synthesizeSpeech.mockResolvedValue({
      success: false,
      error: "No TTS provider is configured.",
    });

    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();

    await expectDefined(
      ttsHandlers["tts.speak"],
      'ttsHandlers["tts.speak"] test invariant',
    )({
      params: { text: "Hello there." },
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.UNAVAILABLE,
      message: "No TTS provider is configured.",
    });
  });

  it("tts.speak returns typed unavailable without calling a degraded TTS provider", async () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "tts",
        state: "unavailable",
        paths: ["tts.providers.elevenlabs.apiKey"],
        refKeys: ["env:default:ELEVENLABS_API_KEY"],
        reason: "secret reference was not found",
      },
    ]);

    const { ttsHandlers } = await import("./tts.js");
    const respond = vi.fn();

    await expectDefined(
      ttsHandlers["tts.speak"],
      'ttsHandlers["tts.speak"] test invariant',
    )({
      params: { text: "Hello there." },
      respond,
      context: { getRuntimeConfig: mocks.getRuntimeConfig },
    } as never);

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.UNAVAILABLE,
      message:
        "SecretSurfaceUnavailableError: Secret owner capability:tts is configured but unavailable (secret reference was not found).: code=SECRET_SURFACE_UNAVAILABLE",
    });
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      details: {
        reason: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "capability",
        ownerId: "tts",
      },
    });
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });
});
