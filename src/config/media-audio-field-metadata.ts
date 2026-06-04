/** Config paths with user-facing metadata for audio understanding settings. */
export const MEDIA_AUDIO_FIELD_KEYS = [
  "tools.media.audio.enabled",
  "tools.media.audio.maxBytes",
  "tools.media.audio.maxChars",
  "tools.media.audio.prompt",
  "tools.media.audio.timeoutSeconds",
  "tools.media.audio.language",
  "tools.media.audio.attachments",
  "tools.media.audio.models",
  "tools.media.audio.scope",
  "tools.media.audio.echoTranscript",
  "tools.media.audio.echoFormat",
  "tools.media.audio.request",
  "tools.media.audio.request.headers",
  "tools.media.audio.request.auth",
  "tools.media.audio.request.auth.mode",
  "tools.media.audio.request.auth.token",
  "tools.media.audio.request.auth.headerName",
  "tools.media.audio.request.auth.value",
  "tools.media.audio.request.auth.prefix",
  "tools.media.audio.request.proxy",
  "tools.media.audio.request.proxy.mode",
  "tools.media.audio.request.proxy.url",
  "tools.media.audio.request.proxy.tls",
  "tools.media.audio.request.tls",
] as const;

type MediaAudioFieldKey = (typeof MEDIA_AUDIO_FIELD_KEYS)[number];

export const MEDIA_AUDIO_FIELD_HELP: Record<MediaAudioFieldKey, string> = {
  "tools.media.audio.enabled":
    "Enable audio understanding so voice notes or audio clips can be transcribed/summarized for agent context. Disable when audio ingestion is outside policy or unnecessary for your workflows.",
  "tools.media.audio.maxBytes":
    "Maximum accepted audio payload size in bytes before processing is rejected or clipped by policy. Set this based on expected recording length and upstream provider limits.",
  "tools.media.audio.maxChars":
    "Maximum characters retained from audio understanding output to prevent oversized transcript injection. Increase for long-form dictation, or lower to keep conversational turns compact.",
  "tools.media.audio.prompt":
    "Instruction template guiding audio understanding output style, such as concise summary versus near-verbatim transcript. Keep wording consistent so downstream automations can rely on output format.",
  "tools.media.audio.timeoutSeconds":
    "Timeout in seconds for audio understanding execution before the operation is cancelled. Use longer timeouts for long recordings and tighter ones for interactive chat responsiveness.",
  "tools.media.audio.language":
    "Preferred language hint for audio understanding/transcription when provider support is available. Set this to improve recognition accuracy for known primary languages.",
  "tools.media.audio.attachments":
    "Attachment policy for audio inputs indicating which uploaded files are eligible for audio processing. Keep restrictive defaults in mixed-content channels to avoid unintended audio workloads.",
  "tools.media.audio.models":
    "Ordered model preferences specifically for audio understanding, used before shared media model fallback. Choose models optimized for transcription quality in your primary language/domain.",
  "tools.media.audio.scope":
    "Scope selector for when audio understanding runs across inbound messages and attachments. Keep focused scopes in high-volume channels to reduce cost and avoid accidental transcription.",
  "tools.media.audio.echoTranscript":
    "Echo the audio transcript back to the originating chat before agent processing. When enabled, users immediately see what was heard from their voice note, helping them verify transcription accuracy before the agent acts on it. Default: false.",
  "tools.media.audio.echoFormat":
    "Format string for the echoed transcript message. Use `{transcript}` as a placeholder for the transcribed text. Default: '📝 \"{transcript}\"'.",
  "tools.media.audio.request":
    "Low-level HTTP request overrides for audio providers, including custom headers, auth, proxy routing, and TLS client settings. Use this for proxy-backed or self-hosted transcription endpoints when plain baseUrl/apiKey fields are not enough.",
  "tools.media.audio.request.headers":
    "Additional HTTP headers merged into audio provider requests after provider defaults. Use this for tenant routing or proxy integration headers, and keep secrets in env-backed values.",
  "tools.media.audio.request.auth":
    "Optional auth override for audio provider requests. Use this when the upstream expects a non-default bearer token or custom auth header shape.",
  "tools.media.audio.request.auth.mode":
    'Auth override mode for audio requests: "provider-default" keeps the normal provider auth, "authorization-bearer" forces an Authorization bearer token, and "header" sends a custom header/value pair.',
  "tools.media.audio.request.auth.token":
    "Bearer token used when audio request auth.mode is authorization-bearer. Keep this in secret storage rather than inline config.",
  "tools.media.audio.request.auth.headerName":
    "Header name used when audio request auth.mode is header. Match the exact upstream expectation, such as x-api-key or authorization.",
  "tools.media.audio.request.auth.value":
    "Header value used when audio request auth.mode is header. Keep secrets in env-backed values and avoid duplicating provider-default auth unnecessarily.",
  "tools.media.audio.request.auth.prefix":
    "Optional prefix prepended to the custom auth header value, such as Bearer. Leave unset when the upstream expects the raw credential only.",
  "tools.media.audio.request.proxy":
    "Proxy transport override for audio requests. Use env-proxy to respect process proxy settings, or explicit-proxy to force a dedicated proxy URL for this provider path.",
  "tools.media.audio.request.proxy.mode":
    'Proxy mode for audio requests: "env-proxy" uses environment proxy settings, while "explicit-proxy" uses the configured proxy URL only for this request path.',
  "tools.media.audio.request.proxy.url":
    "Explicit proxy URL for audio provider traffic when proxy.mode is explicit-proxy. Keep credentials out of inline URLs when possible and prefer secret-backed env injection.",
  "tools.media.audio.request.proxy.tls":
    "TLS settings applied when connecting to the configured audio proxy, such as custom CA trust for an internal proxy gateway.",
  "tools.media.audio.request.tls":
    "Direct TLS client settings for audio provider requests, including custom CA trust, client certs, or SNI overrides for managed gateways and internal endpoints.",
};

export const MEDIA_AUDIO_FIELD_LABELS: Record<MediaAudioFieldKey, string> = {
  "tools.media.audio.enabled": "Enable Audio Understanding",
  "tools.media.audio.maxBytes": "Audio Understanding Max Bytes",
  "tools.media.audio.maxChars": "Audio Understanding Max Chars",
  "tools.media.audio.prompt": "Audio Understanding Prompt",
  "tools.media.audio.timeoutSeconds": "Audio Understanding Timeout (sec)",
  "tools.media.audio.language": "Audio Understanding Language",
  "tools.media.audio.attachments": "Audio Understanding Attachment Policy",
  "tools.media.audio.models": "Audio Understanding Models",
  "tools.media.audio.scope": "Audio Understanding Scope",
  "tools.media.audio.echoTranscript": "Echo Transcript to Chat",
  "tools.media.audio.echoFormat": "Transcript Echo Format",
  "tools.media.audio.request": "Audio Request Overrides",
  "tools.media.audio.request.headers": "Audio Request Headers",
  "tools.media.audio.request.auth": "Audio Request Auth Override",
  "tools.media.audio.request.auth.mode": "Audio Request Auth Mode",
  "tools.media.audio.request.auth.token": "Audio Request Bearer Token",
  "tools.media.audio.request.auth.headerName": "Audio Request Auth Header Name",
  "tools.media.audio.request.auth.value": "Audio Request Auth Header Value",
  "tools.media.audio.request.auth.prefix": "Audio Request Auth Header Prefix",
  "tools.media.audio.request.proxy": "Audio Request Proxy",
  "tools.media.audio.request.proxy.mode": "Audio Request Proxy Mode",
  "tools.media.audio.request.proxy.url": "Audio Request Proxy URL",
  "tools.media.audio.request.proxy.tls": "Audio Request Proxy TLS",
  "tools.media.audio.request.tls": "Audio Request TLS",
};
