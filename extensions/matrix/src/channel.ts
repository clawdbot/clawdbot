import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";
import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../../../src/channels/plugins/config-helpers.js";
import { formatPairingApproveHint } from "../../../src/channels/plugins/helpers.js";
import { PAIRING_APPROVED_MESSAGE } from "../../../src/channels/plugins/pairing-message.js";
import { applyAccountNameToChannelSection } from "../../../src/channels/plugins/setup-helpers.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";

import { matrixMessageActions } from "./actions.js";
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
    collectWarnings: ({ account }) => {
      const groupPolicy = account.config.groupPolicy ?? "allowlist";
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
