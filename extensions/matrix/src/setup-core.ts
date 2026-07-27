import { createChannelDmPolicy } from "openclaw/plugin-sdk/channel-dm-policy";
import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Matrix plugin module implements setup core behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  prepareScopedSetupConfig,
  type ChannelSetupAdapter,
  type ChannelSetupWizardAdapter,
} from "openclaw/plugin-sdk/setup";
import { resolveDefaultMatrixAccountId, resolveMatrixAccountConfig } from "./matrix/accounts.js";
import { resolveMatrixConfigFieldPath, updateMatrixAccountConfig } from "./matrix/config-update.js";
import { applyMatrixSetupAccountConfig, validateMatrixSetupInput } from "./setup-config.js";
import {
  namedAccountPromotionKeys,
  resolveSingleAccountPromotionTarget,
  singleAccountKeysToMove,
} from "./setup-contract.js";
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
    dmPolicy: createChannelDmPolicy({
      label: "Matrix",
      channel,
      policyPath: "dm.policy",
      allowFromPath: "dm.allowFrom",
      resolveAccount: (cfg, accountId) => {
        const accountIdResolved = resolveMatrixSetupWizardAccountId(cfg as CoreConfig, accountId);
        const config = resolveMatrixAccountConfig({
          cfg: cfg as CoreConfig,
          accountId: accountIdResolved,
        });
        return {
          accountId: accountIdResolved,
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
        ) as OpenClawConfig,
      promptAllowFrom: async (params) => {
        const promptAllowFrom = (await loadWizard()).dmPolicy?.promptAllowFrom;
        return promptAllowFrom ? await promptAllowFrom(params) : params.cfg;
      },
    }),
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
  singleAccountKeysToMove,
  namedAccountPromotionKeys,
  resolveSingleAccountPromotionTarget,
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

export const matrixSetupContract = defineChannelSetupContract({
  fields: {
    homeserver: {
      kind: "string",
      cli: { flags: "--homeserver <url>", description: "Matrix homeserver URL" },
    },
    userId: { kind: "string", cli: { flags: "--user-id <id>", description: "Matrix user id" } },
    accessToken: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--access-token <token>", description: "Matrix access token" },
    },
    password: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--password <password>", description: "Matrix password" },
    },
    deviceName: {
      kind: "string",
      cli: { flags: "--device-name <name>", description: "Matrix device name" },
    },
    avatarUrl: {
      kind: "string",
      cli: { flags: "--avatar-url <url>", description: "Matrix avatar URL" },
    },
    initialSyncLimit: {
      kind: "integer",
      cli: { flags: "--initial-sync-limit <n>", description: "Matrix initial sync room limit" },
    },
    proxy: { kind: "string", cli: { flags: "--proxy <url>", description: "Matrix proxy URL" } },
    dangerouslyAllowPrivateNetwork: {
      kind: "boolean",
      cli: {
        flags: "--dangerously-allow-private-network",
        description: "Allow private-network Matrix homeservers",
      },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use Matrix environment credentials" },
    },
  },
  legacyAdapter: matrixSetupAdapter,
});
