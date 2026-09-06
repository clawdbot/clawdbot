// Gateway config reload planner.
// Maps changed config paths to hot-reload actions, no-ops, or full restarts.
import {
  type ChannelId,
  type ChannelPlugin,
  listChannelPlugins,
} from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActivePluginHttpRouteRegistry,
  getActivePluginHttpRouteRegistryVersion,
} from "../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/account-id.js";
import { isTranscriptTitleOnlyConfigChange } from "../transcripts/config-reload.js";
import { isPlainObject } from "../utils.js";
import { canHotReloadGatewayAuthCredentials } from "./auth-resolve.js";

export type ChannelKind = ChannelId;

export type GatewayReloadPlan = {
  changedPaths: string[];
  restartGateway: boolean;
  restartReasons: string[];
  hotReasons: string[];
  reloadHooks: boolean;
  reloadInternalHooks?: boolean;
  /** Refresh the hook target-policy snapshot without invalidating transform modules. */
  refreshHooksPolicy?: boolean;
  restartGmailWatcher: boolean;
  restartCron: boolean;
  restartHeartbeat: boolean;
  reconcileSystemJobs?: boolean;
  reloadPlugins: boolean;
  restartChannels: Set<ChannelKind>;
  restartServices?: Set<string>;
  disposeMcpRuntimes: boolean;
  /** Account targets; absent means no targeted restarts for hand-built plans. */
  restartChannelAccounts?: Map<ChannelKind, Set<string>>;
  noopPaths: string[];
};

const RELOAD_ACTIONS = [
  "reloadHooks",
  "reloadInternalHooks",
  "refreshHooksPolicy",
  "restartGmailWatcher",
  "restartCron",
  "restartHeartbeat",
  "reconcileSystemJobs",
  "reloadPlugins",
  "disposeMcpRuntimes",
] as const;
type ReloadAction = (typeof RELOAD_ACTIONS)[number];

export function isNoopGatewayReloadPlan(plan: GatewayReloadPlan): boolean {
  return (
    !plan.restartGateway &&
    plan.hotReasons.length === 0 &&
    RELOAD_ACTIONS.every((action) => !plan[action]) &&
    plan.restartChannels.size === 0 &&
    (plan.restartServices?.size ?? 0) === 0 &&
    (plan.restartChannelAccounts?.size ?? 0) === 0
  );
}

type ReloadPolicy = {
  prefixes: readonly string[];
  kind: "restart" | "hot" | "none";
  actions?: readonly ReloadAction[];
  channels?: readonly ChannelPlugin[];
  services?: readonly string[];
  accountScoped?: boolean;
};
type ReloadRule = Omit<ReloadPolicy, "prefixes"> & { prefix: string };

type ConfigReloadMetadata = {
  kind: ReloadRule["kind"];
};

type GatewayReloadPlanOptions = {
  noopPaths?: Iterable<string>;
  forceChangedPaths?: Iterable<string>;
  /** Candidate config used to reject removed, unknown, or unresolvable account targets. */
  candidateConfig?: OpenClawConfig;
  previousConfig?: OpenClawConfig;
  /** Authored comparison snapshots retain intent that runtime overlays may hide. */
  previousCompareConfig?: OpenClawConfig;
  candidateCompareConfig?: OpenClawConfig;
};

const PLUGIN_INSTALL_TIMESTAMP_KEYS = ["installedAt", "resolvedAt"] as const;
const AUTH_CREDENTIAL_PATHS = ["gateway.auth.token", "gateway.auth.password"];
const SHARED_CHANNEL_PREFIXES = [
  "agents.defaults.mediaMaxMb",
  "channels.defaults",
  "channels.modelByChannel",
  "messages.inbound",
  "messages.ackReactionScope",
  "commands",
  "accessGroups",
  "tts",
  "surfaces",
  "acp.stream",
  "diagnostics.flags",
];

function matchesReloadPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

function expandReloadPolicies(policies: ReloadPolicy[]): ReloadRule[] {
  return policies
    .flatMap(({ prefixes, ...policy }) => prefixes.map((prefix) => ({ ...policy, prefix })))
    .toSorted((a, b) => b.prefix.length - a.prefix.length);
}

const CORE_RELOAD_POLICIES: ReloadPolicy[] = [
  { prefixes: ["gateway.remote", "gateway.reload"], kind: "none" },
  {
    prefixes: [
      ...AUTH_CREDENTIAL_PATHS,
      "mcp.apps",
      "secrets.egressProxy",
      "plugins.load",
      "plugins.installs",
    ],
    kind: "restart",
  },
  {
    // These policies use the published snapshot or an existing committed owner;
    // listener and service replacement requires an explicit action below.
    prefixes: [
      "gateway.http.endpoints",
      "gateway.http.securityHeaders.strictTransportSecurity",
      "gateway.tools",
      "gateway.cliAgents",
      "gateway.controlUi.enabled",
      "gateway.controlUi.environment",
      "gateway.controlUi.communityInvite",
      "gateway.controlUi.github",
      "gateway.controlUi.sessionObserver",
      "gateway.controlUi.embedSandbox",
      "gateway.controlUi.allowExternalEmbedUrls",
      "gateway.controlUi.automaticallyFetchFavicons",
      "gateway.controlUi.allowedOrigins",
      "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback",
      "gateway.nodes.browser",
      "gateway.nodes.pairing",
      "gateway.nodes.commands",
      "gateway.nodes.pluginTools.enabled",
      "gateway.nodes.allowSkills",
      "gateway.push.apns.relay",
      "gateway.terminal",
      "gateway.auth.rateLimit",
      "diagnostics.enabled",
      "discovery.mdns.mode",
      "mcp.apps.sandboxOrigin",
      "agents.defaults",
    ],
    kind: "hot",
  },
  { prefixes: ["hooks.gmail"], kind: "hot", actions: ["restartGmailWatcher", "reloadHooks"] },
  {
    prefixes: ["hooks.internal", "agents.defaults.workspace"],
    kind: "hot",
    actions: ["reloadInternalHooks"],
  },
  { prefixes: ["hooks"], kind: "hot", actions: ["reloadHooks"] },
  {
    prefixes: [
      "agents.defaults.heartbeat",
      "agents.defaults.models",
      "agents.defaults.modelPolicy",
      "agents.defaults.model",
      "models",
      "agent.heartbeat",
    ],
    kind: "hot",
    actions: ["restartHeartbeat", "reconcileSystemJobs"],
  },
  {
    prefixes: ["agents.entries"],
    kind: "hot",
    actions: [
      "restartHeartbeat",
      "reconcileSystemJobs",
      "refreshHooksPolicy",
      "reloadInternalHooks",
    ],
  },
  {
    prefixes: ["agents.defaults.sessionStore", "agents.ownership"],
    kind: "hot",
    actions: ["refreshHooksPolicy"],
  },
  {
    prefixes: ["skills.workshop.autonomous.mode"],
    kind: "hot",
    actions: ["reconcileSystemJobs"],
  },
  { prefixes: ["cron"], kind: "hot", actions: ["restartCron"] },
  { prefixes: ["mcp", "gateway.publicOrigin"], kind: "hot", actions: ["disposeMcpRuntimes"] },
  // Capability ownership changes replace the plugin generation that owns its routes.
  {
    prefixes: ["talk.provider", "talk.realtime.provider"],
    kind: "hot",
    actions: ["reloadPlugins"],
  },
];

const DEFAULT_RELOAD_POLICIES: ReloadPolicy[] = [
  {
    prefixes: [
      "meta",
      "identity",
      "wizard",
      "logging",
      "agents",
      "bindings",
      "audio",
      "agent",
      "routing",
      "messages",
      "session",
      "talk",
      "skills",
      "secrets",
      "tui",
      "ui",
    ],
    kind: "none",
  },
  {
    // Prospective operation policy; retained turns and resources keep their own
    // lifetime. Narrow plugin declarations may override these defaults.
    prefixes: [
      "tools",
      "approvals.exec",
      "approvals.plugin",
      "auth.order",
      "auth.profiles",
      "broadcast",
      "memory.citations",
      "worktreeRoot",
      "cloudWorkers.projectProfiles",
      "security.audit.suppressions",
      "security.installPolicy",
      "diagnostics.cacheTrace.enabled",
      "acp.runtime.installCommand",
      "attachments.ttlHours",
      "update.checkOnStart",
      "update.channel",
      "update.auto.enabled",
      "telemetry.enabled",
      "telemetry.consentedAt",
    ],
    kind: "hot",
  },
  { prefixes: ["plugins"], kind: "hot", actions: ["reloadPlugins", "disposeMcpRuntimes"] },
  { prefixes: ["gateway", "discovery"], kind: "restart" },
];

let cachedCatalog:
  | {
      registry: ReturnType<typeof getActivePluginHttpRouteRegistry>;
      version: number;
      rules: ReloadRule[];
      refinementPrefixes: string[];
    }
  | undefined;

function getReloadPolicyCatalog() {
  const registry = getActivePluginHttpRouteRegistry();
  const version = getActivePluginHttpRouteRegistryVersion();
  // Only process-root registry publication changes plugin/channel policy.
  if (cachedCatalog?.registry === registry && cachedCatalog.version === version) {
    return cachedCatalog;
  }
  const channelPlugins = listChannelPlugins();
  const servicePolicies = (registry?.services ?? []).map(({ service }) => ({
    prefixes: service.reload?.configPrefixes ?? [],
    services: [service.id],
  }));
  const channelPolicies = channelPlugins.flatMap((plugin): ReloadPolicy[] => [
    {
      prefixes: plugin.reload?.configPrefixes ?? [],
      kind: "hot",
      channels: [plugin],
      accountScoped: plugin.reload?.accountScopedRestart,
    },
    { prefixes: plugin.reload?.noopPrefixes ?? [], kind: "none", channels: [plugin] },
  ]);
  const channelRules = expandReloadPolicies(channelPolicies);
  const sharedPrefixes = new Set([
    ...SHARED_CHANNEL_PREFIXES,
    ...channelRules
      .filter(({ prefix }) =>
        SHARED_CHANNEL_PREFIXES.some((root) => matchesReloadPrefix(prefix, root)),
      )
      .map(({ prefix }) => prefix),
  ]);
  const policies: ReloadPolicy[] = [
    ...CORE_RELOAD_POLICIES,
    ...(registry?.reloads ?? []).flatMap(({ registration }) =>
      (
        [
          ["restart", registration.restartPrefixes],
          ["hot", registration.hotPrefixes],
          ["none", registration.noopPrefixes],
        ] as const
      ).map(([kind, prefixes]) => ({ kind, prefixes: prefixes ?? [] })),
    ),
    // Shared policy belongs to every loaded channel. One owner's opt-out must
    // not suppress sibling refreshes; undeclared owners remain restart-bound.
    ...Array.from(sharedPrefixes, (prefix): ReloadPolicy => {
      const channels = channelPlugins.filter(
        (plugin) =>
          channelRules.find(
            (rule) => rule.channels?.includes(plugin) && matchesReloadPrefix(prefix, rule.prefix),
          )?.kind !== "none",
      );
      const hasService = servicePolicies.some(({ prefixes }) =>
        prefixes.some((owner) => matchesReloadPrefix(prefix, owner)),
      );
      return { prefixes: [prefix], kind: channels.length || hasService ? "hot" : "none", channels };
    }),
    ...channelPolicies,
    ...channelPlugins.map((plugin): ReloadPolicy => ({
      prefixes: [`plugins.entries.${plugin.id}`],
      kind: "hot",
      actions: ["reloadPlugins", "disposeMcpRuntimes"],
      channels: [plugin],
    })),
    { prefixes: ["session.scope", "session.store"], kind: "hot", actions: ["refreshHooksPolicy"] },
    ...DEFAULT_RELOAD_POLICIES,
  ];
  const ownedRules = expandReloadPolicies(policies);
  const rules = [
    ...ownedRules,
    // Narrow service declarations retain existing owner actions, including
    // channel account targeting, while supplying their own hot classification.
    ...servicePolicies.flatMap(({ prefixes }) =>
      prefixes.map((prefix): ReloadRule => ({
        ...ownedRules.find((owner) => matchesReloadPrefix(prefix, owner.prefix)),
        kind: "hot",
        prefix,
      })),
    ),
  ];
  for (const rule of rules) {
    rule.services = servicePolicies
      .filter((service) =>
        service.prefixes.some((owner) => matchesReloadPrefix(rule.prefix, owner)),
      )
      .flatMap((service) => service.services);
  }
  // Narrow config contracts must override broad owner fallbacks. Sort once per
  // registry snapshot so the hot path can retain first-match semantics.
  rules.sort((a, b) => b.prefix.length - a.prefix.length);
  cachedCatalog = {
    registry,
    version,
    rules,
    refinementPrefixes: rules.map((rule) => rule.prefix),
  };
  return cachedCatalog;
}

export function listConfigReloadRefinementPrefixes(): string[] {
  return getReloadPolicyCatalog().refinementPrefixes;
}

function matchRule(path: string): ReloadRule | undefined {
  return getReloadPolicyCatalog().rules.find(({ prefix }) => matchesReloadPrefix(path, prefix));
}

export function resolveConfigReloadMetadata(path: string): ConfigReloadMetadata {
  if (isPluginInstallTimestampPath(path)) {
    return { kind: "none" };
  }
  return { kind: matchRule(path)?.kind ?? "restart" };
}

function isPluginInstallTimestampPath(path: string): boolean {
  // Legacy compatibility only: new plugin install metadata lives in the
  // managed plugin index, but old config writes may still touch this path.
  return /^plugins\.installs\..+\.(installedAt|resolvedAt)$/.test(path);
}

function getPluginInstallRecords(config: unknown): Record<string, unknown> {
  if (!isPlainObject(config)) {
    return {};
  }
  const plugins = config.plugins;
  if (!isPlainObject(plugins)) {
    return {};
  }
  // Keep legacy config install records out of gateway restart decisions while
  // migration/doctor moves them into the managed plugin index install records.
  const installs = plugins.installs;
  return isPlainObject(installs) ? installs : {};
}

function listPluginInstallRecordDiffPaths(
  prevConfig: unknown,
  nextConfig: unknown,
  visit: (record: {
    id: string;
    prevRecord: unknown;
    nextRecord: unknown;
    paths: string[];
  }) => void,
): string[] {
  const prevInstalls = getPluginInstallRecords(prevConfig);
  const nextInstalls = getPluginInstallRecords(nextConfig);
  const ids = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);
  const paths: string[] = [];

  for (const id of ids) {
    visit({ id, prevRecord: prevInstalls[id], nextRecord: nextInstalls[id], paths });
  }

  return paths;
}

export function listPluginInstallTimestampMetadataPaths(
  prevConfig: unknown,
  nextConfig: unknown,
): string[] {
  return listPluginInstallRecordDiffPaths(
    prevConfig,
    nextConfig,
    ({ id, prevRecord, nextRecord, paths }) => {
      if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) {
        return;
      }
      for (const key of PLUGIN_INSTALL_TIMESTAMP_KEYS) {
        if (prevRecord[key] !== nextRecord[key]) {
          paths.push(`plugins.installs.${id}.${key}`);
        }
      }
    },
  );
}

export function listPluginInstallWholeRecordPaths(
  prevConfig: unknown,
  nextConfig: unknown,
): string[] {
  return listPluginInstallRecordDiffPaths(
    prevConfig,
    nextConfig,
    ({ id, prevRecord, nextRecord, paths }) => {
      if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) {
        paths.push(`plugins.installs.${id}`);
      }
    },
  );
}

function extractAccountIdFromPath(channel: ChannelId, path: string): string | null {
  const prefix = `channels.${channel}.accounts.`;
  const id = path.startsWith(prefix) ? path.slice(prefix.length).split(".", 1)[0] : undefined;
  // Default config is the inheritance base, so it can change every account.
  return id && id !== DEFAULT_ACCOUNT_ID ? id : null;
}

function isResolvableChannelAccount(params: {
  plugin: ChannelPlugin;
  accountId: string;
  config: OpenClawConfig;
}): boolean {
  try {
    if (!params.plugin.config.listAccountIds(params.config).includes(params.accountId)) {
      return false;
    }
    params.plugin.config.resolveAccount(params.config, params.accountId);
    return true;
  } catch {
    return false;
  }
}

export function buildGatewayReloadPlan(
  changedPaths: string[],
  options: GatewayReloadPlanOptions = {},
): GatewayReloadPlan {
  const noopPaths = new Set(options.noopPaths);
  const forceChangedPaths = new Set(options.forceChangedPaths);
  const restartChannelAccounts = new Map<ChannelKind, Set<string>>();
  const plan: GatewayReloadPlan = {
    changedPaths,
    restartGateway: false,
    restartReasons: [],
    hotReasons: [],
    reloadHooks: false,
    reloadInternalHooks: false,
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    reconcileSystemJobs: false,
    reloadPlugins: false,
    restartChannels: new Set(),
    restartServices: new Set(),
    disposeMcpRuntimes: false,
    restartChannelAccounts,
    noopPaths: [],
  };

  for (const path of changedPaths) {
    // Arrays diff at their parent path. Titles configure future admissions;
    // retaining this exact live capture must not rename or finalize its archive.
    if (
      path === "transcripts.autoStart" &&
      !forceChangedPaths.has(path) &&
      options.previousConfig &&
      options.candidateConfig &&
      options.candidateConfig.gateway?.reload?.mode !== "off" &&
      isTranscriptTitleOnlyConfigChange(
        options.previousCompareConfig ?? options.previousConfig,
        options.candidateCompareConfig ?? options.candidateConfig,
      )
    ) {
      plan.noopPaths.push(path);
      continue;
    }
    const isTimestampNoop =
      !forceChangedPaths.has(path) &&
      (noopPaths.size > 0 ? noopPaths.has(path) : isPluginInstallTimestampPath(path));
    if (isTimestampNoop) {
      plan.noopPaths.push(path);
      continue;
    }
    const rule = matchRule(path);
    const kind = rule?.kind ?? "restart";
    const isCredentialRotation =
      rule &&
      AUTH_CREDENTIAL_PATHS.includes(rule.prefix) &&
      canHotReloadGatewayAuthCredentials(options.previousConfig, options.candidateConfig);
    if (kind === "restart" && !isCredentialRotation) {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (kind === "none") {
      plan.noopPaths.push(path);
      continue;
    }
    plan.hotReasons.push(path);
    for (const action of rule?.actions ?? []) {
      plan[action] = true;
    }
    for (const service of rule?.services ?? []) {
      plan.restartServices?.add(service);
    }
    for (const plugin of rule?.channels ?? []) {
      const accountId = rule?.accountScoped ? extractAccountIdFromPath(plugin.id, path) : null;
      if (
        accountId === null ||
        (options.candidateConfig &&
          !isResolvableChannelAccount({ plugin, accountId, config: options.candidateConfig }))
      ) {
        plan.restartChannels.add(plugin.id);
        continue;
      }
      const accounts = restartChannelAccounts.get(plugin.id) ?? new Set<string>();
      accounts.add(accountId);
      restartChannelAccounts.set(plugin.id, accounts);
    }
  }

  // A wholesale restart covers its account targets and must run only once.
  for (const channel of plan.restartChannels) {
    restartChannelAccounts.delete(channel);
  }

  return plan;
}
