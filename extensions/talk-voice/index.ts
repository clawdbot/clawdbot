import { resolveActiveTalkProviderConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

function mask(s: string, keep: number = 6): string {
  const trimmed = s.trim();
  if (trimmed.length <= keep) {
    return "***";
  }
  return `${trimmed.slice(0, keep)}…`;
}

function isLikelyVoiceId(value: string): boolean {
  const v = value.trim();
  if (v.length < 10 || v.length > 64) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(v);
}

function resolveProviderLabel(providerId: string): string {
  switch (providerId) {
    case "openai":
      return "OpenAI";
    case "microsoft":
      return "Microsoft";
    case "elevenlabs":
      return "ElevenLabs";
    default:
      return providerId;
  }
}

function formatVoiceMeta(voice: SpeechVoiceOption): string | undefined {
  const parts = [voice.locale, voice.gender];
  const personalities = voice.personalities?.filter((value) => value.trim().length > 0) ?? [];
  if (personalities.length > 0) {
    parts.push(personalities.join(", "));
  }
  const filtered = parts.filter((part): part is string => Boolean(part?.trim()));
  return filtered.length > 0 ? filtered.join(" · ") : undefined;
}

function formatVoiceList(voices: SpeechVoiceOption[], limit: number, providerId: string): string {
  const sliced = voices.slice(0, Math.max(1, Math.min(limit, 50)));
  const lines: string[] = [];
  lines.push(`${resolveProviderLabel(providerId)} voices: ${voices.length}`);
  lines.push("");
  for (const v of sliced) {
    const name = (v.name ?? "").trim() || "(unnamed)";
    const category = (v.category ?? "").trim();
    const meta = category ? ` · ${category}` : "";
    lines.push(`- ${name}${meta}`);
    lines.push(`  id: ${v.id}`);
    const details = formatVoiceMeta(v);
    if (details) {
      lines.push(`  meta: ${details}`);
    }
    const description = (v.description ?? "").trim();
    if (description) {
      lines.push(`  note: ${description}`);
    }
  }
  if (voices.length > sliced.length) {
    lines.push("");
    lines.push(`(showing first ${sliced.length})`);
  }
  return lines.join("\n");
}

function findVoice(voices: SpeechVoiceOption[], query: string): SpeechVoiceOption | null {
  const q = query.trim();
  if (!q) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(q);
  const byId = voices.find((v) => v.id === q);
  if (byId) {
    return byId;
  }
  const exactName = voices.find((v) => normalizeOptionalLowercaseString(v.name) === lower);
  if (exactName) {
    return exactName;
  }
  const partial = voices.find((v) => normalizeLowercaseStringOrEmpty(v.name).includes(lower));
  return partial ?? null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveCommandLabel(channel: string): string {
  return channel === "discord" ? "/talkvoice" : "/voice";
}

function asProviderBaseUrl(value: unknown): string | undefined {
  const trimmed = asTrimmedString(value);
  return trimmed || undefined;
}

const TALK_ADMIN_SCOPE = "operator.admin";

function requiresAdminToSetVoice(
  channel: string,
  gatewayClientScopes?: readonly string[],
): boolean {
  if (Array.isArray(gatewayClientScopes)) {
    return !gatewayClientScopes.includes(TALK_ADMIN_SCOPE);
  }
  return channel === "webchat";
}

export default definePluginEntry({
  id: "talk-voice",
  name: "Talk Voice",
  description: "Command helpers for managing Talk voice configuration",
  register(api: OpenClawPluginApi) {
    api.registerCommand({
      name: "voice",
      nativeNames: {
        discord: "talkvoice",
      },
      description: "List/set Talk provider voices (affects iOS Talk playback).",
      acceptsArgs: true,
      handler: async (ctx) => {
        const commandLabel = resolveCommandLabel(ctx.channel);
        const args = ctx.args?.trim() ?? "";
        const tokens = args.split(/\s+/).filter(Boolean);
        const action = normalizeLowercaseStringOrEmpty(tokens[0] ?? "status");

        const cfg = api.runtime.config.loadConfig();
        const active = resolveActiveTalkProviderConfig(cfg.talk);
        if (!active) {
          return {
            text:
              "Talk voice is not configured.\n\n" +
              "Missing: talk.provider and talk.providers.<provider>.\n" +
              "Set it on the gateway, then retry.",
          };
        }
        const providerId = active.provider;
        const providerLabel = resolveProviderLabel(providerId);
        const apiKey = asTrimmedString(active.config.apiKey);
        const baseUrl = asProviderBaseUrl(active.config.baseUrl);

        const currentVoiceId = asTrimmedString(active.config.voiceId);

        if (action === "status") {
          return {
            text:
              "Talk voice status:\n" +
              `- provider: ${providerId}\n` +
              `- talk.providers.${providerId}.voiceId: ${currentVoiceId ? currentVoiceId : "(unset)"}\n` +
              `- ${providerId}.apiKey: ${apiKey ? mask(apiKey) : "(unset)"}`,
          };
        }

        if (action === "list") {
          const limit = Number.parseInt(tokens[1] ?? "12", 10);
          try {
            const voices = await api.runtime.tts.listVoices({
              provider: providerId,
              cfg,
              apiKey: apiKey || undefined,
              baseUrl,
            });
            return {
              text: formatVoiceList(voices, Number.isFinite(limit) ? limit : 12, providerId),
            };
          } catch (error) {
            const message = formatErrorMessage(error);
            return { text: `${providerLabel} voice list failed: ${message}` };
          }
        }

        if (action === "set") {
          // Gateway callers can override messageChannel, so scope presence is
          // the reliable signal for internal admin-only mutations.
          if (requiresAdminToSetVoice(ctx.channel, ctx.gatewayClientScopes)) {
            return { text: `⚠️ ${commandLabel} set requires operator.admin.` };
          }

          const query = tokens.slice(1).join(" ").trim();
          if (!query) {
            return { text: `Usage: ${commandLabel} set <voiceId|name>` };
          }
          let voices: SpeechVoiceOption[];
          try {
            voices = await api.runtime.tts.listVoices({
              provider: providerId,
              cfg,
              apiKey: apiKey || undefined,
              baseUrl,
            });
          } catch (error) {
            const message = formatErrorMessage(error);
            return { text: `${providerLabel} voice lookup failed: ${message}` };
          }
          const chosen = findVoice(voices, query);
          if (!chosen) {
            const hint = isLikelyVoiceId(query) ? query : `"${query}"`;
            return { text: `No voice found for ${hint}. Try: ${commandLabel} list` };
          }

          const nextConfig = {
            ...cfg,
            talk: {
              ...cfg.talk,
              provider: providerId,
              providers: {
                ...cfg.talk?.providers,
                [providerId]: {
                  ...cfg.talk?.providers?.[providerId],
                  voiceId: chosen.id,
                },
              },
              ...(providerId === "elevenlabs" ? { voiceId: chosen.id } : {}),
            },
          };
          await api.runtime.config.writeConfigFile(nextConfig);

          const name = (chosen.name ?? "").trim() || "(unnamed)";
          return { text: `✅ ${providerLabel} Talk voice set to ${name}\n${chosen.id}` };
        }

        return {
          text: [
            "Voice commands:",
            "",
            `${commandLabel} status`,
            `${commandLabel} list [limit]`,
            `${commandLabel} set <voiceId|name>`,
          ].join("\n"),
        };
      },
    });
  },
});
