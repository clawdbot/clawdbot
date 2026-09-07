// Nextcloud Talk plugin module implements gateway behavior.
import { clearAccountFieldsFromConfigSection } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveNextcloudTalkAccount, type ResolvedNextcloudTalkAccount } from "./accounts.js";
import type { ChannelPlugin } from "./channel-api.js";
import { monitorNextcloudTalkProvider } from "./monitor-runtime.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

export const nextcloudTalkGatewayAdapter: NonNullable<
  ChannelPlugin<ResolvedNextcloudTalkAccount>["gateway"]
> = {
  startAccount: async (ctx) => {
    const account = ctx.account;
    if (!account.secret || !account.baseUrl) {
      throw new Error(
        `Nextcloud Talk not configured for account "${account.accountId}" (missing secret or baseUrl)`,
      );
    }

    ctx.log?.info(`[${account.accountId}] starting Nextcloud Talk webhook server`);

    const statusSink = createAccountStatusSink({
      accountId: ctx.accountId,
      setStatus: ctx.setStatus,
    });

    await runPassiveAccountLifecycle({
      abortSignal: ctx.abortSignal,
      start: async () =>
        await monitorNextcloudTalkProvider({
          accountId: account.accountId,
          config: ctx.cfg as CoreConfig,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          statusSink,
        }),
      stop: async (monitor) => {
        await monitor.stop();
      },
    });
  },
  logoutAccount: async ({ accountId, cfg }) => {
    const { nextConfig, changed, cleared } = clearAccountFieldsFromConfigSection({
      cfg,
      sectionKey: "nextcloud-talk",
      accountId,
      fields: ["botSecret"],
    });

    const resolved = resolveNextcloudTalkAccount({
      cfg: nextConfig as CoreConfig,
      accountId,
    });
    const loggedOut = resolved.secretSource === "none";

    if (changed) {
      await getNextcloudTalkRuntime().config.replaceConfigFile({
        nextConfig,
        afterWrite: { mode: "auto" },
      });
    }

    return {
      cleared,
      envSecret: Boolean(process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim()),
      loggedOut,
    };
  },
};
