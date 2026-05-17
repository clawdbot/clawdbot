import type { ConfigUiHint, ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export const CONFIG_TAGS = [
  "security",
  "auth",
  "network",
  "access",
  "privacy",
  "observability",
  "performance",
  "reliability",
  "storage",
  "models",
  "media",
  "automation",
  "channels",
  "tools",
  "advanced",
] as const;

export type ConfigTag = (typeof CONFIG_TAGS)[number];

const TAG_PRIORITY: Record<ConfigTag, number> = {
  security: 0,
  auth: 1,
  access: 2,
  network: 3,
  privacy: 4,
  observability: 5,
  reliability: 6,
  performance: 7,
  storage: 8,
  models: 9,
  media: 10,
  automation: 11,
  channels: 12,
  tools: 13,
  advanced: 14,
};

const TAG_OVERRIDES: Record<string, ConfigTag[]> = {
  "gateway.auth.token": ["security", "auth", "access", "network"],
  "gateway.auth.password": ["security", "auth", "access", "network"],
  "gateway.push.apns.relay.baseUrl": ["network", "advanced"],
  "gateway.controlUi.embedSandbox": ["security", "access", "advanced"],
  "gateway.controlUi.allowExternalEmbedUrls": ["security", "access", "network", "advanced"],
  "gateway.controlUi.chatMessageMaxWidth": ["advanced"],
  "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback": [
    "security",
    "access",
    "network",
    "advanced",
  ],
  "gateway.controlUi.dangerouslyDisableDeviceAuth": ["security", "access", "network", "advanced"],
  "gateway.controlUi.allowInsecureAuth": ["security", "access", "network", "advanced"],
  "gateway.nodes.pairing.autoApproveCidrs": ["security", "access", "network", "advanced"],
  "proxy.tls.caFile": ["security", "network", "storage", "advanced"],
  "tools.exec.applyPatch.workspaceOnly": ["tools", "security", "access", "advanced"],
};

const PREFIX_RULES: Array<{ prefix: string; tags: ConfigTag[] }> = [
  { prefix: "channels.", tags: ["channels", "network"] },
  { prefix: "tools.", tags: ["tools"] },
  { prefix: "gateway.", tags: ["network"] },
  { prefix: "nodehost.", tags: ["network"] },
  { prefix: "discovery.", tags: ["network"] },
  { prefix: "auth.", tags: ["auth", "access"] },
  { prefix: "memory.", tags: ["storage"] },
  { prefix: "models.", tags: ["models"] },
  { prefix: "diagnostics.", tags: ["observability"] },
  { prefix: "logging.", tags: ["observability"] },
  { prefix: "cron.", tags: ["automation"] },
  { prefix: "talk.", tags: ["media"] },
  { prefix: "audio.", tags: ["media"] },
];

const KEYWORD_RULES: Array<{ pattern: RegExp; tags: ConfigTag[] }> = [
  { pattern: /(token|password|secret|api[_.-]?key|tlsfingerprint)/i, tags: ["security", "auth"] },
  { pattern: /(allow|deny|owner|permission|policy|access)/i, tags: ["access"] },
  { pattern: /(timeout|debounce|interval|concurrency|max|limit|cachettl)/i, tags: ["performance"] },
  { pattern: /(retry|backoff|fallback|circuit|health|reload|probe)/i, tags: ["reliability"] },
  { pattern: /(path|dir|file|store|db|session|cache)/i, tags: ["storage"] },
  { pattern: /(telemetry|trace|metrics|logs|diagnostic)/i, tags: ["observability"] },
  { pattern: /(experimental|dangerously|insecure)/i, tags: ["advanced", "security"] },
  { pattern: /(privacy|redact|sanitize|anonym|pseudonym)/i, tags: ["privacy"] },
];

const MODEL_PATH_PATTERN = /(^|\.)(model|models|modelid|imagemodel)(\.|$)/i;
const MEDIA_PATH_PATTERN = /(tools\.media\.|^audio\.|^talk\.|image|video|stt|tts)/i;
const AUTOMATION_PATH_PATTERN = /(cron|heartbeat|schedule|onstart|watchdebounce)/i;
const AUTH_KEYWORD_PATTERN = /(token|password|secret|api[_.-]?key|credential|oauth)/i;

function normalizeTag(tag: string): ConfigTag | null {
  const normalized = normalizeLowercaseStringOrEmpty(tag) as ConfigTag;
  return CONFIG_TAGS.includes(normalized) ? normalized : null;
}

function normalizeTags(tags: ReadonlyArray<string>): ConfigTag[] {
  const out = new Set<ConfigTag>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized) {
      out.add(normalized);
    }
  }
  return [...out].toSorted((a, b) => TAG_PRIORITY[a] - TAG_PRIORITY[b]);
}

function collectUnknownTags(tags: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeLowercaseStringOrEmpty(tag);
    if (!normalized || normalizeTag(normalized)) {
      continue;
    }
    out.add(normalized);
  }
  return [...out];
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]+");
  return new RegExp(`^${escaped}$`, "i");
}

function resolveOverride(path: string): ConfigTag[] | undefined {
  const direct = TAG_OVERRIDES[path];
  if (direct) {
    return direct;
  }
  for (const [pattern, tags] of Object.entries(TAG_OVERRIDES)) {
    if (!pattern.includes("*")) {
      continue;
    }
    if (patternToRegExp(pattern).test(path)) {
      return tags;
    }
  }
  return undefined;
}

function addTags(set: Set<ConfigTag>, tags: ReadonlyArray<ConfigTag>): void {
  for (const tag of tags) {
    set.add(tag);
  }
}

export function deriveTagsForPath(path: string, hint?: ConfigUiHint): ConfigTag[] {
  const lowerPath = normalizeLowercaseStringOrEmpty(path);
  const override = resolveOverride(path);
  if (override) {
    return normalizeTags(override);
  }

  const tags = new Set<ConfigTag>();
  for (const rule of PREFIX_RULES) {
    if (lowerPath.startsWith(rule.prefix)) {
      addTags(tags, rule.tags);
    }
  }

  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(path)) {
      addTags(tags, rule.tags);
    }
  }

  if (MODEL_PATH_PATTERN.test(path)) {
    tags.add("models");
  }
  if (MEDIA_PATH_PATTERN.test(path)) {
    tags.add("media");
  }
  if (AUTOMATION_PATH_PATTERN.test(path)) {
    tags.add("automation");
  }

  if (hint?.sensitive) {
    tags.add("security");
    if (AUTH_KEYWORD_PATTERN.test(path)) {
      tags.add("auth");
    }
  }
  if (hint?.advanced) {
    tags.add("advanced");
  }

  if (tags.size === 0) {
    tags.add("advanced");
  }

  return normalizeTags([...tags]);
}

export function applyDerivedTags(hints: ConfigUiHints): ConfigUiHints {
  const next: ConfigUiHints = {};
  for (const [path, hint] of Object.entries(hints)) {
    const existingTags = Array.isArray(hint?.tags) ? hint.tags : [];
    const derivedTags = deriveTagsForPath(path, hint);
    const tags = [
      ...normalizeTags([...derivedTags, ...existingTags]),
      ...collectUnknownTags(existingTags),
    ];
    next[path] = { ...hint, tags };
  }
  return next;
}
