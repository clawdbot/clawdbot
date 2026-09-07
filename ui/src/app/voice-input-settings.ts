import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const COMPOSER_VOICE_INPUT_MODES = ["gesture", "dictation"] as const;

export type ComposerVoiceInputMode = (typeof COMPOSER_VOICE_INPUT_MODES)[number];

export type ComposerAudioPreferences = {
  composerVoiceInputMode?: ComposerVoiceInputMode;
  realtimeTalkInputDeviceId?: string;
  realtimeTalkVideoDeviceId?: string;
};

export const DEFAULT_COMPOSER_VOICE_INPUT_MODE = "gesture" as const;

export const normalizeComposerVoiceInputMode = (value: unknown): ComposerVoiceInputMode =>
  COMPOSER_VOICE_INPUT_MODES.includes(value as ComposerVoiceInputMode)
    ? (value as ComposerVoiceInputMode)
    : DEFAULT_COMPOSER_VOICE_INPUT_MODE;

type ComposerAudioPreferenceSource = {
  composerVoiceInputMode?: unknown;
  realtimeTalkInputDeviceId?: unknown;
  realtimeTalkVideoDeviceId?: unknown;
};

export function normalizeComposerAudioPreferences(
  value: ComposerAudioPreferenceSource,
): ComposerAudioPreferences {
  return {
    composerVoiceInputMode: normalizeComposerVoiceInputMode(value.composerVoiceInputMode),
    realtimeTalkInputDeviceId: normalizeOptionalString(value.realtimeTalkInputDeviceId),
    realtimeTalkVideoDeviceId: normalizeOptionalString(value.realtimeTalkVideoDeviceId),
  };
}

export function serializeComposerVoiceInputMode(value: unknown): {
  composerVoiceInputMode?: "dictation";
} {
  return normalizeComposerVoiceInputMode(value) === "dictation"
    ? { composerVoiceInputMode: "dictation" }
    : {};
}

export function serializeComposerAudioPreferences(value: ComposerAudioPreferences): ReturnType<
  typeof serializeComposerVoiceInputMode
> & {
  realtimeTalkInputDeviceId?: string;
  realtimeTalkVideoDeviceId?: string;
} {
  const inputDeviceId = normalizeOptionalString(value.realtimeTalkInputDeviceId);
  const videoDeviceId = normalizeOptionalString(value.realtimeTalkVideoDeviceId);
  return {
    ...serializeComposerVoiceInputMode(value.composerVoiceInputMode),
    ...(inputDeviceId ? { realtimeTalkInputDeviceId: inputDeviceId } : {}),
    ...(videoDeviceId ? { realtimeTalkVideoDeviceId: videoDeviceId } : {}),
  };
}
