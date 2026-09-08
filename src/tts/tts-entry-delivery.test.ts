import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTtsTool } from "../agents/tools/tts-tool.js";
import { handleTtsCommands } from "../auto-reply/reply/commands-tts.js";
import type { HandleCommandsParams } from "../auto-reply/reply/commands-types.js";
import { parseInlineSessionDirectives } from "../auto-reply/reply/directive-handling.parse.js";
import { resolveChannelTtsVoiceDelivery } from "../channels/plugins/tts-capabilities.js";
import type { ChannelTtsVoiceDeliveryCapabilities } from "../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../config/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { listSpeechProviders } from "./provider-registry.js";
import { maybeApplyTtsToPayload, textToSpeech } from "./tts.js";

// Constructed Ogg/Opus metadata fixture; no provider or decoder has been run.
// One synthetic silence packet; use external decoder proof before claiming playable audio.
const SYNTHETIC_OGG_OPUS = Buffer.from(
  "T2dnUwACAAAAAAAAAAAxU1RUAAAAAHiu4UMBE09wdXNIZWFkAQEAAIC7AAAAAABPZ2dTAAAAAAAAAAAAADFTVFQBAAAAB6hLcAE3T3B1c1RhZ3MnAAAAT3BlbkNsYXcgc3ludGhldGljIFRUUyBtZXRhZGF0YSBmaXh0dXJlAAAAAE9nZ1MABMADAAAAAAAAMVNUVAIAAADuHqTAAQP4//4=",
  "base64",
);
const SYNTHETIC_OGG_OPUS_SHA256 =
  "08bf258f524277fa0b07e6334ebffb1eb600871d8d86ae3db139c2b968ddfb27";

const converter = vi.hoisted(() => ({ requests: [] as Array<{ source: string; target: string }> }));

vi.mock("../media/media-services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/media-services.js")>();
  return {
    ...actual,
    transcodeAudioBuffer: async (params: Parameters<typeof actual.transcodeAudioBuffer>[0]) => {
      converter.requests.push({ source: params.sourceExtension, target: params.targetExtension });
      if (params.sourceExtension !== "ogg" || params.targetExtension !== "caf") {
        throw new Error("Unexpected conversion in the TTS metadata fixture");
      }
      // On macOS this is an explicit converter-failure fixture, not host capability proof.
      // Other platforms execute the real early platform-unsupported path without a subprocess.
      return process.platform === "darwin"
        ? {
            ok: false as const,
            reason: "transcoder-failed" as const,
            detail: "synthetic unavailable converter",
          }
        : actual.transcodeAudioBuffer(params);
    },
  };
});

const PROVIDER = "synthetic-tts-metadata";
const CHANNEL = "imessage";
const SPOKEN = "This synthetic audio should keep its channel delivery decision.";
const requests: Array<{ target: string; text: string }> = [];
let state: OpenClawTestState;
let cfg: OpenClawConfig;

function installFixture(voice: ChannelTtsVoiceDeliveryCapabilities, compatible = true): void {
  const provider: SpeechProviderPlugin = {
    id: PROVIDER,
    label: "Synthetic TTS metadata fixture",
    isConfigured: () => true,
    synthesize: async (request) => {
      requests.push({ target: request.target, text: request.text });
      return {
        audioBuffer: await fs.readFile(state.path("provider.ogg")),
        fileExtension: ".ogg",
        outputFormat: "ogg-24khz-16bit-mono-opus",
        voiceCompatible: compatible,
      };
    },
  };
  const registry = createTestRegistry([
    {
      pluginId: CHANNEL,
      source: "synthetic-tts-metadata-fixture",
      plugin: createChannelTestPluginBase({
        id: CHANNEL,
        capabilities: { chatTypes: ["direct"], media: true, tts: { voice } },
      }),
    },
  ]);
  registry.speechProviders.push({ pluginId: PROVIDER, source: "synthetic", provider });
  setActivePluginRegistry(registry);
  expect(listSpeechProviders(cfg).map((entry) => entry.id)).toEqual([PROVIDER]);
  expect(resolveChannelTtsVoiceDelivery(CHANNEL)).toEqual(voice);
}

function commandParams(): HandleCommandsParams {
  const body = `/tts audio ${SPOKEN}`;
  return {
    cfg,
    ctx: {},
    agentId: "main",
    command: {
      surface: CHANNEL,
      channel: CHANNEL,
      senderId: "synthetic-owner",
      ownerList: ["synthetic-owner"],
      senderIsOwner: true,
      isAuthorizedSender: true,
      rawBodyNormalized: body,
      commandBodyNormalized: body,
    },
    directives: parseInlineSessionDirectives(""),
    elevated: { enabled: false, allowed: false, failures: [] },
    sessionKey: "agent:main:tts-metadata-proof",
    workspaceDir: state.workspaceDir,
    defaultGroupActivation: () => "always",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: PROVIDER,
    model: "synthetic",
    contextTokens: 4096,
    isGroup: false,
  };
}

async function assertStoredAudio(filePath: unknown): Promise<string> {
  if (typeof filePath !== "string") {
    throw new Error("Expected an actual persisted audio path");
  }
  expect(path.dirname(filePath)).toBe(state.statePath("media", "tool-speech-synthesis"));
  const buffer = await fs.readFile(filePath);
  expect(crypto.createHash("sha256").update(buffer).digest("hex")).toBe(SYNTHETIC_OGG_OPUS_SHA256);
  expect(await detectMime({ buffer, filePath })).toBe("audio/ogg");
  // The canonical media store preserves the supplied audio/ogg header extension.
  expect(path.extname(filePath)).toBe(".ogg");
  return filePath;
}

async function observeEntries(expectedVoice: boolean): Promise<void> {
  const core = await textToSpeech({ text: SPOKEN, cfg, channel: CHANNEL, disableFallback: true });
  expect(core).toMatchObject({ success: true, audioAsVoice: expectedVoice, provider: PROVIDER });
  expect(core.voiceCompatible).toBe(!expectedVoice);
  await assertStoredAudio(core.audioPath);

  const tool = createTtsTool({ config: cfg, agentChannel: CHANNEL });
  const result = await tool.execute("synthetic-tts", { text: SPOKEN });
  const media = asRecord(asRecord(result.details)?.media);
  await assertStoredAudio(media?.mediaUrl);

  const command = await handleTtsCommands(commandParams(), true);
  expect(command?.shouldContinue).toBe(false);
  await assertStoredAudio(command?.reply?.mediaUrl);

  const automatic = await maybeApplyTtsToPayload({
    payload: { text: SPOKEN },
    cfg,
    channel: CHANNEL,
    kind: "final",
  });
  await assertStoredAudio(automatic.mediaUrl);

  process.stdout.write(
    `${JSON.stringify({
      proof: "tts-entry-delivery",
      platform: process.platform,
      converter:
        converter.requests.length === 0
          ? "not-requested"
          : process.platform === "darwin"
            ? "controlled-failure"
            : "real-platform-unsupported",
      provider: PROVIDER,
      providerCompatible: core.voiceCompatible,
      coreVoice: core.audioAsVoice,
      toolVoice: media?.audioAsVoice === true,
      commandVoice: command?.reply?.audioAsVoice === true,
      automaticVoice: automatic.audioAsVoice === true,
      byteHash: SYNTHETIC_OGG_OPUS_SHA256,
      requests,
      converterRequests: converter.requests,
    })}\n`,
  );

  expect(requests).toHaveLength(4);
  expect.soft(media?.audioAsVoice === true, "tool preserves core decision").toBe(expectedVoice);
  expect
    .soft(command?.reply?.audioAsVoice === true, "/tts audio preserves core decision")
    .toBe(expectedVoice);
  expect
    .soft(automatic.audioAsVoice === true, "automatic sibling preserves core decision")
    .toBe(expectedVoice);
}

describe("TTS real synthesis owner to public output entries", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "home",
      prefix: "openclaw-tts-entry-proof-",
    });
    vi.stubEnv("OPENCLAW_TTS_PREFS", state.path("tts-prefs.json"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Network is forbidden in the TTS metadata fixture");
      }),
    );
    cfg = { tts: { auto: "always", provider: PROVIDER } };
    await fs.writeFile(state.path("provider.ogg"), SYNTHETIC_OGG_OPUS);
    requests.length = 0;
    converter.requests.length = 0;
  });

  afterEach(async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it("keeps incompatible audio-file output nonvoice despite provider compatibility", async () => {
    installFixture({
      synthesisTarget: "audio-file",
      audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
      preferAudioFileFormat: "caf",
    });
    await observeEntries(false);
    expect(requests.every((entry) => entry.target === "audio-file")).toBe(true);
    expect(converter.requests).toHaveLength(4);
  });

  it("retains the opposite-polarity decision for a channel that transcodes voice output", async () => {
    installFixture({ synthesisTarget: "voice-note", transcodesAudio: true }, false);
    await observeEntries(true);
    expect(requests.every((entry) => entry.target === "voice-note")).toBe(true);
    expect(converter.requests).toHaveLength(0);
  });

  it("preserves a separate explicit automatic-payload voice request", async () => {
    installFixture({
      synthesisTarget: "audio-file",
      audioFileFormats: ["mp3", "caf"],
      preferAudioFileFormat: "caf",
    });
    const core = await textToSpeech({ text: SPOKEN, cfg, channel: CHANNEL, disableFallback: true });
    expect(core).toMatchObject({ success: true, audioAsVoice: false, voiceCompatible: true });
    const automatic = await maybeApplyTtsToPayload({
      payload: { text: SPOKEN, audioAsVoice: true },
      cfg,
      channel: CHANNEL,
      kind: "final",
    });
    await assertStoredAudio(automatic.mediaUrl);
    expect(automatic.audioAsVoice).toBe(true);
  });
});
