import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createAsyncComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  checkZcaAuthenticated,
  resolveZalouserAccountSync,
  type ResolvedZalouserAccount,
} from "./accounts.js";
import type { ChannelDirectoryEntry, ChannelPlugin } from "./channel-api.js";
import { DEFAULT_ACCOUNT_ID } from "./channel-api.js";
import {
  zalouserAuthAdapter,
  zalouserGroupsAdapter,
  zalouserMessageActions,
  zalouserMessagingAdapter,
  zalouserOutboundAdapter,
  zalouserPairingTextAdapter,
  resolveZalouserQrProfile,
  zalouserResolverAdapter,
  zalouserSecurityAdapter,
  zalouserThreadingAdapter,
} from "./channel.adapters.js";
import { listZalouserDirectoryGroupMembers } from "./directory.js";
import type { ZalouserProbeResult } from "./probe.js";
import { createZalouserSetupWizardProxy, zalouserSetupAdapter } from "./setup-core.js";
import { createZalouserPluginBase } from "./shared.js";
import { collectZalouserStatusIssues } from "./status-issues.js";

const loadZalouserChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));
const zalouserSetupWizardProxy = createZalouserSetupWizardProxy(
  async () => (await import("./setup-surface.js")).zalouserSetupWizard,
);

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

export const zalouserPlugin: ChannelPlugin<ResolvedZalouserAccount, ZalouserProbeResult> =
  createChatChannelPlugin({
    base: {
      ...createZalouserPluginBase({
        setupWizard: zalouserSetupWizardProxy,
        setup: zalouserSetupAdapter,
      }),
      groups: zalouserGroupsAdapter,
      actions: zalouserMessageActions,
      messaging: zalouserMessagingAdapter,
      directory: {
        self: async ({ cfg, accountId }) => {
          const { getZaloUserInfo } = await loadZalouserChannelRuntime();
          const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
          const parsed = await getZaloUserInfo(account.profile);
          if (!parsed?.userId) {
            return null;
          }
          return mapUser({
            id: parsed.userId,
            name: parsed.displayName ?? null,
            avatarUrl: parsed.avatar ?? null,
            raw: parsed,
          });
        },
        listPeers: async ({ cfg, accountId, query, limit }) => {
          const { listZaloFriendsMatching } = await loadZalouserChannelRuntime();
          const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
          const friends = await listZaloFriendsMatching(account.profile, query);
          const rows = friends.map((friend) =>
            mapUser({
              id: friend.userId,
              name: friend.displayName ?? null,
              avatarUrl: friend.avatar ?? null,
              raw: friend,
            }),
          );
          return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
        },
        listGroups: async ({ cfg, accountId, query, limit }) => {
          const { listZaloGroupsMatching } = await loadZalouserChannelRuntime();
          const account = resolveZalouserAccountSync({ cfg: cfg, accountId });
          const groups = await listZaloGroupsMatching(account.profile, query);
          const rows = groups.map((group) =>
            mapGroup({
              id: `group:${group.groupId}`,
              name: group.name ?? null,
              raw: group,
            }),
          );
          return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
        },
        listGroupMembers: async ({ cfg, accountId, groupId, limit }) => {
          const { listZaloGroupMembers } = await loadZalouserChannelRuntime();
          return await listZalouserDirectoryGroupMembers(
            {
              cfg,
              accountId: accountId ?? undefined,
              groupId,
              limit: limit ?? undefined,
            },
            { listZaloGroupMembers },
          );
        },
      },
      resolver: zalouserResolverAdapter,
      auth: zalouserAuthAdapter,
      status: createAsyncComputedAccountStatusAdapter<ResolvedZalouserAccount, ZalouserProbeResult>(
        {
          defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
          collectStatusIssues: collectZalouserStatusIssues,
          buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot),
          probeAccount: async ({ account, timeoutMs }) =>
            (await loadZalouserChannelRuntime()).probeZalouser(account.profile, timeoutMs),
          resolveAccountSnapshot: async ({ account, runtime }) => {
            const configured = await checkZcaAuthenticated(account.profile);
            const configError = "not authenticated";
            return {
              accountId: account.accountId,
              name: account.name,
              enabled: account.enabled,
              configured,
              extra: {
                dmPolicy: account.config.dmPolicy ?? "pairing",
                lastError: configured
                  ? (runtime?.lastError ?? null)
                  : (runtime?.lastError ?? configError),
              },
            };
          },
        },
      ),
      gateway: {
        startAccount: async (ctx) => {
          const { getZaloUserInfo } = await loadZalouserChannelRuntime();
          const account = ctx.account;
          let userLabel = "";
          try {
            const userInfo = await getZaloUserInfo(account.profile);
            if (userInfo?.displayName) {
              userLabel = ` (${userInfo.displayName})`;
            }
            ctx.setStatus({
              accountId: account.accountId,
              profile: userInfo,
            });
          } catch {
            // ignore probe errors
          }
          const statusSink = createAccountStatusSink({
            accountId: ctx.accountId,
            setStatus: ctx.setStatus,
          });
          ctx.log?.info(`[${account.accountId}] starting zalouser provider${userLabel}`);
          const { monitorZalouserProvider } = await import("./monitor.js");
          return monitorZalouserProvider({
            account,
            config: ctx.cfg,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
            statusSink,
          });
        },
        loginWithQrStart: async (params) => {
          const { startZaloQrLogin } = await loadZalouserChannelRuntime();
          const profile = resolveZalouserQrProfile(params.accountId);
          return await startZaloQrLogin({
            profile,
            force: params.force,
            timeoutMs: params.timeoutMs,
          });
        },
        loginWithQrWait: async (params) => {
          const { waitForZaloQrLogin } = await loadZalouserChannelRuntime();
          const profile = resolveZalouserQrProfile(params.accountId);
          return await waitForZaloQrLogin({
            profile,
            timeoutMs: params.timeoutMs,
          });
        },
        logoutAccount: async (ctx) =>
          await (
            await loadZalouserChannelRuntime()
          ).logoutZaloProfile(ctx.account.profile || resolveZalouserQrProfile(ctx.accountId)),
      },
    },
    security: zalouserSecurityAdapter,
    threading: zalouserThreadingAdapter,
    pairing: {
      text: zalouserPairingTextAdapter,
    },
    outbound: zalouserOutboundAdapter,
  });

export type { ResolvedZalouserAccount };
