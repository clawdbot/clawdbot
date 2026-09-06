// Declarative CLI command catalog for startup policy and fast-path routing.
import { hasFlag } from "./argv.js";

export type CliCommandPluginLoadPolicy =
  | "never"
  | "always"
  | "text-only"
  | ((ctx: { argv: string[]; commandPath: string[]; jsonOutputMode: boolean }) => boolean);
type CliConfigGuardMode = "run" | "skip" | "validate" | "when-suppressed";
type CliConfigGuardPolicy =
  | CliConfigGuardMode
  | ((ctx: { argv: string[]; commandPath: string[] }) => CliConfigGuardMode);
export type CliPluginRegistryScope =
  | "all"
  | "channels"
  | "configured-channels"
  | "memory"
  | "sandbox-backends"
  | "sandbox-management";
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
  | "gateway-health"
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
  | "channels-status"
  | "plugins-list";

export type CliCommandPathPolicy = {
  configGuard: CliConfigGuardPolicy;
  stateStoreGuard: "run" | "skip";
  loadPlugins: CliCommandPluginLoadPolicy;
  pluginRegistry: CliPluginRegistryPolicy;
  ownsProtocolStdout: boolean;
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

function hasCliOption(argv: readonly string[], name: string): boolean {
  for (const arg of argv.slice(2)) {
    if (arg === "--") {
      return false;
    }
    if (arg === name || arg.startsWith(`${name}=`)) {
      return true;
    }
  }
  return false;
}

// These commands own their state boundary; bootstrap must not observe or initialize it first.
const PASSIVE_STARTUP_POLICY = {
  configGuard: "skip",
  loadPlugins: "never",
  ensureCliPath: false,
  networkProxy: "bypass",
} satisfies Partial<CliCommandPathPolicy>;

/** Command path registry used before Commander registration has loaded all plugins. */
export const cliCommandCatalog: readonly CliCommandCatalogEntry[] = [
  {
    commandPath: ["setup"],
    policy: { configGuard: "skip", loadPlugins: "never", ensureCliPath: false },
  },
  {
    commandPath: ["qa"],
    // Private QA commands create or inspect repo-owned fixtures. They must not
    // read, validate, migrate, or inherit proxy policy from operator state.
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["database"],
    // Release-local database inspection must not observe default state or load runtime policy.
    policy: { ...PASSIVE_STARTUP_POLICY, hideBanner: true },
  },
  {
    commandPath: ["crestodian"], // hidden alias
    policy: { configGuard: "skip", loadPlugins: "never", ensureCliPath: false },
  },
  {
    commandPath: ["agent"],
    policy: {
      configGuard: ({ argv }) => (hasFlag(argv, "--local") ? "run" : "skip"),
      loadPlugins: ({ argv }) => hasFlag(argv, "--local"),
      pluginRegistry: { scope: "all" },
      networkProxy: ({ argv }) => (hasFlag(argv, "--local") ? "default" : "bypass"),
    },
  },
  {
    commandPath: ["agent", "exec"],
    policy: {
      configGuard: "skip",
      loadPlugins: "never",
      ownsProtocolStdout: true,
      hideBanner: true,
      networkProxy: "default",
    },
  },
  { commandPath: ["message"], policy: { loadPlugins: "never" } },
  { commandPath: ["docs"], policy: { configGuard: "skip" } },
  // Destructive maintenance owns a validity-aware, non-observing config read.
  // Startup migrations would mutate the SQLite state these commands may refuse to remove.
  { commandPath: ["reset"], policy: { configGuard: "skip" } },
  { commandPath: ["uninstall"], policy: { configGuard: "skip" } },
  {
    commandPath: ["channels"],
    policy: {
      loadPlugins: "always",
      pluginRegistry: { scope: "configured-channels" },
    },
  },
  { commandPath: ["directory"], policy: { loadPlugins: "always" } },
  {
    commandPath: ["sandbox"],
    policy: {
      loadPlugins: ({ argv, commandPath }) =>
        !(
          (commandPath[1] === "list" || commandPath[1] === "recreate") &&
          hasFlag(argv, "--browser")
        ),
      pluginRegistry: { scope: "sandbox-backends" },
    },
  },
  {
    commandPath: ["sandbox", "list"],
    policy: { pluginRegistry: { scope: "sandbox-management" } },
  },
  {
    commandPath: ["sandbox", "recreate"],
    policy: { pluginRegistry: { scope: "sandbox-management" } },
  },
  { commandPath: ["agents"], policy: { loadPlugins: "always", networkProxy: "bypass" } },
  {
    commandPath: ["agents"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
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
    policy: { configGuard: "skip", loadPlugins: "never" },
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
  {
    commandPath: ["configure"],
    policy: { configGuard: "skip", stateStoreGuard: "run", loadPlugins: "never" },
  },
  {
    commandPath: ["config"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  ...["create", "validate", "build", "dev"].map((subcommand): CliCommandCatalogEntry => ({
    commandPath: ["claws", subcommand],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  })),
  {
    commandPath: ["migrate"],
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["status"],
    policy: {
      configGuard: "skip",
      loadPlugins: "never",
      pluginRegistry: { scope: "channels" },
      ensureCliPath: false,
      networkProxy: "bypass",
    },
    route: { id: "status" },
  },
  {
    commandPath: ["telemetry"],
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["health"],
    policy: {
      configGuard: "skip",
      loadPlugins: "never",
      pluginRegistry: { scope: "channels" },
      ensureCliPath: false,
      networkProxy: "bypass",
    },
    route: { id: "health" },
  },
  {
    commandPath: ["audit"],
    policy: { ...PASSIVE_STARTUP_POLICY },
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
      configGuard: "skip",
      loadPlugins: "never",
      networkProxy: "bypass",
    },
    route: { id: "gateway-status" },
  },
  ...["call", "restart", "suspend", "resume"].map((subcommand): CliCommandCatalogEntry => ({
    commandPath: ["gateway", subcommand],
    exact: true,
    policy: { configGuard: "validate", loadPlugins: "never", networkProxy: "bypass" },
  })),
  {
    commandPath: ["gateway", "diagnostics"],
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  { commandPath: ["gateway", "discover"], exact: true, policy: { networkProxy: "bypass" } },
  {
    commandPath: ["gateway", "health"],
    exact: true,
    // The routed JSON command owns its config read; running the startup guard first
    // duplicates config/state initialization before the health socket can open.
    policy: { configGuard: "skip", networkProxy: "bypass" },
    route: { id: "gateway-health" },
  },
  { commandPath: ["gateway", "install"], exact: true, policy: { networkProxy: "bypass" } },
  { commandPath: ["gateway", "probe"], exact: true, policy: { networkProxy: "bypass" } },
  {
    commandPath: ["gateway", "stability"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  { commandPath: ["gateway", "start"], exact: true, policy: { networkProxy: "bypass" } },
  {
    commandPath: ["gateway", "stop"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  { commandPath: ["gateway", "uninstall"], exact: true, policy: { networkProxy: "bypass" } },
  {
    commandPath: ["gateway", "usage-cost"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["sessions"],
    exact: true,
    policy: {
      configGuard: "skip",
      ensureCliPath: false,
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    },
    route: { id: "sessions" },
  },
  {
    commandPath: ["agents", "list"],
    // Output combines config with shared-state provenance and optional read-only
    // channel metadata, so the route should not preload bundled plugin runtimes.
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
    route: { id: "agents-list" },
  },
  {
    commandPath: ["config", "file"],
    exact: true,
    // A path query must work before config validation and must not initialize state.
    policy: {
      configGuard: "skip",
      ensureCliPath: false,
      loadPlugins: "never",
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    },
  },
  {
    commandPath: ["config", "get"],
    exact: true,
    policy: {
      configGuard: "skip",
      ensureCliPath: false,
      networkProxy: "bypass",
    },
    route: { id: "config-get" },
  },
  {
    commandPath: ["config", "unset"],
    exact: true,
    policy: { configGuard: "run", ensureCliPath: false, networkProxy: "bypass" },
    route: { id: "config-unset" },
  },
  {
    commandPath: ["models"],
    exact: true,
    policy: { ...PASSIVE_STARTUP_POLICY },
    route: { id: "models-status" },
  },
  // Default-policy children must remain distinct from the passive parent action.
  ...["refresh", "set", "set-image", "aliases", "fallbacks", "image-fallbacks", "scan"].map(
    (subcommand): CliCommandCatalogEntry => ({ commandPath: ["models", subcommand] }),
  ),
  { commandPath: ["models", "auth"], policy: { stateStoreGuard: "run" } },
  {
    commandPath: ["models", "accounts"],
    // Personal credentials belong to the selected Gateway, not local model state.
    policy: { ...PASSIVE_STARTUP_POLICY },
  },
  {
    commandPath: ["models", "list"],
    exact: true,
    policy: { configGuard: "skip", ensureCliPath: false, networkProxy: "bypass" },
    route: { id: "models-list" },
  },
  {
    commandPath: ["models", "status"],
    exact: true,
    policy: {
      ensureCliPath: false,
      configGuard: "skip",
      loadPlugins: "never",
      networkProxy: ({ argv }) => (hasFlag(argv, "--probe") ? "default" : "bypass"),
    },
    route: { id: "models-status" },
  },
  {
    commandPath: ["tasks", "list"],
    exact: true,
    policy: {
      configGuard: "skip",
      ensureCliPath: false,
      loadPlugins: "never",
      networkProxy: "bypass",
    },
    route: { id: "tasks-list" },
  },
  {
    commandPath: ["tasks", "audit"],
    exact: true,
    policy: {
      configGuard: "skip",
      ensureCliPath: false,
      loadPlugins: "never",
      networkProxy: "bypass",
    },
    route: { id: "tasks-audit" },
  },
  {
    commandPath: ["tasks"],
    policy: {
      configGuard: "skip",
      ensureCliPath: false,
      loadPlugins: "never",
      networkProxy: "bypass",
    },
    route: { id: "tasks-list" },
  },
  {
    // This unregistered root is reserved so plugin registration cannot claim it;
    // the catalog entry preserves its startup policy.
    commandPath: ["tool"],
    policy: { loadPlugins: "never", ensureCliPath: false, networkProxy: "bypass" },
  },
  {
    // This unregistered root is reserved so plugin registration cannot claim it;
    // the catalog entry preserves its startup policy.
    commandPath: ["tools"],
    policy: { loadPlugins: "never", ensureCliPath: false, networkProxy: "bypass" },
  },
  { commandPath: ["acp"], policy: { networkProxy: "bypass" } },
  {
    commandPath: ["acp"],
    exact: true,
    policy: { ownsProtocolStdout: true },
  },
  { commandPath: ["approvals"], policy: { networkProxy: "bypass" } },
  {
    commandPath: ["approvals", "pending"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  // automations is a commander alias for cron; argv-derived command paths keep the typed token.
  {
    commandPath: ["automations"],
    policy: { configGuard: "skip", networkProxy: "bypass" },
  },
  { commandPath: ["backup"], policy: { configGuard: "skip", networkProxy: "bypass" } },
  { commandPath: ["chat"], policy: { networkProxy: "bypass" } },
  { commandPath: ["config"], policy: { networkProxy: "bypass" } },
  { commandPath: ["cron"], policy: { configGuard: "skip", networkProxy: "bypass" } },
  { commandPath: ["dashboard"], policy: { networkProxy: "bypass" } },
  { commandPath: ["daemon"], policy: { networkProxy: "bypass" } },
  {
    commandPath: ["devices"],
    // Every devices subcommand either dispatches to the Gateway or uses the
    // explicit local pairing fallback. None should observe canonical state
    // before the Gateway-owned mutation runs.
    policy: { configGuard: "validate", networkProxy: "bypass" },
  },
  {
    commandPath: ["worktrees"],
    policy: { loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["fleet"],
    policy: { loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["doctor"],
    policy: {
      configGuard: "skip",
      loadPlugins: "never",
      // Shared-state maintenance must acquire exclusive ownership before any
      // config-health observation can open the canonical SQLite database.
      networkProxy: ({ argv }) => (hasCliOption(argv, "--state-sqlite") ? "bypass" : "default"),
    },
  },
  {
    commandPath: ["triage"],
    policy: { configGuard: "skip", loadPlugins: "never" },
  },
  { commandPath: ["exec-approvals"], policy: { networkProxy: "bypass" } },
  { commandPath: ["exec-policy"], policy: { networkProxy: "bypass" } },
  { commandPath: ["hooks"], policy: { networkProxy: "bypass" } },
  {
    commandPath: ["hooks"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["hooks", "list"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["hooks", "info"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["hooks", "check"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  { commandPath: ["logs"], policy: { networkProxy: "bypass" } },
  { commandPath: ["mcp"], policy: { networkProxy: "bypass" } },
  {
    commandPath: ["mcp", "serve"],
    exact: true,
    policy: { ownsProtocolStdout: true },
  },
  {
    commandPath: ["browser", "extension", "native-host"],
    exact: true,
    policy: { hideBanner: true, ownsProtocolStdout: true, networkProxy: "bypass" },
  },
  {
    commandPath: ["node"],
    policy: { networkProxy: "bypass" },
  },
  // Remote pairing verification owns a read-only identity lookup, including before its action.
  { commandPath: ["node", "identity"], exact: true, policy: PASSIVE_STARTUP_POLICY },
  {
    commandPath: ["node", "worker"],
    exact: true,
    policy: {
      // The app worker owns node startup, not Gateway channel schemas or Doctor preflight.
      configGuard: "validate",
      hideBanner: true,
      loadPlugins: "never",
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    },
  },
  {
    commandPath: ["node", "run"],
    exact: true,
    policy: { networkProxy: "default" },
  },
  {
    commandPath: ["connect"],
    exact: true,
    policy: { networkProxy: "default" },
  },
  {
    commandPath: ["worker"],
    exact: true,
    policy: {
      configGuard: "skip",
      hideBanner: true,
      loadPlugins: "never",
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    },
  },
  { commandPath: ["nodes"], policy: { networkProxy: "bypass" } },
  { commandPath: ["nodes", "status"], exact: true, policy: { configGuard: "skip" } },
  { commandPath: ["nodes", "list"], exact: true, policy: { configGuard: "skip" } },
  // Built-in node commands are Gateway RPCs. Keep their CLI processes off the
  // writable canonical state database, including commands whose RPC mutates
  // Gateway-owned pairing state. Bare and plugin-provided node commands retain
  // the config guard because plugin discovery still needs validated config.
  ...[
    "describe",
    "pending",
    "approve",
    "reject",
    "remove",
    "rename",
    "invoke",
    "notify",
    "push",
    "camera",
    "screen",
    "location",
  ].map((subcommand): CliCommandCatalogEntry => ({
    commandPath: ["nodes", subcommand],
    policy: { configGuard: "validate" },
  })),
  { commandPath: ["pairing"], policy: { networkProxy: "bypass" } },
  { commandPath: ["proxy"], policy: { networkProxy: "bypass" } },
  { commandPath: ["qr"], policy: { networkProxy: "bypass" } },
  { commandPath: ["reset"], policy: { networkProxy: "bypass" } },
  {
    commandPath: ["completion"],
    policy: {
      configGuard: "skip",
      hideBanner: true,
      networkProxy: "bypass",
    },
  },
  { commandPath: ["secrets"], policy: { configGuard: "skip", networkProxy: "bypass" } },
  { commandPath: ["security"], policy: { networkProxy: "bypass" } },
  { commandPath: ["system"], policy: { networkProxy: "bypass" } },
  { commandPath: ["resume"], policy: { networkProxy: "bypass" } },
  { commandPath: ["terminal"], policy: { networkProxy: "bypass" } },
  { commandPath: ["tui"], policy: { networkProxy: "bypass" } },
  { commandPath: ["uninstall"], policy: { networkProxy: "bypass" } },
  {
    commandPath: ["update", "cleanup"],
    exact: true,
    policy: { ...PASSIVE_STARTUP_POLICY, hideBanner: true },
  },
  {
    commandPath: ["update"],
    policy: {
      configGuard: "skip",
      hideBanner: true,
    },
  },
  {
    commandPath: ["config", "validate"],
    exact: true,
    policy: { configGuard: "skip", networkProxy: "bypass" },
  },
  {
    commandPath: ["config", "schema"],
    exact: true,
    policy: { configGuard: "skip", ownsProtocolStdout: true, networkProxy: "bypass" },
  },
  {
    commandPath: ["plugins", "update"],
    exact: true,
    policy: { hideBanner: true },
  },
  {
    commandPath: ["plugins", "list"],
    exact: true,
    policy: {
      configGuard: "skip",
      ensureCliPath: false,
      loadPlugins: "never",
      networkProxy: "bypass",
    },
    route: { id: "plugins-list" },
  },
  // Authoring commands operate on a target package, not operator config, and a
  // scaffolded plugin build can run through an older CLI; the startup guard
  // would abort them on a host config they never read.
  { commandPath: ["plugins", "build"], exact: true, policy: { configGuard: "skip" } },
  { commandPath: ["plugins", "validate"], exact: true, policy: { configGuard: "skip" } },
  { commandPath: ["plugins", "init"], exact: true, policy: { configGuard: "skip" } },
  {
    commandPath: ["onboard"],
    exact: true,
    policy: { loadPlugins: "never" },
  },
  {
    commandPath: ["onboard", "recommendations"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["onboard", "recommendations", "acknowledge"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["onboard", "recommendations", "refresh"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["channels", "add"],
    exact: true,
    policy: { stateStoreGuard: "run", loadPlugins: "never", networkProxy: "bypass" },
  },
  { commandPath: ["channels", "login"], exact: true, policy: { stateStoreGuard: "run" } },
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
      configGuard: "skip",
      loadPlugins: "never",
      networkProxy: ({ argv }) => (hasFlag(argv, "--probe") ? "default" : "bypass"),
    },
    route: { id: "channels-status" },
  },
  {
    commandPath: ["channels", "list"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
    route: { id: "channels-list" },
  },
  {
    commandPath: ["skills"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["skills", "check"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["skills", "info"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  { commandPath: ["skills", "install"], exact: true },
  {
    commandPath: ["skills", "list"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  {
    commandPath: ["skills", "search"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never" },
  },
  {
    commandPath: ["memory"],
    policy: { loadPlugins: "always", pluginRegistry: { scope: "memory" } },
  },
  {
    commandPath: ["memory", "search"],
    exact: true,
    policy: { configGuard: "skip" },
  },
  {
    commandPath: ["memory", "status"],
    exact: true,
    policy: {
      configGuard: ({ argv }) =>
        hasFlag(argv, "--index") || hasFlag(argv, "--fix") ? "run" : "skip",
    },
  },
  { commandPath: ["skills", "update"], exact: true },
  { commandPath: ["skills", "verify"], exact: true },
];
