// Shared model-provider brand icon resolution and rendering for surfaces
// that show provider rows (chat model picker, model providers settings page).
// Icon assets live in ui/public/provider-icons/ProviderIcon-<name>.svg;
// shared styles live under .provider-brand-icon in styles/components.css.
import { html } from "lit";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { takeGraphemes } from "../lib/graphemes.ts";

const PROVIDER_ICON_NAMES = new Set([
  "abacus",
  "alibaba",
  "amp",
  "antigravity",
  "arcee",
  "augment",
  "baseten",
  "bedrock",
  "byteplus",
  "cerebras",
  "chutes",
  "claude",
  "clawrouter",
  "cloudflare",
  "codebuff",
  "codex",
  "cohere",
  "comfy",
  "commandcode",
  "copilot",
  "crof",
  "crossmodel",
  "cursor",
  "deepgram",
  "deepinfra",
  "deepseek",
  "devin",
  "doubao",
  "elevenlabs",
  "factory",
  "fal",
  "featherless",
  "fireworks",
  "gemini",
  "grok",
  "groq",
  "huggingface",
  "jetbrains",
  "kilo",
  "kimi",
  "kiro",
  "litellm",
  "llamacpp",
  "llmproxy",
  "lmstudio",
  "longcat",
  "manus",
  "meta",
  "microsoft",
  "mimo",
  "minimax",
  "mistral",
  "novita",
  "nvidia",
  "ollama",
  "opencode",
  "opencodego",
  "openrouter",
  "perplexity",
  "pi",
  "pixverse",
  "poe",
  "qianfan",
  "qoder",
  "runway",
  "sakana",
  "stepfun",
  "synthetic",
  "t3chat",
  "tencent",
  "together",
  "venice",
  "vercel",
  "vertexai",
  "vllm",
  "volcengine",
  "warp",
  "windsurf",
  "zai",
  "zed",
]);

// Canonical provider id → icon asset name for providers whose brand mark ships
// under a different slug than their catalog id.
const PROVIDER_ICON_ALIASES: Readonly<Record<string, string>> = {
  anthropic: "claude",
  "amazon-bedrock": "bedrock",
  "aws-bedrock": "bedrock",
  "claude-cli": "claude",
  "cloudflare-ai-gateway": "cloudflare",
  "copilot-proxy": "copilot",
  google: "gemini",
  "google-gemini-cli": "gemini",
  "github-copilot": "copilot",
  kilocode: "kilo",
  "kimi-coding": "kimi",
  "llama-cpp": "llamacpp",
  "microsoft-foundry": "microsoft",
  "minimax-portal": "minimax",
  "ollama-cloud": "ollama",
  // CodexBar names its bundled OpenAI knot asset "codex".
  openai: "codex",
  moonshot: "kimi",
  "opencode-go": "opencodego",
  "opencode-zen": "opencode",
  qwen: "alibaba",
  "qwen-token-plan": "alibaba",
  "stepfun-plan": "stepfun",
  "tencent-tokenhub": "tencent",
  "tencent-tokenplan": "tencent",
  xai: "grok",
  // Xiaomi ships its AI models under the MiMo brand mark.
  xiaomi: "mimo",
  "xiaomi-token-plan": "mimo",
  "vercel-ai-gateway": "vercel",
  "vertex-ai": "vertexai",
  "z-ai": "zai",
};

// Brand display names for provider ids whose title-cased id reads wrong.
const PROVIDER_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  "claude-cli": "Claude CLI",
  codex: "OpenAI Codex",
  "codex-app-server": "OpenAI Codex",
  google: "Google",
  "google-gemini-cli": "Gemini CLI",
  "github-copilot": "GitHub",
  "llama-cpp": "llama.cpp",
  lmstudio: "LM Studio",
  longcat: "LongCat",
  openai: "OpenAI",
  moonshot: "Moonshot AI",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  qwen: "Qwen Cloud",
  zai: "Z.AI",
};

/** Title-cased fallback label built from the provider id ("z-ai" → "Z Ai"). */
export function formatRawProviderLabel(provider: string): string {
  return provider
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** Brand display name for a (normalized, lowercase) provider id. */
export function providerDisplayLabel(provider: string): string {
  return PROVIDER_DISPLAY_LABELS[provider] ?? formatRawProviderLabel(provider);
}

/** Provider id from a canonical `provider/model` reference, or null when absent. */
export function providerIdFromModelRef(modelRef: string): string | null {
  const separator = modelRef.indexOf("/");
  const provider = separator > 0 ? modelRef.slice(0, separator).trim().toLowerCase() : "";
  return provider || null;
}

/** Icon asset name for a (normalized, lowercase) provider id, or null when no brand mark ships. */
function resolveProviderIconName(provider: string): string | null {
  const normalized = provider.trim().toLowerCase();
  const icon = PROVIDER_ICON_ALIASES[normalized] ?? normalized;
  return PROVIDER_ICON_NAMES.has(icon) ? icon : null;
}

/** Whether a provider identity has a bundled brand mark. */
export function hasProviderBrandIcon(provider: string): boolean {
  return resolveProviderIconName(provider) !== null;
}

function providerIconAssetPath(icon: string): string {
  return inferControlUiPublicAssetPath(`provider-icons/ProviderIcon-${icon}.svg`);
}

/** Lettered badge for surfaces that must not infer a provider identity. */
export function renderProviderFallbackIcon(label: string, options?: { className?: string }) {
  const surfaceClass = options?.className ? ` ${options.className}` : "";
  const letter = takeGraphemes(label.trim().toUpperCase(), 1) || "?";
  return html`
    <span
      class="provider-brand-icon provider-brand-icon--fallback${surfaceClass}"
      aria-hidden="true"
    >
      ${letter}
    </span>
  `;
}

/**
 * Brand icon span for a provider id; falls back to a lettered badge when no
 * brand mark ships. `className` lets surfaces attach their sizing class.
 */
export function renderProviderBrandIcon(provider: string, options?: { className?: string }) {
  const surfaceClass = options?.className ? ` ${options.className}` : "";
  const icon = resolveProviderIconName(provider);
  if (!icon) {
    return renderProviderFallbackIcon(provider, options);
  }
  return html`
    <span
      class="provider-brand-icon${surfaceClass}"
      data-provider-icon=${icon}
      style=${`--provider-icon-url: url("${providerIconAssetPath(icon)}")`}
      aria-hidden="true"
    ></span>
  `;
}
