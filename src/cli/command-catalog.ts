export type CliCommandPluginLoadPolicy = "never" | "always" | "text-only";
export type CliRouteConfigGuardPolicy = "never" | "always" | "when-suppressed";
export type CliRoutedCommandId =
  | "health"
  | "status"
  | "gateway-status"
  | "sessions"
  | "agents-list"
  | "config-get"
  | "config-unset"
  | "models-list"
  | "models-status"
  | "channels-list"
  | "channels-status";

export type CliCommandPathPolicy = {
  bypassConfigGuard: boolean;
  routeConfigGuard: CliRouteConfigGuardPolicy;
  loadPlugins: CliCommandPluginLoadPolicy;
  hideBanner: boolean;
  ensureCliPath: boolean;
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
  { commandPath: ["agent"], policy: { loadPlugins: "always" } },
  { commandPath: ["message"], policy: { loadPlugins: "always" } },
  { commandPath: ["channels"], policy: { loadPlugins: "always" } },
  { commandPath: ["directory"], policy: { loadPlugins: "always" } },
  { commandPath: ["agents"], policy: { loadPlugins: "always" } },
  { commandPath: ["configure"], policy: { loadPlugins: "always" } },
  {
    commandPath: ["status"],
    policy: {
      loadPlugins: "never",
      routeConfigGuard: "when-suppressed",
      ensureCliPath: false,
    },
    route: { id: "status" },
  },
  {
    commandPath: ["health"],
    policy: { loadPlugins: "never", ensureCliPath: false },
    route: { id: "health" },
  },
  {
    commandPath: ["gateway", "status"],
    exact: true,
    policy: { routeConfigGuard: "always" },
    route: { id: "gateway-status" },
  },
  {
    commandPath: ["sessions"],
    exact: true,
    policy: { ensureCliPath: false },
    route: { id: "sessions" },
  },
  {
    commandPath: ["agents", "list"],
    route: { id: "agents-list" },
  },
  {
    commandPath: ["config", "get"],
    exact: true,
    policy: { ensureCliPath: false },
    route: { id: "config-get" },
  },
  {
    commandPath: ["config", "unset"],
    exact: true,
    policy: { ensureCliPath: false },
    route: { id: "config-unset" },
  },
  {
    commandPath: ["models", "list"],
    exact: true,
    policy: { ensureCliPath: false },
    route: { id: "models-list" },
  },
  {
    commandPath: ["models", "status"],
    exact: true,
    policy: { ensureCliPath: false },
    route: { id: "models-status" },
  },
  { commandPath: ["backup"], policy: { bypassConfigGuard: true } },
  { commandPath: ["doctor"], policy: { bypassConfigGuard: true } },
  {
    commandPath: ["completion"],
    policy: {
      bypassConfigGuard: true,
      hideBanner: true,
    },
  },
  { commandPath: ["secrets"], policy: { bypassConfigGuard: true } },
  { commandPath: ["update"], policy: { hideBanner: true } },
  {
    commandPath: ["config", "validate"],
    exact: true,
    policy: { bypassConfigGuard: true },
  },
  {
    commandPath: ["config", "schema"],
    exact: true,
    policy: { bypassConfigGuard: true },
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
    policy: { loadPlugins: "never" },
  },
  {
    commandPath: ["channels", "status"],
    exact: true,
    policy: { loadPlugins: "never" },
    route: { id: "channels-status" },
  },
  {
    commandPath: ["channels", "list"],
    exact: true,
    policy: { loadPlugins: "never" },
    route: { id: "channels-list" },
  },
];
