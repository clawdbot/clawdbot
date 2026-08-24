/**
 * Lazy setup wizard proxy helpers.
 *
 * Delegates setup wizard status, credential, allowlist, and finalization hooks to loaded wizards.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDelegatedSetupWizardStatusResolvers } from "./setup-wizard-binary.js";
import type { ChannelSetupDmPolicy } from "./setup-wizard-types.js";
import type { ChannelSetupWizard } from "./setup-wizard.js";

type PromptAllowFromParams = Parameters<NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>>[0];
type ResolveAllowFromEntriesParams = Parameters<
  NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]
>[0];
type ResolveAllowFromEntriesResult = Awaited<
  ReturnType<NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]>
>;
type ResolveGroupAllowlistParams = Parameters<
  NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>
>[0];

type DelegatedStatusBase = Omit<
  ChannelSetupWizard["status"],
  "resolveConfigured" | "resolveStatusLines" | "resolveSelectionHint" | "resolveQuickstartScore"
>;

/**
 * Creates a setup wizard facade with selected hooks delegated to a lazy wizard.
 */
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
      resolveConfigured: async (statusParams) =>
        await (await params.loadWizard()).status.resolveConfigured(statusParams),
      ...createDelegatedSetupWizardStatusResolvers(params.loadWizard),
    },
    // Keep static setup metadata available immediately, while expensive
    // prepare/finalize/status behavior loads only when the wizard needs it.
    ...(params.resolveShouldPromptAccountIds
      ? { resolveShouldPromptAccountIds: params.resolveShouldPromptAccountIds }
      : {}),
    ...(params.delegatePrepare
      ? {
          prepare: async (
            prepareParams: Parameters<NonNullable<ChannelSetupWizard["prepare"]>>[0],
          ) => await (await params.loadWizard()).prepare?.(prepareParams),
        }
      : {}),
    credentials: params.credentials ?? [],
    ...(params.textInputs ? { textInputs: params.textInputs } : {}),
    ...(params.delegateFinalize
      ? {
          finalize: async (
            finalizeParams: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0],
          ) => await (await params.loadWizard()).finalize?.(finalizeParams),
        }
      : {}),
    ...(params.completionNote ? { completionNote: params.completionNote } : {}),
    ...(params.dmPolicy ? { dmPolicy: params.dmPolicy } : {}),
    ...(params.disable ? { disable: params.disable } : {}),
    ...(params.onAccountRecorded ? { onAccountRecorded: params.onAccountRecorded } : {}),
  } satisfies ChannelSetupWizard;
}

/**
 * Creates a setup wizard proxy that delegates allowlist resolution when available.
 */
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
        // A base wizard may expose allowlist UI before the delegated wizard has
        // resolver support. Preserve raw entries as unresolved instead of failing.
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
        // Group allowlists are channel-specific; callers provide the safe
        // fallback representation when the delegated wizard has no resolver.
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
