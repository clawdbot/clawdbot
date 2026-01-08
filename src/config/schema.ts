import { VERSION } from "../version.js";
import { ClawdbotSchema } from "./zod-schema.js";

export type ConfigUiHint = {
  label?: string;
  help?: string;
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  itemTemplate?: unknown;
};

export type ConfigUiHints = Record<string, ConfigUiHint>;

export type ConfigSchema = ReturnType<typeof ClawdbotSchema.toJSONSchema>;

export type ConfigSchemaResponse = {
  schema: ConfigSchema;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

const GROUP_LABELS: Record<string, string> = {
  identity: "Identity",
  wizard: "Wizard",
  logging: "Logging",
  gateway: "Gateway",
  agent: "Agent",
  models: "Models",
  routing: "Routing",
  messages: "Messages",
  commands: "Commands",
  session: "Session",
  cron: "Cron",
  hooks: "Hooks",
  ui: "UI",
  browser: "Browser",
  talk: "Talk",
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  skills: "Skills",
  discovery: "Discovery",
  presence: "Presence",
  voicewake: "Voice Wake",
};

const GROUP_ORDER: Record<string, number> = {
  identity: 10,
  wizard: 20,
  gateway: 30,
  agent: 40,
  models: 50,
  routing: 60,
  messages: 70,
  commands: 75,
  session: 80,
  cron: 90,
  hooks: 100,
  ui: 110,
  browser: 120,
  talk: 130,
  telegram: 140,
  discord: 150,
  slack: 155,
  signal: 160,
  imessage: 170,
  whatsapp: 180,
  skills: 190,
  discovery: 200,
  presence: 210,
  voicewake: 220,
  logging: 900,
};

const FIELD_LABELS: Record<string, string> = {
  "gateway.remote.url": "Remote Gateway URL",
  "gateway.remote.token": "Remote Gateway Token",
  "gateway.remote.password": "Remote Gateway Password",
  "gateway.auth.token": "Gateway Token",
  "gateway.auth.password": "Gateway Password",
  "gateway.controlUi.basePath": "Control UI Base Path",
  "gateway.reload.mode": "Config Reload Mode",
  "gateway.reload.debounceMs": "Config Reload Debounce (ms)",
  "agent.workspace": "Workspace",
  "auth.profiles": "Auth Profiles",
  "auth.order": "Auth Profile Order",
  "agent.models": "Models",
  "agent.model.primary": "Primary Model",
  "agent.model.fallbacks": "Model Fallbacks",
  "agent.imageModel.primary": "Image Model",
  "agent.imageModel.fallbacks": "Image Model Fallbacks",
  "commands.native": "Native Commands",
  "commands.text": "Text Commands",
  "commands.useAccessGroups": "Use Access Groups",
  "ui.seamColor": "Accent Color",
  "browser.controlUrl": "Browser Control URL",
  "session.agentToAgent.maxPingPongTurns": "Agent-to-Agent Ping-Pong Turns",
  "messages.ackReaction": "Ack Reaction Emoji",
  "messages.ackReactionScope": "Ack Reaction Scope",
  "talk.apiKey": "Talk API Key",
  "telegram.botToken": "Telegram Bot Token",
  "telegram.dmPolicy": "Telegram DM Policy",
  "telegram.streamMode": "Telegram Stream Mode",
  "telegram.retry.attempts": "Telegram Retry Attempts",
  "telegram.retry.minDelayMs": "Telegram Retry Min Delay (ms)",
  "telegram.retry.maxDelayMs": "Telegram Retry Max Delay (ms)",
  "telegram.retry.jitter": "Telegram Retry Jitter",
  "whatsapp.dmPolicy": "WhatsApp DM Policy",
  "whatsapp.selfChatMode": "WhatsApp Self-Phone Mode",
  "signal.dmPolicy": "Signal DM Policy",
  "imessage.dmPolicy": "iMessage DM Policy",
  "discord.dm.policy": "Discord DM Policy",
  "discord.retry.attempts": "Discord Retry Attempts",
  "discord.retry.minDelayMs": "Discord Retry Min Delay (ms)",
  "discord.retry.maxDelayMs": "Discord Retry Max Delay (ms)",
  "discord.retry.jitter": "Discord Retry Jitter",
  "discord.maxLinesPerMessage": "Discord Max Lines Per Message",
  "slack.dm.policy": "Slack DM Policy",
  "slack.allowBots": "Slack Allow Bot Messages",
  "discord.token": "Discord Bot Token",
  "slack.botToken": "Slack Bot Token",
  "slack.appToken": "Slack App Token",
  "signal.account": "Signal Account",
  "imessage.cliPath": "iMessage CLI Path",
};

const FIELD_HELP: Record<string, string> = {
  "gateway.remote.url": "Remote Gateway WebSocket URL (ws:// or wss://).",
  "gateway.auth.token":
    "Required for multi-machine access or non-loopback binds.",
  "gateway.auth.password": "Required for Tailscale funnel.",
  "gateway.controlUi.basePath":
    "Optional URL prefix where the Control UI is served (e.g. /clawdbot).",
  "gateway.reload.mode":
    'Hot reload strategy for config changes ("hybrid" recommended).',
  "gateway.reload.debounceMs":
    "Debounce window (ms) before applying config changes.",
  "slack.allowBots":
    "Allow bot-authored messages to trigger Slack replies (default: false).",
  "auth.profiles": "Named auth profiles (provider + mode + optional email).",
  "auth.order":
    "Ordered auth profile IDs per provider (used for automatic failover).",
  "agent.models":
    "Configured model catalog (keys are full provider/model IDs).",
  "agent.model.primary": "Primary model (provider/model).",
  "agent.model.fallbacks":
    "Ordered fallback models (provider/model). Used when the primary model fails.",
  "agent.imageModel.primary":
    "Optional image model (provider/model) used when the primary model lacks image input.",
  "agent.imageModel.fallbacks":
    "Ordered fallback image models (provider/model).",
  "commands.native":
    "Register native commands with connectors that support it (Discord/Slack/Telegram).",
  "commands.text": "Allow text command parsing (slash commands only).",
  "commands.useAccessGroups":
    "Enforce access-group allowlists/policies for commands.",
  "session.agentToAgent.maxPingPongTurns":
    "Max reply-back turns between requester and target (0–5).",
  "messages.ackReaction":
    "Emoji reaction used to acknowledge inbound messages (empty disables).",
  "messages.ackReactionScope":
    'When to send ack reactions ("group-mentions", "group-all", "direct", "all").',
  "telegram.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires telegram.allowFrom=["*"].',
  "telegram.streamMode":
    "Draft streaming mode for Telegram replies (off | partial | block). Requires private topics + sendMessageDraft.",
  "telegram.retry.attempts":
    "Max retry attempts for outbound Telegram API calls (default: 3).",
  "telegram.retry.minDelayMs":
    "Minimum retry delay in ms for Telegram outbound calls.",
  "telegram.retry.maxDelayMs":
    "Maximum retry delay cap in ms for Telegram outbound calls.",
  "telegram.retry.jitter":
    "Jitter factor (0-1) applied to Telegram retry delays.",
  "whatsapp.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires whatsapp.allowFrom=["*"].',
  "whatsapp.selfChatMode":
    "Same-phone setup (bot uses your personal WhatsApp number). Suppresses pairing replies for outbound DMs.",
  "signal.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires signal.allowFrom=["*"].',
  "imessage.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires imessage.allowFrom=["*"].',
  "discord.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires discord.dm.allowFrom=["*"].',
  "discord.retry.attempts":
    "Max retry attempts for outbound Discord API calls (default: 3).",
  "discord.retry.minDelayMs":
    "Minimum retry delay in ms for Discord outbound calls.",
  "discord.retry.maxDelayMs":
    "Maximum retry delay cap in ms for Discord outbound calls.",
  "discord.retry.jitter":
    "Jitter factor (0-1) applied to Discord retry delays.",
  "discord.maxLinesPerMessage":
    "Soft max line count per Discord message (default: 17).",
  "slack.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires slack.dm.allowFrom=["*"].',
};

const FIELD_PLACEHOLDERS: Record<string, string> = {
  "gateway.remote.url": "ws://host:18789",
  "gateway.controlUi.basePath": "/clawdbot",
};

const SENSITIVE_PATTERNS = [/token/i, /password/i, /secret/i, /api.?key/i];

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

function buildBaseHints(): ConfigUiHints {
  const hints: ConfigUiHints = {};
  for (const [group, label] of Object.entries(GROUP_LABELS)) {
    hints[group] = {
      label,
      group: label,
      order: GROUP_ORDER[group],
    };
  }
  for (const [path, label] of Object.entries(FIELD_LABELS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, label } : { label };
  }
  for (const [path, help] of Object.entries(FIELD_HELP)) {
    const current = hints[path];
    hints[path] = current ? { ...current, help } : { help };
  }
  for (const [path, placeholder] of Object.entries(FIELD_PLACEHOLDERS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, placeholder } : { placeholder };
  }
  return hints;
}

function applySensitiveHints(hints: ConfigUiHints): ConfigUiHints {
  const next = { ...hints };
  for (const key of Object.keys(next)) {
    if (isSensitivePath(key)) {
      next[key] = { ...next[key], sensitive: true };
    }
  }
  return next;
}

let cached: ConfigSchemaResponse | null = null;

export function buildConfigSchema(): ConfigSchemaResponse {
  if (cached) return cached;
  const schema = ClawdbotSchema.toJSONSchema({
    target: "draft-07",
    unrepresentable: "any",
  });
  schema.title = "ClawdbotConfig";
  const hints = applySensitiveHints(buildBaseHints());
  const next = {
    schema,
    uiHints: hints,
    version: VERSION,
    generatedAt: new Date().toISOString(),
  };
  cached = next;
  return next;
}
