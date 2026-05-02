import { hasFlag } from "./argv.js";

export type CliCommandPluginLoadPolicy =
  | "never"
  | "always"
  | "text-only"
  | ((ctx: { argv: string[]; commandPath: string[]; jsonOutputMode: boolean }) => boolean);
type CliRouteConfigGuardPolicy = "never" | "always" | "when-suppressed";
export type CliPluginRegistryScope = "all" | "channels" | "configured-channels";
export type CliPluginRegistryPolicy = {
  scope: CliPluginRegistryScope;
};
export type CliNetworkProxyPolicy = "default" | "bypass";
type CliNetworkProxyPolicyResolver =
  | CliNetworkProxyPolicy
  | ((ctx: { argv: string[]; commandPath: string[] }) => CliNetworkProxyPolicy);
type CliRoutedCommandId =
  | "health"
  | "status"
  | "gateway-status"
  | "sessions"
  | "agents-list"
  | "config-get"
  | "config-unset"
  | "models-list"
  | "models-status"
  | "tasks-list"
  | "tasks-audit"
  | "channels-list"
  | "channels-status";

export type CliCommandPathPolicy = {
  bypassConfigGuard: boolean;
  routeConfigGuard: CliRouteConfigGuardPolicy;
  loadPlugins: CliCommandPluginLoadPolicy;
  pluginRegistry: CliPluginRegistryPolicy;
  hideBanner: boolean;
  ensureCliPath: boolean;
  networkProxy: CliNetworkProxyPolicyResolver;
};

export type CliCommandCatalogEntry = {
  commandPath: readonly string[];
  exact?: boolean;
  policy?: Partial<CliCommandPathPolicy>;
  route?: {
    id: CliRoutedCommandId;
    preloadPlugins?: boolean;
  };
};

export const cliCommandCatalog: readonly CliCommandCatalogEntry[] = [
  {
    commandPath: ["crestodian"],
    policy: { bypassConfigGuard: true, loadPlugins: "never", ensureCliPath: false },
  },
  {
    commandPath: ["agent"],
    policy: {
      loadPlugins: ({ argv, jsonOutputMode }) => hasFlag(argv, "--local") || !jsonOutputMode,
      pluginRegistry: { scope: "all" },
      networkProxy: ({ argv }) => (hasFlag(argv, "--local") ? "default" : "bypass"),
    },
  },
  { commandPath: ["message"], policy: { loadPlugins: "never" } },
  {
    commandPath: ["channels"],
    policy: {
      loadPlugins: "always",
      pluginRegistry: { scope: "configured-channels" },
    },
  },
  { commandPath: ["directory"], policy: { loadPlugins: "always" } },
  { commandPath: ["agents"], policy: { loadPlugins: "always", networkProxy: "bypass" } },
  {
    commandPath: ["agents"],
    exact: true,
    policy: { loadPlugins: "never", networkProxy: "bypass" },
    route: { id: "agents-list" },
  },
  {
    commandPath: ["agents", "bind"],
    exact: true,
    policy: { loadPlugins: "never" },
  },
  {
    commandPath: ["agents", "bindings"],
    exact: true,
    policy: { loadPlugins: "never" },
  },
  {
    commandPath: ["agents", "unbind"],
    exact: true,
    policy: { loadPlugins: "never" },
  },
  {
    commandPath: ["agents", "set-identity"],
    exact: true,
    policy: { loadPlugins: "never" },
  },
  {
    commandPath: ["agents", "delete"],
    exact: true,
    policy: { loadPlugins: "never" },
  },
  { commandPath: ["configure"], policy: { bypassConfigGuard: true, loadPlugins: "never" } },
  {
    commandPath: ["migrate"],
    policy: { bypassConfigGuard: true, loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["status"],
    policy: {
      loadPlugins: "never",
      pluginRegistry: { scope: "channels" },
      routeConfigGuard: "when-suppressed",
      ensureCliPath: false,
      networkProxy: "bypass",
    },
    route: { id: "status" },
  },
  {
    commandPath: ["health"],
    policy: {
      loadPlugins: "never",
      pluginRegistry: { scope: "channels" },
      ensureCliPath: false,
      networkProxy: "bypass",
    },
    route: { id: "health" },
  },
  {
    commandPath: ["gateway"],
    policy: {
      networkProxy: ({ commandPath }) =>
        commandPath.length === 1 || commandPath[1] === "run" ? "default" : "bypass",
    },
  },
  {
    commandPath: ["gateway", "status"],
    exact: true,
    policy: {
      routeConfigGuard: "always",
      loadPlugins: "never",
      networkProxy: "bypass",
    },
    route: { id: "gateway-status" },
  },
  { commandPath: ["gateway", "call"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "diagnostics"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "discover"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "export"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "health"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "install"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "probe"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "restart"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "stability"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "start"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "stop"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "uninstall"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "usage-cost"], exact: true, policy: { networkProxy: "bypass" } },
  {
    commandPath: ["sessions"],
    exact: true,
    policy: { ensureCliPath: false, networkProxy: "bypass" },
    route: { id: "sessions" },
  },
  {
    commandPath: ["commitments"],
    policy: {
      ensureCliPath: false,
      routeConfigGuard: "when-suppressed",
      loadPlugins: "never",
      networkProxy: "bypass",
    },
  },
  {
    commandPath: ["agents", "list"],
    // Text and JSON output are derived from config plus read-only channel
    // metadata, so the route should not preload bundled plugin runtimes.
    policy: { loadPlugins: "never", networkProxy: "bypass" },
    route: { id: "agents-list" },
  },
  {
    commandPath: ["config", "get"],
    exact: true,
    policy: { ensureCliPath: false, networkProxy: "bypass" },
    route: { id: "config-get" },
  },
  {
    commandPath: ["config", "unset"],
    exact: true,
    policy: { ensureCliPath: false, networkProxy: "bypass" },
    route: { id: "config-unset" },
  },
  {
    commandPath: ["models", "list"],
    exact: true,
    policy: { ensureCliPath: false, routeConfigGuard: "always", networkProxy: "bypass" },
    route: { id: "models-list" },
  },
  {
    commandPath: ["models", "status"],
    exact: true,
    policy: {
      ensureCliPath: false,
      routeConfigGuard: "always",
      networkProxy: ({ argv }) => (hasFlag(argv, "--probe") ? "default" : "bypass"),
    },
    route: { id: "models-status" },
  },
  {
    commandPath: ["tasks", "list"],
    exact: true,
    policy: {
      ensureCliPath: false,
      routeConfigGuard: "when-suppressed",
      loadPlugins: "never",
      networkProxy: "bypass",
    },
    route: { id: "tasks-list" },
  },
  {
    commandPath: ["tasks", "audit"],
    exact: true,
    policy: {
      ensureCliPath: false,
      routeConfigGuard: "when-suppressed",
      loadPlugins: "never",
      networkProxy: "bypass",
    },
    route: { id: "tasks-audit" },
  },
  {
    commandPath: ["tasks"],
    policy: {
      ensureCliPath: false,
      routeConfigGuard: "when-suppressed",
      loadPlugins: "never",
      networkProxy: "bypass",
    },
    route: { id: "tasks-list" },
  },
  {
    commandPath: ["tool"],
    policy: { loadPlugins: "never", ensureCliPath: false, networkProxy: "bypass" },
  },
  {
    commandPath: ["tools"],
    policy: { loadPlugins: "never", ensureCliPath: false, networkProxy: "bypass" },
  },
  { commandPath: ["acp"], policy: { networkProxy: "bypass" } },
  { commandPath: ["approvals"], policy: { networkProxy: "bypass" } },
  { commandPath: ["backup"], policy: { bypassConfigGuard: true, networkProxy: "bypass" } },
  { commandPath: ["chat"], policy: { networkProxy: "bypass" } },
  { commandPath: ["config"], policy: { networkProxy: "bypass" } },
  { commandPath: ["cron"], policy: { networkProxy: "bypass" } },
  { commandPath: ["dashboard"], policy: { networkProxy: "bypass" } },
  { commandPath: ["daemon"], policy: { networkProxy: "bypass" } },
  { commandPath: ["devices"], policy: { networkProxy: "bypass" } },
  { commandPath: ["doctor"], policy: { bypassConfigGuard: true } },
  { commandPath: ["exec-policy"], policy: { networkProxy: "bypass" } },
  { commandPath: ["hooks"], policy: { networkProxy: "bypass" } },
  { commandPath: ["logs"], policy: { networkProxy: "bypass" } },
  { commandPath: ["mcp"], policy: { networkProxy: "bypass" } },
  {
    commandPath: ["node"],
    policy: { networkProxy: "bypass" },
  },
  {
    commandPath: ["node", "run"],
    exact: true,
    policy: { networkProxy: "default" },
  },
  { commandPath: ["nodes"], policy: { networkProxy: "bypass" } },
  { commandPath: ["pairing"], policy: { networkProxy: "bypass" } },
  { commandPath: ["proxy"], policy: { networkProxy: "bypass" } },
  { commandPath: ["qr"], policy: { networkProxy: "bypass" } },
  { commandPath: ["reset"], policy: { networkProxy: "bypass" } },
  {
    commandPath: ["completion"],
    policy: {
      bypassConfigGuard: true,
      hideBanner: true,
      networkProxy: "bypass",
    },
  },
  { commandPath: ["secrets"], policy: { bypassConfigGuard: true, networkProxy: "bypass" } },
  { commandPath: ["security"], policy: { networkProxy: "bypass" } },
  { commandPath: ["system"], policy: { networkProxy: "bypass" } },
  { commandPath: ["terminal"], policy: { networkProxy: "bypass" } },
  { commandPath: ["tui"], policy: { networkProxy: "bypass" } },
  { commandPath: ["uninstall"], policy: { networkProxy: "bypass" } },
  { commandPath: ["update"], policy: { hideBanner: true } },
  {
    commandPath: ["config", "validate"],
    exact: true,
    policy: { bypassConfigGuard: true, networkProxy: "bypass" },
  },
  {
    commandPath: ["config", "schema"],
    exact: true,
    policy: { bypassConfigGuard: true, networkProxy: "bypass" },
  },
  {
    commandPath: ["plugins", "update"],
    exact: true,
    policy: { hideBanner: true },
  },
  {
    commandPath: ["onboard"],
    exact: true,
    policy: { loadPlugins: "never" },
  },
  {
    commandPath: ["channels", "add"],
    exact: true,
    policy: { loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["channels", "logs"],
    exact: true,
    policy: { loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["channels", "remove"],
    exact: true,
    policy: {
      pluginRegistry: { scope: "configured-channels" },
      networkProxy: "bypass",
    },
  },
  {
    commandPath: ["channels", "resolve"],
    exact: true,
    policy: {
      pluginRegistry: { scope: "configured-channels" },
      networkProxy: "bypass",
    },
  },
  {
    commandPath: ["channels", "status"],
    exact: true,
    policy: {
      loadPlugins: "never",
      networkProxy: ({ argv }) => (hasFlag(argv, "--probe") ? "default" : "bypass"),
    },
    route: { id: "channels-status" },
  },
  {
    commandPath: ["channels", "list"],
    exact: true,
    policy: { loadPlugins: "never", networkProxy: "bypass" },
    route: { id: "channels-list" },
  },
  { commandPath: ["skills"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["skills", "check"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["skills", "info"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["skills", "install"], exact: true },
  { commandPath: ["skills", "list"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["skills", "search"], exact: true },
  { commandPath: ["skills", "update"], exact: true },
];
