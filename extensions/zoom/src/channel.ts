import type { ChannelPlugin, MoltbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE } from "clawdbot/plugin-sdk";

import { zoomOnboardingAdapter } from "./onboarding.js";
import { zoomOutbound } from "./outbound.js";
import { probeZoom } from "./probe.js";
import { resolveZoomGroupToolPolicy } from "./policy.js";
import { sendZoomTextMessage } from "./send.js";
import { resolveZoomCredentials } from "./token.js";
import type { ZoomConfig } from "./types.js";

type ResolvedZoomAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const meta = {
  id: "zoom",
  label: "Zoom Team Chat",
  selectionLabel: "Zoom Team Chat (S2S OAuth)",
  docsPath: "/channels/zoom",
  docsLabel: "zoom",
  blurb: "S2S OAuth; enterprise messaging.",
  aliases: [],
  order: 70,
} as const;

export const zoomPlugin: ChannelPlugin<ResolvedZoomAccount> = {
  id: "zoom",
  meta: {
    ...meta,
  },
  onboarding: zoomOnboardingAdapter,
  pairing: {
    idLabel: "zoomUserJid",
    normalizeAllowEntry: (entry) => entry.replace(/^(zoom|user):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      await sendZoomTextMessage({
        cfg,
        to: id,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    threads: false,
    media: false,
  },
  groups: {
    resolveToolPolicy: resolveZoomGroupToolPolicy,
  },
  reload: { configPrefixes: ["channels.zoom"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => {
      const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
      return {
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: zoomCfg?.enabled !== false,
        configured: Boolean(resolveZoomCredentials(zoomCfg)),
      };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => {
      const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          zoom: {
            ...zoomCfg,
            enabled,
          },
        },
      };
    },
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg } as MoltbotConfig;
      const nextChannels = { ...cfg.channels };
      delete (nextChannels as Record<string, unknown>).zoom;
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (_account, cfg) => {
      const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
      return Boolean(resolveZoomCredentials(zoomCfg));
    },
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg }) => {
      const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
      return zoomCfg?.allowFrom ?? [];
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    collectWarnings: ({ cfg }) => {
      const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = zoomCfg?.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- Zoom groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.zoom.groupPolicy="allowlist" + channels.zoom.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg }) => {
      const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          zoom: {
            ...zoomCfg,
            enabled: true,
          },
        },
      };
    },
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      // Remove common prefixes
      if (/^(zoom|user|channel):/i.test(trimmed)) {
        return trimmed.replace(/^(zoom|user|channel):/i, "").trim();
      }
      return trimmed;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        // Zoom JIDs typically contain @xmpp.zoom.us
        if (trimmed.includes("@xmpp.zoom.us")) return true;
        // Or look like user:/channel: prefixed
        if (/^(user|channel):/i.test(trimmed)) return true;
        return false;
      },
      hint: "<userJid|channelJid|user:JID|channel:JID>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, query, limit }) => {
      const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const entry of zoomCfg?.allowFrom ?? []) {
        const trimmed = String(entry).trim();
        if (trimmed && trimmed !== "*") ids.add(trimmed);
      }
      for (const userId of Object.keys(zoomCfg?.dms ?? {})) {
        const trimmed = userId.trim();
        if (trimmed) ids.add(trimmed);
      }
      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => {
          const lowered = raw.toLowerCase();
          if (lowered.startsWith("user:")) return raw;
          return `user:${raw}`;
        })
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
    },
    listGroups: async ({ cfg, query, limit }) => {
      const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const channelId of Object.keys(zoomCfg?.channels ?? {})) {
        const trimmed = channelId.trim();
        if (trimmed && trimmed !== "*") ids.add(trimmed);
      }
      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => raw.replace(/^channel:/i, "").trim())
        .map((id) => `channel:${id}`)
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
    },
  },
  outbound: zoomOutbound,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      port: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      port: snapshot.port ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ cfg }) => {
      const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
      return await probeZoom(zoomCfg);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      port: runtime?.port ?? null,
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorZoomProvider } = await import("./monitor.js");
      const zoomCfg = ctx.cfg.channels?.zoom as ZoomConfig | undefined;
      const port = zoomCfg?.webhook?.port ?? 4000;
      ctx.setStatus({
        accountId: ctx.accountId,
        port,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });
      ctx.log?.info(`starting provider (port ${port})`);
      return monitorZoomProvider({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
