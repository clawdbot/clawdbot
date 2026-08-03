// TTS runtime tests cover speech synthesis behavior.
import crypto from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, TtsConfig } from "openclaw/plugin-sdk/config-contracts";
import { MAX_TIMER_TIMEOUT_MS as MAX_TIMER_TIMEOUT_MS_CORE } from "openclaw/plugin-sdk/number-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  clearRuntimeConfigSnapshot as clearRuntimeConfigSnapshotCore,
  setRuntimeConfigSnapshot as setRuntimeConfigSnapshotCore,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import type {
  SpeechListVoicesRequest,
  SpeechProviderPlugin,
  SpeechProviderPrepareSynthesisContext,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import { expect, vi } from "vitest";
import { CODE_HEAVY_SPOKEN_FALLBACK as CODE_HEAVY_SPOKEN_FALLBACK_CORE } from "./speech-text.js";
import type { TtsAudioPersistence } from "./tts-synthesis.js";

type MockSpeechSynthesisResult = Awaited<ReturnType<SpeechProviderPlugin["synthesize"]>>;

const synthesizeMock = vi.hoisted(() =>
  vi.fn(
    async (request: SpeechSynthesisRequest): Promise<MockSpeechSynthesisResult> => ({
      audioBuffer: Buffer.from("voice"),
      fileExtension: ".ogg",
      outputFormat: "ogg",
      voiceCompatible: request.target === "voice-note",
    }),
  ),
);
const prepareSynthesisMock = vi.hoisted(() =>
  vi.fn(async (_ctx: SpeechProviderPrepareSynthesisContext) => undefined),
);

const listSpeechProvidersMock = vi.hoisted(() => vi.fn());
const getSpeechProviderMock = vi.hoisted(() => vi.fn());
const transcodeAudioBufferMock = vi.hoisted(() =>
  // Default off: most tests rely on the synthesized buffer reaching the
  // channel unchanged. Tests that exercise the pre-transcode branch override
  // per-call via `transcodeAudioBufferMock.mockResolvedValueOnce(...)`.
  // Typed as the helper's full return shape so per-call overrides aren't
  // narrowed to the default's literal.
  vi.fn<
    () => Promise<
      | { ok: true; buffer: Buffer }
      | {
          ok: false;
          reason:
            | "platform-unsupported"
            | "invalid-extension"
            | "noop-same-container"
            | "no-recipe"
            | "transcoder-failed";
          detail?: string;
        }
    >
  >(async () => ({ ok: false, reason: "platform-unsupported" })),
);

vi.mock("../media/media-services.js", () => ({
  transcodeAudioBuffer: transcodeAudioBufferMock,
}));

vi.mock("../channels/plugins/tts-capabilities.js", () => ({
  normalizeChannelId: (channel: string | undefined) => channel?.trim().toLowerCase() ?? null,
  resolveChannelTtsVoiceDelivery: (channel: string | undefined) => {
    const normalized = channel?.trim().toLowerCase();
    if (normalized === "voice-memo-chat") {
      return {
        synthesisTarget: "audio-file",
        audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
        preferAudioFileFormat: "caf",
      };
    }
    if (normalized === "feishu" || normalized === "whatsapp") {
      return { synthesisTarget: "voice-note", transcodesAudio: true };
    }
    if (normalized === "discord" || normalized === "matrix" || normalized === "telegram") {
      return { synthesisTarget: "voice-note" };
    }
    return undefined;
  },
}));

vi.mock("./provider-registry.js", async () => {
  const actual =
    await vi.importActual<typeof import("./provider-registry.js")>("./provider-registry.js");
  const mockProvider: SpeechProviderPlugin = {
    id: "mock",
    label: "Mock",
    autoSelectOrder: 1,
    isConfigured: () => true,
    prepareSynthesis: prepareSynthesisMock,
    synthesize: synthesizeMock,
  };
  listSpeechProvidersMock.mockImplementation(() => [mockProvider]);
  getSpeechProviderMock.mockImplementation((providerId: string) =>
    providerId === "mock" ? mockProvider : null,
  );
  return {
    ...actual,
    canonicalizeSpeechProviderId: (providerId: string | undefined) =>
      providerId?.trim().toLowerCase() || undefined,
    normalizeSpeechProviderId: (providerId: string | undefined) =>
      providerId?.trim().toLowerCase() || undefined,
    getSpeechProvider: getSpeechProviderMock,
    listSpeechProviders: listSpeechProvidersMock,
  };
});

vi.mock("./tts-core.js", async () => {
  const actual = await vi.importActual<typeof import("./tts-core.js")>("./tts-core.js");
  return { ...actual, scheduleCleanup: vi.fn() };
});

export const {
  testApi,
  buildTtsSystemPromptHint,
  getTtsPersona,
  getTtsProvider,
  isTtsProviderConfigured,
  listSpeechVoices,
  prepareTtsRequest,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setTtsMachinePrefsPathResolver,
  setSummarizationEnabled,
  setTtsMaxLength,
  synthesizeSpeech,
  textToSpeechStream,
  textToSpeechTelephony,
} = await import("./runtime-api.js");
export const { maybeApplyTtsToPayload: maybeApplyTtsToPayloadCore } =
  await import("./tts-payload.js");
export const { textToSpeech: textToSpeechCore } = await import("./tts-synthesis.js");

export const CODE_HEAVY_SPOKEN_FALLBACK = CODE_HEAVY_SPOKEN_FALLBACK_CORE;
export const MAX_TIMER_TIMEOUT_MS = MAX_TIMER_TIMEOUT_MS_CORE;
export function clearRuntimeConfigSnapshot(): void {
  clearRuntimeConfigSnapshotCore();
}
export const setRuntimeConfigSnapshot = (
  ...args: Parameters<typeof setRuntimeConfigSnapshotCore>
) => setRuntimeConfigSnapshotCore(...args);

export const nativeVoiceNoteChannels = [
  "discord",
  "feishu",
  "matrix",
  "telegram",
  "whatsapp",
] as const;

export function createMockSpeechProvider(
  id = "mock",
  options: Partial<SpeechProviderPlugin> = {},
): SpeechProviderPlugin {
  return {
    id,
    label: id,
    autoSelectOrder: id === "mock" ? 1 : 2,
    isConfigured: () => true,
    prepareSynthesis: prepareSynthesisMock,
    synthesize: synthesizeMock,
    ...options,
  };
}

export function installSpeechProviders(providers: SpeechProviderPlugin[]): void {
  listSpeechProvidersMock.mockImplementation(() => providers);
  getSpeechProviderMock.mockImplementation(
    (providerId: string) => providers.find((provider) => provider.id === providerId) ?? null,
  );
}

// macOS os.tmpdir() is a /var -> /private/var symlink and fs-safe rejects
// symlinked store roots; resolve the canonical dir before writing prefs.
const PREFS_TMP_DIR = realpathSync(os.tmpdir());

async function persistTestTtsAudio({
  audioBuffer,
  fileExtension,
}: Parameters<TtsAudioPersistence>[0]): Promise<string> {
  const dir = path.join(PREFS_TMP_DIR, `openclaw-speech-core-media-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const audioPath = path.join(dir, `voice---${crypto.randomUUID()}${fileExtension}`);
  writeFileSync(audioPath, audioBuffer);
  return audioPath;
}

export function textToSpeech(params: Parameters<typeof textToSpeechCore>[0]) {
  return textToSpeechCore(params, persistTestTtsAudio);
}

export function maybeApplyTtsToPayload(params: Parameters<typeof maybeApplyTtsToPayloadCore>[0]) {
  return maybeApplyTtsToPayloadCore(params, persistTestTtsAudio);
}

export function prefsPathFor(prefsName: string): string {
  return path.join(PREFS_TMP_DIR, `${prefsName}.json`);
}

export function createTtsConfig(prefsName: string): OpenClawConfig {
  setTtsMachinePrefsPathResolver(() => prefsPathFor(prefsName));
  return {
    tts: {
      enabled: true,
      provider: "mock",
    },
  };
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

export function requireFirstCallParam(calls: ReadonlyArray<readonly unknown[]>, label: string) {
  const call = calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

export function requireFirstSynthesisRequest(label: string): Record<string, unknown> {
  return requireRecord(requireFirstCallParam(synthesizeMock.mock.calls, label), label);
}

export function requireAttempt(attempts: unknown[] | undefined, index: number) {
  if (!attempts) {
    throw new Error("expected synthesis attempts");
  }
  return requireRecord(attempts[index], `synthesis attempt ${index}`);
}

export async function expectTtsPayloadResult(params: {
  channel: string;
  prefsName: string;
  text: string;
  target: "voice-note" | "audio-file";
  audioAsVoice: true | undefined;
  providerResult?: MockSpeechSynthesisResult;
  mediaExtension?: string;
  kind?: "tool" | "block" | "final";
}) {
  if (params.providerResult) {
    synthesizeMock.mockResolvedValueOnce(params.providerResult);
  }
  const cfg = createTtsConfig(params.prefsName);
  let mediaDir: string | undefined;
  try {
    const result = await maybeApplyTtsToPayload({
      payload: { text: params.text },
      cfg,
      channel: params.channel,
      kind: params.kind ?? "final",
    });

    expect(synthesizeMock).toHaveBeenCalled();
    const request = requireRecord(
      synthesizeMock.mock.calls.at(-1)?.[0],
      "latest synthesis request",
    );
    expect(request.target).toBe(params.target);
    expect(result.audioAsVoice).toBe(params.audioAsVoice);
    expect(result.mediaUrl).toMatch(
      new RegExp(`voice---[a-f0-9-]+\\.${params.mediaExtension ?? "ogg"}$`),
    );
    expect(result.spokenText).toBe(params.text);
    expect(result.ttsSupplement).toEqual({ spokenText: params.text });
    expect((result as { trustedLocalMedia?: boolean }).trustedLocalMedia).toBe(true);

    mediaDir = result.mediaUrl ? path.dirname(result.mediaUrl) : undefined;
  } finally {
    if (mediaDir) {
      rmSync(mediaDir, { recursive: true, force: true });
    }
  }
}

export { prepareSynthesisMock, synthesizeMock, transcodeAudioBufferMock };
export type {
  OpenClawConfig,
  ReplyPayload,
  SpeechListVoicesRequest,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
  TtsConfig,
};
