// Presentation data for the plugins catalog: bundled cover art and deterministic
// fallback gradients.
import { expectDefined } from "@openclaw/normalization-core";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { takeGraphemes } from "../../lib/graphemes.ts";

/**
 * Cover art bundled at ui/public/plugin-art/<slug>.webp. The gateway CSP is
 * img-src 'self', so catalog artwork must ship with the Control UI bundle;
 * remote icon URLs cannot render here.
 */
const PLUGIN_ART_SLUGS: ReadonlySet<string> = new Set([
  "acpx",
  "active-memory",
  "admin-http-rpc",
  "airtable",
  "alibaba",
  "amazon-bedrock",
  "amazon-bedrock-mantle",
  "anthropic",
  "anthropic-vertex",
  "arcee",
  "azure-speech",
  "bonjour",
  "brave",
  "browser",
  "byteplus",
  "canva",
  "canvas",
  "cerebras",
  "chutes",
  "clawrouter",
  "clickclack",
  "cloudflare-ai-gateway",
  "codex",
  "cohere",
  "comfy",
  "context7",
  "copilot",
  "copilot-proxy",
  "deepgram",
  "deepinfra",
  "deepseek",
  "deepwiki",
  "device-pair",
  "diagnostics-otel",
  "diagnostics-prometheus",
  "diffs",
  "diffs-language-pack",
  "discord",
  "document-extract",
  "duckduckgo",
  "dungeon-master",
  "elevenlabs",
  "email-inbox",
  "exa",
  "fal",
  "featherless",
  "feishu",
  "file-transfer",
  "firecrawl",
  "fireworks",
  "github",
  "github-copilot",
  "gmi",
  "google",
  "google-calendar",
  "google-meet",
  "googlechat",
  "gradium",
  "grafana",
  "groq",
  "home-assistant",
  "hugging-face",
  "huggingface",
  "imessage",
  "inworld",
  "irc",
  "jira",
  "kilocode",
  "kimi",
  "kubernetes",
  "line",
  "linear",
  "litellm",
  "llama-cpp",
  "llm-task",
  "lmstudio",
  "lobster",
  "logbook",
  "longcat",
  "maps",
  "matrix",
  "mattermost",
  "memory-core",
  "memory-lancedb",
  "memory-wiki",
  "meta",
  "microsoft",
  "microsoft-foundry",
  "migrate-claude",
  "migrate-hermes",
  "minimax",
  "mistral",
  "moonshot",
  "morning-brief",
  "msteams",
  "nextcloud-talk",
  "nostr",
  "notes",
  "notion",
  "novita",
  "nvidia",
  "oc-path",
  "ollama",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "openshell",
  "parallel",
  "pdf-tools",
  "perplexity",
  "philips-hue",
  "pixverse",
  "policy",
  "portfolio-pulse",
  "qa-channel",
  "qa-lab",
  "qianfan",
  "qqbot",
  "qwen",
  "raft",
  "reddit",
  "reef",
  "runway",
  "searxng",
  "senseaudio",
  "sentry",
  "sglang",
  "signal",
  "slack",
  "sms",
  "sonos",
  "spotify",
  "stepfun",
  "stripe",
  "synology-chat",
  "synthetic",
  "talk-voice",
  "tavily",
  "telegram",
  "tencent",
  "tlon",
  "todoist",
  "together",
  "tokenjuice",
  "transcription",
  "translation",
  "trip-scout",
  "tts-local-cli",
  "twitch",
  "vault",
  "venice",
  "vercel-ai-gateway",
  "vllm",
  "voice-call",
  "volcengine",
  "voyage",
  "vydra",
  "web-readability",
  "webhooks",
  "whatsapp",
  "workboard",
  "xai",
  "xiaomi",
  "youtube",
  "zai",
  "zalo",
  "zalouser",
]);

// Only the trusted first-party scope may drop package role suffixes. Broader
// unscoping would let third-party catalog ids claim bundled OpenClaw art.
const OPENCLAW_PLUGIN_ART_ID = /^@openclaw\/(.+?)(?:-(?:plugin|provider))?$/u;

export function pluginArtPath(id: string): string | null {
  const scopedSlug = OPENCLAW_PLUGIN_ART_ID.exec(id)?.[1];
  const slug = PLUGIN_ART_SLUGS.has(id) ? id : scopedSlug;
  return slug && PLUGIN_ART_SLUGS.has(slug)
    ? inferControlUiPublicAssetPath(`plugin-art/${slug}.webp`)
    : null;
}

/**
 * Deterministic two-stop gradients for plugins without bundled art so every
 * tile keeps a distinct identity instead of an empty box.
 */
const FALLBACK_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ["#f59e0b", "#ea580c"],
  ["#38bdf8", "#1d4ed8"],
  ["#34d399", "#047857"],
  ["#a855f7", "#6b21a8"],
  ["#f472b6", "#be185d"],
  ["#22d3ee", "#0e7490"],
  ["#fbbf24", "#b45309"],
  ["#818cf8", "#4338ca"],
  ["#4ade80", "#166534"],
  ["#fb7185", "#9f1239"],
];

export function pluginFallbackGradient(id: string): readonly [string, string] {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return expectDefined(
    FALLBACK_GRADIENTS[hash % FALLBACK_GRADIENTS.length],
    "plugin fallback gradient palette entry",
  );
}

export function pluginMonogram(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  const first = expectDefined(words[0], "plugin monogram first word");
  const second = words[1];
  const initials = second
    ? `${takeGraphemes(first, 1)}${takeGraphemes(second, 1)}`
    : takeGraphemes(first, 2);
  return initials.toLocaleUpperCase();
}
