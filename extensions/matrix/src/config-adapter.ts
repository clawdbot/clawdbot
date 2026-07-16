import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  listMatrixAccountIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
  resolveMatrixAccountConfig,
  type ResolvedMatrixAccount,
} from "./matrix/accounts.js";
import { normalizeMatrixAllowList } from "./matrix/monitor/allowlist.js";

export { DEFAULT_ACCOUNT_ID };

export const matrixConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedMatrixAccount,
  ReturnType<typeof resolveMatrixAccountConfig>
>({
  sectionKey: "matrix",
  listAccountIds: listMatrixAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccount),
  resolveAccessorAccount: ({ cfg, accountId }) => resolveMatrixAccountConfig({ cfg, accountId }),
  defaultAccountId: resolveDefaultMatrixAccountId,
  clearBaseFields: [
    "name",
    "homeserver",
    "network",
    "proxy",
    "userId",
    "accessToken",
    "password",
    "deviceId",
    "deviceName",
    "avatarUrl",
    "initialSyncLimit",
  ],
  resolveAllowFrom: (account) => account.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => normalizeMatrixAllowList(allowFrom),
});
