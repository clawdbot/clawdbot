import type {
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelDock,
  ChannelGroupContext,
  ChannelPlugin,
  MoltbotConfig,
  GroupToolPolicyConfig,
} from "clawdbot/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
} from "clawdbot/plugin-sdk";
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
import type { ZcaFriend, ZcaGroup, ZcaUserInfo } from "./types.js";
import { ZalouserConfigSchema } from "./config-schema.js";
import { collectZalouserStatusIssues } from "./status-issues.js";
import { probeZalouser } from "./probe.js";

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
  const normalized = normalizeAccountId(accountId);
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

function resolveZalouserGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const account = resolveZalouserAccountSync({
    cfg: params.cfg as MoltbotConfig,
    accountId: params.accountId ?? undefined,
  });
  const groups = account.config.groups ?? {};
  const groupId = params.groupId?.trim();
  const groupChannel = params.groupChannel?.trim();
  const candidates = [groupId, groupChannel, "*"].filter(
    (value): value is string => Boolean(value),
  );
  for (const key of candidates) {
    const entry = groups[key];
    if (entry?.tools) return entry.tools;
  }
  return undefined;
}

export const zalouserDock: ChannelDock = {
  id: "zalouser",
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 2000 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveZalouserAccountSync({ cfg: cfg as MoltbotConfig, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(zalouser|zlu):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  groups: {
    resolveRequireMention: () => true,
    resolveToolPolicy: resolveZalouserGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
};

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
  configSchema: buildChannelConfigSchema(ZalouserConfigSchema),
  config: {
    listAccountIds: (cfg) => listZalouserAccountIds(cfg as MoltbotConfig),
    resolveAccount: (cfg, accountId) =>
      resolveZalouserAccountSync({ cfg: cfg as MoltbotConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultZalouserAccountId(cfg as MoltbotConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as MoltbotConfig,
        sectionKey: "zalouser",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as MoltbotConfig,
        sectionKey: "zalouser",
        accountId,
        clearBaseFields: ["profile", "name", "dmPolicy", "allowFrom", "groupPolicy", "groups", "messagePrefix"],
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
      (resolveZalouserAccountSync({ cfg: cfg as MoltbotConfig, accountId }).config.allowFrom ?? []).map(
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
        (cfg as MoltbotConfig).channels?.zalouser?.accounts?.[resolvedAccountId],
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
    resolveToolPolicy: resolveZalouserGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as MoltbotConfig,
        channelKey: "zalouser",
        accountId,
        name,
      }),
    validateInput: () => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as MoltbotConfig,
        channelKey: "zalouser",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "zalouser",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            zalouser: {
              ...next.channels?.zalouser,
              enabled: true,
            },
          },
        } as MoltbotConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          zalouser: {
            ...next.channels?.zalouser,
            enabled: true,
            accounts: {
              ...(next.channels?.zalouser?.accounts ?? {}),
              [accountId]: {
                ...(next.channels?.zalouser?.accounts?.[accountId] ?? {}),
                enabled: true,
              },
            },
          },
        },
      } as MoltbotConfig;
    },
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw?.trim();
      if (!trimmed) return undefined;
      return trimmed.replace(/^(zalouser|zlu):/i, "");
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        return /^\d{3,}$/.test(trimmed);
      },
      hint: "<threadId>",
    },
  },
  directory: {
    self: async ({ cfg, accountId, runtime }) => {
      const ok = await checkZcaInstalled();
      if (!ok) throw new Error("Missing dependency: `zca` not found in PATH");
      const account = resolveZalouserAccountSync({ cfg: cfg as MoltbotConfig, accountId });
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
      const account = resolveZalouserAccountSync({ cfg: cfg as MoltbotConfig, accountId });
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
      const account = resolveZalouserAccountSync({ cfg: cfg as MoltbotConfig, accountId });
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
      const account = resolveZalouserAccountSync({ cfg: cfg as MoltbotConfig, accountId });
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
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind, runtime }) => {
      const results = [];
      for (const input of inputs) {
        const trimmed = input.trim();
        if (!trimmed) {
          results.push({ input, resolved: false, note: "empty input" });
          continue;
        }
        if (/^\d+$/.test(trimmed)) {
          results.push({ input, resolved: true, id: trimmed });
          continue;
        }
        try {
          const account = resolveZalouserAccountSync({
            cfg: cfg as MoltbotConfig,
            accountId: accountId ?? DEFAULT_ACCOUNT_ID,
          });
          const args =
            kind === "user"
              ? trimmed
                ? ["friend", "find", trimmed]
                : ["friend", "list", "-j"]
              : ["group", "list", "-j"];
          const result = await runZca(args, { profile: account.profile, timeout: 15000 });
          if (!result.ok) throw new Error(result.stderr || "zca lookup failed");
          if (kind === "user") {
            const parsed = parseJsonOutput<ZcaFriend[]>(result.stdout) ?? [];
            const matches = Array.isArray(parsed)
              ? parsed.map((f) => ({
                  id: String(f.userId),
                  name: f.displayName ?? undefined,
                }))
              : [];
            const best = matches[0];
            results.push({
              input,
              resolved: Boolean(best?.id),
              id: best?.id,
              name: best?.name,
              note: matches.length > 1 ? "multiple matches; chose first" : undefined,
            });
          } else {
            const parsed = parseJsonOutput<ZcaGroup[]>(result.stdout) ?? [];
            const matches = Array.isArray(parsed)
              ? parsed.map((g) => ({
                  id: String(g.groupId),
                  name: g.name ?? undefined,
                }))
              : [];
            const best = matches.find((g) => g.name?.toLowerCase() === trimmed.toLowerCase()) ?? matches[0];
            results.push({
              input,
              resolved: Boolean(best?.id),
              id: best?.id,
              name: best?.name,
              note: matches.length > 1 ? "multiple matches; chose first" : undefined,
            });
          }
        } catch (err) {
          runtime.error?.(`zalouser resolve failed: ${String(err)}`);
          results.push({ input, resolved: false, note: "lookup failed" });
        }
      }
      return results;
    },
  },
  pairing: {
    idLabel: "zalouserUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(zalouser|zlu):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg as MoltbotConfig });
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
        cfg: cfg as MoltbotConfig,
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
      });
      const ok = await checkZcaInstalled();
      if (!ok) {
        throw new Error(
          "Missing dependency: `zca` not found in PATH. See docs.molt.bot/channels/zalouser",
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
    chunkerMode: "text",
    textChunkLimit: 2000,
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg as MoltbotConfig, accountId });
      const result = await sendMessageZalouser(to, text, { profile: account.profile });
      return {
        channel: "zalouser",
        ok: result.ok,
        messageId: result.messageId ?? "",
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const account = resolveZalouserAccountSync({ cfg: cfg as MoltbotConfig, accountId });
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
    collectStatusIssues: collectZalouserStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeZalouser(account.profile, timeoutMs),
    buildAccountSnapshot: async ({ account, runtime }) => {
      const zcaInstalled = await checkZcaInstalled();
      const configured = zcaInstalled ? await checkZcaAuthenticated(account.profile) : false;
      const configError = zcaInstalled ? "not authenticated" : "zca CLI not found in PATH";
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: configured ? (runtime?.lastError ?? null) : runtime?.lastError ?? configError,
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
        config: ctx.cfg as MoltbotConfig,
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
