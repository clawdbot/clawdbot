import crypto from "node:crypto";
import { readLatestAssistantTextFromSessionTranscript } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
} from "../../tts/provider-registry.js";
import {
  getResolvedSpeechProviderConfig,
  getLastTtsAttempt,
  getTtsMaxLength,
  getTtsPersona,
  getTtsProvider,
  isSummarizationEnabled,
  isTtsEnabled,
  isTtsProviderConfigured,
  listTtsPersonas,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setLastTtsAttempt,
  setSummarizationEnabled,
  setTtsEnabled,
  setTtsMaxLength,
  setTtsPersona,
  setTtsProvider,
  textToSpeech,
} from "../../tts/tts.js";
import { isSilentReplyPayloadText } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";

type ParsedTtsCommand = {
  action: string;
  args: string;
};

type TtsAttemptDetail = NonNullable<
  NonNullable<ReturnType<typeof getLastTtsAttempt>>["attempts"]
>[number];

function parseTtsCommand(normalized: string): ParsedTtsCommand | null {
  // Accept `/tts` and `/tts <action> [args]` as a single control surface.
  if (normalized === "/tts") {
    return { action: "status", args: "" };
  }
  if (!normalized.startsWith("/tts ")) {
    return null;
  }
  const rest = normalized.slice(5).trim();
  if (!rest) {
    return { action: "status", args: "" };
  }
  const [action, ...tail] = rest.split(/\s+/);
  return {
    action: normalizeOptionalLowercaseString(action) ?? "",
    args: normalizeOptionalString(tail.join(" ")) ?? "",
  };
}

function formatAttemptDetails(attempts: TtsAttemptDetail[] | undefined): string | undefined {
  if (!attempts || attempts.length === 0) {
    return undefined;
  }
  return attempts
    .map((attempt) => {
      const reason = attempt.reasonCode === "success" ? "ok" : attempt.reasonCode;
      const latency = Number.isFinite(attempt.latencyMs) ? ` ${attempt.latencyMs}ms` : "";
      const persona =
        attempt.persona && attempt.personaBinding && attempt.personaBinding !== "none"
          ? ` persona=${attempt.persona}:${attempt.personaBinding}`
          : "";
      return `${attempt.provider}:${attempt.outcome}(${reason})${persona}${latency}`;
    })
    .join(", ");
}

function ttsUsage(): ReplyPayload {
  // Keep usage in one place so help/validation stays consistent.
  return {
    text:
      `🔊 **TTS (Text-to-Speech) Help**\n\n` +
      `**Commands:**\n` +
      `• /tts on — Enable automatic TTS for replies\n` +
      `• /tts off — Disable TTS\n` +
      `• /tts status — Show current settings\n` +
      `• /tts provider [name] — View/change provider\n` +
      `• /tts persona [id|off] — View/change persona\n` +
      `• /tts limit [number] — View/change text limit\n` +
      `• /tts summary [on|off] — View/change auto-summary\n` +
      `• /tts audio <text> — Generate audio from text\n` +
      `• /tts latest — Read the latest assistant reply once\n` +
      `• /tts chat on|off|default — Override auto-TTS for this chat\n\n` +
      `**Providers:**\n` +
      `Use /tts provider to list the registered speech providers and their status.\n\n` +
      `**Text Limit (default: 1500, max: 4096):**\n` +
      `When text exceeds the limit:\n` +
      `• Summary ON: AI summarizes, then generates audio\n` +
      `• Summary OFF: Truncates text, then generates audio\n\n` +
      `**Examples:**\n` +
      `/tts provider <id>\n` +
      `/tts persona <id>\n` +
      `/tts limit 2000\n` +
      `/tts latest\n` +
      `/tts audio Hello, this is a test!`,
  };
}

function hashTtsReadLatestText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function buildTtsAudioReply(params: {
  text: string;
  cfg: Parameters<typeof textToSpeech>[0]["cfg"];
  channel: string;
  accountId?: string;
  prefsPath: string;
  agentId?: string;
}): Promise<{ reply: ReplyPayload; provider?: string; hash?: string } | { error: string }> {
  const start = Date.now();
  const result = await textToSpeech({
    text: params.text,
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    prefsPath: params.prefsPath,
    agentId: params.agentId,
  });

  if (result.success && result.audioPath) {
    setLastTtsAttempt({
      timestamp: Date.now(),
      success: true,
      textLength: params.text.length,
      summarized: false,
      provider: result.provider,
      persona: result.persona,
      fallbackFrom: result.fallbackFrom,
      attemptedProviders: result.attemptedProviders,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
    });
    return {
      provider: result.provider,
      reply: {
        mediaUrl: result.audioPath,
        audioAsVoice: result.voiceCompatible === true,
        trustedLocalMedia: true,
        spokenText: params.text,
      },
    };
  }

  setLastTtsAttempt({
    timestamp: Date.now(),
    success: false,
    textLength: params.text.length,
    summarized: false,
    persona: result.persona,
    attemptedProviders: result.attemptedProviders,
    attempts: result.attempts,
    error: result.error,
    latencyMs: Date.now() - start,
  });
  return { error: result.error ?? "unknown error" };
}

export const handleTtsCommands: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseTtsCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring TTS command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const accountId = params.ctx?.AccountId;
  const config = resolveTtsConfig(params.cfg, {
    agentId: params.agentId,
    channelId: params.command.channel,
    accountId,
  });
  const prefsPath = resolveTtsPrefsPath(config);
  const action = parsed.action;
  const args = parsed.args;

  if (action === "help") {
    return { shouldContinue: false, reply: ttsUsage() };
  }

  if (action === "on") {
    setTtsEnabled(prefsPath, true);
    return { shouldContinue: false, reply: { text: "🔊 TTS enabled." } };
  }

  if (action === "off") {
    setTtsEnabled(prefsPath, false);
    return { shouldContinue: false, reply: { text: "🔇 TTS disabled." } };
  }

  if (action === "chat") {
    const requested = normalizeOptionalLowercaseString(args) ?? "";
    if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
      return {
        shouldContinue: false,
        reply: { text: "🔇 No active chat session is available for a chat-scoped TTS override." },
      };
    }
    if (!requested || requested === "status") {
      return {
        shouldContinue: false,
        reply: { text: `🔊 Chat TTS override: ${params.sessionEntry.ttsAuto ?? "default"}.` },
      };
    }
    if (requested === "on") {
      params.sessionEntry.ttsAuto = "always";
      await persistSessionEntry(params);
      return { shouldContinue: false, reply: { text: "🔊 TTS enabled for this chat." } };
    }
    if (requested === "off") {
      params.sessionEntry.ttsAuto = "off";
      await persistSessionEntry(params);
      return { shouldContinue: false, reply: { text: "🔇 TTS disabled for this chat." } };
    }
    if (requested === "default" || requested === "inherit" || requested === "clear") {
      delete params.sessionEntry.ttsAuto;
      await persistSessionEntry(params);
      return { shouldContinue: false, reply: { text: "🔊 TTS chat override cleared." } };
    }
    return { shouldContinue: false, reply: ttsUsage() };
  }

  if (
    action === "latest" ||
    (action === "read" && normalizeOptionalLowercaseString(args) === "latest")
  ) {
    if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
      return {
        shouldContinue: false,
        reply: { text: "🎤 No active chat session is available for `/tts latest`." },
      };
    }
    const latest = await readLatestAssistantTextFromSessionTranscript(
      params.sessionEntry.sessionFile,
    );
    const latestText = latest?.text.trim();
    if (!latestText || isSilentReplyPayloadText(latestText)) {
      return {
        shouldContinue: false,
        reply: { text: "🎤 No readable assistant reply was found in this chat yet." },
      };
    }
    const hash = hashTtsReadLatestText(latestText);
    if (params.sessionEntry.lastTtsReadLatestHash === hash) {
      return {
        shouldContinue: false,
        reply: { text: "🔊 Latest assistant reply was already sent as audio." },
      };
    }

    const audio = await buildTtsAudioReply({
      text: latestText,
      cfg: params.cfg,
      channel: params.command.channel,
      accountId,
      prefsPath,
      agentId: params.agentId,
    });
    if ("error" in audio) {
      return {
        shouldContinue: false,
        reply: { text: `❌ Error generating audio: ${audio.error}` },
      };
    }

    params.sessionEntry.lastTtsReadLatestHash = hash;
    params.sessionEntry.lastTtsReadLatestAt = Date.now();
    await persistSessionEntry(params);
    return { shouldContinue: false, reply: audio.reply };
  }

  if (action === "audio") {
    if (!args.trim()) {
      return {
        shouldContinue: false,
        reply: {
          text:
            `🎤 Generate audio from text.\n\n` +
            `Usage: /tts audio <text>\n` +
            `Example: /tts audio Hello, this is a test!`,
        },
      };
    }

    const audio = await buildTtsAudioReply({
      text: args,
      cfg: params.cfg,
      channel: params.command.channel,
      accountId,
      prefsPath,
      agentId: params.agentId,
    });
    if (!("error" in audio)) {
      return { shouldContinue: false, reply: audio.reply };
    }
    return {
      shouldContinue: false,
      reply: { text: `❌ Error generating audio: ${audio.error}` },
    };
  }

  if (action === "provider") {
    const currentProvider = getTtsProvider(config, prefsPath);
    if (!args.trim()) {
      const providers = listSpeechProviders(params.cfg);
      return {
        shouldContinue: false,
        reply: {
          text:
            `🎙️ TTS provider\n` +
            `Primary: ${currentProvider}\n` +
            providers
              .map(
                (provider) =>
                  `${provider.label}: ${
                    provider.isConfigured({
                      cfg: params.cfg,
                      providerConfig: getResolvedSpeechProviderConfig(
                        config,
                        provider.id,
                        params.cfg,
                      ),
                      timeoutMs: config.timeoutMs,
                    })
                      ? "✅"
                      : "❌"
                  }`,
              )
              .join("\n") +
            `\nUsage: /tts provider <id>`,
        },
      };
    }

    const requested = normalizeOptionalLowercaseString(args) ?? "";
    const resolvedProvider = getSpeechProvider(requested, params.cfg);
    if (!resolvedProvider) {
      return { shouldContinue: false, reply: ttsUsage() };
    }

    const nextProvider = canonicalizeSpeechProviderId(requested, params.cfg) ?? resolvedProvider.id;
    setTtsProvider(prefsPath, nextProvider);
    return {
      shouldContinue: false,
      reply: { text: `✅ TTS provider set to ${nextProvider}.` },
    };
  }

  if (action === "persona") {
    const personas = listTtsPersonas(config);
    const activePersona = getTtsPersona(config, prefsPath);
    if (!args.trim()) {
      const lines = [
        "🎭 TTS persona",
        `Active: ${activePersona?.id ?? "none"}`,
        personas.length > 0
          ? personas
              .map((persona) => {
                const label = persona.label ? ` (${persona.label})` : "";
                const provider = persona.provider ? ` provider=${persona.provider}` : "";
                return `${persona.id}${label}${provider}`;
              })
              .join("\n")
          : "No personas configured.",
        "Usage: /tts persona <id> | off",
      ];
      return { shouldContinue: false, reply: { text: lines.join("\n") } };
    }

    const requested = normalizeOptionalLowercaseString(args) ?? "";
    if (requested === "off" || requested === "none" || requested === "default") {
      setTtsPersona(prefsPath, null);
      return { shouldContinue: false, reply: { text: "✅ TTS persona disabled." } };
    }
    const persona = personas.find((entry) => entry.id === requested);
    if (!persona) {
      return {
        shouldContinue: false,
        reply: {
          text:
            `❌ Unknown TTS persona: ${requested || args}.\n` +
            `Use /tts persona to list configured personas.`,
        },
      };
    }
    setTtsPersona(prefsPath, persona.id);
    return {
      shouldContinue: false,
      reply: { text: `✅ TTS persona set to ${persona.id}.` },
    };
  }

  if (action === "limit") {
    if (!args.trim()) {
      const currentLimit = getTtsMaxLength(prefsPath);
      return {
        shouldContinue: false,
        reply: {
          text:
            `📏 TTS limit: ${currentLimit} characters.\n\n` +
            `Text longer than this triggers summary (if enabled).\n` +
            `Range: 100-4096 chars (Telegram max).\n\n` +
            `To change: /tts limit <number>\n` +
            `Example: /tts limit 2000`,
        },
      };
    }
    const next = Number.parseInt(args.trim(), 10);
    if (!Number.isFinite(next) || next < 100 || next > 4096) {
      return {
        shouldContinue: false,
        reply: { text: "❌ Limit must be between 100 and 4096 characters." },
      };
    }
    setTtsMaxLength(prefsPath, next);
    return {
      shouldContinue: false,
      reply: { text: `✅ TTS limit set to ${next} characters.` },
    };
  }

  if (action === "summary") {
    if (!args.trim()) {
      const enabled = isSummarizationEnabled(prefsPath);
      const maxLen = getTtsMaxLength(prefsPath);
      return {
        shouldContinue: false,
        reply: {
          text:
            `📝 TTS auto-summary: ${enabled ? "on" : "off"}.\n\n` +
            `When text exceeds ${maxLen} chars:\n` +
            `• ON: summarizes text, then generates audio\n` +
            `• OFF: truncates text, then generates audio\n\n` +
            `To change: /tts summary on | off`,
        },
      };
    }
    const requested = normalizeOptionalLowercaseString(args) ?? "";
    if (requested !== "on" && requested !== "off") {
      return { shouldContinue: false, reply: ttsUsage() };
    }
    setSummarizationEnabled(prefsPath, requested === "on");
    return {
      shouldContinue: false,
      reply: {
        text: requested === "on" ? "✅ TTS auto-summary enabled." : "❌ TTS auto-summary disabled.",
      },
    };
  }

  if (action === "status") {
    const enabled = isTtsEnabled(config, prefsPath);
    const provider = getTtsProvider(config, prefsPath);
    const persona = getTtsPersona(config, prefsPath);
    const hasKey = isTtsProviderConfigured(config, provider, params.cfg);
    const maxLength = getTtsMaxLength(prefsPath);
    const summarize = isSummarizationEnabled(prefsPath);
    const last = getLastTtsAttempt();
    const lines = [
      "📊 TTS status",
      `State: ${enabled ? "✅ enabled" : "❌ disabled"}`,
      `Chat override: ${params.sessionEntry?.ttsAuto ?? "default"}`,
      `Provider: ${provider} (${hasKey ? "✅ configured" : "❌ not configured"})`,
      `Persona: ${persona?.id ?? "none"}`,
      `Text limit: ${maxLength} chars`,
      `Auto-summary: ${summarize ? "on" : "off"}`,
    ];
    if (last) {
      const timeAgo = Math.round((Date.now() - last.timestamp) / 1000);
      lines.push("");
      lines.push(`Last attempt (${timeAgo}s ago): ${last.success ? "✅" : "❌"}`);
      lines.push(`Text: ${last.textLength} chars${last.summarized ? " (summarized)" : ""}`);
      if (last.success) {
        lines.push(`Provider: ${last.provider ?? "unknown"}`);
        if (last.persona) {
          lines.push(`Persona: ${last.persona}`);
        }
        if (last.fallbackFrom && last.provider && last.fallbackFrom !== last.provider) {
          lines.push(`Fallback: ${last.fallbackFrom} -> ${last.provider}`);
        }
        if (last.attemptedProviders && last.attemptedProviders.length > 1) {
          lines.push(`Attempts: ${last.attemptedProviders.join(" -> ")}`);
        }
        const details = formatAttemptDetails(last.attempts);
        if (details) {
          lines.push(`Attempt details: ${details}`);
        }
        lines.push(`Latency: ${last.latencyMs ?? 0}ms`);
      } else if (last.error) {
        lines.push(`Error: ${last.error}`);
        if (last.attemptedProviders && last.attemptedProviders.length > 0) {
          lines.push(`Attempts: ${last.attemptedProviders.join(" -> ")}`);
        }
        const details = formatAttemptDetails(last.attempts);
        if (details) {
          lines.push(`Attempt details: ${details}`);
        }
      }
    }
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  return { shouldContinue: false, reply: ttsUsage() };
};
