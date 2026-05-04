import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { matrixConfigAdapter } from "./config-adapter.js";
import { MatrixChannelConfigSchema } from "./config-schema.js";
import { resolveMatrixAccount, type ResolvedMatrixAccount } from "./matrix/accounts.js";
import { createMatrixSetupWizardProxy, matrixSetupAdapter } from "./setup-core.js";

const matrixSetupWizard = createMatrixSetupWizardProxy(async () => ({
  matrixSetupWizard: (await import("./setup-surface.js")).matrixSetupWizard,
}));

export const matrixSetupPlugin: ChannelPlugin<ResolvedMatrixAccount> = {
  id: "matrix",
  meta: {
    id: "matrix",
    label: "Matrix",
    selectionLabel: "Matrix (plugin)",
    docsPath: "/channels/matrix",
    docsLabel: "matrix",
    blurb: "open protocol; configure a homeserver + access token.",
    order: 70,
    quickstartAllowFrom: true,
  },
  setupWizard: matrixSetupWizard,
  setup: matrixSetupAdapter,
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    polls: true,
    reactions: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["channels.matrix"] },
  configSchema: MatrixChannelConfigSchema,
  config: {
    ...matrixConfigAdapter,
    isConfigured: (account) => account.configured,
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: account.configured,
        extra: {
          baseUrl: account.homeserver,
        },
      }),
    hasConfiguredState: ({ cfg }) => resolveMatrixAccount({ cfg }).configured,
  },
};
