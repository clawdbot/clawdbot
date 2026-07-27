// Irc plugin module implements gateway behavior.
import { runPassiveAccountLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import type { ResolvedIrcAccount } from "./accounts.js";
import { createAccountStatusSink } from "./channel-api.js";
import type { RuntimeEnv } from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

const loadIrcChannelRuntime = createLazyRuntimeModule(() => import("./channel-runtime.js"));

export async function startIrcGatewayAccount(ctx: {
  cfg: CoreConfig;
  accountId: string;
  account: ResolvedIrcAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  setStatus: (next: ChannelAccountSnapshot) => void;
  log?: {
    info?: (message: string) => void;
  };
}): Promise<void> {
  const account = ctx.account;
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });
  if (!account.configured) {
    throw new Error(
      `IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`,
    );
  }
  ctx.log?.info?.(
    `[${account.accountId}] starting IRC provider (${account.host}:${account.port}${account.tls ? " tls" : ""})`,
  );
  const { monitorIrcProvider } = await loadIrcChannelRuntime();
  await runPassiveAccountLifecycle({
    abortSignal: ctx.abortSignal,
    start: async () =>
      await monitorIrcProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink,
      }),
    stop: async (monitor) => {
      await monitor.stop();
    },
  });
}
