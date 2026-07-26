/** Config paths with user-facing metadata for audio understanding settings. */
const MEDIA_AUDIO_FIELD_KEYS = [
  "tools.media.audio.enabled",
  "tools.media.audio.preferredModel",
  "tools.media.audio.maxBytes",
  "tools.media.audio.maxChars",
  "tools.media.audio.prompt",
  "tools.media.audio.timeoutSeconds",
  "tools.media.audio.language",
  "tools.media.audio.scope",
  "tools.media.audio.attachments",
  "tools.media.audio.echoTranscript",
  "tools.media.audio.echoFormat",
] as const;

type MediaAudioFieldKey = (typeof MEDIA_AUDIO_FIELD_KEYS)[number];

export const MEDIA_AUDIO_FIELD_HELP: Record<MediaAudioFieldKey, string> = {
  "tools.media.audio.enabled":
    "Enable audio understanding so voice notes or audio clips can be transcribed for agent context.",
  "tools.media.audio.preferredModel":
    "Prefer one capability-tagged tools.media.models entry for audio transcription before the remaining compatible fallbacks.",
  "tools.media.audio.maxBytes":
    "Default audio input size limit for configured and auto-detected models. Set this to the largest recording your providers and network should accept.",
  "tools.media.audio.maxChars":
    "Default maximum transcript length for configured and auto-detected models. Use a lower value to keep long voice notes from expanding agent context.",
  "tools.media.audio.prompt":
    "Default audio transcription prompt when a model entry does not override it. Keep the instruction stable when downstream workflows rely on transcript style.",
  "tools.media.audio.timeoutSeconds":
    "Default timeout for audio understanding requests. Increase it for long recordings or slower local transcription models.",
  "tools.media.audio.language":
    "Default language hint for audio transcription providers. Set it when the primary spoken language is known and provider detection is unreliable.",
  "tools.media.audio.scope":
    "Restrict audio understanding by channel, chat type, or source key. Keep this narrow where automatic transcription is sensitive or expensive.",
  "tools.media.audio.attachments":
    "Choose which matching audio attachments are processed. Use first-only handling unless multi-attachment transcription is intentional.",
  "tools.media.audio.echoTranscript":
    "Echo the audio transcript to the originating chat before agent processing. Enable this when users need to verify what the system heard.",
  "tools.media.audio.echoFormat":
    "Format the echoed transcript with a {transcript} placeholder. Keep the placeholder intact so delivery includes the transcript.",
};

export const MEDIA_AUDIO_FIELD_LABELS: Record<MediaAudioFieldKey, string> = {
  "tools.media.audio.enabled": "Enable Audio Understanding",
  "tools.media.audio.preferredModel": "Preferred Audio Understanding Model",
  "tools.media.audio.maxBytes": "Audio Understanding Max Bytes",
  "tools.media.audio.maxChars": "Audio Understanding Max Chars",
  "tools.media.audio.prompt": "Audio Understanding Prompt",
  "tools.media.audio.timeoutSeconds": "Audio Understanding Timeout (sec)",
  "tools.media.audio.language": "Audio Understanding Language",
  "tools.media.audio.scope": "Audio Understanding Scope",
  "tools.media.audio.attachments": "Audio Understanding Attachment Policy",
  "tools.media.audio.echoTranscript": "Echo Transcript to Chat",
  "tools.media.audio.echoFormat": "Transcript Echo Format",
};
