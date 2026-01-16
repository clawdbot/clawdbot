import type { ChannelPlugin } from "../../../src/channels/plugins/types.plugin.js";
import type {
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
} from "../../../src/channels/plugins/types.core.js";

import { formatPairingApproveHint } from "../../../src/channels/plugins/helpers.js";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
  getZcaUserInfo,
  checkZcaAuthenticated,
  type ResolvedZalouserAccount,
} from "./accounts.js";
import { zalouserOnboardingAdapter } from "./onboarding.js";
import { sendMessageZalouser } from "./send.js";
import { checkZcaInstalled, parseJsonOutput, runZca, runZcaInteractive } from "./zca.js";
import {
  DEFAULT_ACCOUNT_ID,
  type CoreConfig,
  type ZalouserConfig,
  type ZcaFriend,
  type ZcaGroup,
  type ZcaUserInfo,
} from "./types.js";

const meta = {
  id: "zalouser",
  label: "Zalo Personal",
  selectionLabel: "Zalo (Personal Account)",
  docsPath: "/channels/zalouser",
  docsLabel: "zalouser",
  blurb: "Zalo personal account via QR code login.",
  aliases: ["zlu"],
  order: 85,
  quickstartAllowFrom: true,
};

function resolveZalouserQrProfile(accountId?: string | null): string {
  const normalized = String(accountId ?? "").trim();
  if (!normalized || normalized === DEFAULT_ACCOUNT_ID) {
    return process.env.ZCA_PROFILE?.trim() || "default";
  }
  return normalized;
}

function mapUser(params: {
  id: string;
  name?: string | null;
  avatarUrl?: string | null;
  raw?: unknown;
}): ChannelDirectoryEntry {
  return {
    kind: "user",
    id: params.id,
    name: params.name ?? undefined,
    avatarUrl: params.avatarUrl ?? undefined,
    raw: params.raw,
  };
}

function mapGroup(params: {
  id: string;
  name?: string | null;
  raw?: unknown;
}): ChannelDirectoryEntry {
  return {
    kind: "group",
    id: params.id,
    name: params.name ?? undefined,
    raw: params.raw,
  };
}

function deleteAccountFromConfigSection(params: {
  cfg: CoreConfig;
  accountId: string;
}): CoreConfig {
  const { cfg, accountId } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const { zalouser: _removed, ...restChannels } = cfg.channels ?? {};
    return { ...cfg, channels: restChannels };
  }
  const accounts = { ...(cfg.channels?.zalouser?.accounts ?? {}) };
  delete accounts[accountId];
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalouser: {
        ...cfg.channels?.zalouser,
        accounts,
      },
    },
  };
}

function setAccountEnabledInConfigSection(params: {
  cfg: CoreConfig;
  accountId: string;
  enabled: boolean;
}): CoreConfig {
  const { cfg, accountId, enabled } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalouser: {
          ...cfg.channels?.zalouser,
          enabled,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalouser: {
        ...cfg.channels?.zalouser,
        accounts: {
          ...(cfg.channels?.zalouser?.accounts ?? {}),
          [accountId]: {
            ...(cfg.channels?.zalouser?.accounts?.[accountId] ?? {}),
            enabled,
          },
        },
      },
    },
  };
}

export const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount> = {
  id: "zalouser",
  meta,
  onboarding: zalouserOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.zalouser"] },
  config: {
    listAccountIds: (cfg) => listZalouserAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveZalouserAccountSync({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultZalouserAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        accountId,
        enabled,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        accountId,
      }),
    isConfigured: async (account) => {
      // Check if zca auth status is OK for this profile
      const result = await runZca(["auth", "status"], {
        profile: account.profile,
        timeout: 5000,
      });
      return result.ok;
    },
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: undefined,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZalouserAccountSync({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(zalouser|zlu):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg as CoreConfig).channels?.zalouser?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.zalouser.accounts.${resolvedAccountId}.`
        : "channels.zalouser.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("zalouser"),
        normalizeEntry: (raw) => raw.replace(/^(zalouser|zlu):/i, ""),
      };
    },
  },
  groups: {
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw?.trim();
      if (!trimmed) return undefined;
      return trimmed.replace(/^(zalouser|zlu):/i, "");
    },
  },
  directory: {
    self: async ({ cfg, accountId, runtime }) => {
      const ok = await checkZcaInstalled();
      if (!ok) throw new Error("Missing dependency: `zca` not found in PATH");
      const account = resolveZalouserAccountSync({ cfg: cfg as CoreConfig, accountId });
      const result = await runZca(["me", "info", "-j"], { profile: account.profile, timeout: 10000 });
      if (!result.ok) {
        runtime.error(result.stderr || "Failed to fetch profile");
        return null;
      }
      const parsed = parseJsonOutput<ZcaUserInfo>(result.stdout);
      if (!parsed?.userId) return null;
      return mapUser({
        id: String(parsed.userId),
        name: parsed.displayName ?? null,
        avatarUrl: parsed.avatar ?? null,
        raw: parsed,
      });
    },
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const ok = await checkZcaInstalled();
      if (!ok) throw new Error("Missing dependency: `zca` not found in PATH");
      const account = resolveZalouserAccountSync({ cfg: cfg as CoreConfig, accountId });
      const args = query?.trim()
        ? ["friend", "find", query.trim()]
        : ["friend", "list", "-j"];
      const result = await runZca(args, { profile: account.profile, timeout: 15000 });
      if (!result.ok) {
        throw new Error(result.stderr || "Failed to list peers");
      }
      const parsed = parseJsonOutput<ZcaFriend[]>(result.stdout);
      const rows = Array.isArray(parsed)
        ? parsed.map((f) =>
            mapUser({
              id: String(f.userId),
              name: f.displayName ?? null,
              avatarUrl: f.avatar ?? null,
              raw: f,
            }),
          )
        : [];
      return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const ok = await checkZcaInstalled();
      if (!ok) throw new Error("Missing dependency: `zca` not found in PATH");
      const account = resolveZalouserAccountSync({ cfg: cfg as CoreConfig, accountId });
      const result = await runZca(["group", "list", "-j"], { profile: account.profile, timeout: 15000 });
      if (!result.ok) {
        throw new Error(result.stderr || "Failed to list groups");
      }
      const parsed = parseJsonOutput<ZcaGroup[]>(result.stdout);
      let rows = Array.isArray(parsed)
        ? parsed.map((g) =>
            mapGroup({
              id: String(g.groupId),
              name: g.name ?? null,
              raw: g,
            }),
          )
        : [];
      const q = query?.trim().toLowerCase();
      if (q) {
        rows = rows.filter((g) => (g.name ?? "").toLowerCase().includes(q) || g.id.includes(q));
      }
      return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
    },
    listGroupMembers: async ({ cfg, accountId, groupId, limit }) => {
      const ok = await checkZcaInstalled();
      if (!ok) throw new Error("Missing dependency: `zca` not found in PATH");
      const account = resolveZalouserAccountSync({ cfg: cfg as CoreConfig, accountId });
      const result = await runZca(["group", "members", groupId, "-j"], {
        profile: account.profile,
        timeout: 20000,
      });
      if (!result.ok) {
        throw new Error(result.stderr || "Failed to list group members");
      }
      const parsed = parseJsonOutput<Array<Partial<ZcaFriend> & { userId?: string | number }>>(result.stdout);
      const rows = Array.isArray(parsed)
        ? parsed
            .map((m) => {
              const id = m.userId ?? (m as { id?: string | number }).id;
              if (!id) return null;
              return mapUser({
                id: String(id),
                name: (m as { displayName?: string }).displayName ?? null,
                avatarUrl: (m as { avatar?: string }).avatar ?? null,
                raw: m,
              });
            })
            .filter(Boolean)
        : [];
      const sliced = typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
      return sliced as ChannelDirectoryEntry[];
    },
  },
  pairing: {
    idLabel: "zalouserUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(zalouser|zlu):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg as CoreConfig });
      const authenticated = await checkZcaAuthenticated(account.profile);
      if (!authenticated) throw new Error("Zalouser not authenticated");
      await sendMessageZalouser(id, "Your pairing request has been approved.", {
        profile: account.profile,
      });
    },
  },
  auth: {
    login: async ({ cfg, accountId, runtime }) => {
      const account = resolveZalouserAccountSync({
        cfg: cfg as CoreConfig,
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
      });
      const ok = await checkZcaInstalled();
      if (!ok) {
        throw new Error(
          "Missing dependency: `zca` not found in PATH. See docs.clawd.bot/channels/zalouser",
        );
      }
      runtime.log(
        `Scan the QR code in this terminal to link Zalo Personal (account: ${account.accountId}, profile: ${account.profile}).`,
      );
      const result = await runZcaInteractive(["auth", "login"], { profile: account.profile });
      if (!result.ok) {
        throw new Error(result.stderr || "Zalouser login failed");
      }
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => {
      if (!text) return [];
      if (limit <= 0 || text.length <= limit) return [text];
      const chunks: string[] = [];
      let remaining = text;
      while (remaining.length > limit) {
        const window = remaining.slice(0, limit);
        const lastNewline = window.lastIndexOf("\n");
        const lastSpace = window.lastIndexOf(" ");
        let breakIdx = lastNewline > 0 ? lastNewline : lastSpace;
        if (breakIdx <= 0) breakIdx = limit;
        const rawChunk = remaining.slice(0, breakIdx);
        const chunk = rawChunk.trimEnd();
        if (chunk.length > 0) chunks.push(chunk);
        const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
        const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
        remaining = remaining.slice(nextStart).trimStart();
      }
      if (remaining.length) chunks.push(remaining);
      return chunks;
    },
    textChunkLimit: 2000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to Zalouser requires --to <threadId>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg as CoreConfig, accountId });
      const result = await sendMessageZalouser(to, text, { profile: account.profile });
      return {
        channel: "zalouser",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg as CoreConfig, accountId });
      const result = await sendMessageZalouser(to, text, {
        profile: account.profile,
        mediaUrl,
      });
      return {
        channel: "zalouser",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const result = await runZca(["me", "info", "-j"], {
        profile: account.profile,
        timeout: timeoutMs,
      });
      if (!result.ok) {
        return { ok: false, error: result.stderr };
      }
      try {
        return { ok: true, user: JSON.parse(result.stdout) };
      } catch {
        return { ok: false, error: "Failed to parse user info" };
      }
    },
    buildAccountSnapshot: async ({ account, runtime }) => {
      const configured = await checkZcaAuthenticated(account.profile);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: configured ? (runtime?.lastError ?? null) : "not configured",
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
        dmPolicy: account.config.dmPolicy ?? "pairing",
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      let userLabel = "";
      try {
        const userInfo = await getZcaUserInfo(account.profile);
        if (userInfo?.displayName) userLabel = ` (${userInfo.displayName})`;
        ctx.setStatus({
          accountId: account.accountId,
          user: userInfo,
        });
      } catch {
        // ignore probe errors
      }
      ctx.log?.info(`[${account.accountId}] starting zalouser provider${userLabel}`);
      const { monitorZalouserProvider } = await import("./monitor.js");
      return monitorZalouserProvider({
        account,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
    loginWithQrStart: async (params) => {
      const profile = resolveZalouserQrProfile(params.accountId);
      // Start login and get QR code
      const result = await runZca(["auth", "login", "--qr-base64"], {
        profile,
        timeout: params.timeoutMs ?? 30000,
      });
      if (!result.ok) {
        return { message: result.stderr || "Failed to start QR login" };
      }
      // The stdout should contain the base64 QR data URL
      const qrMatch = result.stdout.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/);
      if (qrMatch) {
        return { qrDataUrl: qrMatch[0], message: "Scan QR code with Zalo app" };
      }
      return { message: result.stdout || "QR login started" };
    },
    loginWithQrWait: async (params) => {
      const profile = resolveZalouserQrProfile(params.accountId);
      // Check if already authenticated
      const statusResult = await runZca(["auth", "status"], {
        profile,
        timeout: params.timeoutMs ?? 60000,
      });
      return {
        connected: statusResult.ok,
        message: statusResult.ok ? "Login successful" : statusResult.stderr || "Login pending",
      };
    },
    logoutAccount: async (ctx) => {
      const result = await runZca(["auth", "logout"], {
        profile: ctx.account.profile,
        timeout: 10000,
      });
      return {
        cleared: result.ok,
        loggedOut: result.ok,
        message: result.ok ? "Logged out" : result.stderr,
      };
    },
  },
};

export type { ResolvedZalouserAccount };
