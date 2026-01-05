import { loadConfig } from "../config/config.js";
import { MiniMaxTTSClient } from "./client.js";
import type { TTSProgressCallback, TTSRequest, TTSResponse } from "./types.js";

let cachedClient: MiniMaxTTSClient | null = null;

/**
 * Get or create TTS client from config
 */
export function getTTSClient(): MiniMaxTTSClient | null {
  if (cachedClient) {
    return cachedClient;
  }

  const config = loadConfig();
  const ttsConfig = config.tts;

  if (!ttsConfig?.enabled) {
    return null;
  }

  const apiKey = ttsConfig.minimaxApiKey || process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    console.warn("[tts] No MiniMax API key configured");
    return null;
  }

  cachedClient = new MiniMaxTTSClient({
    apiKey,
    groupId: ttsConfig.minimaxGroupId,
    cacheTtlSec: ttsConfig.cacheTtlSec,
    maxChars: ttsConfig.maxChars,
    timeoutSec: ttsConfig.timeoutSec,
  });

  return cachedClient;
}

/**
 * Synthesize text using configured TTS provider
 */
export async function synthesize(
  text: string,
  onProgress?: TTSProgressCallback,
): Promise<TTSResponse> {
  const client = getTTSClient();
  if (!client) {
    return {
      success: false,
      error: "TTS not enabled or not configured",
    };
  }

  const config = loadConfig();
  const ttsConfig = config.tts;

  if (!ttsConfig) {
    return {
      success: false,
      error: "TTS not configured",
    };
  }

  const request: TTSRequest = {
    text,
    model: ttsConfig.model,
    voiceId: ttsConfig.voiceId,
    emotion: ttsConfig.emotion,
    speed: ttsConfig.speed,
  };

  return client.synthesize(request, onProgress);
}

/**
 * Check if TTS is enabled
 */
export function isTTSEnabled(): boolean {
  const config = loadConfig();
  return config.tts?.enabled ?? false;
}
