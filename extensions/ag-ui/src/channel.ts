import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";

type ResolvedAguiAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

export const aguiChannelPlugin: ChannelPlugin<ResolvedAguiAccount> = {
  id: "ag-ui",
  meta: {
    id: "ag-ui",
    label: "AG-UI",
    selectionLabel: "AG-UI",
    docsPath: "/channels/ag-ui",
    docsLabel: "ag-ui",
    blurb: "AG-UI protocol endpoint for AG-UI clients.",
    order: 90,
  },
  capabilities: {
    chatTypes: ["direct"],
    blockStreaming: true,
  },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({
      accountId: "default",
      enabled: true,
      configured: true,
    }),
    defaultAccountId: () => "default",
  },
  gateway: {
    // AG-UI is a passive HTTP/SSE endpoint — there is no outbound connection to
    // maintain. This lifecycle hook exists so the gateway ACTIVATES the plugin
    // when the channel is enabled: activation runs the plugin entry's
    // registerFull(), which wires the /v1/ag-ui HTTP routes. A channel with no
    // gateway lifecycle is never started, so its plugin is never activated and
    // its routes never register. We mark the account running and stay up until
    // the gateway aborts on shutdown/reload.
    startAccount: async (ctx) => {
      ctx.setStatus({ accountId: ctx.accountId, running: true });
      ctx.log?.info?.(`[${ctx.accountId}] AG-UI channel active (HTTP endpoint ready)`);
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    },
  },
  pairing: {
    idLabel: "aguiDeviceId",
    normalizeAllowEntry: (entry: string) => entry.replace(/^ag-ui:/i, "").toLowerCase(),
  },
};
