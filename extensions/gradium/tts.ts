import { assertOkOrThrowProviderError } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeGradiumBaseUrl } from "./shared.js";

export async function gradiumTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  outputFormat: "wav" | "opus" | "ulaw_8000" | "pcm" | "pcm_24000" | "alaw_8000";
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, apiKey, baseUrl, voiceId, outputFormat, timeoutMs } = params;
  const normalizedBaseUrl = normalizeGradiumBaseUrl(baseUrl);
  const url = `${normalizedBaseUrl}/api/post/speech/tts`;
  const hostname = new URL(normalizedBaseUrl).hostname;

  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice_id: voiceId,
        only_audio: true,
        output_format: outputFormat,
        json_config: JSON.stringify({ padding_bonus: 0 }),
      }),
    },
    timeoutMs,
    policy: { hostnameAllowlist: [hostname] },
    auditContext: "gradium.tts",
  });

  try {
    await assertOkOrThrowProviderError(response, "Gradium API error");

    return Buffer.from(await response.arrayBuffer());
  } finally {
    await release();
  }
}
