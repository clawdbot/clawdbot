import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  prepareScopedSetupConfig,
  type ChannelSetupAdapter,
} from "openclaw/plugin-sdk/setup";
import { applyMatrixSetupAccountConfig, validateMatrixSetupInput } from "./setup-config.js";
import type { CoreConfig } from "./types.js";

const channel = "matrix" as const;

function resolveMatrixSetupAccountId(params: { accountId?: string; name?: string }): string {
  return normalizeAccountId(params.accountId?.trim() || params.name?.trim() || DEFAULT_ACCOUNT_ID);
}

export const matrixSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId, input }) =>
    resolveMatrixSetupAccountId({
      accountId,
      name: input?.name,
    }),
  resolveBindingAccountId: ({ accountId, agentId }) =>
    resolveMatrixSetupAccountId({
      accountId,
      name: agentId,
    }),
  applyAccountName: ({ cfg, accountId, name }) =>
    prepareScopedSetupConfig({
      cfg: cfg as CoreConfig,
      channelKey: channel,
      accountId,
      name,
    }) as CoreConfig,
  validateInput: ({ accountId, input }) => validateMatrixSetupInput({ accountId, input }),
  applyAccountConfig: ({ cfg, accountId, input }) =>
    applyMatrixSetupAccountConfig({
      cfg: cfg as CoreConfig,
      accountId,
      input,
    }),
  afterAccountConfigWritten: async ({ previousCfg, cfg, accountId, runtime }) => {
    const { runMatrixSetupBootstrapAfterConfigWrite } = await import("./setup-bootstrap.js");
    await runMatrixSetupBootstrapAfterConfigWrite({
      previousCfg: previousCfg as CoreConfig,
      cfg: cfg as CoreConfig,
      accountId,
      runtime,
    });
  },
};
