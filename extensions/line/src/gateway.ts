import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveLineAccount } from "./accounts.js";
import {
  clearAccountEntryFields,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type LineConfig,
  type OpenClawConfig,
  type ResolvedLineAccount,
} from "./channel-api.js";
import { getLineRuntime } from "./runtime.js";

const loadLineProbeRuntime = createLazyRuntimeModule(() => import("./probe.runtime.js"));
const loadLineMonitorRuntime = createLazyRuntimeModule(() => import("./monitor.runtime.js"));

export const lineGatewayAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["gateway"]> = {
  startAccount: async (ctx) => {
    const account = ctx.account;
    const token = account.channelAccessToken.trim();
    const secret = account.channelSecret.trim();
    if (!token) {
      throw new Error(
        `LINE webhook mode requires a non-empty channel access token for account "${account.accountId}".`,
      );
    }
    if (!secret) {
      throw new Error(
        `LINE webhook mode requires a non-empty channel secret for account "${account.accountId}".`,
      );
    }

    let lineBotLabel = "";
    try {
      const probe = await (await loadLineProbeRuntime()).probeLineBot(token, 2500);
      const displayName = probe.ok ? probe.bot?.displayName?.trim() : null;
      if (displayName) {
        lineBotLabel = ` (${displayName})`;
      }
    } catch (err) {
      if (getLineRuntime().logging.shouldLogVerbose()) {
        ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
      }
    }

    ctx.log?.info(`[${account.accountId}] starting LINE provider${lineBotLabel}`);

    const monitorLineProvider =
      getLineRuntime().channel.line?.monitorLineProvider ??
      (await loadLineMonitorRuntime()).monitorLineProvider;

    return await monitorLineProvider({
      channelAccessToken: token,
      channelSecret: secret,
      accountId: account.accountId,
      config: ctx.cfg,
      runtime: ctx.runtime,
      abortSignal: ctx.abortSignal,
      webhookPath: account.config.webhookPath,
    });
  },
  logoutAccount: async ({ accountId, cfg }) => {
    const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim() ?? "";
    const nextCfg = { ...cfg } as OpenClawConfig;
    const lineConfig = (cfg.channels?.line ?? {}) as LineConfig;
    const nextLine = { ...lineConfig };
    let cleared = false;
    let changed = false;

    if (accountId === DEFAULT_ACCOUNT_ID) {
      if (
        nextLine.channelAccessToken ||
        nextLine.channelSecret ||
        nextLine.tokenFile ||
        nextLine.secretFile
      ) {
        delete nextLine.channelAccessToken;
        delete nextLine.channelSecret;
        delete nextLine.tokenFile;
        delete nextLine.secretFile;
        cleared = true;
        changed = true;
      }
    }

    const accountCleanup = clearAccountEntryFields({
      accounts: nextLine.accounts,
      accountId,
      fields: ["channelAccessToken", "channelSecret", "tokenFile", "secretFile"],
      markClearedOnFieldPresence: true,
    });
    if (accountCleanup.changed) {
      changed = true;
      if (accountCleanup.cleared) {
        cleared = true;
      }
      if (accountCleanup.nextAccounts) {
        nextLine.accounts = accountCleanup.nextAccounts;
      } else {
        delete nextLine.accounts;
      }
    }

    if (changed) {
      if (Object.keys(nextLine).length > 0) {
        nextCfg.channels = { ...nextCfg.channels, line: nextLine };
      } else {
        const nextChannels = { ...nextCfg.channels };
        delete (nextChannels as Record<string, unknown>).line;
        if (Object.keys(nextChannels).length > 0) {
          nextCfg.channels = nextChannels;
        } else {
          delete nextCfg.channels;
        }
      }
      await getLineRuntime().config.replaceConfigFile({
        nextConfig: nextCfg,
        afterWrite: { mode: "auto" },
      });
    }

    const resolved = resolveLineAccount({
      cfg: changed ? nextCfg : cfg,
      accountId,
    });
    const loggedOut = resolved.tokenSource === "none";

    return { cleared, envToken: Boolean(envToken), loggedOut };
  },
};
