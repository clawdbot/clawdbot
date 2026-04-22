import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SRC_ROOT, "..");

const CORE_SECRET_SURFACE_GUARDS = [
  {
    path: "src/secrets/runtime-config-collectors-channels.ts",
    forbiddenPatterns: [
      /["']irc["']/,
      /["']bluebubbles["']/,
      /["']msteams["']/,
      /["']nextcloud-talk["']/,
    ],
  },
  {
    path: "src/secrets/target-registry-data.ts",
    forbiddenPatterns: [
      /channels\.irc\./,
      /channels\.bluebubbles\./,
      /channels\.msteams\./,
      /channels\.nextcloud-talk\./,
      /plugins\.entries\.(?:brave|google|exa|xai|moonshot|perplexity|firecrawl|tavily|minimax)\.config\.web(?:Search|Fetch)\.apiKey/,
    ],
  },
  {
    path: "src/cli/command-secret-targets.ts",
    forbiddenPatterns: [
      /plugins\.entries\.(?:brave|google|exa|xai|moonshot|perplexity|firecrawl|tavily|minimax)\.config\.web(?:Search|Fetch)\.apiKey/,
    ],
  },
  {
    path: "src/config/markdown-tables.ts",
    forbiddenPatterns: [/["']signal["']/, /["']whatsapp["']/, /["']mattermost["']/],
  },
  {
    path: "src/plugin-sdk/channel-config-helpers.ts",
    forbiddenPatterns: [
      /\bresolveWhatsAppConfigAllowFrom\b/,
      /\bresolveWhatsAppConfigDefaultTo\b/,
      /\bresolveIMessageConfigAllowFrom\b/,
      /\bresolveIMessageConfigDefaultTo\b/,
      /\bformatWhatsAppConfigAllowFromEntries\b/,
    ],
  },
  {
    path: "src/plugin-sdk/command-auth.ts",
    forbiddenPatterns: [/\bpluginId:\s*"telegram"/],
  },
  {
    path: "src/gateway/channel-health-policy.ts",
    forbiddenPatterns: [/\btelegram\b/],
  },
  {
    path: "src/channels/model-overrides.ts",
    forbiddenPatterns: [/\bfeishu\b/],
  },
  {
    path: "src/config/sessions/group.ts",
    forbiddenPatterns: [/\bwhatsapp\b/, /@g\.us/],
  },
  {
    path: "src/channels/conversation-label.ts",
    forbiddenPatterns: [/@g\.us/],
  },
  {
    path: "src/auto-reply/command-auth.ts",
    forbiddenPatterns: [/@g\.us/],
  },
  {
    path: "src/channels/plugins/setup-promotion-helpers.ts",
    forbiddenPatterns: [/\btelegram\b/],
  },
  {
    path: "src/flows/search-setup.ts",
    forbiddenPatterns: [/\bbrave\b/],
  },
  {
    path: "src/web-search/runtime.ts",
    forbiddenPatterns: [/\bbrave\b/],
  },
  {
    path: "src/media-understanding/defaults.ts",
    forbiddenPatterns: [
      /\b(?:openai|anthropic|google|groq|deepgram|mistral|minimax|zai|qwen|moonshot|openrouter)\b/,
      /\b(?:gpt-|claude-|gemini-|whisper-|nova-|voxtral-|MiniMax-|glm-|qwen-|kimi-)\b/,
    ],
  },
] as const;

describe("channel secret contract surface guardrails", () => {
  for (const entry of CORE_SECRET_SURFACE_GUARDS) {
    it(`keeps ${entry.path} free of moved channel-specific secret wiring`, () => {
      const source = readFileSync(resolve(REPO_ROOT, entry.path), "utf8");
      for (const pattern of entry.forbiddenPatterns) {
        expect(source).not.toMatch(pattern);
      }
    });
  }
});
