// Line plugin module implements gateway behavior.
import { clearAccountFieldsFromConfigSection } from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin, PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-outbound";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveLineAccount } from "./accounts.js";
import { getLineRuntime } from "./runtime.js";
import { describeLineWebhookDelivery } from "./status.js";
import type { ResolvedLineAccount } from "./types.js";

const loadLineProbeRuntime = createLazyRuntimeModule(() => import("./probe.runtime.js"));
const loadLineMonitorRuntime = createLazyRuntimeModule(() => import("./monitor.runtime.js"));

export const lineGatewayAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["gateway"]> = {
  startAccount: async (ctx) => {
    const account = ctx.account;
    const statusSink = createAccountStatusSink({
      accountId: account.accountId,
      setStatus: ctx.setStatus,
    });
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
    statusSink({ lifecycle: "starting" });

    let lineBotLabel = "";
    try {
      const probe = await (await loadLineProbeRuntime()).probeLineBot(token, 2500);
      const displayName = probe.ok ? probe.bot?.displayName?.trim() : null;
      if (displayName) {
        lineBotLabel = ` (${displayName})`;
      }
      // Startup is where an operator is actually watching, and reaching the same
      // report through status costs them a flag they have no reason to try when
      // nothing looks wrong. The probe already has the answer here.
      const delivery = describeLineWebhookDelivery({
        webhook: probe.ok ? probe.webhook : undefined,
      });
      if (delivery) {
        ctx.log?.warn(`[${account.accountId}] ${delivery.message} Fix: ${delivery.fix}.`);
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
      buildContext: (ctx.channelRuntime as PluginRuntime["channel"] | undefined)?.inbound
        .buildContext,
      abortSignal: ctx.abortSignal,
      webhookPath: account.config.webhookPath,
      statusSink,
    });
  },
  logoutAccount: async ({ accountId, cfg }) => {
    const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim() ?? "";
    const { nextConfig, changed, cleared } = clearAccountFieldsFromConfigSection({
      cfg,
      sectionKey: "line",
      accountId,
      fields: ["channelAccessToken", "channelSecret", "tokenFile", "secretFile"],
      markClearedOnFieldPresence: true,
    });
    if (changed) {
      await getLineRuntime().config.replaceConfigFile({
        nextConfig,
        afterWrite: { mode: "auto" },
      });
    }

    const resolved = resolveLineAccount({
      cfg: nextConfig,
      accountId,
    });
    const loggedOut = resolved.tokenSource === "none";

    return { cleared, envToken: Boolean(envToken), loggedOut };
  },
};
