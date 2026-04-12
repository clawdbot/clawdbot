import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDelegatedSetupWizardStatusResolvers } from "./setup-wizard-binary.js";
import type { ChannelSetupDmPolicy } from "./setup-wizard-types.js";
import type { ChannelSetupWizard } from "./setup-wizard.js";

type PromptAllowFromParams = Parameters<NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>>[0];
type ResolveConfiguredParams = Parameters<ChannelSetupWizard["status"]["resolveConfigured"]>[0];
type ResolveAllowFromEntriesParams = Parameters<
  NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]
>[0];
type ResolveAllowFromEntriesResult = Awaited<
  ReturnType<NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]>
>;
type ResolveGroupAllowlistParams = Parameters<
  NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>
>[0];

export function createDelegatedResolveConfigured(loadWizard: () => Promise<ChannelSetupWizard>) {
  return async ({ cfg, accountId }: ResolveConfiguredParams) =>
    await (await loadWizard()).status.resolveConfigured({ cfg, accountId });
}

export function createDelegatedPrepare(loadWizard: () => Promise<ChannelSetupWizard>) {
  return async (params: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0]) =>
    await (await loadWizard()).prepare?.(params);
}

export function createDelegatedFinalize(loadWizard: () => Promise<ChannelSetupWizard>) {
  return async (params: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]) =>
    await (await loadWizard()).finalize?.(params);
}

type DelegatedStatusBase = Omit<
  ChannelSetupWizard["status"],
  "resolveConfigured" | "resolveStatusLines" | "resolveSelectionHint" | "resolveQuickstartScore"
>;

export function createDelegatedSetupWizardProxy(params: {
  channel: string;
  loadWizard: () => Promise<ChannelSetupWizard>;
  status: DelegatedStatusBase;
  credentials?: ChannelSetupWizard["credentials"];
  textInputs?: ChannelSetupWizard["textInputs"];
  completionNote?: ChannelSetupWizard["completionNote"];
  dmPolicy?: ChannelSetupWizard["dmPolicy"];
  disable?: ChannelSetupWizard["disable"];
  resolveShouldPromptAccountIds?: ChannelSetupWizard["resolveShouldPromptAccountIds"];
  onAccountRecorded?: ChannelSetupWizard["onAccountRecorded"];
  delegatePrepare?: boolean;
  delegateFinalize?: boolean;
}): ChannelSetupWizard {
  return {
    channel: params.channel,
    status: {
      ...params.status,
      resolveConfigured: createDelegatedResolveConfigured(params.loadWizard),
      ...createDelegatedSetupWizardStatusResolvers(params.loadWizard),
    },
    ...(params.resolveShouldPromptAccountIds
      ? { resolveShouldPromptAccountIds: params.resolveShouldPromptAccountIds }
      : {}),
    ...(params.delegatePrepare ? { prepare: createDelegatedPrepare(params.loadWizard) } : {}),
    credentials: params.credentials ?? [],
    ...(params.textInputs ? { textInputs: params.textInputs } : {}),
    ...(params.delegateFinalize ? { finalize: createDelegatedFinalize(params.loadWizard) } : {}),
    ...(params.completionNote ? { completionNote: params.completionNote } : {}),
    ...(params.dmPolicy ? { dmPolicy: params.dmPolicy } : {}),
    ...(params.disable ? { disable: params.disable } : {}),
    ...(params.onAccountRecorded ? { onAccountRecorded: params.onAccountRecorded } : {}),
  } satisfies ChannelSetupWizard;
}

export function createAllowlistSetupWizardProxy<TGroupResolved>(params: {
  loadWizard: () => Promise<ChannelSetupWizard>;
  createBase: (handlers: {
    promptAllowFrom: (params: PromptAllowFromParams) => Promise<OpenClawConfig>;
    resolveAllowFromEntries: (
      params: ResolveAllowFromEntriesParams,
    ) => Promise<ResolveAllowFromEntriesResult>;
    resolveGroupAllowlist: (params: ResolveGroupAllowlistParams) => Promise<TGroupResolved>;
  }) => ChannelSetupWizard;
  fallbackResolvedGroupAllowlist: (entries: string[]) => TGroupResolved;
}) {
  return params.createBase({
    promptAllowFrom: async ({ cfg, prompter, accountId }) => {
      const wizard = await params.loadWizard();
      if (!wizard.dmPolicy?.promptAllowFrom) {
        return cfg;
      }
      return await wizard.dmPolicy.promptAllowFrom({ cfg, prompter, accountId });
    },
    resolveAllowFromEntries: async ({ cfg, accountId, credentialValues, entries }) => {
      const wizard = await params.loadWizard();
      if (!wizard.allowFrom) {
        return entries.map((input) => ({ input, resolved: false, id: null }));
      }
      return await wizard.allowFrom.resolveEntries({
        cfg,
        accountId,
        credentialValues,
        entries,
      });
    },
    resolveGroupAllowlist: async ({ cfg, accountId, credentialValues, entries, prompter }) => {
      const wizard = await params.loadWizard();
      if (!wizard.groupAccess?.resolveAllowlist) {
        return params.fallbackResolvedGroupAllowlist(entries);
      }
      return (await wizard.groupAccess.resolveAllowlist({
        cfg,
        accountId,
        credentialValues,
        entries,
        prompter,
      })) as TGroupResolved;
    },
  });
}
