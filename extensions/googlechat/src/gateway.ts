// Googlechat plugin module implements gateway behavior.
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { channelBlockedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { isGoogleChatNativeApprovalClientEnabled } from "./approval-native.js";
import type { GoogleChatRuntimeEnv } from "./monitor-types.js";

const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "googleChatChannelRuntime",
);

const UNRESOLVED_WEBHOOK_URL_ERROR =
  "Invalid webhookUrl: expected an absolute URL such as https://chat.example.com/googlechat. No inbound webhook route was registered.";

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
  // An unparseable webhookUrl resolves to no path, and the monitor bails before it
  // creates ingress or registers the HTTP route. Reporting the default path instead
  // would advertise a route nothing binds, and this channel never sets `connected`,
  // so health evaluation would read "healthy" for the lifetime of the process.
  // The status store patch-merges, so the blocked branch clears `webhookPath`
  // explicitly: a restart with broken config must not keep the previous run's path.
  const webhookPath = resolveGoogleChatWebhookPath({ account });
  statusSink({
    running: true,
    lastStartAt: Date.now(),
    ...(webhookPath
      ? { webhookPath, lifecycle: "starting" as const }
      : channelBlockedPatch(UNRESOLVED_WEBHOOK_URL_ERROR, {
          webhookPath: undefined,
        })),
    audienceType: account.config.audienceType,
    audience: account.config.audience,
  });
  let stopped = false;
  const markStopped = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    statusSink({
      running: false,
      lastStopAt: Date.now(),
    });
  };
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
  try {
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
        await unregister?.();
      },
      onStop: async () => {
        markStopped();
      },
    });
  } catch (error) {
    markStopped();
    throw error;
  }
}
