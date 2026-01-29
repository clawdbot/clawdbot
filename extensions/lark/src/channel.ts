import type { ChannelPlugin, ClawdbotConfig } from "clawdbot/plugin-sdk";
import { buildChannelConfigSchema, DEFAULT_ACCOUNT_ID, formatPairingApproveHint } from "clawdbot/plugin-sdk";
import { LarkConfigSchema, type LarkConfig } from "./types.js";
import { larkOutbound } from "./send.js";
import { resolveLarkCredentials, getTenantAccessToken } from "./token.js";
import { getLarkRuntime } from "./runtime.js";

type ResolvedLarkAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  config: LarkConfig;
};

const meta = {
  id: "lark",
  label: "Feishu / Lark",
  selectionLabel: "Feishu / Lark (Open Platform)",
  docsPath: "/channels/lark",
  docsLabel: "lark",
  blurb: "Feishu Open Platform bot integration.",
  aliases: ["feishu"],
  order: 70,
} as const;

function resolveLarkAccount(cfg: ClawdbotConfig, _accountId?: string): ResolvedLarkAccount {
  const larkCfg = cfg.channels?.lark as LarkConfig | undefined;
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: larkCfg?.enabled !== false,
    configured: Boolean(resolveLarkCredentials(larkCfg)),
    config: larkCfg ?? ({} as LarkConfig),
  };
}

function normalizeAllowEntry(entry: string): string {
  return entry.trim().replace(/^lark:/i, "").replace(/^feishu:/i, "");
}

export const larkPlugin: ChannelPlugin<ResolvedLarkAccount> = {
  id: "lark",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    threads: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.lark"] },
  configSchema: buildChannelConfigSchema(LarkConfigSchema),

  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => resolveLarkAccount(cfg as ClawdbotConfig),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        lark: {
          ...cfg.channels?.lark,
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg } as ClawdbotConfig;
      const nextChannels = { ...cfg.channels };
      delete nextChannels.lark;
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (_account, cfg) => Boolean(resolveLarkCredentials((cfg as ClawdbotConfig).channels?.lark as LarkConfig)),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg }) => ((cfg as ClawdbotConfig).channels?.lark as LarkConfig)?.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) => allowFrom.map((s) => normalizeAllowEntry(String(s))),
  },

  security: {
    resolveDmPolicy: ({ cfg, account }) => {
      const larkCfg = (cfg as ClawdbotConfig).channels?.lark as LarkConfig | undefined;
      return {
        policy: larkCfg?.dmPolicy ?? "pairing",
        allowFrom: larkCfg?.allowFrom ?? [],
        policyPath: "channels.lark.dmPolicy",
        allowFromPath: "channels.lark.",
        approveHint: formatPairingApproveHint("lark"),
        normalizeEntry: normalizeAllowEntry,
      };
    },
    collectWarnings: ({ cfg }) => {
      const warnings: string[] = [];
      const larkCfg = (cfg as ClawdbotConfig).channels?.lark as LarkConfig | undefined;
      
      if (larkCfg?.dmPolicy === "open") {
        warnings.push(
          `- Lark DMs are open to anyone. Set channels.lark.dmPolicy="pairing" or "allowlist" for security.`
        );
      }
      
      const groupPolicy = larkCfg?.groupPolicy ?? "allowlist";
      if (groupPolicy === "open") {
        warnings.push(
          `- Lark groups: groupPolicy="open" allows any group to trigger (mention-gated). Set channels.lark.groupPolicy="allowlist" and configure channels.lark.groups.`
        );
      }
      
      return warnings;
    },
  },

  pairing: {
    idLabel: "larkUserId",
    normalizeAllowEntry,
    notifyApproval: async ({ cfg, id }) => {
      const larkCfg = (cfg as ClawdbotConfig).channels?.lark as LarkConfig | undefined;
      const creds = resolveLarkCredentials(larkCfg);
      if (!creds) {
        throw new Error("Lark credentials not configured");
      }
      
      const token = await getTenantAccessToken(creds);
      const url = `${creds.baseUrl.replace(/\/$/, "")}/open-apis/im/v1/messages?receive_id_type=open_id`;
      
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: id,
          msg_type: "text",
          content: JSON.stringify({ text: "Your pairing request has been approved. You can now chat with this bot." }),
        }),
      });
      
      if (!res.ok) {
        throw new Error(`Failed to send approval notification: ${res.status}`);
      }
    },
  },

  groups: {
    resolveRequireMention: ({ cfg, groupId }) => {
      const larkCfg = (cfg as ClawdbotConfig).channels?.lark as LarkConfig | undefined;
      const groupConfig = larkCfg?.groups?.[groupId] ?? larkCfg?.groups?.["*"];
      return groupConfig?.requireMention ?? true;
    },
    resolveToolPolicy: ({ cfg, groupId }) => {
      const larkCfg = (cfg as ClawdbotConfig).channels?.lark as LarkConfig | undefined;
      const groupConfig = larkCfg?.groups?.[groupId] ?? larkCfg?.groups?.["*"];
      return groupConfig?.toolPolicy ?? "full";
    },
  },

  outbound: {
    ...larkOutbound,
    deliveryMode: "direct",
    textChunkLimit: 4000,
    chunker: (text, limit) => getLarkRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((entry) => {
        const issues = [];
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        
        if (enabled && !configured) {
          issues.push({
            channel: "lark",
            accountId: String(entry.accountId ?? DEFAULT_ACCOUNT_ID),
            kind: "config",
            message: "Lark credentials not configured (appId and appSecret required).",
            fix: "Set channels.lark.appId and channels.lark.appSecret.",
          });
        }
        
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => {
      const creds = resolveLarkCredentials(account.config);
      if (!creds) {
        return { ok: false, error: "Not configured" };
      }
      
      try {
        const token = await getTenantAccessToken(creds);
        return { ok: true, token: token.substring(0, 8) + "..." };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dmPolicy ?? "pairing",
      probe,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const { monitorLarkProvider } = await import("./monitor.js");
      const larkCfg = (ctx.cfg as ClawdbotConfig).channels?.lark as LarkConfig | undefined;
      const port = larkCfg?.webhook?.port ?? 3000;
      
      ctx.setStatus({
        accountId: ctx.accountId,
        running: true,
        lastStartAt: Date.now(),
        port,
      });
      ctx.log?.info(`[${ctx.accountId}] starting Lark provider (port ${port})`);
      
      return monitorLarkProvider({
        cfg: ctx.cfg as ClawdbotConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },

  onboarding: {
    detectState: async (cfg) => {
      const larkCfg = (cfg as ClawdbotConfig).channels?.lark as LarkConfig | undefined;
      const creds = resolveLarkCredentials(larkCfg);
      
      if (creds) {
        return { state: "configured", message: "Lark is configured" };
      }
      return { state: "unconfigured", message: "Set appId and appSecret in channels.lark" };
    },
  },
};
