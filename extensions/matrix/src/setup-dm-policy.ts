// Matrix plugin module implements setup dm policy behavior.
import { createChannelDmPolicy } from "openclaw/plugin-sdk/channel-dm-policy";
import type { DmPolicy } from "openclaw/plugin-sdk/config-contracts";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeAllowFromEntries,
  type ChannelSetupDmPolicy,
} from "openclaw/plugin-sdk/setup";
import { resolveDefaultMatrixAccountId, resolveMatrixAccountConfig } from "./matrix/accounts.js";
import { resolveMatrixConfigFieldPath, updateMatrixAccountConfig } from "./matrix/config-update.js";
import type { CoreConfig, MatrixConfig } from "./types.js";

type MatrixDmAllowFrom = NonNullable<MatrixConfig["dm"]>["allowFrom"];

function resolveMatrixSetupDmAllowFrom(policy: DmPolicy, allowFrom: MatrixDmAllowFrom): string[] {
  if (policy === "open") {
    return addWildcardAllowFrom(allowFrom);
  }
  return normalizeAllowFromEntries(allowFrom ?? []).filter((entry) => entry !== "*");
}

export function createMatrixSetupDmPolicy(
  promptAllowFrom: NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>,
): ChannelSetupDmPolicy {
  return createChannelDmPolicy({
    label: "Matrix",
    channel: "matrix",
    policyPath: "dm.policy",
    allowFromPath: "dm.allowFrom",
    resolveAccount: (cfg, accountId) => {
      const resolvedCfg = cfg as CoreConfig;
      const resolvedAccountId = normalizeAccountId(
        accountId?.trim() || resolveDefaultMatrixAccountId(resolvedCfg) || DEFAULT_ACCOUNT_ID,
      );
      const config = resolveMatrixAccountConfig({
        cfg: resolvedCfg,
        accountId: resolvedAccountId,
      });
      return {
        accountId: resolvedAccountId,
        config: { dmPolicy: config.dm?.policy, allowFrom: config.dm?.allowFrom, dm: config.dm },
      };
    },
    resolveConfigKeys: ({ cfg, account }) => ({
      policyKey: resolveMatrixConfigFieldPath(cfg as CoreConfig, account.accountId, "dm.policy"),
      allowFromKey: resolveMatrixConfigFieldPath(
        cfg as CoreConfig,
        account.accountId,
        "dm.allowFrom",
      ),
    }),
    resolveAllowFrom: ({ policy, account }) =>
      resolveMatrixSetupDmAllowFrom(policy, account.config.allowFrom),
    buildPatch: ({ account, policy, allowFrom }) => ({
      dm: { ...account.config.dm, policy, allowFrom },
    }),
    applyPatch: ({ cfg, account, patch }) =>
      updateMatrixAccountConfig(
        cfg as CoreConfig,
        account.accountId,
        patch as Parameters<typeof updateMatrixAccountConfig>[2],
      ),
    promptAllowFrom,
  });
}
