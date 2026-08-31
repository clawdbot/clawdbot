// OpenClaw operation grammar, approval descriptions, and public types.
import { parseConfigSetPath } from "../cli/config-cli-path.js";
import type { ConfigSetOptions } from "../cli/config-set-input.js";
import type { DoctorOptions } from "../commands/doctor.types.js";
import { DEFAULT_SECRET_PROVIDER_ALIAS } from "../config/types.secrets.js";
import { normalizeAgentIdStrict } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { isValidSecretRef } from "../secrets/ref-contract.js";
import type { TuiResult } from "../tui/tui-types.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { isReservedSystemAgentId } from "./agent-id.js";
import {
  isSystemAgentSensitiveConfigPathEmbedding,
  isSystemAgentSensitiveConfigValue,
  redactSystemAgentConfigPath,
} from "./config-redaction.js";
import type { SystemAgentOperation } from "./operation-types.js";
import { INVALID_CONFIG_SET_MESSAGE } from "./operations-internal.js";
import type { SystemAgentOverview } from "./overview.js";
import { validateSystemAgentPluginInstallSpec } from "./plugin-install-spec.js";

type SystemAgentOverviewLoader = () => Promise<SystemAgentOverview>;
type SystemAgentOverviewFormatter = (overview: SystemAgentOverview) => string;

export type { SystemAgentOperation };

/** Result returned by the operation executor. */
export type SystemAgentOperationResult = {
  applied: boolean;
  /** Creation created or preserved BOOTSTRAP.md for the agent's first turn. */
  bootstrapPending?: boolean;
  /** Agent created by this operation, when applicable. */
  agentId?: string;
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
  resolveApiKeyForProvider?: typeof import("../agents/model-auth.js").resolveApiKeyForProviderCore;
  formatOverview?: SystemAgentOverviewFormatter;
  loadOverview?: SystemAgentOverviewLoader;
  createAgent?: typeof import("../agents/agent-create.js").createAgent;
  runConfigSet?: (opts: {
    path?: string;
    value?: string;
    cliOptions: ConfigSetOptions;
  }) => Promise<void>;
  runDoctor?: (runtime: RuntimeEnv, options: DoctorOptions) => Promise<void>;
  runGatewayRestart?: () => Promise<void | boolean>;
  runGatewayStart?: () => Promise<void>;
  runGatewayStop?: () => Promise<void>;
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

// Every command pattern is anchored to the whole input. Optional clauses use a
// fixed order (workspace before model) so filler words never become values.
const CONFIG_SET_PREFIX_RE = /^(?:config\s+set|set\s+config)\s+/i;
const CONFIG_SET_REF_PREFIX_RE = /^(?:config\s+set-ref|set\s+secretref|set\s+secret\s+ref)\s+/i;
const CONFIG_GET_PREFIX_RE = /^config\s+get(?=\s|$)/i;
const CONFIG_SCHEMA_PREFIX_RE = /^config\s+schema(?=\s|$)/i;
const CONFIG_SET_REF_ARGS_RE = new RegExp(
  String.raw`^(?:(?<source>env|file|exec|store)\s+)?(?<id>\S+)(?:\s+provider\s+(?<provider>[A-Za-z0-9_-]+))?$`,
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
const SKILLS_SETUP_RE = /^(?:configure|set\s*up|setup)\s+skills$/i;
const SEARCH_SETUP_RE =
  /^(?:(?:configure|set\s*up|setup)\s+(?:web\s+)?search|(?:web\s+)?search\s+provider\s+setup)$/i;
const GATEWAY_CONFIG_SETUP_RE = /^(?:configure\s+gateway|set\s*up\s+gateway|gateway\s+settings)$/i;
const MEMORY_IMPORT_RE = /^(?:import\s+memor(?:y|ies)|memory\s+import)$/i;
const OPEN_GUIDED_SETUP_RE =
  /^(?:open\s+setup\s+wizard|setup\s+wizard|menu\s+setup|use\s+the\s+(?:setup\s+)?wizard)$/i;
const OPEN_CLASSIC_SETUP_RE = /^(?:open\s+classic(?:\s+setup)?\s+wizard|classic\s+setup)$/i;
const OPEN_CHANNEL_SETUP_RE = /^open\s+channel\s+wizard(?:\s+for\s+(?<channel>[a-z0-9_-]+))?$/i;
const OPEN_SEARCH_SETUP_RE = /^open\s+(?:web\s+)?search\s+wizard$/i;
const OPEN_GATEWAY_SETUP_RE = /^open\s+gateway\s+wizard$/i;

const NO_MATCH_MESSAGE =
  "I can run doctor/status/health, check or restart Gateway, configure gateway settings, list agents/models, configure skills or web search, import memory, set default model, connect channels (`connect telegram`), show `channel info <channel>`, open the setup wizard, show audit, or switch to your agent TUI.";

function normalizeExplicitSystemAgentId(agentId: string): string {
  const normalized = normalizeAgentIdStrict(agentId);
  // Preserve an unrepresentable input so the execution owner rejects it instead of targeting main.
  return normalized.ok ? normalized.value : agentId;
}

function parseConfigSetCommand(
  input: string,
): { path: string; value: string; valid: true } | { valid: false } | undefined {
  const prefix = input.match(CONFIG_SET_PREFIX_RE)?.[0];
  if (!prefix) {
    return undefined;
  }
  const body = input.slice(prefix.length);
  for (const separator of body.matchAll(/\s+/gu)) {
    const path = body.slice(0, separator.index);
    const value = body.slice(separator.index).trim();
    if (!value) {
      continue;
    }
    try {
      // Reuse the writer's grammar so quoted/escaped dynamic keys cannot fall
      // through to model-visible text while remaining valid config commands.
      parseConfigSetPath(path);
      if (isSystemAgentSensitiveConfigPathEmbedding(path)) {
        return { valid: false };
      }
      return { path, value, valid: true };
    } catch {
      continue;
    }
  }
  // Keep malformed writes on the host side so their values never reach the
  // model. This outcome is deliberately non-executable.
  return body.trim() ? { valid: false } : undefined;
}

function parseConfigReadPath(
  input: string,
  prefixPattern: RegExp,
  options: { allowEmpty: boolean; allowRoot?: boolean },
): { path?: string; valid: true } | { valid: false } | undefined {
  const prefix = input.match(prefixPattern)?.[0];
  if (!prefix) {
    return undefined;
  }
  const path = input.slice(prefix.length).trim();
  if (!path) {
    return options.allowEmpty ? { valid: true } : { valid: false };
  }
  if (options.allowRoot && path === ".") {
    return { path, valid: true };
  }
  try {
    parseConfigSetPath(path);
    return isSystemAgentSensitiveConfigPathEmbedding(path)
      ? { valid: false }
      : { path, valid: true };
  } catch {
    return { valid: false };
  }
}

function parseConfigSetRefCommand(input: string):
  | {
      path: string;
      source: "env" | "file" | "exec" | "store";
      id: string;
      provider?: string;
      valid: true;
    }
  | { valid: false }
  | undefined {
  const prefix = input.match(CONFIG_SET_REF_PREFIX_RE)?.[0];
  if (!prefix) {
    return undefined;
  }
  const body = input.slice(prefix.length);
  for (const separator of body.matchAll(/\s+/gu)) {
    const path = body.slice(0, separator.index);
    const args = body.slice(separator.index).trim().match(CONFIG_SET_REF_ARGS_RE);
    if (!args?.groups?.id) {
      continue;
    }
    try {
      parseConfigSetPath(path);
      if (isSystemAgentSensitiveConfigPathEmbedding(path)) {
        return { valid: false };
      }
    } catch {
      continue;
    }
    const source = (args.groups.source?.toLowerCase() ?? "env") as
      | "env"
      | "file"
      | "exec"
      | "store";
    const id = args.groups.id.trim();
    const provider = args.groups.provider ?? DEFAULT_SECRET_PROVIDER_ALIAS;
    if (!isValidSecretRef({ source, provider, id })) {
      return { valid: false };
    }
    return {
      path,
      source,
      id,
      ...(args.groups.provider ? { provider: args.groups.provider } : {}),
      valid: true,
    };
  }
  return body.trim() ? { valid: false } : undefined;
}

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
  const configSetRef = parseConfigSetRefCommand(trimmed);
  if (configSetRef?.valid) {
    return {
      kind: "config-set-ref",
      path: configSetRef.path,
      source: configSetRef.source,
      id: configSetRef.id,
      ...(configSetRef.provider ? { provider: configSetRef.provider } : {}),
    };
  }
  if (configSetRef && !configSetRef.valid) {
    return { kind: "none", message: INVALID_CONFIG_SET_MESSAGE };
  }
  const configSet = parseConfigSetCommand(trimmed);
  if (configSet) {
    if (!configSet.valid) {
      return { kind: "none", message: INVALID_CONFIG_SET_MESSAGE };
    }
    return {
      kind: "config-set",
      path: configSet.path,
      value: configSet.value,
    };
  }
  const configGet = parseConfigReadPath(trimmed, CONFIG_GET_PREFIX_RE, { allowEmpty: false });
  if (configGet?.valid && configGet.path) {
    return { kind: "config-get", path: configGet.path };
  }
  if (configGet && !configGet.valid) {
    return { kind: "none", message: INVALID_CONFIG_SET_MESSAGE };
  }
  const configSchema = parseConfigReadPath(trimmed, CONFIG_SCHEMA_PREFIX_RE, {
    allowEmpty: true,
    allowRoot: true,
  });
  if (configSchema?.valid) {
    return { kind: "config-schema", ...(configSchema.path ? { path: configSchema.path } : {}) };
  }
  if (configSchema && !configSchema.valid) {
    return { kind: "none", message: INVALID_CONFIG_SET_MESSAGE };
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
  if (SKILLS_SETUP_RE.test(trimmed)) {
    return { kind: "skills-setup" };
  }
  if (SEARCH_SETUP_RE.test(trimmed)) {
    return { kind: "search-setup" };
  }
  if (GATEWAY_CONFIG_SETUP_RE.test(trimmed)) {
    return { kind: "gateway-config-setup" };
  }
  if (MEMORY_IMPORT_RE.test(trimmed)) {
    return { kind: "memory-import" };
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
  if (OPEN_SEARCH_SETUP_RE.test(trimmed)) {
    return { kind: "open-setup", target: "search" };
  }
  if (OPEN_GATEWAY_SETUP_RE.test(trimmed)) {
    return { kind: "open-setup", target: "gateway" };
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
      agentId: normalizeExplicitSystemAgentId(createMatch.groups.agent),
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
      ...(agent ? { agentId: normalizeExplicitSystemAgentId(agent) } : {}),
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
      return `set config ${redactSystemAgentConfigPath(operation.path)} to ${formatConfigSetValueForPlan(operation.path, operation.value)}`;
    case "config-set-ref":
      return `set config ${redactSystemAgentConfigPath(operation.path)} to ${operation.source} SecretRef <redacted>`;
    case "setup":
      return formatSetupPlanDescription(operation);
    case "model-setup":
      return "configure a model provider and default model";
    case "doctor-fix":
      return "run openclaw doctor --fix on the machine running OpenClaw, with OpenClaw stopped";
    case "plugin-install":
      return `install plugin ${operation.spec}`;
    case "plugin-uninstall":
      return `uninstall plugin ${operation.pluginId}`;
    case "create-agent":
      return [
        `create agent ${operation.agentId} with workspace ${formatCreateAgentWorkspace(operation.workspace)}`,
        operation.requesterAgentId ? `requested by agent ${operation.requesterAgentId}` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
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

export const SYSTEM_AGENT_OPERATOR_APPROVAL_HANDOFF =
  "This change needs operator approval and cannot be applied from this chat. Approve it in the OpenClaw operator UI (`openclaw dashboard` on the Gateway host), or run the change there with `openclaw setup`.";

export const SYSTEM_AGENT_OPERATOR_NAVIGATION_HANDOFF =
  "Channel, model, and setup flows need a human operator in the OpenClaw app; they cannot run from a delegated agent request. Open `openclaw dashboard` or run `openclaw setup` on the Gateway host.";

/** Format the standard approval plan text for a persistent operation. */
export function formatSystemAgentPersistentPlan(
  operation: SystemAgentOperation,
  operatorApprovalOnly = false,
): string {
  const description = describeSystemAgentPersistentOperation(operation);
  return operatorApprovalOnly
    ? `Refused: ${description} requires operator approval and was not applied from this chat.\n\n${SYSTEM_AGENT_OPERATOR_APPROVAL_HANDOFF}`
    : `Plan: ${description}. Say yes to apply.`;
}

function formatCreateAgentWorkspace(workspace: string | undefined): string {
  return workspace ? shortenHomePath(resolveUserPath(workspace)) : shortenHomePath(process.cwd());
}

function formatConfigSetValueForPlan(configPath: string, value: string): string {
  if (isSystemAgentSensitiveConfigValue(configPath, value)) {
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
