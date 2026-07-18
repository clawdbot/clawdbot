// OpenClaw operation grammar, approval descriptions, and public types.
import type { ConfigSetOptions } from "../cli/config-set-input.js";
import type { DoctorOptions } from "../commands/doctor.types.js";
import { isSensitiveConfigPath } from "../config/sensitive-paths.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TuiResult } from "../tui/tui-types.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { isReservedSystemAgentId } from "./agent-id.js";
import type { SystemAgentOperation } from "./operation-types.js";
import type { SystemAgentOverview } from "./overview.js";
import { validateSystemAgentPluginInstallSpec } from "./plugin-install.js";

type SystemAgentOverviewLoader = () => Promise<SystemAgentOverview>;
type SystemAgentOverviewFormatter = (overview: SystemAgentOverview) => string;

export type { SystemAgentOperation };

/** Result returned by the operation executor. */
export type SystemAgentOperationResult = {
  applied: boolean;
  /** Setup created or preserved BOOTSTRAP.md for the agent's first turn. */
  bootstrapPending?: boolean;
  exitsInteractive?: boolean;
  message?: string;
  nextInput?: string;
  /** Agent TUI exited via /openclaw: re-enter the shell even without a request. */
  returnToShell?: boolean;
  followUp?: Extract<SystemAgentOperation, { kind: "model-setup" }>;
};

/** Injectable command dependencies used by tests and alternate runners. */
export type SystemAgentCommandDeps = {
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
  ensureAuthProfileStore?: typeof import("../agents/auth-profiles/store.js").ensureAuthProfileStore;
  resolveCliAuthBindingFingerprint?: typeof import("../agents/cli-auth-epoch.js").resolveCliAuthBindingFingerprint;
  resolveApiKeyForProvider?: typeof import("../agents/model-auth.js").resolveApiKeyForProvider;
  formatOverview?: SystemAgentOverviewFormatter;
  loadOverview?: SystemAgentOverviewLoader;
  runAgentsAdd?: (
    opts: {
      name?: string;
      workspace?: string;
      model?: string;
      nonInteractive?: boolean;
      json?: boolean;
    },
    runtime: RuntimeEnv,
    params?: { hasFlags?: boolean },
  ) => Promise<void>;
  runConfigSet?: (opts: {
    path?: string;
    value?: string;
    cliOptions: ConfigSetOptions;
  }) => Promise<void>;
  runDoctor?: (runtime: RuntimeEnv, options: DoctorOptions) => Promise<void>;
  runGatewayRestart?: () => Promise<void | boolean>;
  runGatewayStart?: () => Promise<void>;
  runGatewayStop?: () => Promise<void>;
  runPluginInstall?: (spec: string, runtime: RuntimeEnv) => Promise<void>;
  runPluginUninstall?: (pluginId: string, runtime: RuntimeEnv) => Promise<void>;
  runPluginsList?: (runtime: RuntimeEnv) => Promise<void>;
  runPluginsSearch?: (query: string, runtime: RuntimeEnv) => Promise<void>;
  runTui?: (opts: {
    local: boolean;
    session?: string;
    deliver?: boolean;
    historyLimit?: number;
    message?: string;
  }) => Promise<TuiResult | void>;
  /** Where setup side effects run; the gateway surface never manages its own daemon. */
  setupSurface?: "cli" | "gateway";
  applySetup?: typeof import("./setup-apply.js").applySystemAgentSetup;
  verifyInferenceConfig?: typeof import("./setup-inference.js").verifySetupInferenceConfig;
  listChannelSetupPlugins?: typeof import("../channels/plugins/setup-registry.js").listChannelSetupPlugins;
  resolveChannelSetupEntries?: typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
  isChannelConfigured?: typeof import("../config/channel-configured-shared.js").isStaticallyChannelConfigured;
};

// Grammar tokens. Workspace/path tokens accept quoted strings so paths with
// spaces survive; model refs and ids stay single tokens.
const ARG_WORD = String.raw`(?:"[^"]+"|'[^']+'|\S+)`;
const CONFIG_PATH = String.raw`[A-Za-z0-9_.[\]-]+`;

// Every command pattern is anchored to the whole input. Optional clauses use a
// fixed order (workspace before model) so filler words never become values.
const CONFIG_SET_RE = new RegExp(
  String.raw`^(?:config\s+set|set\s+config)\s+(?<path>${CONFIG_PATH})\s+(?<value>.+)$`,
  "i",
);
const CONFIG_GET_RE = new RegExp(String.raw`^config\s+get\s+(?<path>${CONFIG_PATH})$`, "i");
const CONFIG_SCHEMA_RE = new RegExp(
  String.raw`^config\s+schema(?:\s+(?<path>${CONFIG_PATH}))?$`,
  "i",
);
const CONFIG_SET_REF_RE = new RegExp(
  String.raw`^(?:config\s+set-ref|set\s+secretref|set\s+secret\s+ref)\s+(?<path>${CONFIG_PATH})\s+(?:(?<source>env|file|exec)\s+)?(?<id>\S+)(?:\s+provider\s+(?<provider>[A-Za-z0-9_-]+))?$`,
  "i",
);
const SETUP_RE = new RegExp(
  String.raw`^(?:setup|set\s+me\s+up|set\s+up\s+openclaw|onboard(?:\s+me)?|bootstrap|first\s+run)(?:\s+workspace\s+(?<workspace>${ARG_WORD}))?(?:\s+model\s+(?<model>\S+))?$`,
  "i",
);
const MODEL_SETUP_RE = new RegExp(
  String.raw`^(?:configure\s+(?:a\s+)?model\s+provider|set\s*up\s+(?:a\s+)?model\s+provider|model\s+setup)(?:\s+workspace\s+(?<workspace>${ARG_WORD}))?$`,
  "i",
);
const CREATE_AGENT_RE = new RegExp(
  String.raw`^(?:create|add|set\s*up|new)\s+(?:(?:an?|new|my)\s+)?agent\s+(?<agent>[a-z0-9_-]+)(?:\s+workspace\s+(?<workspace>${ARG_WORD}))?(?:\s+model\s+(?<model>\S+))?$`,
  "i",
);
// "talk to agent for ~/Projects/work" is a documented selector; "for|in" are
// only valid here, after the literal word "agent", never as generic fillers.
const TALK_AGENT_RE = new RegExp(
  String.raw`^(?:talk\s+to|switch\s+to|open|enter)\s+(?:(?:my|the)\s+)?(?:(?<agent>[a-z0-9_-]+)\s+)?agent(?:\s+(?:for|in|workspace)\s+(?<workspace>${ARG_WORD}))?$`,
  "i",
);
const SET_MODEL_RE =
  /^(?:set|configure|use)\s+(?:the\s+)?(?:default\s+)?models?\s+(?<model>\S+)(?:\s+for\s+agent\s+(?<agent>\S+))?$/i;
const GATEWAY_RE =
  /^(?:gateway\s+(?<sub>status|start|stop|restart)|(?<verb>start|stop|restart)\s+(?:the\s+)?gateway)$/i;
const PLUGIN_LIST_RE = /^(?:(?:plugins?|clawhub)\s+list|list\s+plugins?)$/i;
const PLUGIN_SEARCH_RE =
  /^(?:(?:plugins?|clawhub)\s+search|search\s+plugins?(?:\s+for)?)\s+(?<query>.+)$/i;
const PLUGIN_INSTALL_RE =
  /^(?:plugins?\s+install|install\s+(?:(?<source>npm|clawhub)\s+)?plugins?)\s+(?<spec>\S+)$/i;
const PLUGIN_UNINSTALL_RE =
  /^(?:plugins?\s+(?:uninstall|remove)|(?:uninstall|remove)\s+plugins?)\s+(?<pluginId>[A-Za-z0-9_.@/-]+)$/i;
const CHANNEL_LIST_RE = /^(?:channels|list\s+channels|show\s+channels)$/i;
const CHANNEL_CONNECT_RE =
  /^(?:connect|link)\s+(?:channel\s+)?(?:to\s+)?(?<channel>[a-z0-9_-]+)(?:\s+channel)?$/i;
const CHANNEL_INFO_RE =
  /^(?:channel\s+info\s+(?<channel>[a-z0-9_-]+)|about\s+(?<aboutChannel>[a-z0-9_-]+)\s+channel)$/i;
const OPEN_GUIDED_SETUP_RE =
  /^(?:open\s+setup\s+wizard|setup\s+wizard|menu\s+setup|use\s+the\s+(?:setup\s+)?wizard)$/i;
const OPEN_CLASSIC_SETUP_RE = /^(?:open\s+classic(?:\s+setup)?\s+wizard|classic\s+setup)$/i;
const OPEN_CHANNEL_SETUP_RE = /^open\s+channel\s+wizard(?:\s+for\s+(?<channel>[a-z0-9_-]+))?$/i;

const NO_MATCH_MESSAGE =
  "I can run doctor/status/health, check or restart Gateway, list agents/models, configure a model provider, set default model, connect channels (`connect telegram`), show `channel info <channel>`, open the setup wizard, show audit, or switch to your agent TUI.";
/**
 * Parse one user command into OpenClaw's closed operation union. Anything
 * that does not match the anchored grammar exactly returns kind "none" so the
 * caller can route it to the system agent (or show guidance).
 */
export function parseSystemAgentOperation(input: string): SystemAgentOperation {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) {
    return {
      kind: "none",
      message: "Tiny claw tap: say status, doctor, models, agents, or talk to agent.",
    };
  }
  if (["help", "?", "overview", "system"].includes(lower)) {
    return { kind: "overview" };
  }
  switch (lower) {
    case "audit":
    case "audit log":
    case "show audit":
      return { kind: "audit" };
    case "status":
      return { kind: "status" };
    case "health":
      return { kind: "health" };
    case "doctor":
      return { kind: "doctor" };
    case "doctor fix":
    case "doctor repair":
      return { kind: "doctor-fix" };
    case "config validate":
    case "validate config":
      return { kind: "config-validate" };
    case "agents":
    case "list agents":
      return { kind: "agents" };
    case "models":
    case "list models":
      return { kind: "models" };
    case "tui":
    case "open tui":
    case "chat":
      return { kind: "open-tui" };
    case "quit":
    case "exit":
      return { kind: "none", message: "OpenClaw retracts into shell. Bye." };
    default:
      break;
  }
  const configSetRefMatch = trimmed.match(CONFIG_SET_REF_RE);
  if (configSetRefMatch?.groups?.path && configSetRefMatch.groups.id?.trim()) {
    // SecretRef commands store references only; raw secret values are never embedded here.
    const source = configSetRefMatch.groups.source?.toLowerCase() ?? "env";
    return {
      kind: "config-set-ref",
      path: configSetRefMatch.groups.path,
      source: source as "env" | "file" | "exec",
      id: configSetRefMatch.groups.id.trim(),
      ...(configSetRefMatch.groups.provider ? { provider: configSetRefMatch.groups.provider } : {}),
    };
  }
  const configSetMatch = trimmed.match(CONFIG_SET_RE);
  if (configSetMatch?.groups?.path && configSetMatch.groups.value?.trim()) {
    return {
      kind: "config-set",
      path: configSetMatch.groups.path,
      value: configSetMatch.groups.value.trim(),
    };
  }
  const configGetMatch = trimmed.match(CONFIG_GET_RE);
  if (configGetMatch?.groups?.path) {
    return { kind: "config-get", path: configGetMatch.groups.path };
  }
  const configSchemaMatch = trimmed.match(CONFIG_SCHEMA_RE);
  if (configSchemaMatch) {
    const path = configSchemaMatch.groups?.path?.trim();
    return { kind: "config-schema", ...(path ? { path } : {}) };
  }
  if (PLUGIN_LIST_RE.test(trimmed)) {
    return { kind: "plugin-list" };
  }
  const pluginSearchMatch = trimmed.match(PLUGIN_SEARCH_RE);
  if (pluginSearchMatch?.groups?.query?.trim()) {
    return { kind: "plugin-search", query: pluginSearchMatch.groups.query.trim() };
  }
  const pluginInstallMatch = trimmed.match(PLUGIN_INSTALL_RE);
  if (pluginInstallMatch?.groups?.spec?.trim()) {
    const spec = normalizePluginInstallSpec(
      pluginInstallMatch.groups.spec.trim(),
      pluginInstallMatch.groups.source,
    );
    const validationError = validateSystemAgentPluginInstallSpec(spec);
    if (validationError) {
      return { kind: "none", message: validationError };
    }
    return { kind: "plugin-install", spec };
  }
  const pluginUninstallMatch = trimmed.match(PLUGIN_UNINSTALL_RE);
  if (pluginUninstallMatch?.groups?.pluginId?.trim()) {
    return { kind: "plugin-uninstall", pluginId: pluginUninstallMatch.groups.pluginId.trim() };
  }
  if (CHANNEL_LIST_RE.test(trimmed)) {
    return { kind: "channel-list" };
  }
  const channelInfoMatch = trimmed.match(CHANNEL_INFO_RE);
  const channelInfo = channelInfoMatch?.groups?.channel ?? channelInfoMatch?.groups?.aboutChannel;
  if (channelInfo) {
    return { kind: "channel-info", channel: channelInfo.toLowerCase() };
  }
  const channelConnectMatch = trimmed.match(CHANNEL_CONNECT_RE);
  if (channelConnectMatch?.groups?.channel) {
    return { kind: "channel-setup", channel: channelConnectMatch.groups.channel.toLowerCase() };
  }
  const modelSetupMatch = trimmed.match(MODEL_SETUP_RE);
  if (modelSetupMatch) {
    const workspace = trimShellishToken(modelSetupMatch.groups?.workspace);
    return {
      kind: "model-setup",
      ...(workspace ? { workspace } : {}),
    };
  }
  if (OPEN_GUIDED_SETUP_RE.test(trimmed)) {
    return { kind: "open-setup", target: "guided" };
  }
  if (OPEN_CLASSIC_SETUP_RE.test(trimmed)) {
    return { kind: "open-setup", target: "classic" };
  }
  const openChannelSetupMatch = trimmed.match(OPEN_CHANNEL_SETUP_RE);
  if (openChannelSetupMatch) {
    const channel = openChannelSetupMatch.groups?.channel?.toLowerCase();
    return {
      kind: "open-setup",
      target: "channels",
      ...(channel ? { channel } : {}),
    };
  }
  const setupMatch = trimmed.match(SETUP_RE);
  if (setupMatch) {
    const workspace = trimShellishToken(setupMatch.groups?.workspace);
    const model = setupMatch.groups?.model;
    return {
      kind: "setup",
      ...(workspace ? { workspace } : {}),
      ...(model ? { model } : {}),
    };
  }
  const gatewayMatch = trimmed.match(GATEWAY_RE);
  if (gatewayMatch) {
    const action = (gatewayMatch.groups?.sub ?? gatewayMatch.groups?.verb ?? "").toLowerCase();
    if (action === "start") {
      return { kind: "gateway-start" };
    }
    if (action === "stop") {
      return { kind: "gateway-stop" };
    }
    if (action === "restart") {
      return { kind: "gateway-restart" };
    }
    return { kind: "gateway-status" };
  }
  const createMatch = trimmed.match(CREATE_AGENT_RE);
  if (createMatch?.groups?.agent) {
    const workspace = trimShellishToken(createMatch.groups.workspace);
    const model = createMatch.groups.model;
    return {
      kind: "create-agent",
      agentId: normalizeAgentId(createMatch.groups.agent),
      ...(workspace ? { workspace } : {}),
      ...(model ? { model } : {}),
    };
  }
  const talkMatch = trimmed.match(TALK_AGENT_RE);
  if (talkMatch) {
    const workspace = trimShellishToken(talkMatch.groups?.workspace);
    return {
      kind: "open-tui",
      ...(talkMatch.groups?.agent ? { agentId: talkMatch.groups.agent } : {}),
      ...(workspace ? { workspace } : {}),
    };
  }
  const setModelMatch = trimmed.match(SET_MODEL_RE);
  if (setModelMatch?.groups?.model) {
    const agent = setModelMatch.groups.agent?.trim();
    return {
      kind: "set-default-model",
      model: setModelMatch.groups.model,
      ...(agent ? { agentId: normalizeAgentId(agent) } : {}),
    };
  }
  return { kind: "none", message: NO_MATCH_MESSAGE };
}

function trimShellishToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || undefined;
  }
  return trimmed;
}

function normalizePluginInstallSpec(spec: string, source: string | undefined): string {
  const trimmed = spec.trim();
  const normalizedSource = source?.toLowerCase();
  if (normalizedSource === "npm" && !trimmed.toLowerCase().startsWith("npm:")) {
    return `npm:${trimmed}`;
  }
  if (normalizedSource === "clawhub" && !trimmed.toLowerCase().startsWith("clawhub:")) {
    return `clawhub:${trimmed}`;
  }
  return trimmed;
}

/**
 * Return whether an operation can change local state or process lifecycle.
 * Guided setup operations are intentionally absent: starting a wizard is not
 * itself a write; the wizard owns approval and persistence for its answers.
 */
export function isPersistentSystemAgentOperation(operation: SystemAgentOperation): boolean {
  return (
    operation.kind === "set-default-model" ||
    operation.kind === "config-set" ||
    operation.kind === "config-set-ref" ||
    operation.kind === "setup" ||
    operation.kind === "plugin-install" ||
    operation.kind === "plugin-uninstall" ||
    (operation.kind === "create-agent" &&
      !operation.model?.trim() &&
      !isReservedSystemAgentId(operation.agentId)) ||
    operation.kind === "gateway-start" ||
    operation.kind === "gateway-stop" ||
    operation.kind === "gateway-restart"
  );
}

/** Format a user-facing description for an operation requiring approval. */
export function describeSystemAgentPersistentOperation(operation: SystemAgentOperation): string {
  switch (operation.kind) {
    case "set-default-model":
      return operation.agentId
        ? `set agent ${operation.agentId}'s model to ${operation.model}`
        : `set agents.defaults.model.primary to ${operation.model}`;
    case "config-set":
      return `set config ${operation.path} to ${formatConfigSetValueForPlan(operation.path, operation.value)}`;
    case "config-set-ref":
      return `set config ${operation.path} to ${operation.source} SecretRef ${operation.source === "env" ? operation.id : "<redacted>"}`;
    case "setup":
      return formatSetupPlanDescription(operation);
    case "model-setup":
      return "configure a model provider and default model";
    case "doctor-fix":
      return "exit OpenClaw and run openclaw doctor --fix";
    case "plugin-install":
      return `install plugin ${operation.spec}`;
    case "plugin-uninstall":
      return `uninstall plugin ${operation.pluginId}`;
    case "create-agent":
      return `create agent ${operation.agentId} with workspace ${formatCreateAgentWorkspace(operation.workspace)}`;
    case "gateway-start":
      return "start the Gateway";
    case "gateway-stop":
      return "stop the Gateway";
    case "gateway-restart":
      return "restart the Gateway";
    default:
      return "apply this action";
  }
}

/** Format the standard approval plan text for a persistent operation. */
export function formatSystemAgentPersistentPlan(operation: SystemAgentOperation): string {
  return `Plan: ${describeSystemAgentPersistentOperation(operation)}. Say yes to apply.`;
}

function formatCreateAgentWorkspace(workspace: string | undefined): string {
  return workspace ? shortenHomePath(resolveUserPath(workspace)) : shortenHomePath(process.cwd());
}

function formatConfigSetValueForPlan(configPath: string, value: string): string {
  if (isSensitiveConfigPath(configPath)) {
    return "<redacted>";
  }
  return value;
}

function formatSetupPlanDescription(
  operation: Extract<SystemAgentOperation, { kind: "setup" }>,
): string {
  const workspace = shortenHomePath(resolveUserPath(operation.workspace ?? process.cwd()));
  return `bootstrap OpenClaw setup for workspace ${workspace}`;
}
