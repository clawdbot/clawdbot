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
import { isPlainObject } from "../utils.js";
import { canHotReloadGatewayAuthCredentials } from "./auth-resolve.js";

export type ChannelKind = ChannelId;

export type GatewayReloadPlan = {
  changedPaths: string[];
  restartGateway: boolean;
  restartReasons: string[];
  hotReasons: string[];
  reloadHooks: boolean;
  /** Refresh the hook target-policy snapshot without invalidating transform modules. */
  refreshHooksPolicy?: boolean;
  restartGmailWatcher: boolean;
  restartCron: boolean;
  restartHeartbeat: boolean;
  reconcileSkillReviewJobs?: boolean;
  reloadPlugins: boolean;
  restartChannels: Set<ChannelKind>;
  disposeMcpRuntimes: boolean;
  /** Account targets; absent means no targeted restarts for hand-built plans. */
  restartChannelAccounts?: Map<ChannelKind, Set<string>>;
  noopPaths: string[];
};

export function isNoopGatewayReloadPlan(plan: GatewayReloadPlan): boolean {
  return (
    !plan.restartGateway &&
    plan.hotReasons.length === 0 &&
    !plan.reloadHooks &&
    !plan.refreshHooksPolicy &&
    !plan.restartGmailWatcher &&
    !plan.restartCron &&
    !plan.restartHeartbeat &&
    !plan.reconcileSkillReviewJobs &&
    !plan.reloadPlugins &&
    !plan.disposeMcpRuntimes &&
    plan.restartChannels.size === 0 &&
    (plan.restartChannelAccounts?.size ?? 0) === 0
  );
}

type ReloadRule = {
  prefix: string;
  kind: "restart" | "hot" | "none";
  actions?: ReloadAction[];
  accountScopedPlugin?: ChannelPlugin;
};

type ConfigReloadMetadata = {
  kind: ReloadRule["kind"];
};

type ReloadAction =
  | "reload-hooks"
  | "refresh-hooks-policy"
  | "restart-gmail-watcher"
  | "restart-cron"
  | "restart-heartbeat"
  | "reconcile-skill-review-jobs"
  | "reload-plugins"
  | "dispose-mcp-runtimes"
  | `restart-channel-account:${ChannelId}`
  | `restart-channel:${ChannelId}`;

type GatewayReloadPlanOptions = {
  noopPaths?: Iterable<string>;
  forceChangedPaths?: Iterable<string>;
  /** Candidate config used to reject removed, unknown, or unresolvable account targets. */
  candidateConfig?: OpenClawConfig;
  previousConfig?: OpenClawConfig;
};

const PLUGIN_INSTALL_TIMESTAMP_KEYS = ["installedAt", "resolvedAt"] as const;
const AUTH_CREDENTIAL_PATHS = ["gateway.auth.token", "gateway.auth.password"];

const BASE_RELOAD_RULES: ReloadRule[] = [
  { prefix: "gateway.remote", kind: "none" },
  { prefix: "gateway.reload", kind: "none" },
  ...AUTH_CREDENTIAL_PATHS.map((prefix): ReloadRule => ({ prefix, kind: "restart" })),
  // Request policy reads the published config; listeners and startup-owned
  // resources retain the broad Gateway restart rule below.
  { prefix: "gateway.http.endpoints", kind: "hot" },
  { prefix: "gateway.http.securityHeaders.strictTransportSecurity", kind: "hot" },
  { prefix: "gateway.tools", kind: "hot" },
  { prefix: "gateway.cliAgents", kind: "hot" },
  { prefix: "gateway.controlUi.environment", kind: "hot" },
  { prefix: "gateway.controlUi.communityInvite", kind: "hot" },
  { prefix: "gateway.controlUi.github", kind: "hot" },
  { prefix: "gateway.controlUi.toolTitles", kind: "hot" },
  { prefix: "gateway.controlUi.sessionObserver", kind: "hot" },
  { prefix: "gateway.controlUi.embedSandbox", kind: "hot" },
  { prefix: "gateway.controlUi.allowExternalEmbedUrls", kind: "hot" },
  { prefix: "gateway.controlUi.automaticallyFetchFavicons", kind: "hot" },
  { prefix: "gateway.controlUi.allowedOrigins", kind: "hot" },
  { prefix: "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback", kind: "hot" },
  { prefix: "gateway.nodes.browser", kind: "hot" },
  { prefix: "gateway.nodes.pairing", kind: "hot" },
  { prefix: "gateway.nodes.commands", kind: "hot" },
  { prefix: "gateway.nodes.pluginTools.enabled", kind: "hot" },
  { prefix: "gateway.nodes.allowSkills", kind: "hot" },
  { prefix: "gateway.push.apns.relay", kind: "hot" },
  { prefix: "gateway.terminal", kind: "hot" },
  { prefix: "hooks.gmail", kind: "hot", actions: ["restart-gmail-watcher"] },
  { prefix: "hooks", kind: "hot", actions: ["reload-hooks"] },
  {
    prefix: "agents.defaults.heartbeat",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "agents.defaults.sessionStore",
    kind: "hot",
    actions: ["refresh-hooks-policy"],
  },
  { prefix: "agents.defaults", kind: "hot" },
  {
    prefix: "agents.defaults.models",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "agents.defaults.modelPolicy",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "agents.defaults.model",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "models",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  {
    prefix: "agents.entries",
    kind: "hot",
    actions: ["restart-heartbeat", "refresh-hooks-policy"],
  },
  { prefix: "agents.ownership", kind: "hot", actions: ["refresh-hooks-policy"] },
  { prefix: "agent.heartbeat", kind: "hot", actions: ["restart-heartbeat"] },
  {
    prefix: "skills.workshop.autonomous.mode",
    kind: "hot",
    actions: ["reconcile-skill-review-jobs"],
  },
  { prefix: "cron", kind: "hot", actions: ["restart-cron"] },
  // The dedicated Apps listener and origin are created once during Gateway
  // startup; disposing MCP runtimes cannot move or create that HTTP server.
  { prefix: "mcp.apps", kind: "restart" },
  { prefix: "mcp", kind: "hot", actions: ["dispose-mcp-runtimes"] },
  // The proxy listener, per-start CA, and run-token registry are Gateway-owned.
  { prefix: "secrets.egressProxy", kind: "restart" },
  { prefix: "plugins.load", kind: "restart" },
  { prefix: "plugins.installs", kind: "restart" },
  // Capability ownership changes must replace the plugin generation that owns its routes.
  { prefix: "talk.provider", kind: "hot", actions: ["reload-plugins"] },
  { prefix: "talk.realtime.provider", kind: "hot", actions: ["reload-plugins"] },
];

const BASE_RELOAD_RULES_TAIL: ReloadRule[] = [
  { prefix: "meta", kind: "none" },
  { prefix: "identity", kind: "none" },
  { prefix: "wizard", kind: "none" },
  { prefix: "logging", kind: "none" },
  { prefix: "agents", kind: "none" },
  { prefix: "tools", kind: "hot" },
  { prefix: "bindings", kind: "none" },
  { prefix: "audio", kind: "none" },
  { prefix: "agent", kind: "none" },
  { prefix: "routing", kind: "none" },
  { prefix: "messages", kind: "none" },
  { prefix: "session", kind: "none" },
  { prefix: "talk", kind: "none" },
  { prefix: "skills", kind: "none" },
  { prefix: "secrets", kind: "none" },
  { prefix: "session.scope", kind: "hot", actions: ["refresh-hooks-policy"] },
  { prefix: "session.store", kind: "hot", actions: ["refresh-hooks-policy"] },
  { prefix: "plugins", kind: "hot", actions: ["reload-plugins", "dispose-mcp-runtimes"] },
  { prefix: "tui", kind: "none" },
  { prefix: "ui", kind: "none" },
  { prefix: "gateway", kind: "restart" },
  { prefix: "discovery", kind: "restart" },
];

let cachedReloadRules: ReloadRule[] | null = null;
let cachedRefinementPrefixes: string[] = [];
let cachedRegistry: ReturnType<typeof getActivePluginHttpRouteRegistry> | null = null;
let cachedGatewayRegistryVersion = -1;

function listReloadRules(): ReloadRule[] {
  // Reload metadata is gateway policy owned by the process-root registry.
  const registry = getActivePluginHttpRouteRegistry();
  const gatewayRegistryVersion = getActivePluginHttpRouteRegistryVersion();
  // Plugin/channel reload rules are process-stable until the root registry
  // version changes; cache them to keep every config diff cheap.
  if (registry !== cachedRegistry || gatewayRegistryVersion !== cachedGatewayRegistryVersion) {
    cachedReloadRules = null;
    cachedRefinementPrefixes = [];
    cachedRegistry = registry;
    cachedGatewayRegistryVersion = gatewayRegistryVersion;
  }
  if (cachedReloadRules) {
    return cachedReloadRules;
  }
  // Channel docking: plugins contribute hot reload/no-op prefixes here.
  const channelPlugins = listChannelPlugins();
  const channelReloadRules: ReloadRule[] = channelPlugins.flatMap((plugin) => {
    const restartAction = plugin.reload?.accountScopedRestart
      ? (`restart-channel-account:${plugin.id}` as ReloadAction)
      : (`restart-channel:${plugin.id}` as ReloadAction);
    return (plugin.reload?.configPrefixes ?? [])
      .map((prefix): ReloadRule => {
        const rule: ReloadRule = {
          prefix,
          kind: "hot",
          actions: [restartAction],
        };
        if (plugin.reload?.accountScopedRestart) {
          rule.accountScopedPlugin = plugin;
        }
        return rule;
      })
      .concat(
        (plugin.reload?.noopPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "none",
          }),
        ),
      );
  });
  const channelPluginStateRules: ReloadRule[] = channelPlugins.flatMap((plugin) => [
    {
      prefix: `plugins.entries.${plugin.id}`,
      kind: "hot",
      actions: [
        "reload-plugins",
        "dispose-mcp-runtimes",
        `restart-channel:${plugin.id}` as ReloadAction,
      ],
    },
  ]);
  const pluginReloadRules: ReloadRule[] = (registry?.reloads ?? []).flatMap((entry) =>
    (entry.registration.restartPrefixes ?? [])
      .map(
        (prefix): ReloadRule => ({
          prefix,
          kind: "restart",
        }),
      )
      .concat(
        (entry.registration.hotPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "hot",
          }),
        ),
        (entry.registration.noopPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "none",
          }),
        ),
      ),
  );
  const rules: ReloadRule[] = [
    ...BASE_RELOAD_RULES,
    ...pluginReloadRules,
    ...channelReloadRules,
    ...channelPluginStateRules,
    // Channel snapshots capture shared policy. Fan out by default while
    // preserving explicit plugin/channel policies above on equal-prefix ties.
    ...["agents.defaults.mediaMaxMb", "channels.defaults", "channels.modelByChannel"].map(
      (prefix): ReloadRule => ({
        prefix,
        kind: "hot",
        actions: channelPlugins.map(({ id }): ReloadAction => `restart-channel:${id}`),
      }),
    ),
    ...BASE_RELOAD_RULES_TAIL,
  ];
  // Narrow config contracts must override broad owner fallbacks. Sort once per
  // registry snapshot so the hot path can retain first-match semantics.
  rules.sort((a, b) => b.prefix.length - a.prefix.length);
  cachedRefinementPrefixes = rules.map((rule) => rule.prefix);
  cachedReloadRules = rules;
  return rules;
}

export function listConfigReloadRefinementPrefixes(): string[] {
  listReloadRules();
  return cachedRefinementPrefixes;
}

function matchRule(path: string): ReloadRule | null {
  for (const rule of listReloadRules()) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) {
      return rule;
    }
  }
  return null;
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
  if (!path.startsWith(prefix)) {
    return null;
  }
  const rest = path.slice(prefix.length);
  if (rest.length === 0) {
    return null;
  }
  const dotIdx = rest.indexOf(".");
  const id = dotIdx === -1 ? rest : rest.slice(0, dotIdx);
  if (id.length === 0) {
    return null;
  }
  // Default config is the inheritance base, so it can change every account.
  if (id === DEFAULT_ACCOUNT_ID) {
    return null;
  }
  return id;
}

function isResolvableChannelAccount(params: {
  plugin: ChannelPlugin | undefined;
  accountId: string;
  config: OpenClawConfig;
}): boolean {
  if (!params.plugin) {
    return false;
  }
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
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    reconcileSkillReviewJobs: false,
    reloadPlugins: false,
    restartChannels: new Set(),
    disposeMcpRuntimes: false,
    restartChannelAccounts,
    noopPaths: [],
  };

  const applyAction = (
    action: ReloadAction,
    originatingPath: string,
    accountScopedPlugin?: ChannelPlugin,
  ) => {
    if (action.startsWith("restart-channel-account:")) {
      const channel = action.slice("restart-channel-account:".length) as ChannelId;
      const accountId = extractAccountIdFromPath(channel, originatingPath);
      if (accountId !== null) {
        if (
          options.candidateConfig &&
          !isResolvableChannelAccount({
            plugin: accountScopedPlugin,
            accountId,
            config: options.candidateConfig,
          })
        ) {
          plan.restartChannels.add(channel);
          return;
        }
        let set = restartChannelAccounts.get(channel);
        if (!set) {
          set = new Set<string>();
          restartChannelAccounts.set(channel, set);
        }
        set.add(accountId);
        return;
      }
      plan.restartChannels.add(channel);
      return;
    }
    if (action.startsWith("restart-channel:")) {
      const channel = action.slice("restart-channel:".length) as ChannelId;
      plan.restartChannels.add(channel);
      return;
    }
    switch (action) {
      case "reload-hooks":
        plan.reloadHooks = true;
        break;
      case "refresh-hooks-policy":
        plan.refreshHooksPolicy = true;
        break;
      case "restart-gmail-watcher":
        plan.restartGmailWatcher = true;
        break;
      case "restart-cron":
        plan.restartCron = true;
        break;
      case "restart-heartbeat":
        plan.restartHeartbeat = true;
        break;
      case "reconcile-skill-review-jobs":
        plan.reconcileSkillReviewJobs = true;
        break;
      case "reload-plugins":
        plan.reloadPlugins = true;
        break;
      case "dispose-mcp-runtimes":
        plan.disposeMcpRuntimes = true;
        break;
      default:
        break;
    }
  };

  for (const path of changedPaths) {
    const isTimestampNoop =
      !forceChangedPaths.has(path) &&
      (noopPaths.size > 0 ? noopPaths.has(path) : isPluginInstallTimestampPath(path));
    if (isTimestampNoop) {
      plan.noopPaths.push(path);
      continue;
    }
    const rule = matchRule(path);
    if (!rule) {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    const isCredentialRotation =
      AUTH_CREDENTIAL_PATHS.includes(rule.prefix) &&
      canHotReloadGatewayAuthCredentials(options.previousConfig, options.candidateConfig);
    if (rule.kind === "restart" && !isCredentialRotation) {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "none") {
      plan.noopPaths.push(path);
      continue;
    }
    plan.hotReasons.push(path);
    for (const action of rule.actions ?? []) {
      applyAction(action, path, rule.accountScopedPlugin);
    }
  }

  // A wholesale restart covers its account targets and must run only once.
  for (const channel of plan.restartChannels) {
    restartChannelAccounts.delete(channel);
  }

  if (plan.restartGmailWatcher) {
    plan.reloadHooks = true;
  }

  return plan;
}
