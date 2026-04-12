import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "../../config/runtime-group-policy.js";
import type { GroupPolicy } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type GroupPolicyWarningCollector = (groupPolicy: GroupPolicy) => string[];
type AccountGroupPolicyWarningCollector<ResolvedAccount> = (params: {
  account: ResolvedAccount;
  cfg: OpenClawConfig;
}) => string[];
type ConfigGroupPolicyWarningCollector<Params extends { cfg: OpenClawConfig }> = (
  params: Params,
) => string[];
type WarningCollector<Params> = (params: Params) => string[];

export function composeWarningCollectors<Params>(
  ...collectors: Array<WarningCollector<Params> | null | undefined>
): WarningCollector<Params> {
  return (params) => collectors.flatMap((collector) => collector?.(params) ?? []);
}

export function projectWarningCollector<Params, Projected>(
  project: (params: Params) => Projected,
  collector: WarningCollector<Projected>,
): WarningCollector<Params> {
  return (params) => collector(project(params));
}

export function projectConfigWarningCollector<Params extends { cfg: OpenClawConfig }>(
  collector: WarningCollector<{ cfg: OpenClawConfig }>,
): WarningCollector<Params> {
  return projectWarningCollector((params) => ({ cfg: params.cfg }), collector);
}

export function projectConfigAccountIdWarningCollector<
  Params extends { cfg: OpenClawConfig; accountId?: string | null },
>(
  collector: WarningCollector<{ cfg: OpenClawConfig; accountId?: string | null }>,
): WarningCollector<Params> {
  return projectWarningCollector(
    (params) => ({ cfg: params.cfg, accountId: params.accountId }),
    collector,
  );
}

export function projectAccountWarningCollector<
  ResolvedAccount,
  Params extends { account: ResolvedAccount },
>(collector: WarningCollector<ResolvedAccount>): WarningCollector<Params> {
  return projectWarningCollector((params) => params.account, collector);
}

export function projectAccountConfigWarningCollector<
  ResolvedAccount,
  ProjectedCfg,
  Params extends { account: ResolvedAccount; cfg: OpenClawConfig },
>(
  projectCfg: (cfg: OpenClawConfig) => ProjectedCfg,
  collector: WarningCollector<{ account: ResolvedAccount; cfg: ProjectedCfg }>,
): WarningCollector<Params> {
  return projectWarningCollector(
    (params) => ({ account: params.account, cfg: projectCfg(params.cfg) }),
    collector,
  );
}

export function createConditionalWarningCollector<Params>(
  ...collectors: Array<(params: Params) => string | string[] | null | undefined | false>
): WarningCollector<Params> {
  return (params) =>
    collectors.flatMap((collector) => {
      const next = collector(params);
      if (!next) {
        return [];
      }
      return Array.isArray(next) ? next : [next];
    });
}

export function composeAccountWarningCollectors<
  ResolvedAccount,
  Params extends { account: ResolvedAccount },
>(
  baseCollector: WarningCollector<Params>,
  ...collectors: Array<(account: ResolvedAccount) => string | string[] | null | undefined | false>
): WarningCollector<Params> {
  return composeWarningCollectors(
    baseCollector,
    createConditionalWarningCollector<Params>(
      ...collectors.map(
        (collector) =>
          ({ account }: Params) =>
            collector(account),
      ),
    ),
  );
}

export function buildOpenGroupPolicyWarning(params: {
  surface: string;
  openBehavior: string;
  remediation: string;
}): string {
  return `- ${params.surface}: groupPolicy="open" ${params.openBehavior}. ${params.remediation}.`;
}

export function buildOpenGroupPolicyRestrictSendersWarning(params: {
  surface: string;
  openScope: string;
  groupPolicyPath: string;
  groupAllowFromPath: string;
  mentionGated?: boolean;
}): string {
  const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
  return buildOpenGroupPolicyWarning({
    surface: params.surface,
    openBehavior: `allows ${params.openScope} to trigger${mentionSuffix}`,
    remediation: `Set ${params.groupPolicyPath}="allowlist" + ${params.groupAllowFromPath} to restrict senders`,
  });
}

export function buildOpenGroupPolicyNoRouteAllowlistWarning(params: {
  surface: string;
  routeAllowlistPath: string;
  routeScope: string;
  groupPolicyPath: string;
  groupAllowFromPath: string;
  mentionGated?: boolean;
}): string {
  const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
  return buildOpenGroupPolicyWarning({
    surface: params.surface,
    openBehavior: `with no ${params.routeAllowlistPath} allowlist; any ${params.routeScope} can add + ping${mentionSuffix}`,
    remediation: `Set ${params.groupPolicyPath}="allowlist" + ${params.groupAllowFromPath} or configure ${params.routeAllowlistPath}`,
  });
}

export function buildOpenGroupPolicyConfigureRouteAllowlistWarning(params: {
  surface: string;
  openScope: string;
  groupPolicyPath: string;
  routeAllowlistPath: string;
  mentionGated?: boolean;
}): string {
  const mentionSuffix = params.mentionGated === false ? "" : " (mention-gated)";
  return buildOpenGroupPolicyWarning({
    surface: params.surface,
    openBehavior: `allows ${params.openScope} to trigger${mentionSuffix}`,
    remediation: `Set ${params.groupPolicyPath}="allowlist" and configure ${params.routeAllowlistPath}`,
  });
}

export function collectOpenGroupPolicyRestrictSendersWarnings(
  params: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0] & {
    groupPolicy: "open" | "allowlist" | "disabled";
  },
): string[] {
  if (params.groupPolicy !== "open") {
    return [];
  }
  return [buildOpenGroupPolicyRestrictSendersWarning(params)];
}

export function collectAllowlistProviderRestrictSendersWarnings(
  params: {
    cfg: OpenClawConfig;
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy | null;
  } & Omit<Parameters<typeof collectOpenGroupPolicyRestrictSendersWarnings>[0], "groupPolicy">,
): string[] {
  return collectAllowlistProviderGroupPolicyWarnings({
    cfg: params.cfg,
    providerConfigPresent: params.providerConfigPresent,
    configuredGroupPolicy: params.configuredGroupPolicy,
    collect: (groupPolicy) =>
      collectOpenGroupPolicyRestrictSendersWarnings({
        groupPolicy,
        surface: params.surface,
        openScope: params.openScope,
        groupPolicyPath: params.groupPolicyPath,
        groupAllowFromPath: params.groupAllowFromPath,
        mentionGated: params.mentionGated,
      }),
  });
}

/** Build an account-aware allowlist-provider warning collector for sender-restricted groups. */
export function createAllowlistProviderRestrictSendersWarningCollector<ResolvedAccount>(
  params: {
    providerConfigPresent: (cfg: OpenClawConfig) => boolean;
    resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  } & Omit<
    Parameters<typeof collectAllowlistProviderRestrictSendersWarnings>[0],
    "cfg" | "providerConfigPresent" | "configuredGroupPolicy"
  >,
): AccountGroupPolicyWarningCollector<ResolvedAccount> {
  return createAllowlistProviderGroupPolicyWarningCollector({
    providerConfigPresent: params.providerConfigPresent,
    resolveGroupPolicy: ({ account }: { account: ResolvedAccount; cfg: OpenClawConfig }) =>
      params.resolveGroupPolicy(account),
    collect: ({ groupPolicy }) =>
      collectOpenGroupPolicyRestrictSendersWarnings({
        groupPolicy,
        surface: params.surface,
        openScope: params.openScope,
        groupPolicyPath: params.groupPolicyPath,
        groupAllowFromPath: params.groupAllowFromPath,
        mentionGated: params.mentionGated,
      }),
  });
}

/** Build a direct account-aware warning collector when the policy already lives on the account. */
export function createOpenGroupPolicyRestrictSendersWarningCollector<ResolvedAccount>(
  params: {
    resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
    defaultGroupPolicy?: GroupPolicy;
  } & Omit<Parameters<typeof collectOpenGroupPolicyRestrictSendersWarnings>[0], "groupPolicy">,
): (account: ResolvedAccount) => string[] {
  return (account) =>
    collectOpenGroupPolicyRestrictSendersWarnings({
      groupPolicy: params.resolveGroupPolicy(account) ?? params.defaultGroupPolicy ?? "allowlist",
      surface: params.surface,
      openScope: params.openScope,
      groupPolicyPath: params.groupPolicyPath,
      groupAllowFromPath: params.groupAllowFromPath,
      mentionGated: params.mentionGated,
    });
}

export function collectAllowlistProviderGroupPolicyWarnings(params: {
  cfg: OpenClawConfig;
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy | null;
  collect: GroupPolicyWarningCollector;
}): string[] {
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.configuredGroupPolicy ?? undefined,
    defaultGroupPolicy,
  });
  return params.collect(groupPolicy);
}

/** Build a config-aware allowlist-provider warning collector from an arbitrary policy resolver. */
export function createAllowlistProviderGroupPolicyWarningCollector<
  Params extends { cfg: OpenClawConfig },
>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (params: Params) => GroupPolicy | null | undefined;
  collect: (params: Params & { groupPolicy: GroupPolicy }) => string[];
}): ConfigGroupPolicyWarningCollector<Params> {
  return (runtime) =>
    collectAllowlistProviderGroupPolicyWarnings({
      cfg: runtime.cfg,
      providerConfigPresent: params.providerConfigPresent(runtime.cfg),
      configuredGroupPolicy: params.resolveGroupPolicy(runtime),
      collect: (groupPolicy) => params.collect({ ...runtime, groupPolicy }),
    });
}

export function collectOpenProviderGroupPolicyWarnings(params: {
  cfg: OpenClawConfig;
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy | null;
  collect: GroupPolicyWarningCollector;
}): string[] {
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.configuredGroupPolicy ?? undefined,
    defaultGroupPolicy,
  });
  return params.collect(groupPolicy);
}

/** Build a config-aware open-provider warning collector from an arbitrary policy resolver. */
export function createOpenProviderGroupPolicyWarningCollector<
  Params extends { cfg: OpenClawConfig },
>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (params: Params) => GroupPolicy | null | undefined;
  collect: (params: Params & { groupPolicy: GroupPolicy }) => string[];
}): ConfigGroupPolicyWarningCollector<Params> {
  return (runtime) =>
    collectOpenProviderGroupPolicyWarnings({
      cfg: runtime.cfg,
      providerConfigPresent: params.providerConfigPresent(runtime.cfg),
      configuredGroupPolicy: params.resolveGroupPolicy(runtime),
      collect: (groupPolicy) => params.collect({ ...runtime, groupPolicy }),
    });
}

/** Build an account-aware allowlist-provider warning collector for simple open-policy warnings. */
export function createAllowlistProviderOpenWarningCollector<ResolvedAccount>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  buildOpenWarning: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount> {
  return createAllowlistProviderGroupPolicyWarningCollector({
    providerConfigPresent: params.providerConfigPresent,
    resolveGroupPolicy: ({ account }: { account: ResolvedAccount; cfg: OpenClawConfig }) =>
      params.resolveGroupPolicy(account),
    collect: ({ groupPolicy }) =>
      groupPolicy === "open" ? [buildOpenGroupPolicyWarning(params.buildOpenWarning)] : [],
  });
}

export function collectOpenGroupPolicyRouteAllowlistWarnings(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  routeAllowlistConfigured: boolean;
  restrictSenders: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0];
  noRouteAllowlist: Parameters<typeof buildOpenGroupPolicyNoRouteAllowlistWarning>[0];
}): string[] {
  if (params.groupPolicy !== "open") {
    return [];
  }
  if (params.routeAllowlistConfigured) {
    return [buildOpenGroupPolicyRestrictSendersWarning(params.restrictSenders)];
  }
  return [buildOpenGroupPolicyNoRouteAllowlistWarning(params.noRouteAllowlist)];
}

/** Build an account-aware allowlist-provider warning collector for route-allowlisted groups. */
export function createAllowlistProviderRouteAllowlistWarningCollector<ResolvedAccount>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  resolveRouteAllowlistConfigured: (account: ResolvedAccount) => boolean;
  restrictSenders: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0];
  noRouteAllowlist: Parameters<typeof buildOpenGroupPolicyNoRouteAllowlistWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount> {
  return createAllowlistProviderGroupPolicyWarningCollector({
    providerConfigPresent: params.providerConfigPresent,
    resolveGroupPolicy: ({ account }: { account: ResolvedAccount; cfg: OpenClawConfig }) =>
      params.resolveGroupPolicy(account),
    collect: ({ account, groupPolicy }) =>
      collectOpenGroupPolicyRouteAllowlistWarnings({
        groupPolicy,
        routeAllowlistConfigured: params.resolveRouteAllowlistConfigured(account),
        restrictSenders: params.restrictSenders,
        noRouteAllowlist: params.noRouteAllowlist,
      }),
  });
}

export function collectOpenGroupPolicyConfiguredRouteWarnings(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  routeAllowlistConfigured: boolean;
  configureRouteAllowlist: Parameters<typeof buildOpenGroupPolicyConfigureRouteAllowlistWarning>[0];
  missingRouteAllowlist: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): string[] {
  if (params.groupPolicy !== "open") {
    return [];
  }
  if (params.routeAllowlistConfigured) {
    return [buildOpenGroupPolicyConfigureRouteAllowlistWarning(params.configureRouteAllowlist)];
  }
  return [buildOpenGroupPolicyWarning(params.missingRouteAllowlist)];
}

/** Build an account-aware open-provider warning collector for configured-route channels. */
export function createOpenProviderConfiguredRouteWarningCollector<ResolvedAccount>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  resolveRouteAllowlistConfigured: (account: ResolvedAccount) => boolean;
  configureRouteAllowlist: Parameters<typeof buildOpenGroupPolicyConfigureRouteAllowlistWarning>[0];
  missingRouteAllowlist: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount> {
  return createOpenProviderGroupPolicyWarningCollector({
    providerConfigPresent: params.providerConfigPresent,
    resolveGroupPolicy: ({ account }: { account: ResolvedAccount; cfg: OpenClawConfig }) =>
      params.resolveGroupPolicy(account),
    collect: ({ account, groupPolicy }) =>
      collectOpenGroupPolicyConfiguredRouteWarnings({
        groupPolicy,
        routeAllowlistConfigured: params.resolveRouteAllowlistConfigured(account),
        configureRouteAllowlist: params.configureRouteAllowlist,
        missingRouteAllowlist: params.missingRouteAllowlist,
      }),
  });
}
