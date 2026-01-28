import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  looksLikeZoomTargetId,
  normalizeZoomMessagingTarget,
  type ChannelPlugin,
  type ResolvedZoomAccount,
  resolveZoomAccount,
  ZoomConfigSchema,
  monitorZoomProvider,
  zoomOnboardingAdapter,
} from "clawdbot/plugin-sdk";

const meta = getChatChannelMeta("zoom");

export const zoomPlugin: ChannelPlugin<ResolvedZoomAccount> = {
  id: "zoom",
  meta: {
    ...meta,
  },
  onboarding: zoomOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.zoom"] },
  configSchema: buildChannelConfigSchema(ZoomConfigSchema),
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveZoomAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => {
      if (!cfg.channels) cfg.channels = {};
      if (!(cfg.channels as any).zoom) (cfg.channels as any).zoom = {};
      (cfg.channels as any).zoom.enabled = enabled;
      return cfg;
    },
    deleteAccount: ({ cfg }) => {
      if ((cfg.channels as any)?.zoom) delete (cfg.channels as any).zoom;
      return cfg;
    },
    isConfigured: (account) =>
      Boolean(
        account.clientId?.trim() &&
        account.clientSecret?.trim() &&
        account.botJid?.trim() &&
        account.secretToken?.trim()
      ),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: "Zoom Team Chat",
      enabled: account.enabled,
      configured: Boolean(
        account.clientId?.trim() &&
        account.clientSecret?.trim() &&
        account.botJid?.trim() &&
        account.secretToken?.trim()
      ),
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveZoomAccount({ cfg, accountId });
      return (account.config.dm?.allowFrom ?? []).map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dm?.policy ?? "open",
      allowFrom: account.config.dm?.allowFrom ?? [],
      allowFromPath: "channels.zoom.dm.",
      approveHint: "Send a message to the bot to get started",
      normalizeEntry: (raw) => String(raw ?? "").trim(),
    }),
    collectWarnings: () => [],
  },
  messaging: {
    normalizeTarget: (target) => normalizeZoomMessagingTarget(String(target ?? "")),
    targetResolver: {
      looksLikeId: (input) => looksLikeZoomTargetId(input),
      hint: "<userJid>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Zoom provider`);

      // Call monitor directly (imported from SDK)
      return monitorZoomProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        port: 3001,  // Use 3001 to avoid conflict with gateway Control UI on 3000
      });
    },
  },
};
