// OpenAI-compatible realtime transcription plugin entrypoint.
//
// All provider registration happens through `capability-catalog.ts`, which the
// OpenClaw runtime loads directly from the manifest. The `index.ts` body is
// intentionally a no-op so the catalog-only path is the single registration
// surface; this matches the pattern used by other bundled providers that only
// ship a single capability family.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "openai-compatible-stt",
  name: "OpenAI-compatible STT (universal)",
  description:
    "Universal realtime transcription provider for any self-hosted OpenAI-compatible or raw-PCM-over-WebSocket endpoint. Works with whisper.cpp server mode (via a thin WebSocket shim), faster-whisper-server, vLLM, or any custom STT service.",
  register(_api) {
    // Provider registration is handled by the capability catalog entry.
  },
});
