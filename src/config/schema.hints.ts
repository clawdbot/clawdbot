// Provides schema hint metadata for config docs and UI labels.
import {
  isSensitiveUrlConfigPath,
  SENSITIVE_URL_HINT_TAG,
} from "@openclaw/net-policy/redact-sensitive-url";
import type { z } from "zod";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { isKernelOwnedChannelConfigKey } from "./channel-config-keys.js";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { applyDerivedTags } from "./schema.tags.js";
import { applyConfigTierHints } from "./schema.tiers.js";
import { walkConfigSchema } from "./schema.walk.js";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import { sensitive } from "./zod-schema.sensitive.js";

export type { ConfigUiHint, ConfigUiHints } from "../shared/config-ui-hints-types.js";

const GROUP_HINTS = [
  ["wizard", "Wizard", 20],
  ["update", "Update", 25],
  ["cli", "CLI", 26],
  ["diagnostics", "Diagnostics", 27],
  ["telemetry", "Telemetry", 28],
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
  ["worktreeRoot", "Worktree Root", 105],
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
  tts: "https://docs.openclaw.ai/tools/tts",
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
  telemetry: "https://docs.openclaw.ai/gateway/telemetry",
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
  worktreeRoot: "https://docs.openclaw.ai/concepts/managed-worktrees",
  proxy: "https://docs.openclaw.ai/security/network-proxy",
  transcripts: "https://docs.openclaw.ai/plugins/meeting-plugins",
  surfaces: "https://docs.openclaw.ai/concepts/messages",
} as const satisfies Record<string, string>;

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
  for (const path of ["agents.defaults.models.*", "agents.entries.*.models.*"]) {
    const runtimePath = `${path}.agentRuntime`;
    const codeModePath = `${path}.codeMode`;
    hints[runtimePath] = { ...hints[runtimePath], order: -2 };
    hints[codeModePath] = { ...hints[codeModePath], order: -1, placeholder: "Default" };
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

/**
 * Traverses the Zod schema tree and returns a copy of `hints` with every
 * sensitive path marked and credential-bearing URL paths tagged.
 */
export function mapSensitivePaths(
  schema: z.ZodType,
  path: string,
  hints: ConfigUiHints,
): ConfigUiHints {
  const next = { ...hints };
  const urlPaths = new Set<string>();
  walkConfigSchema(schema, path, (fieldSchema, fieldPath) => {
    if (sensitive.has(fieldSchema)) {
      next[fieldPath] = { ...next[fieldPath], sensitive: true };
    }
    if (fieldPath && isSensitiveUrlConfigPath(fieldPath)) {
      urlPaths.add(fieldPath);
    }
  });
  return applySensitiveUrlHints(next, urlPaths);
}

/** @internal */
export const testApi = {
  SECTION_DOCS_URLS,
};
