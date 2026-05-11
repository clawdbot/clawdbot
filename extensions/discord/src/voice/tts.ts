import {
  getTtsProvider,
  resolveAgentDir,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  type ResolvedTtsConfig,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig, TtsConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseTtsDirectives } from "openclaw/plugin-sdk/speech";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getDiscordRuntime } from "../runtime.js";
import { sanitizeVoiceReplyTextForSpeech } from "./sanitize.js";

type VoiceReplyAudioResult =
  | {
      status: "ok";
      mode: "file";
      audioPath: string;
      speakText: string;
    }
  | {
      status: "ok";
      mode: "stream";
      audioStream: ReadableStream<Uint8Array>;
      release?: () => Promise<void>;
      speakText: string;
    }
  | {
      status: "empty";
    }
  | {
      status: "failed";
      error?: string;
    };

function mergeTtsConfig(base: TtsConfig, override?: TtsConfig): TtsConfig {
  if (!override) {
    return base;
  }
  const baseProviders = base.providers ?? {};
  const overrideProviders = override.providers ?? {};
  const mergedProviders = Object.fromEntries(
    [...new Set([...Object.keys(baseProviders), ...Object.keys(overrideProviders)])].map(
      (providerId) => {
        const baseProvider = baseProviders[providerId] ?? {};
        const overrideProvider = overrideProviders[providerId] ?? {};
        return [
          providerId,
          {
            ...baseProvider,
            ...overrideProvider,
          },
        ];
      },
    ),
  );
  return {
    ...base,
    ...override,
    modelOverrides: {
      ...base.modelOverrides,
      ...override.modelOverrides,
    },
    ...(Object.keys(mergedProviders).length === 0 ? {} : { providers: mergedProviders }),
  };
}

function resolveVoiceTtsConfig(params: { cfg: OpenClawConfig; override?: TtsConfig }): {
  cfg: OpenClawConfig;
  resolved: ResolvedTtsConfig;
} {
  if (!params.override) {
    return { cfg: params.cfg, resolved: resolveTtsConfig(params.cfg) };
  }
  const base = params.cfg.messages?.tts ?? {};
  const merged = mergeTtsConfig(base, params.override);
  const messages = params.cfg.messages ?? {};
  const cfg = {
    ...params.cfg,
    messages: {
      ...messages,
      tts: merged,
    },
  };
  return { cfg, resolved: resolveTtsConfig(cfg) };
}

export async function transcribeVoiceAudio(params: {
  cfg: OpenClawConfig;
  agentId: string;
  filePath: string;
}): Promise<string | undefined> {
  const result = await getDiscordRuntime().mediaUnderstanding.transcribeAudioFile({
    filePath: params.filePath,
    cfg: params.cfg,
    agentDir: resolveAgentDir(params.cfg, params.agentId),
    mime: "audio/wav",
  });
  return normalizeOptionalString(result.text);
}

export async function synthesizeVoiceReplyAudio(params: {
  cfg: OpenClawConfig;
  override?: TtsConfig;
  replyText: string;
  speakerLabel: string;
}): Promise<VoiceReplyAudioResult> {
  const { cfg: ttsCfg, resolved: ttsConfig } = resolveVoiceTtsConfig({
    cfg: params.cfg,
    override: params.override,
  });
  const directive = parseTtsDirectives(params.replyText, ttsConfig.modelOverrides, {
    cfg: ttsCfg,
    providerConfigs: ttsConfig.providerConfigs,
    preferredProviderId: getTtsProvider(ttsConfig, resolveTtsPrefsPath(ttsConfig)),
  });
  const rawSpeakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
  const speakText = sanitizeVoiceReplyTextForSpeech(rawSpeakText, params.speakerLabel);
  if (!speakText) {
    return { status: "empty" };
  }

  const runtime = getDiscordRuntime();
  const streamResult = await runtime.tts.textToSpeechStream?.({
    text: speakText,
    cfg: ttsCfg,
    channel: "discord",
    overrides: directive.overrides,
    disableFallback: true,
  });
  if (streamResult?.success && streamResult.audioStream) {
    return {
      status: "ok",
      mode: "stream",
      audioStream: streamResult.audioStream,
      release: streamResult.release,
      speakText,
    };
  }

  const result = await runtime.tts.textToSpeech({
    text: speakText,
    cfg: ttsCfg,
    channel: "discord",
    overrides: directive.overrides,
  });
  if (!result.success || !result.audioPath) {
    return { status: "failed", error: result.error ?? "unknown error" };
  }
  return { status: "ok", mode: "file", audioPath: result.audioPath, speakText };
}
