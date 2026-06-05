// Googlechat plugin module implements gateway behavior.
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { isGoogleChatNativeApprovalClientEnabled } from "./approval-native.js";
import type { GoogleChatRuntimeEnv } from "./monitor-types.js";

const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "googleChatChannelRuntime",
);

export async function startGoogleChatGatewayAccount(ctx: {
  account: ResolvedGoogleChatAccount;
  cfg: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  abortSignal: AbortSignal;
  channelRuntime?: ChannelRuntimeSurface;
  setStatus: (next: ChannelAccountSnapshot) => void;
  log?: {
    info?: (message: string) => void;
  };
}): Promise<void> {
  const account = ctx.account;
  const statusSink = createAccountStatusSink({
    accountId: account.accountId,
    setStatus: ctx.setStatus,
  });
  ctx.log?.info?.(`[${account.accountId}] starting Google Chat webhook`);
  const { resolveGoogleChatWebhookPath, startGoogleChatMonitor } =
    await loadGoogleChatChannelRuntime();
  statusSink({
    running: true,
    lastStartAt: Date.now(),
    webhookPath: resolveGoogleChatWebhookPath({ account }),
    audienceType: account.config.audienceType,
    audience: account.config.audience,
  });
  if (
    isGoogleChatNativeApprovalClientEnabled({
      cfg: ctx.cfg,
      accountId: account.accountId,
    })
  ) {
    registerChannelRuntimeContext({
      channelRuntime: ctx.channelRuntime,
      channelId: "googlechat",
      accountId: account.accountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      context: { account },
      abortSignal: ctx.abortSignal,
    });
  }
  await runPassiveAccountLifecycle({
    abortSignal: ctx.abortSignal,
    start: async () =>
      await startGoogleChatMonitor({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
        webhookUrl: account.config.webhookUrl,
        statusSink,
      }),
    stop: async (unregister) => {
      unregister?.();
    },
    onStop: async () => {
      statusSink({
        running: false,
        lastStopAt: Date.now(),
      });
    },
  });
}
