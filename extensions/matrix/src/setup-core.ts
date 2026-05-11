import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_ACCOUNT_ID,
  type DmPolicy,
  normalizeAccountId,
  prepareScopedSetupConfig,
  type ChannelSetupAdapter,
  type ChannelSetupWizardAdapter,
} from "openclaw/plugin-sdk/setup";
import { resolveDefaultMatrixAccountId, resolveMatrixAccountConfig } from "./matrix/accounts.js";
import { resolveMatrixConfigFieldPath, updateMatrixAccountConfig } from "./matrix/config-update.js";
import { applyMatrixSetupAccountConfig, validateMatrixSetupInput } from "./setup-config.js";
import { resolveMatrixSetupDmAllowFrom } from "./setup-dm-policy.js";
import type { CoreConfig } from "./types.js";

const channel = "matrix" as const;
type MatrixSetupWizardModule = { matrixSetupWizard: ChannelSetupWizardAdapter };

function resolveMatrixSetupAccountId(params: { accountId?: string; name?: string }): string {
  return normalizeAccountId(params.accountId?.trim() || params.name?.trim() || DEFAULT_ACCOUNT_ID);
}

function resolveMatrixSetupWizardAccountId(cfg: CoreConfig, accountId?: string): string {
  return normalizeAccountId(
    accountId?.trim() || resolveDefaultMatrixAccountId(cfg) || DEFAULT_ACCOUNT_ID,
  );
}

function setMatrixDmPolicy(cfg: CoreConfig, policy: DmPolicy, accountId?: string): CoreConfig {
  const resolvedAccountId = resolveMatrixSetupWizardAccountId(cfg, accountId);
  const existing = resolveMatrixAccountConfig({
    cfg,
    accountId: resolvedAccountId,
  });
  const allowFrom = resolveMatrixSetupDmAllowFrom(policy, existing.dm?.allowFrom);
  return updateMatrixAccountConfig(cfg, resolvedAccountId, {
    dm: {
      ...existing.dm,
      policy,
      allowFrom,
    },
  });
}

export function createMatrixSetupWizardProxy(
  loadWizardModule: () => Promise<MatrixSetupWizardModule>,
): ChannelSetupWizardAdapter {
  let wizardPromise: Promise<ChannelSetupWizardAdapter> | null = null;
  const loadWizard = () => {
    wizardPromise ??= loadWizardModule().then((module) => module.matrixSetupWizard);
    return wizardPromise;
  };
  return {
    channel,
    getStatus: async (ctx) => await (await loadWizard()).getStatus(ctx),
    configure: async (ctx) => await (await loadWizard()).configure(ctx),
    configureInteractive: async (ctx) => {
      const wizard = await loadWizard();
      return await (wizard.configureInteractive ?? wizard.configure)(ctx);
    },
    configureWhenConfigured: async (ctx) => {
      const wizard = await loadWizard();
      return await (
        wizard.configureWhenConfigured ??
        wizard.configureInteractive ??
        wizard.configure
      )(ctx);
    },
    afterConfigWritten: async (ctx) => await (await loadWizard()).afterConfigWritten?.(ctx),
    dmPolicy: {
      label: "Matrix",
      channel,
      policyKey: "channels.matrix.dm.policy",
      allowFromKey: "channels.matrix.dm.allowFrom",
      resolveConfigKeys: (cfg, accountId) => {
        const resolvedAccountId = resolveMatrixSetupWizardAccountId(cfg as CoreConfig, accountId);
        return {
          policyKey: resolveMatrixConfigFieldPath(
            cfg as CoreConfig,
            resolvedAccountId,
            "dm.policy",
          ),
          allowFromKey: resolveMatrixConfigFieldPath(
            cfg as CoreConfig,
            resolvedAccountId,
            "dm.allowFrom",
          ),
        };
      },
      getCurrent: (cfg, accountId) =>
        resolveMatrixAccountConfig({
          cfg: cfg as CoreConfig,
          accountId: resolveMatrixSetupWizardAccountId(cfg as CoreConfig, accountId),
        }).dm?.policy ?? "pairing",
      setPolicy: (cfg, policy, accountId) =>
        setMatrixDmPolicy(cfg as CoreConfig, policy, accountId) as OpenClawConfig,
      promptAllowFrom: async (params) => {
        const promptAllowFrom = (await loadWizard()).dmPolicy?.promptAllowFrom;
        return promptAllowFrom ? await promptAllowFrom(params) : params.cfg;
      },
    },
    disable: (cfg) => ({
      ...(cfg as CoreConfig),
      channels: {
        ...(cfg as CoreConfig).channels,
        matrix: { ...(cfg as CoreConfig).channels?.matrix, enabled: false },
      },
    }),
  };
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
