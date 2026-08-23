import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";

/**
 * Help text for the channel leaves every channel inherits from the shared
 * account shape. Channels declare their own hints for provider-specific keys;
 * without this table those shared keys render as a bare label in the Control UI.
 */
const SHARED_CHANNEL_FIELD_HELP: Record<string, string> = {
  ackReaction: "Emoji reaction added to an inbound message while the agent works on it.",
  accounts: "Additional named accounts for this channel. Each one takes the same settings.",
  actions: "Which channel actions (messages, reactions, threads, search) the agent may call.",
  agentId: "Pin inbound messages from this channel to one agent.",
  allowBots: "Accept messages authored by other bots. Loop protection still applies.",
  allowFrom:
    'Sender ids allowed to reach the agent. Required by "allowlist"; use ["*"] to allow everyone.',
  botLoopProtection: "Guards against bot-to-bot reply loops once bot messages are accepted.",
  capabilities: "Override the channel capabilities OpenClaw assumes this account supports.",
  commands: "Native command surface for this channel, such as slash commands and command menus.",
  configWrites: "Let this channel write config in response to its own commands and events.",
  contextVisibility:
    'How much quoted context from other senders reaches the agent: "all" keeps it, the allowlist modes gate it by sender.',
  dangerouslyAllowNameMatching:
    "Break-glass compatibility: match allowlist entries by mutable display name instead of stable ids. Keep this off.",
  defaultAccount: "Account used when an outbound request does not name one.",
  defaultTo: "Target used for outbound messages when the caller supplies none.",
  dm: "Settings that apply only to direct messages on this channel.",
  dmHistoryLimit: "History limit for direct messages. Overrides the channel history limit in DMs.",
  dmPolicy:
    'Who may DM the agent: "pairing" approves each new sender, "allowlist" trusts allowFrom, "open" allows anyone, "disabled" turns DMs off.',
  dms: "Per-conversation overrides, keyed by DM id.",
  enabled: "Turn this channel on or off without removing its configuration.",
  execApprovals:
    "Approval prompts for commands that need operator sign-off, delivered in this channel.",
  groupAllowFrom: "Sender ids allowed in group chats. Falls back to allowFrom when unset.",
  groupPolicy:
    'Who may use the agent in groups: "allowlist" trusts groupAllowFrom, "open" allows any group, "disabled" turns group chat off.',
  groups: "Per-group overrides, keyed by group id.",
  healthMonitor: "Per-channel opt-out for the health monitor that restarts stalled channels.",
  heartbeatVisibility: "Which heartbeat results this channel shows.",
  historyLimit: "How many earlier messages to include as context. 0 disables history.",
  markdown: "Markdown rendering overrides for this channel.",
  mediaMaxMb: "Largest inbound attachment to download, in megabytes.",
  mentionPatterns: "Extra patterns that count as mentioning the agent in group chats.",
  model: "Model override for runs started from this channel.",
  name: "Display name for this account in the Control UI and logs.",
  network: "Outbound network settings for this channel, such as timeouts and retries.",
  proxy: "Proxy used for this channel's outbound connections.",
  reactionAllowlist:
    'Sender ids whose reactions reach the agent when reactionNotifications is "allowlist".',
  reactionLevel: "How freely the agent adds its own reactions to messages.",
  reactionNotifications: "Which inbound reactions reach the agent.",
  replyToMode: "When to attach a native reply to the message that triggered the run.",
  replyToModeByChatType: "Per-chat-type override of replyToMode.",
  requireMention: "Only respond in group chats when the agent is mentioned.",
  responsePrefix: "Text prepended to every outbound reply.",
  sendReadReceipts: "Mark inbound messages as read on this channel.",
  streaming: "How replies stream back to this channel while the agent is still working.",
  systemPrompt: "Extra system prompt applied to runs started from this channel.",
  textChunkLimit: "Maximum characters per outbound message before OpenClaw splits it.",
  threadBindings: "How chat threads bind to agent sessions, including idle expiry and spawning.",
  tokenFile: "Read the token from this file instead of storing it inline in config.",
  typingIndicator: "How this channel signals that the agent is working.",
  webhookHost: "Interface the inbound webhook listener binds to.",
  webhookPath: "Path the inbound webhook listener serves.",
  webhookPort: "Port the inbound webhook listener binds to.",
  webhookSecret: "Shared secret used to verify inbound webhook requests.",
  webhookUrl: "Public URL the provider should deliver webhooks to.",
};

// Only the channel root and its per-account mirror share this vocabulary. Deeper
// paths (a Discord guild channel's `enabled`, a Slack DM block) mean something
// narrower, so they keep whatever help their own channel declares.
const SHARED_CHANNEL_FIELD_PATH = /^channels\.[^.]+(?:\.accounts\.[^.]+)?\.([^.]+)$/;

/** Fill missing help on shared channel leaves without overriding channel hints. */
export function applySharedChannelFieldHelp(hints: ConfigUiHints): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
  for (const [path, hint] of Object.entries(hints)) {
    // Any declared help wins, including "" — that is how a channel suppresses
    // shared wording that does not fit its provider.
    if (hint?.help !== undefined) {
      continue;
    }
    const field = SHARED_CHANNEL_FIELD_PATH.exec(path)?.[1];
    const help = field ? SHARED_CHANNEL_FIELD_HELP[field] : undefined;
    if (!help) {
      continue;
    }
    next[path] = { ...hint, help };
  }
  return next;
}
