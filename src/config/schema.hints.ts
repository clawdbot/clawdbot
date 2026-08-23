// Provides schema hint metadata for config docs and UI labels.
import {
  isSensitiveUrlConfigPath,
  SENSITIVE_URL_HINT_TAG,
} from "@openclaw/net-policy/redact-sensitive-url";
import { z } from "zod";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { applyDerivedTags } from "./schema.tags.js";
import { applyConfigTierHints } from "./schema.tiers.js";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import { sensitive } from "./zod-schema.sensitive.js";

export type { ConfigUiHint, ConfigUiHints } from "../shared/config-ui-hints-types.js";

const GROUP_HINTS = [
  ["wizard", "Wizard", 20],
  ["update", "Update", 25],
  ["cli", "CLI", 26],
  ["diagnostics", "Diagnostics", 27],
  ["logging", "Logging", 900],
  ["gateway", "Gateway", 30],
  ["nodeHost", "Node Host", 35],
  ["cloudWorkers", "Cloud Workers", 37],
  ["desktop", "Desktop", 38],
  ["agents", "Agents", 40],
  ["tools", "Tools", 50],
  ["bindings", "Bindings", 55],
  ["audio", "Audio", 60],
  ["models", "Models", 70],
  ["messages", "Messages", 80],
  ["commands", "Commands", 85],
  ["session", "Session", 90],
  ["cron", "Automations", 100],
  ["worktrees", "Worktrees", 105],
  ["hooks", "Hooks", 110],
  ["ui", "UI", 120],
  ["browser", "Browser", 130],
  ["talk", "Talk", 140],
  ["channels", "Messaging Channels", 150],
  ["skills", "Skills", 200],
  ["plugins", "Plugins", 205],
  ["discovery", "Discovery", 210],
  ["presence", "Presence", 220],
  ["voicewake", "Voice Wake", 230],
] as const;

// docsUrl targets task-oriented or beginner pages; configuration-reference anchors are banned.
const SECTION_DOCS_URLS = {
  accessGroups: "https://docs.openclaw.ai/channels/access-groups",
  messages: "https://docs.openclaw.ai/concepts/messages",
  tts: "https://docs.openclaw.ai/tts",
  commands: "https://docs.openclaw.ai/tools/slash-commands",
  hooks: "https://docs.openclaw.ai/automation/hooks",
  cron: "https://docs.openclaw.ai/automation/cron-jobs",
  bindings: "https://docs.openclaw.ai/concepts/agent-bindings",
  plugins: "https://docs.openclaw.ai/plugins/manage-plugins",
  mcp: "https://docs.openclaw.ai/tools/mcp",
  memory: "https://docs.openclaw.ai/concepts/memory",
  talk: "https://docs.openclaw.ai/nodes/talk",
  gateway: "https://docs.openclaw.ai/gateway/configuration",
  browser: "https://docs.openclaw.ai/tools/browser",
  nodeHost: "https://docs.openclaw.ai/nodes",
  discovery: "https://docs.openclaw.ai/gateway/discovery",
  acp: "https://docs.openclaw.ai/tools/acp-agents",
  agents: "https://docs.openclaw.ai/concepts/agent",
  models: "https://docs.openclaw.ai/concepts/models",
  skills: "https://docs.openclaw.ai/tools/skills",
  tools: "https://docs.openclaw.ai/tools",
  session: "https://docs.openclaw.ai/concepts/session",
  security: "https://docs.openclaw.ai/gateway/security",
  approvals: "https://docs.openclaw.ai/tools/exec-approvals",
  env: "https://docs.openclaw.ai/help/environment",
  auth: "https://docs.openclaw.ai/concepts/oauth",
  update: "https://docs.openclaw.ai/install/updating",
  logging: "https://docs.openclaw.ai/logging",
  diagnostics: "https://docs.openclaw.ai/gateway/diagnostics",
  cli: "https://docs.openclaw.ai/cli",
  secrets: "https://docs.openclaw.ai/gateway/secrets",
  ui: "https://docs.openclaw.ai/web/control-ui",
  wizard: "https://docs.openclaw.ai/start/wizard",
  channels: "https://docs.openclaw.ai/channels",
  broadcast: "https://docs.openclaw.ai/channels/broadcast-groups",
  audio: "https://docs.openclaw.ai/nodes/audio",
  voicewake: "https://docs.openclaw.ai/nodes/voicewake",
  presence: "https://docs.openclaw.ai/concepts/presence",
  cloudWorkers: "https://docs.openclaw.ai/gateway/cloud-workers",
  desktop: "https://docs.openclaw.ai/gateway/configuration",
  worktrees: "https://docs.openclaw.ai/concepts/managed-worktrees",
  proxy: "https://docs.openclaw.ai/security/network-proxy",
  transcripts: "https://docs.openclaw.ai/plugins/meeting-plugins",
  surfaces: "https://docs.openclaw.ai/concepts/messages",
} as const satisfies Record<string, string>;

// Root sections without beginner-worthy pages stay explicit. Adding a root config key
// requires choosing a docsUrl or listing it here.
const SECTIONS_WITHOUT_DOCS = ["$schema", "meta", "attachments"] as const;

const FIELD_PLACEHOLDERS: Record<string, string> = {
  "gateway.publicOrigin": "https://gateway.example.com",
  "gateway.remote.url": "ws://host:18789",
  "gateway.remote.tlsFingerprint": "sha256:ab12cd34…",
  "gateway.remote.sshTarget": "user@host",
  "gateway.remote.sshHostKeyPolicy": "strict",
  "gateway.controlUi.basePath": "/openclaw",
  "gateway.controlUi.environment.label": "edge",
  "gateway.controlUi.root": "dist/control-ui",
  "gateway.controlUi.allowedOrigins": "https://control.example.com",
  "gateway.push.apns.relay.baseUrl": "https://ios-push-relay.openclaw.ai",
  "channels.mattermost.baseUrl": "https://chat.example.com",
  "agents.entries.*.identity.avatar": "avatars/openclaw.png",
};

const CHANNEL_NAMESPACE_PREFIX = "channels.";
const CHANNEL_KERNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

/** Return whether a channel config key names a kernel-owned namespace. */
export function isKernelOwnedChannelConfigKey(key: string): boolean {
  return CHANNEL_KERNEL_CONFIG_KEYS.has(key);
}

function isKernelOwnedChannelHintPath(path: string): boolean {
  if (path === "channels") {
    return true;
  }
  const channelKey = path.startsWith(CHANNEL_NAMESPACE_PREFIX)
    ? path.slice(CHANNEL_NAMESPACE_PREFIX.length).split(".", 1)[0]
    : undefined;
  return channelKey !== undefined && isKernelOwnedChannelConfigKey(channelKey);
}

/** Return whether a channel hint path belongs to a plugin-owned channel namespace. */
function isPluginOwnedChannelHintPath(path: string): boolean {
  if (!path.startsWith(CHANNEL_NAMESPACE_PREFIX)) {
    return false;
  }
  return !isKernelOwnedChannelHintPath(path);
}

/** Build core config UI hints while leaving plugin-owned channel hints to plugin schemas. */
export function buildBaseHints(): ConfigUiHints {
  const hints: ConfigUiHints = {};
  for (const [group, label, order] of GROUP_HINTS) {
    hints[group] = {
      label,
      group: label,
      order,
    };
  }
  for (const [path, docsUrl] of Object.entries(SECTION_DOCS_URLS)) {
    hints[path] = { ...hints[path], docsUrl };
  }
  for (const [metadata, field] of [
    [FIELD_LABELS, "label"],
    [FIELD_HELP, "help"],
    [FIELD_PLACEHOLDERS, "placeholder"],
  ] as const) {
    for (const [path, value] of Object.entries(metadata)) {
      if (!isPluginOwnedChannelHintPath(path)) {
        hints[path] = { ...hints[path], [field]: value };
      }
    }
  }
  return applyDerivedTags(applyConfigTierHints(hints));
}

/** Mark sensitive config paths in a hint map without overwriting explicit sensitivity metadata. */
export function applySensitiveHints(
  hints: ConfigUiHints,
  allowedKeys?: ReadonlySet<string>,
): ConfigUiHints {
  const next = { ...hints };
  const keys = allowedKeys ? [...allowedKeys] : Object.keys(next);
  for (const key of keys) {
    const current = next[key];
    if (current?.sensitive !== undefined) {
      continue;
    }
    if (isSensitiveConfigPath(key)) {
      next[key] = { ...current, sensitive: true };
    }
  }
  return next;
}

/** Add the sensitive-url tag to hint paths that carry URLs with credential risk. */
export function applySensitiveUrlHints(
  hints: ConfigUiHints,
  allowedKeys?: ReadonlySet<string>,
): ConfigUiHints {
  const next = { ...hints };
  const keys = allowedKeys ? [...allowedKeys] : Object.keys(next);
  for (const key of keys) {
    if (!isSensitiveUrlConfigPath(key)) {
      continue;
    }
    const current = next[key];
    const tags = new Set(current?.tags ?? []);
    tags.add(SENSITIVE_URL_HINT_TAG);
    next[key] = {
      ...current,
      tags: [...tags],
    };
  }
  return next;
}

/** Walk a Zod schema and collect concrete/wildcard paths accepted by `matchesPath`. */
export function collectMatchingSchemaPaths(
  schema: z.ZodType,
  path: string,
  matchesPath: (path: string) => boolean,
  paths: Set<string> = new Set(),
): Set<string> {
  let currentSchema = schema;

  while (isUnwrappable(currentSchema)) {
    currentSchema = currentSchema.unwrap();
  }

  if (path && matchesPath(path)) {
    paths.add(path);
  }

  if (currentSchema instanceof z.ZodPipe) {
    collectMatchingSchemaPaths(currentSchema.out as unknown as z.ZodType, path, matchesPath, paths);
  } else if (currentSchema instanceof z.ZodObject) {
    const shape = currentSchema.shape;
    for (const key in shape) {
      const nextPath = path ? `${path}.${key}` : key;
      collectMatchingSchemaPaths(shape[key], nextPath, matchesPath, paths);
    }
    const catchallSchema = currentSchema["_def"].catchall as z.ZodType | undefined;
    if (catchallSchema && !(catchallSchema instanceof z.ZodNever)) {
      const nextPath = path ? `${path}.*` : "*";
      collectMatchingSchemaPaths(catchallSchema, nextPath, matchesPath, paths);
    }
  } else if (currentSchema instanceof z.ZodArray) {
    const nextPath = path ? `${path}[]` : "[]";
    collectMatchingSchemaPaths(currentSchema.element as z.ZodType, nextPath, matchesPath, paths);
  } else if (currentSchema instanceof z.ZodRecord) {
    const nextPath = path ? `${path}.*` : "*";
    collectMatchingSchemaPaths(
      currentSchema["_def"].valueType as z.ZodType,
      nextPath,
      matchesPath,
      paths,
    );
  } else if (
    currentSchema instanceof z.ZodUnion ||
    currentSchema instanceof z.ZodDiscriminatedUnion
  ) {
    for (const option of currentSchema.options) {
      collectMatchingSchemaPaths(option as z.ZodType, path, matchesPath, paths);
    }
  } else if (currentSchema instanceof z.ZodIntersection) {
    collectMatchingSchemaPaths(currentSchema["_def"].left as z.ZodType, path, matchesPath, paths);
    collectMatchingSchemaPaths(currentSchema["_def"].right as z.ZodType, path, matchesPath, paths);
  }

  return paths;
}

// Seems to be the only way tsgo accepts us to check if we have a ZodClass
// with an unwrap() method. And it's overly complex because oxlint and
// tsgo are each forbidding what the other allows.
interface ZodDummy {
  unwrap: () => z.ZodType;
}
function isUnwrappable(object: unknown): object is ZodDummy {
  if (!object || typeof object !== "object") {
    return false;
  }
  return (
    "unwrap" in object &&
    typeof (object as Record<string, unknown>).unwrap === "function" &&
    !(object instanceof z.ZodArray)
  );
}

/**
 * Traverses the Zod schema tree and returns a copy of `hints` with every
 * sensitive path marked.
 */
export function mapSensitivePaths(
  schema: z.ZodType,
  path: string,
  hints: ConfigUiHints,
): ConfigUiHints {
  const next = { ...hints };
  mapSensitivePathsMut(schema, path, next);
  return next;
}

function mapSensitivePathsMut(schema: z.ZodType, path: string, hints: ConfigUiHints): void {
  let currentSchema = schema;
  let isSensitive = sensitive.has(currentSchema);

  while (isUnwrappable(currentSchema)) {
    currentSchema = currentSchema.unwrap();
    isSensitive ||= sensitive.has(currentSchema);
  }

  if (isSensitive) {
    hints[path] = { ...hints[path], sensitive: true };
  }

  if (currentSchema instanceof z.ZodPipe) {
    mapSensitivePathsMut(currentSchema.out as unknown as z.ZodType, path, hints);
  } else if (currentSchema instanceof z.ZodObject) {
    const shape = currentSchema.shape;
    for (const key in shape) {
      const nextPath = path ? `${path}.${key}` : key;
      mapSensitivePathsMut(shape[key], nextPath, hints);
    }
    const catchallSchema = currentSchema["_def"].catchall as z.ZodType | undefined;
    if (catchallSchema && !(catchallSchema instanceof z.ZodNever)) {
      const nextPath = path ? `${path}.*` : "*";
      mapSensitivePathsMut(catchallSchema, nextPath, hints);
    }
  } else if (currentSchema instanceof z.ZodArray) {
    const nextPath = path ? `${path}[]` : "[]";
    mapSensitivePathsMut(currentSchema.element as z.ZodType, nextPath, hints);
  } else if (currentSchema instanceof z.ZodRecord) {
    const nextPath = path ? `${path}.*` : "*";
    mapSensitivePathsMut(currentSchema["_def"].valueType as z.ZodType, nextPath, hints);
  } else if (
    currentSchema instanceof z.ZodUnion ||
    currentSchema instanceof z.ZodDiscriminatedUnion
  ) {
    for (const option of currentSchema.options) {
      mapSensitivePathsMut(option as z.ZodType, path, hints);
    }
  } else if (currentSchema instanceof z.ZodIntersection) {
    mapSensitivePathsMut(currentSchema["_def"].left as z.ZodType, path, hints);
    mapSensitivePathsMut(currentSchema["_def"].right as z.ZodType, path, hints);
  }
}

/** @internal */
export const testApi = {
  collectMatchingSchemaPaths,
  mapSensitivePaths,
  SECTION_DOCS_URLS,
  SECTIONS_WITHOUT_DOCS,
};
