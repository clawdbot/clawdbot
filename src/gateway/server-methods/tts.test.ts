/**
 * Tests for text-to-speech gateway methods and provider error envelopes.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { expectGatewayErrorResponse } from "./gateway-response.test-helpers.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
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
  listSpeechProviders: vi.fn(() => []),
}));

vi.mock("../../tts/tts.js", () => ({
  getResolvedSpeechProviderConfig: vi.fn(),
  getTtsPersona: vi.fn(() => undefined),
  getTtsProvider: vi.fn(() => "openai"),
  isTtsEnabled: vi.fn(() => true),
  isTtsProviderConfigured: vi.fn(() => true),
  listTtsPersonas: vi.fn(() => []),
  resolveExplicitTtsOverrides:
    mocks.resolveExplicitTtsOverrides as typeof import("../../tts/tts.js").resolveExplicitTtsOverrides,
  resolveTtsAutoMode: vi.fn(() => false),
  resolveTtsConfig: mocks.resolveTtsConfig,
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts.json"),
  resolveTtsProviderOrder: vi.fn(() => ["openai"]),
  setTtsEnabled: vi.fn(),
  setTtsPersona: vi.fn(),
  setTtsProvider: vi.fn(),
  synthesizeSpeech: mocks.synthesizeSpeech,
  textToSpeech: mocks.textToSpeech as typeof import("../../tts/tts.js").textToSpeech,
}));

describe("ttsHandlers", () => {
  beforeEach(() => {
    mocks.getRuntimeConfig.mockReset();
    mocks.getRuntimeConfig.mockReturnValue({});
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
});
