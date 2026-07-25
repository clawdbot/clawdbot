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
  "augment",
  "bedrock",
  "chutes",
  "claude",
  "clawrouter",
  "codebuff",
  "codex",
  "commandcode",
  "copilot",
  "crof",
  "crossmodel",
  "cursor",
  "deepgram",
  "deepseek",
  "devin",
  "doubao",
  "elevenlabs",
  "factory",
  "gemini",
  "grok",
  "groq",
  "jetbrains",
  "kilo",
  "kimi",
  "kiro",
  "litellm",
  "llmproxy",
  "manus",
  "mimo",
  "minimax",
  "mistral",
  "ollama",
  "opencode",
  "opencodego",
  "openrouter",
  "perplexity",
  "poe",
  "qoder",
  "sakana",
  "stepfun",
  "synthetic",
  "t3chat",
  "venice",
  "vertexai",
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
  google: "gemini",
  "google-gemini-cli": "gemini",
  "github-copilot": "copilot",
  // CodexBar names its bundled OpenAI knot asset "codex".
  openai: "codex",
  "opencode-go": "opencodego",
  "opencode-zen": "opencode",
  xai: "grok",
  "vertex-ai": "vertexai",
  "z-ai": "zai",
};

// Brand display names for provider ids whose title-cased id reads wrong.
const PROVIDER_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  google: "Google",
  "github-copilot": "GitHub",
  openai: "OpenAI",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
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
