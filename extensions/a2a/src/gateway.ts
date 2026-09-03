import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { createA2aHttpHandler } from "./http.js";
import { dispatchA2aInbound } from "./inbound.js";
import { getA2aChannelRuntime } from "./runtime.js";
import { A2aTaskStore } from "./task-store.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

const a2aGatewayRoutePaths = [
  "/.well-known/agent-card.json",
  "/.well-known/agent.json",
  "/a2a/v1",
] as const;

export async function startA2aGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedA2aChannelAccount>,
): Promise<void> {
  const { account } = ctx;
  if (!account.configured) {
    throw new Error(`A2A channel is not configured for account "${account.accountId}"`);
  }

  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    lifecycle: "starting",
    configured: true,
    enabled: account.enabled,
  });

  const runtime = getA2aChannelRuntime();
  // SAFETY: Gateway injects its full runtime despite the narrowed public contract.
  const channelRuntime = (ctx.channelRuntime ?? runtime.channel) as PluginRuntime["channel"];
  const store = new A2aTaskStore();
  const unregisterRoutes: Array<() => void> = [];
  try {
    const handler = createA2aHttpHandler({
      config: ctx.cfg,
      a2aConfig: account.config,
      version: runtime.version,
      taskStore: store,
      dispatchInbound: async (message) => {
        await dispatchA2aInbound({
          ...message,
          account,
          config: ctx.cfg,
          channelRuntime,
          buildContext: channelRuntime.inbound.buildContext,
          store,
        });
      },
    });

    for (const routePath of a2aGatewayRoutePaths) {
      unregisterRoutes.push(
        // A2A owns fixed global paths on a single account, so a duplicate
        // registration means a stale or conflicting owner. Fail loudly instead
        // of replacing a live handler (GHSA-RQP8-Q22P-5J9Q).
        registerPluginHttpRoute({
          path: routePath,
          auth: "plugin",
          match: "exact",
          pluginId: "a2a",
          source: "a2a-gateway",
          accountId: account.accountId,
          throwOnFailure: true,
          handler,
        }),
      );
    }

    ctx.setStatus(channelReadyPatch({ accountId: account.accountId }));
    await waitUntilAbort(ctx.abortSignal);
  } finally {
    // Stop admission before releasing blocked responses; otherwise shutdown can
    // admit a task after its lifecycle-owned waiters and timers were cleared.
    for (const unregister of unregisterRoutes.toReversed()) {
      unregister();
    }
    store.stop();
    ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
  }
}
