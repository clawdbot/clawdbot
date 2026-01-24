/**
 * telegram-tts - Automatic TTS for chat responses
 *
 * Self-contained TTS extension that calls ElevenLabs/OpenAI APIs directly.
 * No external CLI dependencies.
 *
 * Features:
 * - speak tool for programmatic TTS
 * - Multi-provider support (ElevenLabs, OpenAI)
 * - RPC methods for status and control
 *
 * Note: Slash commands (/tts_on, /tts_off, /audio) should be configured
 * via Telegram customCommands and handled by the agent workspace.
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { PluginApi } from "clawdbot";

const PLUGIN_ID = "telegram-tts";
const DEFAULT_TIMEOUT_MS = 30000;
const TEMP_FILE_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Types
// =============================================================================

interface TtsConfig {
  enabled?: boolean;
  provider?: "elevenlabs" | "openai";
  elevenlabs?: {
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
  };
  openai?: {
    apiKey?: string;
    model?: string;
    voice?: string;
  };
  prefsPath?: string;
  maxTextLength?: number;
  timeoutMs?: number;
}

interface UserPreferences {
  tts?: {
    enabled?: boolean;
    provider?: "openai" | "elevenlabs";
    maxLength?: number; // Max chars before summarizing (default 1500)
    summarize?: boolean; // Enable auto-summarization (default true)
  };
}

const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;

interface TtsResult {
  success: boolean;
  audioPath?: string;
  error?: string;
  latencyMs?: number;
  provider?: string;
}

interface TtsStatusEntry {
  timestamp: number;
  success: boolean;
  textLength: number;
  summarized: boolean;
  provider?: string;
  latencyMs?: number;
  error?: string;
}

// Track last TTS attempt for diagnostics (global, not per-user)
// Note: This shows the most recent TTS attempt system-wide, not user-specific
let lastTtsAttempt: TtsStatusEntry | undefined;

// =============================================================================
// Validation
// =============================================================================

/**
 * Validates ElevenLabs voiceId format to prevent URL injection.
 * Voice IDs are alphanumeric strings, typically 20 characters.
 */
function isValidVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

/**
 * Validates OpenAI voice name.
 */
function isValidOpenAIVoice(voice: string): boolean {
  const validVoices = ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"];
  return validVoices.includes(voice);
}

/**
 * Available OpenAI TTS models.
 */
const OPENAI_TTS_MODELS = ["gpt-4o-mini-tts"];

/**
 * Validates OpenAI TTS model name.
 */
function isValidOpenAIModel(model: string): boolean {
  return OPENAI_TTS_MODELS.includes(model);
}

// =============================================================================
// Configuration & Preferences
// =============================================================================

function getPrefsPath(config: TtsConfig): string {
  return (
    config.prefsPath ||
    process.env.CLAWDBOT_TTS_PREFS ||
    join(process.env.HOME || "/home/dev", "clawd", ".user-preferences.json")
  );
}

function isTtsEnabled(prefsPath: string): boolean {
  try {
    if (!existsSync(prefsPath)) return false;
    const prefs: UserPreferences = JSON.parse(readFileSync(prefsPath, "utf8"));
    return prefs?.tts?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Atomically writes to a file using temp file + rename pattern.
 * Prevents race conditions when multiple processes write simultaneously.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, content);
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on rename failure
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

function updatePrefs(prefsPath: string, update: (prefs: UserPreferences) => void): void {
  let prefs: UserPreferences = {};
  try {
    if (existsSync(prefsPath)) {
      prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
    }
  } catch {
    // ignore
  }
  update(prefs);
  atomicWriteFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, enabled };
  });
}

function getTtsProvider(prefsPath: string): "openai" | "elevenlabs" | undefined {
  try {
    if (!existsSync(prefsPath)) return undefined;
    const prefs: UserPreferences = JSON.parse(readFileSync(prefsPath, "utf8"));
    return prefs?.tts?.provider;
  } catch {
    return undefined;
  }
}

function setTtsProvider(prefsPath: string, provider: "openai" | "elevenlabs"): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider };
  });
}

function getTtsMaxLength(prefsPath: string): number {
  try {
    if (!existsSync(prefsPath)) return DEFAULT_TTS_MAX_LENGTH;
    const prefs: UserPreferences = JSON.parse(readFileSync(prefsPath, "utf8"));
    return prefs?.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH;
  } catch {
    return DEFAULT_TTS_MAX_LENGTH;
  }
}

function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, maxLength };
  });
}

function isSummarizationEnabled(prefsPath: string): boolean {
  try {
    if (!existsSync(prefsPath)) return DEFAULT_TTS_SUMMARIZE;
    const prefs: UserPreferences = JSON.parse(readFileSync(prefsPath, "utf8"));
    return prefs?.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE;
  } catch {
    return DEFAULT_TTS_SUMMARIZE;
  }
}

function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, summarize: enabled };
  });
}

// =============================================================================
// Text Summarization (for long texts)
// =============================================================================

interface SummarizeResult {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
}

async function summarizeText(
  text: string,
  targetLength: number,
  apiKey: string,
  timeoutMs: number = 30000
): Promise<SummarizeResult> {
  // Validate targetLength
  if (targetLength < 100 || targetLength > 10000) {
    throw new Error(`Invalid targetLength: ${targetLength}`);
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an assistant that summarizes texts concisely while keeping the most important information. Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. Reply only with the summary, without additional explanations.`,
          },
          {
            role: "user",
            content: `<text_to_summarize>\n${text}\n</text_to_summarize>`,
          },
        ],
        max_tokens: Math.ceil(targetLength / 2), // Conservative estimate for multilingual text
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error("Summarization service unavailable");
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = data.choices?.[0]?.message?.content?.trim();

    if (!summary) {
      throw new Error("No summary returned");
    }

    const latencyMs = Date.now() - startTime;
    return {
      summary,
      latencyMs,
      inputLength: text.length,
      outputLength: summary.length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getApiKey(config: TtsConfig, provider: string): string | undefined {
  if (provider === "elevenlabs") {
    return (
      config.elevenlabs?.apiKey ||
      process.env.ELEVENLABS_API_KEY ||
      process.env.XI_API_KEY
    );
  }
  if (provider === "openai") {
    return config.openai?.apiKey || process.env.OPENAI_API_KEY;
  }
  return undefined;
}

// =============================================================================
// Temp File Cleanup
// =============================================================================

/**
 * Schedules cleanup of a temp directory after a delay.
 * This ensures the file is consumed before deletion.
 */
function scheduleCleanup(tempDir: string, delayMs: number = TEMP_FILE_CLEANUP_DELAY_MS): void {
  const timer = setTimeout(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }, delayMs);
  timer.unref(); // Allow process to exit without waiting for cleanup
}

// =============================================================================
// TTS Providers
// =============================================================================

async function elevenLabsTTS(
  text: string,
  apiKey: string,
  voiceId: string = "pMsXgVXv3BLzUgSXRplE",
  modelId: string = "eleven_multilingual_v2",
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Buffer> {
  // Validate voiceId to prevent URL injection
  if (!isValidVoiceId(voiceId)) {
    throw new Error(`Invalid voiceId format`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      // Don't leak API error details to users
      throw new Error(`ElevenLabs API error (${response.status})`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function openaiTTS(
  text: string,
  apiKey: string,
  model: string = "gpt-4o-mini-tts",
  voice: string = "alloy",
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Buffer> {
  // Validate model
  if (!isValidOpenAIModel(model)) {
    throw new Error(`Invalid model: ${model}`);
  }
  // Validate voice
  if (!isValidOpenAIVoice(voice)) {
    throw new Error(`Invalid voice: ${voice}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: "mp3",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Don't leak API error details to users
      throw new Error(`OpenAI TTS API error (${response.status})`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// Core TTS Function
// =============================================================================

async function textToSpeech(text: string, config: TtsConfig, prefsPath?: string): Promise<TtsResult> {
  // Get user's preferred provider (from prefs) or fall back to config
  const userProvider = prefsPath ? getTtsProvider(prefsPath) : undefined;
  const primaryProvider = userProvider || config.provider || "elevenlabs";
  const fallbackProvider = primaryProvider === "openai" ? "elevenlabs" : "openai";
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;

  const maxLen = config.maxTextLength || 4000;
  if (text.length > maxLen) {
    return {
      success: false,
      error: `Text too long (${text.length} chars, max ${maxLen})`,
    };
  }

  // Try primary provider first, then fallback
  const providers = [primaryProvider, fallbackProvider];
  let lastError: string | undefined;

  for (const provider of providers) {
    const apiKey = getApiKey(config, provider);
    if (!apiKey) {
      lastError = `No API key for ${provider}`;
      continue;
    }

    const providerStartTime = Date.now();
    try {
      let audioBuffer: Buffer;

      if (provider === "elevenlabs") {
        audioBuffer = await elevenLabsTTS(
          text,
          apiKey,
          config.elevenlabs?.voiceId,
          config.elevenlabs?.modelId,
          timeoutMs
        );
      } else if (provider === "openai") {
        audioBuffer = await openaiTTS(
          text,
          apiKey,
          config.openai?.model || "gpt-4o-mini-tts",
          config.openai?.voice,
          timeoutMs
        );
      } else {
        lastError = `Unknown provider: ${provider}`;
        continue;
      }

      const latencyMs = Date.now() - providerStartTime;

      // Save to temp file
      const tempDir = mkdtempSync(join(tmpdir(), "tts-"));
      const audioPath = join(tempDir, `voice-${Date.now()}.mp3`);
      writeFileSync(audioPath, audioBuffer);

      // Schedule cleanup after delay (file should be consumed by then)
      scheduleCleanup(tempDir);

      return { success: true, audioPath, latencyMs, provider };
    } catch (err) {
      const error = err as Error;
      if (error.name === "AbortError") {
        lastError = `${provider}: request timed out`;
      } else {
        lastError = `${provider}: ${error.message}`;
      }
      // Continue to try fallback provider
    }
  }

  return {
    success: false,
    error: `TTS conversion failed: ${lastError || "no providers available"}`,
  };
}

// =============================================================================
// Plugin Registration
// =============================================================================

export default function register(api: PluginApi) {
  const log = api.logger;
  const config: TtsConfig = {
    enabled: false,
    provider: "elevenlabs",
    maxTextLength: 4000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...(api.pluginConfig || {}),
  };
  const prefsPath = getPrefsPath(config);

  log.info(`[${PLUGIN_ID}] Registering plugin...`);
  log.info(`[${PLUGIN_ID}] Provider: ${config.provider}`);
  log.info(`[${PLUGIN_ID}] Preferences: ${prefsPath}`);

  // ===========================================================================
  // Tool: speak
  // ===========================================================================
  api.registerTool({
    name: "speak",
    description: `Convert text to speech and generate voice message.
Use this tool when TTS mode is enabled or user requests audio.

IMPORTANT: After calling this tool, you MUST output the result exactly as returned.
The tool returns "MEDIA:/path/to/audio.mp3" - copy this EXACTLY to your response.
This MEDIA: directive tells the system to send the audio file.

Example flow:
1. User asks a question with TTS enabled
2. You call speak({text: "Your answer here"})
3. Tool returns: MEDIA:/tmp/tts-xxx/voice-123.mp3
4. You output: MEDIA:/tmp/tts-xxx/voice-123.mp3

Do NOT add extra text around the MEDIA directive.`,
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to convert to speech",
        },
      },
      required: ["text"],
    },
    execute: async (_id: string, params: { text?: unknown }) => {
      // Validate text parameter
      if (typeof params?.text !== "string" || params.text.length === 0) {
        return { content: [{ type: "text", text: "Error: Invalid or missing text parameter" }] };
      }

      const text = params.text;
      log.info(`[${PLUGIN_ID}] speak() called, length: ${text.length}`);

      const result = await textToSpeech(text, config, prefsPath);

      if (result.success && result.audioPath) {
        log.info(`[${PLUGIN_ID}] Audio generated: ${result.audioPath}`);
        // Return with MEDIA directive for clawdbot to send
        return {
          content: [
            {
              type: "text",
              text: `MEDIA:${result.audioPath}`,
            },
          ],
        };
      }

      log.error(`[${PLUGIN_ID}] TTS failed: ${result.error}`);
      return {
        content: [
          {
            type: "text",
            text: result.error || "TTS conversion failed",
          },
        ],
      };
    },
  });

  // ===========================================================================
  // RPC Methods
  // ===========================================================================

  // tts.status - Check if TTS is enabled
  api.registerGatewayMethod("tts.status", async () => {
    const userProvider = getTtsProvider(prefsPath);
    const activeProvider = userProvider || config.provider || "elevenlabs";
    return {
      enabled: isTtsEnabled(prefsPath),
      provider: activeProvider,
      fallbackProvider: activeProvider === "openai" ? "elevenlabs" : "openai",
      prefsPath,
      hasOpenAIKey: !!getApiKey(config, "openai"),
      hasElevenLabsKey: !!getApiKey(config, "elevenlabs"),
    };
  });

  // tts.enable - Enable TTS mode
  api.registerGatewayMethod("tts.enable", async () => {
    setTtsEnabled(prefsPath, true);
    log.info(`[${PLUGIN_ID}] TTS enabled via RPC`);
    return { ok: true, enabled: true };
  });

  // tts.disable - Disable TTS mode
  api.registerGatewayMethod("tts.disable", async () => {
    setTtsEnabled(prefsPath, false);
    log.info(`[${PLUGIN_ID}] TTS disabled via RPC`);
    return { ok: true, enabled: false };
  });

  // tts.convert - Convert text to audio (returns path)
  api.registerGatewayMethod("tts.convert", async (params: { text?: unknown }) => {
    // Validate text parameter
    if (typeof params?.text !== "string" || params.text.length === 0) {
      return { ok: false, error: "Invalid or missing 'text' parameter" };
    }
    const result = await textToSpeech(params.text, config, prefsPath);
    if (result.success) {
      return { ok: true, audioPath: result.audioPath };
    }
    return { ok: false, error: result.error };
  });

  // tts.setProvider - Set primary TTS provider
  api.registerGatewayMethod("tts.setProvider", async (params: { provider?: unknown }) => {
    if (params?.provider !== "openai" && params?.provider !== "elevenlabs") {
      return { ok: false, error: "Invalid provider. Use 'openai' or 'elevenlabs'" };
    }
    setTtsProvider(prefsPath, params.provider);
    log.info(`[${PLUGIN_ID}] Provider set to ${params.provider} via RPC`);
    return { ok: true, provider: params.provider };
  });

  // tts.providers - List available providers and their status
  api.registerGatewayMethod("tts.providers", async () => {
    const userProvider = getTtsProvider(prefsPath);
    return {
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          configured: !!getApiKey(config, "openai"),
          models: ["gpt-4o-mini-tts"],
          voices: ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"],
        },
        {
          id: "elevenlabs",
          name: "ElevenLabs",
          configured: !!getApiKey(config, "elevenlabs"),
          models: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_monolingual_v1"],
        },
      ],
      active: userProvider || config.provider || "elevenlabs",
    };
  });

  // ===========================================================================
  // Plugin Commands (LLM-free, intercepted automatically)
  // ===========================================================================

  // /tts_on - Enable TTS mode
  api.registerCommand({
    name: "tts_on",
    description: "Enable text-to-speech for responses",
    handler: () => {
      setTtsEnabled(prefsPath, true);
      log.info(`[${PLUGIN_ID}] TTS enabled via /tts_on command`);
      return { text: "🔊 TTS enabled! I'll now respond with audio." };
    },
  });

  // /tts_off - Disable TTS mode
  api.registerCommand({
    name: "tts_off",
    description: "Disable text-to-speech for responses",
    handler: () => {
      setTtsEnabled(prefsPath, false);
      log.info(`[${PLUGIN_ID}] TTS disabled via /tts_off command`);
      return { text: "🔇 TTS disabled. Back to text mode." };
    },
  });

  // /audio <text> - Convert text to audio immediately
  api.registerCommand({
    name: "audio",
    description: "Convert text to audio message",
    acceptsArgs: true,
    handler: async (ctx) => {
      const text = ctx.args?.trim();
      if (!text) {
        return { text: "❌ Usage: /audio <text to convert to audio>" };
      }

      log.info(`[${PLUGIN_ID}] /audio command, text length: ${text.length}`);
      const result = await textToSpeech(text, config, prefsPath);

      if (result.success && result.audioPath) {
        log.info(`[${PLUGIN_ID}] Audio generated: ${result.audioPath}`);
        return { text: `MEDIA:${result.audioPath}` };
      }

      log.error(`[${PLUGIN_ID}] /audio failed: ${result.error}`);
      return { text: `❌ Error generating audio: ${result.error}` };
    },
  });

  // /tts_provider [openai|elevenlabs] - Set or show TTS provider
  api.registerCommand({
    name: "tts_provider",
    description: "Set or show TTS provider (openai or elevenlabs)",
    acceptsArgs: true,
    handler: (ctx) => {
      const arg = ctx.args?.trim().toLowerCase();
      const currentProvider = getTtsProvider(prefsPath) || config.provider || "elevenlabs";

      if (!arg) {
        // Show current provider
        const fallback = currentProvider === "openai" ? "elevenlabs" : "openai";
        const hasOpenAI = !!getApiKey(config, "openai");
        const hasElevenLabs = !!getApiKey(config, "elevenlabs");
        return {
          text: `🎙️ **TTS Provider**\n\n` +
            `Primary: **${currentProvider}** ${currentProvider === "openai" ? "(gpt-4o-mini-tts)" : "(eleven_multilingual_v2)"}\n` +
            `Fallback: ${fallback}\n\n` +
            `OpenAI: ${hasOpenAI ? "✅ configured" : "❌ no API key"}\n` +
            `ElevenLabs: ${hasElevenLabs ? "✅ configured" : "❌ no API key"}\n\n` +
            `Usage: /tts_provider openai or /tts_provider elevenlabs`,
        };
      }

      if (arg !== "openai" && arg !== "elevenlabs") {
        return { text: "❌ Invalid provider. Use: /tts_provider openai or /tts_provider elevenlabs" };
      }

      setTtsProvider(prefsPath, arg);
      const fallback = arg === "openai" ? "elevenlabs" : "openai";
      log.info(`[${PLUGIN_ID}] Provider set to ${arg} via /tts_provider command`);
      return {
        text: `✅ TTS provider changed!\n\n` +
          `Primary: **${arg}** ${arg === "openai" ? "(gpt-4o-mini-tts)" : "(eleven_multilingual_v2)"}\n` +
          `Fallback: ${fallback}`,
      };
    },
  });

  // /tts_limit [number] - Set or show max text length before summarizing
  api.registerCommand({
    name: "tts_limit",
    description: "Set or show max text length for TTS (longer texts are summarized)",
    acceptsArgs: true,
    handler: (ctx) => {
      const arg = ctx.args?.trim();
      const currentLimit = getTtsMaxLength(prefsPath);

      if (!arg) {
        // Show current limit
        return {
          text: `📏 **TTS Limit**\n\n` +
            `Current limit: **${currentLimit}** characters\n\n` +
            `Texts longer than ${currentLimit} chars will be automatically summarized with gpt-4o-mini before converting to audio.\n\n` +
            `Usage: /tts_limit 2000 (sets new limit)`,
        };
      }

      const newLimit = parseInt(arg, 10);
      if (isNaN(newLimit) || newLimit < 100 || newLimit > 10000) {
        return { text: "❌ Invalid limit. Use a number between 100 and 10000." };
      }

      setTtsMaxLength(prefsPath, newLimit);
      log.info(`[${PLUGIN_ID}] Max length set to ${newLimit} via /tts_limit command`);
      return {
        text: `✅ TTS limit changed to **${newLimit}** characters!\n\n` +
          `Longer texts will be automatically summarized before converting to audio.`,
      };
    },
  });

  // /tts_summary [on|off] - Enable/disable auto-summarization
  api.registerCommand({
    name: "tts_summary",
    description: "Enable or disable auto-summarization for long texts",
    acceptsArgs: true,
    handler: (ctx) => {
      const arg = ctx.args?.trim().toLowerCase();
      const currentEnabled = isSummarizationEnabled(prefsPath);
      const maxLength = getTtsMaxLength(prefsPath);

      if (!arg) {
        // Show current status
        return {
          text: `📝 **TTS Auto-Summary**\n\n` +
            `Status: ${currentEnabled ? "✅ Enabled" : "❌ Disabled"}\n` +
            `Limit: ${maxLength} characters\n\n` +
            `When enabled, texts longer than ${maxLength} chars are summarized with gpt-4o-mini before converting to audio.\n\n` +
            `Usage: /tts_summary on or /tts_summary off`,
        };
      }

      if (arg !== "on" && arg !== "off") {
        return { text: "❌ Use: /tts_summary on or /tts_summary off" };
      }

      const newEnabled = arg === "on";
      setSummarizationEnabled(prefsPath, newEnabled);
      log.info(`[${PLUGIN_ID}] Summarization ${newEnabled ? "enabled" : "disabled"} via /tts_summary command`);
      return {
        text: newEnabled
          ? `✅ Auto-summary **enabled**!\n\nLong texts will be summarized before converting to audio.`
          : `❌ Auto-summary **disabled**!\n\nLong texts will be skipped (no audio).`,
      };
    },
  });

  // /tts_status - Show TTS status and last attempt result
  api.registerCommand({
    name: "tts_status",
    description: "Show TTS status, configuration, and last attempt result",
    acceptsArgs: false,
    handler: () => {
      const enabled = isTtsEnabled(prefsPath);
      const userProvider = getTtsProvider(prefsPath);
      const activeProvider = userProvider || config.provider || "elevenlabs";
      const maxLength = getTtsMaxLength(prefsPath);
      const summarizationEnabled = isSummarizationEnabled(prefsPath);
      const hasKey = !!getApiKey(config, activeProvider);

      let statusLines = [
        `📊 **TTS Status**\n`,
        `State: ${enabled ? "✅ Enabled" : "❌ Disabled"}`,
        `Provider: ${activeProvider} (API Key: ${hasKey ? "✅" : "❌"})`,
        `Text limit: ${maxLength} characters`,
        `Auto-summary: ${summarizationEnabled ? "✅ Enabled" : "❌ Disabled"}`,
      ];

      if (lastTtsAttempt) {
        const timeAgo = Math.round((Date.now() - lastTtsAttempt.timestamp) / 1000);
        statusLines.push(``);
        statusLines.push(`**Last attempt** (${timeAgo}s ago):`);
        statusLines.push(`Result: ${lastTtsAttempt.success ? "✅ Success" : "❌ Failed"}`);
        statusLines.push(`Text: ${lastTtsAttempt.textLength} chars${lastTtsAttempt.summarized ? " (summarized)" : ""}`);
        if (lastTtsAttempt.success) {
          statusLines.push(`Provider: ${lastTtsAttempt.provider}`);
          statusLines.push(`Latency: ${lastTtsAttempt.latencyMs}ms`);
        } else if (lastTtsAttempt.error) {
          statusLines.push(`Error: ${lastTtsAttempt.error}`);
        }
      } else {
        statusLines.push(``);
        statusLines.push(`_No TTS attempts recorded in this session._`);
      }

      return { text: statusLines.join("\n") };
    },
  });

  // ===========================================================================
  // Auto-TTS Hook (message_sending)
  // ===========================================================================

  // Automatically convert text responses to audio when TTS is enabled
  api.on("message_sending", async (event) => {
    // Check if TTS is enabled
    if (!isTtsEnabled(prefsPath)) {
      return; // TTS disabled, don't modify message
    }

    const content = event.content?.trim();
    if (!content) {
      return; // Empty content, skip
    }

    // Skip if already contains MEDIA directive (avoid double conversion)
    if (content.includes("MEDIA:")) {
      return;
    }

    // Skip very short messages (likely errors or status)
    if (content.length < 10) {
      return;
    }

    const maxLength = getTtsMaxLength(prefsPath);
    let textForAudio = content;
    const summarizationEnabled = isSummarizationEnabled(prefsPath);

    // If text exceeds limit, summarize it first (if enabled)
    if (content.length > maxLength) {
      if (!summarizationEnabled) {
        log.info(`[${PLUGIN_ID}] Auto-TTS: Text too long (${content.length} > ${maxLength}), summarization disabled, skipping audio`);
        return; // User disabled summarization, skip audio for long texts
      }

      log.info(`[${PLUGIN_ID}] Auto-TTS: Text too long (${content.length} > ${maxLength}), summarizing...`);

      const openaiKey = getApiKey(config, "openai");
      if (!openaiKey) {
        log.warn(`[${PLUGIN_ID}] Auto-TTS: No OpenAI key for summarization, skipping audio`);
        return; // Can't summarize without OpenAI key
      }

      try {
        const summarizeResult = await summarizeText(content, maxLength, openaiKey, config.timeoutMs);
        textForAudio = summarizeResult.summary;
        log.info(
          `[${PLUGIN_ID}] Auto-TTS: Summarized ${summarizeResult.inputLength} → ${summarizeResult.outputLength} chars in ${summarizeResult.latencyMs}ms`
        );

        // Safeguard: if summary still exceeds hard limit, truncate
        const hardLimit = config.maxTextLength || 4000;
        if (textForAudio.length > hardLimit) {
          log.warn(`[${PLUGIN_ID}] Auto-TTS: Summary exceeded hard limit (${textForAudio.length} > ${hardLimit}), truncating`);
          textForAudio = textForAudio.slice(0, hardLimit - 3) + "...";
        }
      } catch (err) {
        const error = err as Error;
        log.error(`[${PLUGIN_ID}] Auto-TTS: Summarization failed: ${error.message}`);
        return; // On summarization failure, skip audio
      }
    } else {
      log.info(`[${PLUGIN_ID}] Auto-TTS: Converting ${content.length} chars`);
    }

    const wasSummarized = textForAudio !== content;

    try {
      const ttsStartTime = Date.now();
      const result = await textToSpeech(textForAudio, config, prefsPath);

      if (result.success && result.audioPath) {
        const totalLatency = Date.now() - ttsStartTime;
        log.info(
          `[${PLUGIN_ID}] Auto-TTS: Generated via ${result.provider} in ${result.latencyMs}ms (total: ${totalLatency}ms)`
        );

        // Track successful attempt
        lastTtsAttempt = {
          timestamp: Date.now(),
          success: true,
          textLength: content.length,
          summarized: wasSummarized,
          provider: result.provider,
          latencyMs: result.latencyMs,
        };

        // Return modified content with MEDIA directive
        // The text is kept for accessibility, audio is appended
        return {
          content: `MEDIA:${result.audioPath}`,
        };
      } else {
        log.warn(`[${PLUGIN_ID}] Auto-TTS: TTS conversion failed - ${result.error}`);

        // Track failed attempt
        lastTtsAttempt = {
          timestamp: Date.now(),
          success: false,
          textLength: content.length,
          summarized: wasSummarized,
          error: result.error,
        };

        // On failure, send original text without audio
        return;
      }
    } catch (err) {
      const error = err as Error;
      log.error(`[${PLUGIN_ID}] Auto-TTS: Unexpected error - ${error.message}`);

      // Track error
      lastTtsAttempt = {
        timestamp: Date.now(),
        success: false,
        textLength: content.length,
        summarized: wasSummarized,
        error: error.message,
      };

      // On error, send original text
      return;
    }
  });

  // ===========================================================================
  // Startup
  // ===========================================================================

  const ttsEnabled = isTtsEnabled(prefsPath);
  const userProvider = getTtsProvider(prefsPath);
  const activeProvider = userProvider || config.provider || "elevenlabs";
  const hasKey = !!getApiKey(config, activeProvider);

  log.info(`[${PLUGIN_ID}] Ready. TTS: ${ttsEnabled ? "ON" : "OFF"}, Provider: ${activeProvider}, API Key: ${hasKey ? "OK" : "MISSING"}`);

  if (!hasKey) {
    log.warn(
      `[${PLUGIN_ID}] No API key configured. Set ELEVENLABS_API_KEY or OPENAI_API_KEY.`
    );
  }
}

// =============================================================================
// Plugin Metadata
// =============================================================================

export const meta = {
  id: PLUGIN_ID,
  name: "Telegram TTS",
  description: "Text-to-speech for chat responses using ElevenLabs or OpenAI",
  version: "0.3.0",
};

// =============================================================================
// Test Exports (for unit testing)
// =============================================================================

export const _test = {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  OPENAI_TTS_MODELS,
  summarizeText,
};
