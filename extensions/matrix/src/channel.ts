import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "clawdbot/plugin-sdk";

import { matrixMessageActions } from "./actions.js";
import { MatrixConfigSchema } from "./config-schema.js";
import { resolveMatrixGroupRequireMention } from "./group-mentions.js";
import type { CoreConfig } from "./types.js";
import {
  listMatrixAccountIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
  type ResolvedMatrixAccount,
} from "./matrix/accounts.js";
import { resolveMatrixAuth } from "./matrix/client.js";
import { normalizeAllowListLower } from "./matrix/monitor/allowlist.js";
import { probeMatrix } from "./matrix/probe.js";
import { sendMessageMatrix } from "./matrix/send.js";
import { matrixOnboardingAdapter } from "./onboarding.js";
import { matrixOutbound } from "./outbound.js";
import { resolveMatrixTargets } from "./resolve-targets.js";
import {
  listMatrixDirectoryGroupsLive,
  listMatrixDirectoryPeersLive,
} from "./directory-live.js";

const meta = {
  id: "matrix",
  label: "Matrix",
  selectionLabel: "Matrix (plugin)",
  docsPath: "/channels/matrix",
  docsLabel: "matrix",
  blurb: "open protocol; configure a homeserver + access token.",
  order: 70,
  quickstartAllowFrom: true,
};

function normalizeMatrixMessagingTarget(raw: string): string | undefined {
  let normalized = raw.trim();
  if (!normalized) return undefined;
  if (normalized.toLowerCase().startsWith("matrix:")) {
    normalized = normalized.slice("matrix:".length).trim();
  }
  return normalized ? normalized.toLowerCase() : undefined;
}

function buildMatrixConfigUpdate(
  cfg: CoreConfig,
  input: {
    homeserver?: string;
    userId?: string;
    accessToken?: string;
    password?: string;
    deviceName?: string;
    initialSyncLimit?: number;
  },
): CoreConfig {
  const existing = cfg.channels?.matrix ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...existing,
        enabled: true,
        ...(input.homeserver ? { homeserver: input.homeserver } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.accessToken ? { accessToken: input.accessToken } : {}),
        ...(input.password ? { password: input.password } : {}),
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
        ...(typeof input.initialSyncLimit === "number"
          ? { initialSyncLimit: input.initialSyncLimit }
          : {}),
      },
    },
  };
}

export const matrixPlugin: ChannelPlugin<ResolvedMatrixAccount> = {
  id: "matrix",
  meta,
  onboarding: matrixOnboardingAdapter,
  pairing: {
    idLabel: "matrixUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^matrix:/i, ""),
    notifyApproval: async ({ id }) => {
      await sendMessageMatrix(`user:${id}`, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    polls: true,
    reactions: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["channels.matrix"] },
  configSchema: buildChannelConfigSchema(MatrixConfigSchema),
  config: {
    listAccountIds: (cfg) => listMatrixAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveMatrixAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMatrixAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "matrix",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "matrix",
        accountId,
        clearBaseFields: [
          "name",
          "homeserver",
          "userId",
          "accessToken",
          "password",
          "deviceName",
          "initialSyncLimit",
        ],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.homeserver,
    }),
    resolveAllowFrom: ({ cfg }) =>
      ((cfg as CoreConfig).channels?.matrix?.dm?.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) => normalizeAllowListLower(allowFrom),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dm?.policy ?? "pairing",
      allowFrom: account.config.dm?.allowFrom ?? [],
      policyPath: "channels.matrix.dm.policy",
      allowFromPath: "channels.matrix.dm.allowFrom",
      approveHint: formatPairingApproveHint("matrix"),
      normalizeEntry: (raw) => raw.replace(/^matrix:/i, "").trim().toLowerCase(),
    }),
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = (cfg as CoreConfig).channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        "- Matrix rooms: groupPolicy=\"open\" allows any room to trigger (mention-gated). Set channels.matrix.groupPolicy=\"allowlist\" + channels.matrix.rooms to restrict rooms.",
      ];
    },
  },
  groups: {
    resolveRequireMention: resolveMatrixGroupRequireMention,
  },
  threading: {
    resolveReplyToMode: ({ cfg }) =>
      (cfg as CoreConfig).channels?.matrix?.replyToMode ?? "off",
  },
  messaging: {
    normalizeTarget: normalizeMatrixMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        if (/^(matrix:)?[!#@]/i.test(trimmed)) return true;
        return trimmed.includes(":");
      },
      hint: "<room|alias|user>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveMatrixAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();

      for (const entry of account.config.dm?.allowFrom ?? []) {
        const raw = String(entry).trim();
        if (!raw || raw === "*") continue;
        ids.add(raw.replace(/^matrix:/i, ""));
      }

      for (const room of Object.values(account.config.rooms ?? {})) {
        for (const entry of room.users ?? []) {
          const raw = String(entry).trim();
          if (!raw || raw === "*") continue;
          ids.add(raw.replace(/^matrix:/i, ""));
        }
      }

      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => {
          const lowered = raw.toLowerCase();
          const cleaned = lowered.startsWith("user:") ? raw.slice("user:".length).trim() : raw;
          if (cleaned.startsWith("@")) return `user:${cleaned}`;
          return cleaned;
        })
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => {
          const raw = id.startsWith("user:") ? id.slice("user:".length) : id;
          const incomplete = !raw.startsWith("@") || !raw.includes(":");
          return {
            kind: "user",
            id,
            ...(incomplete ? { name: "incomplete id; expected @user:server" } : {}),
          };
        });
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveMatrixAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() || "";
      const ids = Object.keys(account.config.rooms ?? {})
        .map((raw) => raw.trim())
        .filter((raw) => Boolean(raw) && raw !== "*")
        .map((raw) => raw.replace(/^matrix:/i, ""))
        .map((raw) => {
          const lowered = raw.toLowerCase();
          if (lowered.startsWith("room:") || lowered.startsWith("channel:")) return raw;
          if (raw.startsWith("!")) return `room:${raw}`;
          return raw;
        })
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
      return ids;
    },
    listPeersLive: async ({ cfg, query, limit }) =>
      listMatrixDirectoryPeersLive({ cfg, query, limit }),
    listGroupsLive: async ({ cfg, query, limit }) =>
      listMatrixDirectoryGroupsLive({ cfg, query, limit }),
  },
  resolver: {
    resolveTargets: async ({ cfg, inputs, kind, runtime }) =>
      resolveMatrixTargets({ cfg, inputs, kind, runtime }),
  },
  actions: matrixMessageActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "matrix",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (input.useEnv) return null;
      if (!input.homeserver?.trim()) return "Matrix requires --homeserver";
      if (!input.userId?.trim()) return "Matrix requires --user-id";
      if (!input.accessToken?.trim() && !input.password?.trim()) {
        return "Matrix requires --access-token or --password";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "matrix",
        accountId: DEFAULT_ACCOUNT_ID,
        name: input.name,
      });
      if (input.useEnv) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            matrix: {
              ...namedConfig.channels?.matrix,
              enabled: true,
            },
          },
        } as CoreConfig;
      }
      return buildMatrixConfigUpdate(namedConfig as CoreConfig, {
        homeserver: input.homeserver?.trim(),
        userId: input.userId?.trim(),
        accessToken: input.accessToken?.trim(),
        password: input.password?.trim(),
        deviceName: input.deviceName?.trim(),
        initialSyncLimit: input.initialSyncLimit,
      });
    },
  },
  outbound: matrixOutbound,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "matrix",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs, cfg }) => {
      try {
        const auth = await resolveMatrixAuth({ cfg: cfg as CoreConfig });
        return await probeMatrix({
          homeserver: auth.homeserver,
          accessToken: auth.accessToken,
          userId: auth.userId,
          timeoutMs,
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: 0,
        };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.homeserver,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.homeserver,
      });
      ctx.log?.info(
        `[${account.accountId}] starting provider (${account.homeserver ?? "matrix"})`,
      );
      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      const { monitorMatrixProvider } = await import("./matrix/index.js");
      return monitorMatrixProvider({
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
        initialSyncLimit: account.config.initialSyncLimit,
        replyToMode: account.config.replyToMode,
      });
    },
  },
};
