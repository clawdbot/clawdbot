// Channels-page fixtures for the Control UI mock dev harness: a deterministic
// channels.status snapshot plus a scripted setup-wizard step sequence.

export function buildChannelsStatusMock(baseTime: number) {
  const channelMeta = [
    { id: "whatsapp", label: "WhatsApp", detailLabel: "WhatsApp Web" },
    { id: "telegram", label: "Telegram", detailLabel: "Telegram Bot" },
    { id: "discord", label: "Discord", detailLabel: "Discord Bot" },
    { id: "slack", label: "Slack", detailLabel: "Slack App" },
    { id: "signal", label: "Signal", detailLabel: "signal-cli" },
    { id: "imessage", label: "iMessage", detailLabel: "macOS Messages" },
    { id: "googlechat", label: "Google Chat", detailLabel: "Chat API" },
    { id: "nostr", label: "Nostr", detailLabel: "Nostr relays" },
  ];
  const account = (params: {
    accountId?: string;
    configured?: boolean;
    running?: boolean;
    connected?: boolean;
    lastInboundAt?: number;
    lastError?: string;
  }) => ({
    accountId: params.accountId ?? "default",
    enabled: params.configured ?? true,
    configured: params.configured ?? true,
    running: params.running ?? false,
    connected: params.connected ?? null,
    ...(params.lastInboundAt ? { lastInboundAt: params.lastInboundAt } : {}),
    ...(params.lastError ? { lastError: params.lastError } : {}),
  });
  return {
    ts: baseTime,
    channelOrder: channelMeta.map((entry) => entry.id),
    channelLabels: Object.fromEntries(channelMeta.map((entry) => [entry.id, entry.label])),
    channelDetailLabels: Object.fromEntries(
      channelMeta.map((entry) => [entry.id, entry.detailLabel]),
    ),
    channelMeta,
    channels: {
      whatsapp: {
        configured: true,
        linked: true,
        running: true,
        connected: true,
        lastConnectedAt: baseTime - 90_000,
        lastMessageAt: baseTime - 120_000,
        authAgeMs: 6 * 24 * 60 * 60 * 1000,
      },
      telegram: {
        configured: true,
        running: true,
        connected: true,
        lastStartAt: baseTime - 600_000,
      },
      discord: {
        configured: true,
        running: false,
        lastError: "Disallowed intents: enable Message Content in the developer portal.",
      },
    },
    channelAccounts: {
      whatsapp: [account({ running: true, connected: true, lastInboundAt: baseTime - 120_000 })],
      telegram: [account({ running: true, connected: true, lastInboundAt: baseTime - 45_000 })],
      discord: [
        account({
          running: false,
          lastError: "Disallowed intents: enable Message Content in the developer portal.",
        }),
      ],
    },
    channelDefaultAccountId: {
      whatsapp: "default",
      telegram: "default",
      discord: "default",
    },
  };
}

export function buildChannelWizardMocks() {
  const channelSelectStep = {
    id: "mock-wizard-step-channel",
    type: "select",
    message: "Which channel do you want to set up?",
    options: [
      { value: "telegram", label: "Telegram", hint: "bot via @BotFather" },
      { value: "slack", label: "Slack", hint: "socket mode app" },
      { value: "signal", label: "Signal", hint: "signal-cli link" },
      { value: "imessage", label: "iMessage", hint: "macOS Messages" },
      { value: "__skip__", label: "Skip for now" },
    ],
    initialValue: "telegram",
    executor: "client",
  };
  const tokenStep = {
    id: "mock-wizard-step-token",
    type: "text",
    message: "Paste the bot token from @BotFather",
    placeholder: "paste the token here",
    sensitive: true,
    executor: "client",
  };
  return {
    start: {
      sessionId: "mock-wizard-session",
      done: false,
      status: "running",
      step: channelSelectStep,
    },
    next: {
      cases: [
        {
          match: {
            answer: { stepId: "mock-wizard-step-channel", value: "telegram" },
          },
          response: { done: false, status: "running", step: tokenStep },
        },
        { response: { done: true, status: "done", channels: ["telegram"] } },
      ],
    },
  };
}
