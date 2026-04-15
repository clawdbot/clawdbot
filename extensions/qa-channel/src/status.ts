import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "./runtime-api.js";
import type { ResolvedQaChannelAccount } from "./types.js";

export const qaChannelStatus = createComputedAccountStatusAdapter<ResolvedQaChannelAccount>({
  defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
  buildChannelSummary: ({ snapshot }) => ({
    baseUrl: snapshot.baseUrl ?? "[missing]",
  }),
  resolveAccountSnapshot: ({ account }) => ({
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    extra: {
      baseUrl: account.baseUrl || "[missing]",
      botUserId: account.botUserId,
    },
  }),
});
