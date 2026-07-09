// Crestodian operations parse, approve, execute, and audit setup-helper commands.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ConfigSetOptions } from "../cli/config-set-input.js";
import type { DoctorOptions } from "../commands/doctor.types.js";
import {
  detectInferenceBackends,
  type InferenceBackendCandidate,
  type InferenceBackendKind,
} from "../commands/onboard-inference.js";
import { isSensitiveConfigPath } from "../config/sensitive-paths.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TuiResult } from "../tui/tui-types.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { appendCrestodianAuditEntry, resolveCrestodianAuditPath } from "./audit.js";
import type { CrestodianOverview } from "./overview.js";

/**
 * Crestodian command parser and operation executor.
 *
 * The grammar is a single anchored command language: every pattern must match
 * the whole input. Natural language never parses into an operation — it flows
 * to the AI custodian instead (chat) or to the planner (one-shot). This is a
 * security property, not a convenience: unanchored keyword matching used to
 * turn questions like "why did my gateway stop" into mutation proposals.
 *
 * Persistent operations require explicit approval, write audit records, and
 * lazy-load heavy CLI modules only when the selected operation needs them.
 */
type ConfigModule = typeof import("../config/config.js");
type ConfigFileSnapshot = Awaited<ReturnType<ConfigModule["readConfigFileSnapshot"]>>;
type CrestodianOverviewLoader = () => Promise<CrestodianOverview>;
type CrestodianOverviewFormatter = (overview: CrestodianOverview) => string;

const loadConfigModule = async () => await import("../config/config.js");
const loadOverviewModule = async () => await import("./overview.js");

/** Parsed Crestodian operation before approval/execution. */
export type CrestodianOperation =
  | { kind: "none"; message: string }
  | { kind: "overview" }
  | { kind: "doctor" }
  | { kind: "doctor-fix" }
  | { kind: "status" }
  | { kind: "health" }
  | { kind: "config-validate" }
  | { kind: "config-get"; path: string }
  | { kind: "config-schema"; path?: string }
  | { kind: "config-set"; path: string; value: string }
  | {
      kind: "config-set-ref";
      path: string;
      source: "env" | "file" | "exec";
      id: string;
      provider?: string;
    }
  | { kind: "setup"; workspace?: string; model?: string }
  | { kind: "model-setup"; workspace?: string }
  | { kind: "channel-list" }
  | { kind: "channel-info"; channel: string }
  | { kind: "channel-setup"; channel: string }
  | {
      kind: "open-setup";
      target: "guided" | "classic" | "channels";
      channel?: string;
    }
  | { kind: "gateway-status" }
  | { kind: "gateway-start" }
  | { kind: "gateway-stop" }
  | { kind: "gateway-restart" }
  | { kind: "agents" }
  | { kind: "models" }
  | { kind: "plugin-list" }
  | { kind: "plugin-search"; query: string }
  | { kind: "plugin-install"; spec: string }
  | { kind: "plugin-uninstall"; pluginId: string }
  | { kind: "audit" }
  | { kind: "create-agent"; agentId: string; workspace?: string; model?: string }
  | { kind: "open-tui"; agentId?: string; workspace?: string }
  | { kind: "set-default-model"; model: string };

/** Result returned by the operation executor. */
export type CrestodianOperationResult = {
  applied: boolean;
  exitsInteractive?: boolean;
  message?: string;
  nextInput?: string;
  followUp?: Extract<CrestodianOperation, { kind: "model-setup" }>;
};

/** Injectable command dependencies used by tests and alternate runners. */
export type CrestodianCommandDeps = {
  formatOverview?: CrestodianOverviewFormatter;
  loadOverview?: CrestodianOverviewLoader;
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
  runGatewayRestart?: () => Promise<void>;
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
  }) => Promise<TuiResult | void>;
  detectInferenceBackends?: typeof detectInferenceBackends;
  /** Where setup side effects run; the gateway surface never manages its own daemon. */
  setupSurface?: "cli" | "gateway";
  applySetup?: typeof import("./setup-apply.js").applyCrestodianSetup;
  listChannelSetupPlugins?: typeof import("../channels/plugins/setup-registry.js").listChannelSetupPlugins;
  resolveChannelSetupEntries?: typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
  isChannelConfigured?: typeof import("../config/channel-configured-shared.js").isStaticallyChannelConfigured;
};

// Grammar tokens. Workspace/path tokens accept quoted strings so paths with
// spaces survive; model refs and ids stay single tokens.
const TOKEN = String.raw`(?:"[^"]+"|'[^']+'|\S+)`;
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
  String.raw`^(?:setup|set\s+me\s+up|set\s+up\s+openclaw|onboard(?:\s+me)?|bootstrap|first\s+run)(?:\s+workspace\s+(?<workspace>${TOKEN}))?(?:\s+model\s+(?<model>\S+))?$`,
  "i",
);
const MODEL_SETUP_RE = new RegExp(
  String.raw`^(?:configure\s+(?:a\s+)?model\s+provider|set\s*up\s+(?:a\s+)?model\s+provider|model\s+setup)(?:\s+workspace\s+(?<workspace>${TOKEN}))?$`,
  "i",
);
const CREATE_AGENT_RE = new RegExp(
  String.raw`^(?:create|add|set\s*up|new)\s+(?:(?:an?|new|my)\s+)?agent\s+(?<agent>[a-z0-9_-]+)(?:\s+workspace\s+(?<workspace>${TOKEN}))?(?:\s+model\s+(?<model>\S+))?$`,
  "i",
);
// "talk to agent for ~/Projects/work" is a documented selector; "for|in" are
// only valid here, after the literal word "agent", never as generic fillers.
const TALK_AGENT_RE = new RegExp(
  String.raw`^(?:talk\s+to|switch\s+to|open|enter)\s+(?:(?:my|the)\s+)?(?:(?<agent>[a-z0-9_-]+)\s+)?agent(?:\s+(?:for|in|workspace)\s+(?<workspace>${TOKEN}))?$`,
  "i",
);
const SET_MODEL_RE = /^(?:set|configure|use)\s+(?:the\s+)?(?:default\s+)?models?\s+(?<model>\S+)$/i;
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

/** Audit/source labels for detected inference backends (docs-visible contract). */
const INFERENCE_SOURCE_LABELS: Record<InferenceBackendKind, string> = {
  "existing-model": "existing default model",
  "openai-api-key": "OPENAI_API_KEY",
  "anthropic-api-key": "ANTHROPIC_API_KEY",
  "claude-cli": "Claude Code CLI",
  "codex-cli": "Codex app-server",
  "gemini-cli": "Gemini CLI",
};

/**
 * Parse one user command into Crestodian's closed operation union. Anything
 * that does not match the anchored grammar exactly returns kind "none" so the
 * caller can route it to the AI custodian (or show guidance).
 */
export function parseCrestodianOperation(input: string): CrestodianOperation {
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
      return { kind: "none", message: "Crestodian retracts into shell. Bye." };
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
    return {
      kind: "plugin-install",
      spec: normalizePluginInstallSpec(
        pluginInstallMatch.groups.spec.trim(),
        pluginInstallMatch.groups.source,
      ),
    };
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
    return { kind: "set-default-model", model: setModelMatch.groups.model };
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

function validateCrestodianPluginInstallSpec(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed) {
    return "Plugin install spec is required.";
  }
  if (/\s/.test(trimmed)) {
    return "Crestodian plugin install accepts one npm or ClawHub package spec.";
  }
  if (/^(?:\.{1,2}\/|\/|~\/|file:|git(?:\+ssh|\+https)?:|https?:)/i.test(trimmed)) {
    // Crestodian does not install local paths or URLs; those can execute arbitrary package code.
    return "Crestodian plugin install accepts npm or ClawHub package specs only.";
  }
  return null;
}

/**
 * Return whether an operation can change local state or process lifecycle.
 * Guided setup operations are intentionally absent: starting a wizard is not
 * itself a write; the wizard owns approval and persistence for its answers.
 */
export function isPersistentCrestodianOperation(operation: CrestodianOperation): boolean {
  return (
    operation.kind === "set-default-model" ||
    operation.kind === "config-set" ||
    operation.kind === "config-set-ref" ||
    operation.kind === "setup" ||
    operation.kind === "doctor-fix" ||
    operation.kind === "plugin-install" ||
    operation.kind === "plugin-uninstall" ||
    operation.kind === "create-agent" ||
    operation.kind === "gateway-start" ||
    operation.kind === "gateway-stop" ||
    operation.kind === "gateway-restart"
  );
}

/** Format a user-facing description for an operation requiring approval. */
export function describeCrestodianPersistentOperation(operation: CrestodianOperation): string {
  switch (operation.kind) {
    case "set-default-model":
      return `set agents.defaults.model.primary to ${operation.model}`;
    case "config-set":
      return `set config ${operation.path} to ${formatConfigSetValueForPlan(operation.path, operation.value)}`;
    case "config-set-ref":
      return `set config ${operation.path} to ${operation.source} SecretRef ${operation.source === "env" ? operation.id : "<redacted>"}`;
    case "setup":
      return formatSetupPlanDescription(operation);
    case "model-setup":
      return "configure a model provider and default model";
    case "doctor-fix":
      return "run doctor repairs";
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
export function formatCrestodianPersistentPlan(operation: CrestodianOperation): string {
  return `Plan: ${describeCrestodianPersistentOperation(operation)}. Say yes to apply.`;
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

const CONFIG_GET_OUTPUT_MAX_CHARS = 2_000;
const CONFIG_SCHEMA_CHILDREN_MAX = 40;

function redactConfigValue(value: unknown, configPath: string): unknown {
  if (typeof value === "string" || typeof value === "number") {
    return isSensitiveConfigPath(configPath) ? "<redacted>" : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactConfigValue(entry, `${configPath}[]`));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactConfigValue(entry, configPath ? `${configPath}.${key}` : key),
      ]),
    );
  }
  return value;
}

function readConfigValueAtPath(config: unknown, path: string): { found: boolean; value?: unknown } {
  let current: unknown = config;
  for (const rawSegment of path.split(".")) {
    // Support foo[0] style array segments alongside dotted keys.
    const parts = rawSegment.split(/[[\]]/).filter(Boolean);
    for (const part of parts) {
      if (current === null || typeof current !== "object") {
        return { found: false };
      }
      const index = /^\d+$/.test(part) ? Number(part) : undefined;
      if (index !== undefined && Array.isArray(current)) {
        current = current[index];
      } else {
        current = (current as Record<string, unknown>)[part];
      }
      if (current === undefined) {
        return { found: false };
      }
    }
  }
  return { found: true, value: current };
}

function formatSetupPlanDescription(
  operation: Extract<CrestodianOperation, { kind: "setup" }>,
): string {
  const workspace = shortenHomePath(resolveUserPath(operation.workspace ?? process.cwd()));
  const model = operation.model ? ` and default model ${operation.model}` : "";
  return `bootstrap OpenClaw setup for workspace ${workspace}${model}`;
}

async function chooseSetupModel(params: {
  overview: CrestodianOverview;
  requestedModel: string | undefined;
  deps?: CrestodianCommandDeps;
}): Promise<{ model?: string; source: string }> {
  // Setup picks an existing/default local credential path before falling back to no model change.
  if (params.requestedModel?.trim()) {
    return { model: params.requestedModel.trim(), source: "requested" };
  }
  if (params.overview.defaultModel) {
    return { source: "existing default model" };
  }
  const detect = params.deps?.detectInferenceBackends ?? detectInferenceBackends;
  const candidates = await detect({});
  // A definitively logged-out CLI must never become the configured model:
  // setup would claim working AI access while every agent run fails auth.
  const detected: InferenceBackendCandidate | undefined = candidates.find(
    (candidate) => candidate.kind !== "existing-model" && candidate.credentials !== false,
  );
  if (!detected) {
    return { source: "none" };
  }
  return { model: detected.modelRef, source: INFERENCE_SOURCE_LABELS[detected.kind] };
}

function formatGatewayStatusLine(overview: CrestodianOverview): string {
  return [
    `Gateway: ${overview.gateway.reachable ? "reachable" : "not reachable"}`,
    `URL: ${overview.gateway.url}`,
    `Source: ${overview.gateway.source}`,
    overview.gateway.error ? `Note: ${overview.gateway.error}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function runGatewayLifecycle(operation: "start" | "stop" | "restart"): Promise<void> {
  const lifecycle = await import("../cli/daemon-cli/lifecycle.js");
  if (operation === "start") {
    await lifecycle.runDaemonStart();
    return;
  }
  if (operation === "stop") {
    await lifecycle.runDaemonStop();
    return;
  }
  await lifecycle.runDaemonRestart();
}

async function readConfigFileSnapshotLazy(): Promise<ConfigFileSnapshot> {
  const { readConfigFileSnapshot } = await loadConfigModule();
  return await readConfigFileSnapshot();
}

async function loadOverviewForOperation(
  deps: CrestodianCommandDeps | undefined,
): Promise<CrestodianOverview> {
  if (deps?.loadOverview) {
    return await deps.loadOverview();
  }
  const { loadCrestodianOverview } = await loadOverviewModule();
  return await loadCrestodianOverview();
}

async function resolveChannelSetupState(deps: CrestodianCommandDeps | undefined) {
  const listPlugins =
    deps?.listChannelSetupPlugins ??
    (await import("../channels/plugins/setup-registry.js")).listChannelSetupPlugins;
  const resolveEntries =
    deps?.resolveChannelSetupEntries ??
    (await import("../commands/channel-setup/discovery.js")).resolveChannelSetupEntries;
  const isConfigured =
    deps?.isChannelConfigured ??
    (await import("../config/channel-configured-shared.js")).isStaticallyChannelConfigured;
  const { shouldShowChannelInSetup } = await import("../commands/channel-setup/discovery.js");
  const snapshot = await readConfigFileSnapshotLazy();
  const cfg = snapshot.valid ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const installedPlugins = listPlugins();
  const resolved = resolveEntries({ cfg, installedPlugins });
  return {
    cfg,
    installedPlugins,
    resolved: {
      ...resolved,
      // Match the connect/list surfaces: setup-hidden channels stay invisible
      // to chat listings and channel info alike.
      entries: resolved.entries.filter((entry) => shouldShowChannelInSetup(entry.meta)),
    },
    isConfigured,
  };
}

function formatChannelDocsUrl(docsPath: string): string {
  return `https://docs.openclaw.ai${docsPath.startsWith("/") ? docsPath : `/${docsPath}`}`;
}

function formatConfigValidationLine(snapshot: ConfigFileSnapshot): string {
  if (!snapshot.exists) {
    return `Config missing: ${shortenHomePath(snapshot.path)}`;
  }
  if (snapshot.valid) {
    return `Config valid: ${shortenHomePath(snapshot.path)}`;
  }
  return [
    `Config invalid: ${shortenHomePath(snapshot.path)}`,
    ...snapshot.issues.map((issue) => {
      const issuePath = issue.path ? `${issue.path}: ` : "";
      return `  - ${issuePath}${issue.message}`;
    }),
  ].join("\n");
}

function createNoExitRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return {
    ...runtime,
    exit: (code) => {
      throw new Error(`operation exited with code ${code}`);
    },
  };
}

async function resolveTuiAgentId(params: {
  requestedAgentId: string | undefined;
  requestedWorkspace?: string;
  deps?: CrestodianCommandDeps;
}): Promise<string | undefined> {
  const overview = await loadOverviewForOperation(params.deps);
  const workspace = params.requestedWorkspace
    ? resolveUserPath(params.requestedWorkspace)
    : undefined;
  if (workspace) {
    const workspaceMatch = overview.agents.find((agent) => {
      return agent.workspace ? resolveUserPath(agent.workspace) === workspace : false;
    });
    if (workspaceMatch) {
      return workspaceMatch.id;
    }
  }
  if (!params.requestedAgentId?.trim()) {
    return overview.defaultAgentId;
  }
  const requested = normalizeAgentId(params.requestedAgentId);
  const match = overview.agents.find((agent) => {
    return (
      normalizeAgentId(agent.id) === requested ||
      (agent.name ? normalizeAgentId(agent.name) === requested : false)
    );
  });
  return match?.id ?? requested;
}

type ExecuteOptions = {
  approved?: boolean;
  deps?: CrestodianCommandDeps;
  auditDetails?: Record<string, unknown>;
};

/**
 * One persistent operation = one audited apply. The shared wrapper owns the
 * approval gate, before/after config hashes, the audit record, and the
 * `[crestodian] running/done` markers the e2e lanes assert on; each spec only
 * describes what to run and what to record.
 */
type PersistentApplyContext = {
  runtime: RuntimeEnv;
  deps?: CrestodianCommandDeps;
};

type PersistentApplyOutcome = {
  summary: string;
  details?: Record<string, unknown>;
  /** Overrides the after-snapshot config path in the audit record. */
  configPath?: string;
};

async function applyPersistentOperation(params: {
  auditOperation: string;
  operation: CrestodianOperation;
  runtime: RuntimeEnv;
  opts: ExecuteOptions;
  run: (ctx: PersistentApplyContext) => Promise<PersistentApplyOutcome>;
}): Promise<CrestodianOperationResult> {
  const { auditOperation, runtime, opts } = params;
  if (!opts.approved) {
    const message = formatCrestodianPersistentPlan(params.operation);
    runtime.log(message);
    return { applied: false, message };
  }
  runtime.log(`[crestodian] running: ${auditOperation}`);
  const { readConfigFileSnapshot } = await loadConfigModule();
  const before = await readConfigFileSnapshot();
  const outcome = await params.run({ runtime, deps: opts.deps });
  const after = await readConfigFileSnapshot();
  await appendCrestodianAuditEntry({
    operation: auditOperation,
    summary: outcome.summary,
    configPath: outcome.configPath ?? after.path ?? before.path ?? undefined,
    configHashBefore: before.hash ?? null,
    configHashAfter: after.hash ?? null,
    details: { ...opts.auditDetails, ...outcome.details },
  });
  runtime.log(`[crestodian] done: ${auditOperation}`);
  return { applied: true };
}

async function runConfigSetOperation(params: {
  operation: Extract<CrestodianOperation, { kind: "config-set" | "config-set-ref" }>;
  ctx: PersistentApplyContext;
}): Promise<void> {
  const { operation, ctx } = params;
  const runConfigSet =
    ctx.deps?.runConfigSet ??
    (async (setOpts: { path?: string; value?: string; cliOptions: ConfigSetOptions }) => {
      const { runConfigSet: importedRunConfigSet } = await import("../cli/config-cli.js");
      await importedRunConfigSet({
        ...setOpts,
        runtime: createNoExitRuntime(ctx.runtime),
      });
    });
  if (operation.kind === "config-set") {
    await runConfigSet({ path: operation.path, value: operation.value, cliOptions: {} });
    return;
  }
  await runConfigSet({
    path: operation.path,
    cliOptions: {
      refProvider: operation.provider ?? "default",
      refSource: operation.source,
      refId: operation.id,
    },
  });
}

async function executeSetup(
  operation: Extract<CrestodianOperation, { kind: "setup" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<CrestodianOperationResult> {
  const overview = await loadOverviewForOperation(opts.deps);
  const setupModel = await chooseSetupModel({
    overview,
    requestedModel: operation.model,
    deps: opts.deps,
  });
  if (!opts.approved) {
    const message = [
      formatCrestodianPersistentPlan(operation),
      setupModel.model
        ? `Model choice: ${setupModel.model} (${setupModel.source}).`
        : setupModel.source === "existing default model"
          ? `Model choice: keep existing default ${overview.defaultModel}.`
          : "Model choice: none found yet. I will set the workspace first, then offer guided model-provider setup.",
    ].join("\n");
    runtime.log(message);
    return { applied: false, message };
  }
  const workspace = resolveUserPath(operation.workspace ?? process.cwd());
  const result = await applyPersistentOperation({
    auditOperation: "crestodian.setup",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const applySetup =
        ctx.deps?.applySetup ?? (await import("./setup-apply.js")).applyCrestodianSetup;
      const applied = await applySetup({
        workspace,
        ...(setupModel.model ? { model: setupModel.model } : {}),
        surface: ctx.deps?.setupSurface ?? "cli",
        runtime: ctx.runtime,
      });
      const after = await readConfigFileSnapshotLazy();
      ctx.runtime.log(`Updated ${after.path || applied.configPath}`);
      for (const line of applied.lines) {
        ctx.runtime.log(line);
      }
      if (!setupModel.model && overview.defaultModel) {
        ctx.runtime.log(`Default model: ${overview.defaultModel} (kept)`);
      } else if (!setupModel.model) {
        ctx.runtime.log("Default model: not configured yet");
      }
      return {
        summary: setupModel.model
          ? `Bootstrapped setup with ${setupModel.model}`
          : "Bootstrapped setup workspace",
        configPath: after.path || applied.configPath,
        details: {
          workspace,
          modelSource: setupModel.source,
          ...(setupModel.model ? { model: setupModel.model } : {}),
        },
      };
    },
  });
  if (result.applied && !setupModel.model && !overview.defaultModel) {
    return {
      ...result,
      followUp: { kind: "model-setup", workspace },
    };
  }
  return result;
}

async function executeSetDefaultModel(
  operation: Extract<CrestodianOperation, { kind: "set-default-model" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<CrestodianOperationResult> {
  return await applyPersistentOperation({
    auditOperation: "config.setDefaultModel",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const { mutateConfigFile } = await loadConfigModule();
      const { applyDefaultModelPrimaryUpdate } = await import("../commands/models/shared.js");
      const result = await mutateConfigFile({
        base: "source",
        mutate: (cfg) => {
          const next = applyDefaultModelPrimaryUpdate({
            cfg,
            modelRaw: operation.model,
            field: "model",
          });
          Object.assign(cfg, next);
        },
      });
      const { resolveAgentModelPrimaryValue } = await import("../config/model-input.js");
      const effectiveModel = resolveAgentModelPrimaryValue(
        result.nextConfig.agents?.defaults?.model,
      );
      ctx.runtime.log(`Updated ${result.path}`);
      ctx.runtime.log(`Default model: ${effectiveModel ?? operation.model}`);
      return {
        summary: `Set default model to ${operation.model}`,
        configPath: result.path,
        details: { requestedModel: operation.model, effectiveModel },
      };
    },
  });
}

async function executePluginInstall(
  operation: Extract<CrestodianOperation, { kind: "plugin-install" }>,
  runtime: RuntimeEnv,
  opts: ExecuteOptions,
): Promise<CrestodianOperationResult> {
  if (opts.approved) {
    const validationError = validateCrestodianPluginInstallSpec(operation.spec);
    if (validationError) {
      runtime.error(validationError);
      runtime.exit(1);
      return { applied: false };
    }
  }
  const result = await applyPersistentOperation({
    auditOperation: "plugin.install",
    operation,
    runtime,
    opts,
    run: async (ctx) => {
      const runPluginInstall =
        ctx.deps?.runPluginInstall ??
        (async (spec: string, pluginRuntime: RuntimeEnv) => {
          const { runPluginInstallCommand } = await import("../cli/plugins-install-command.js");
          await runPluginInstallCommand({ raw: spec, opts: {}, runtime: pluginRuntime });
        });
      await runPluginInstall(operation.spec, createNoExitRuntime(ctx.runtime));
      return { summary: `Installed plugin ${operation.spec}`, details: { spec: operation.spec } };
    },
  });
  if (result.applied) {
    runtime.log("Restart the Gateway to apply installed plugin changes.");
  }
  return result;
}

/** Execute a parsed Crestodian operation after applying approval gates and audit logging. */
export async function executeCrestodianOperation(
  operation: CrestodianOperation,
  runtime: RuntimeEnv,
  opts: ExecuteOptions = {},
): Promise<CrestodianOperationResult> {
  switch (operation.kind) {
    case "none":
      runtime.log(operation.message);
      return { applied: false, exitsInteractive: operation.message.includes("Bye.") };
    case "overview": {
      const overview = await loadOverviewForOperation(opts.deps);
      if (opts.deps?.formatOverview) {
        runtime.log(opts.deps.formatOverview(overview));
      } else {
        const { formatCrestodianOverview } = await loadOverviewModule();
        runtime.log(formatCrestodianOverview(overview));
      }
      return { applied: false };
    }
    case "agents": {
      const overview = await loadOverviewForOperation(opts.deps);
      runtime.log(
        [
          "Agents:",
          ...overview.agents.map((agent) => {
            const bits = [
              agent.id,
              agent.isDefault ? "default" : undefined,
              agent.name ? `name=${agent.name}` : undefined,
              agent.workspace
                ? `workspace=${shortenHomePath(resolveUserPath(agent.workspace))}`
                : undefined,
            ].filter(Boolean);
            return `  - ${bits.join(" | ")}`;
          }),
        ].join("\n"),
      );
      return { applied: false };
    }
    case "models": {
      const overview = await loadOverviewForOperation(opts.deps);
      runtime.log(
        [
          `Default model: ${overview.defaultModel ?? "not configured"}`,
          `Codex: ${overview.tools.codex.found ? "found" : "not found"}`,
          `Claude Code: ${overview.tools.claude.found ? "found" : "not found"}`,
          `Gemini CLI: ${overview.tools.gemini.found ? "found" : "not found"}`,
          `OpenAI key: ${overview.tools.apiKeys.openai ? "found" : "not found"}`,
          `Anthropic key: ${overview.tools.apiKeys.anthropic ? "found" : "not found"}`,
        ].join("\n"),
      );
      return { applied: false };
    }
    case "plugin-list": {
      const runPluginsList =
        opts.deps?.runPluginsList ??
        (async (pluginRuntime: RuntimeEnv) => {
          const { runPluginsListCommand } = await import("../cli/plugins-list-command.js");
          await runPluginsListCommand({}, pluginRuntime);
        });
      await runPluginsList(runtime);
      return { applied: false };
    }
    case "plugin-search": {
      const runPluginsSearch =
        opts.deps?.runPluginsSearch ??
        (async (query: string, pluginRuntime: RuntimeEnv) => {
          const { runPluginsSearchCommand } = await import("../cli/plugins-search-command.js");
          await runPluginsSearchCommand(query, {}, pluginRuntime);
        });
      await runPluginsSearch(operation.query, runtime);
      return { applied: false };
    }
    case "audit":
      runtime.log(`Audit log: ${resolveCrestodianAuditPath()}`);
      runtime.log("Only applied writes/actions are recorded; discovery stays quiet.");
      return { applied: false };
    case "config-validate": {
      const snapshot = await readConfigFileSnapshotLazy();
      runtime.log(formatConfigValidationLine(snapshot));
      return { applied: false };
    }
    case "config-get": {
      const snapshot = await readConfigFileSnapshotLazy();
      if (!snapshot.exists) {
        runtime.log(`Config missing: ${shortenHomePath(snapshot.path)}`);
        return { applied: false };
      }
      const cfg = snapshot.valid
        ? (snapshot.sourceConfig ?? snapshot.config)
        : snapshot.sourceConfig;
      const lookup = readConfigValueAtPath(cfg ?? {}, operation.path);
      if (!lookup.found) {
        runtime.log(
          `${operation.path}: not set. Use \`config schema ${operation.path}\` to see what is allowed.`,
        );
        return { applied: false };
      }
      const redacted = redactConfigValue(lookup.value, operation.path);
      const rendered = JSON.stringify(redacted, null, 2) ?? "null";
      runtime.log(
        rendered.length > CONFIG_GET_OUTPUT_MAX_CHARS
          ? `${operation.path} = ${truncateUtf16Safe(rendered, CONFIG_GET_OUTPUT_MAX_CHARS)}\n… (truncated)`
          : `${operation.path} = ${rendered}`,
      );
      return { applied: false };
    }
    case "config-schema": {
      const { buildConfigSchema, lookupConfigSchema } = await import("../config/schema.js");
      const response = buildConfigSchema();
      const path = operation.path ?? ".";
      const result = lookupConfigSchema(response, path);
      if (!result) {
        runtime.log(`No config schema at "${path}". Try \`config schema .\` for the root keys.`);
        return { applied: false };
      }
      const schema = result.schema as {
        type?: string | string[];
        description?: string;
        enum?: unknown[];
        default?: unknown;
      };
      const childLines = result.children.slice(0, CONFIG_SCHEMA_CHILDREN_MAX).map((child) => {
        const type = Array.isArray(child.type) ? child.type.join("|") : (child.type ?? "object");
        const bits = [
          type,
          child.required ? "required" : undefined,
          child.hasChildren ? "…" : undefined,
        ]
          .filter(Boolean)
          .join(", ");
        return `  - ${child.path} (${bits})`;
      });
      runtime.log(
        [
          `Schema for ${result.path === "" ? "." : result.path}:`,
          schema.type
            ? `type: ${Array.isArray(schema.type) ? schema.type.join("|") : schema.type}`
            : undefined,
          schema.description ? `description: ${schema.description}` : undefined,
          schema.enum
            ? `allowed values: ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`
            : undefined,
          schema.default !== undefined ? `default: ${JSON.stringify(schema.default)}` : undefined,
          ...(childLines.length > 0 ? ["keys:", ...childLines] : []),
          result.children.length > CONFIG_SCHEMA_CHILDREN_MAX
            ? `… +${result.children.length - CONFIG_SCHEMA_CHILDREN_MAX} more keys`
            : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
      );
      return { applied: false };
    }
    case "channel-list": {
      // Use the same discovery as channel setup (bundled plugins + trusted
      // catalog), so the listing matches what `connect <channel>` can configure
      // even before any plugin registry is active.
      const { resolved } = await resolveChannelSetupState(opts.deps);
      const entries = resolved.entries.toSorted((a, b) => a.id.localeCompare(b.id));
      runtime.log(
        [
          "Channels:",
          ...entries.map(
            (entry) => `  - ${entry.id}${entry.meta.label ? ` (${entry.meta.label})` : ""}`,
          ),
          "",
          "Say `connect <channel>` to walk through setup (for example `connect telegram`).",
        ].join("\n"),
      );
      return { applied: false };
    }
    case "channel-info": {
      const { cfg, installedPlugins, resolved, isConfigured } = await resolveChannelSetupState(
        opts.deps,
      );
      const channel = operation.channel.toLowerCase();
      const entry = resolved.entries.find((candidate) => candidate.id === channel);
      if (!entry) {
        const knownIds = resolved.entries.map((candidate) => candidate.id).toSorted();
        runtime.log(
          [
            `Unknown channel: ${channel}`,
            `Known channels: ${knownIds.length > 0 ? knownIds.join(", ") : "none"}`,
          ].join("\n"),
        );
        return { applied: false };
      }
      const installed =
        installedPlugins.some((plugin) => plugin.id === entry.id) ||
        resolved.installedCatalogById.has(entry.id);
      runtime.log(
        [
          `${entry.meta.label} (${entry.id})`,
          entry.meta.blurb,
          `Configured: ${isConfigured(cfg, entry.id) ? "yes" : "no"}`,
          `Installed: ${installed ? "yes" : "no"}`,
          `Docs: ${formatChannelDocsUrl(entry.meta.docsPath)}`,
          "",
          `Say \`connect ${entry.id}\` to set it up here, or \`open channel wizard for ${entry.id}\` for the masked terminal wizard.`,
        ].join("\n"),
      );
      return { applied: false };
    }
    case "channel-setup":
      // Channel setup is a multi-step wizard; only interactive Crestodian (TUI
      // chat bridge or the gateway chat) can host it. One-shot mode points at
      // the guided paths.
      runtime.log(
        [
          `Connecting ${operation.channel} needs an interactive session.`,
          "Run `openclaw crestodian` and say `connect " + operation.channel + "`,",
          "or run `openclaw channels add` for the terminal wizard.",
        ].join("\n"),
      );
      return { applied: false };
    case "model-setup":
      runtime.log(
        [
          "Model provider setup needs an interactive session with masked credential prompts.",
          "Run `openclaw crestodian` and say `configure model provider`,",
          "or run `openclaw configure --section model` directly.",
        ].join("\n"),
      );
      return { applied: false };
    case "open-setup": {
      const command =
        operation.target === "guided"
          ? "openclaw onboard"
          : operation.target === "classic"
            ? "openclaw onboard --classic"
            : `openclaw channels add${operation.channel ? ` --channel ${operation.channel}` : ""}`;
      runtime.log(
        `One-shot mode cannot open an interactive wizard. Run \`${command}\` in a terminal.`,
      );
      return { applied: false };
    }
    case "setup":
      return await executeSetup(operation, runtime, opts);
    case "config-set":
      return await applyPersistentOperation({
        auditOperation: "config.set",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          await runConfigSetOperation({ operation, ctx });
          return { summary: `Set config ${operation.path}`, details: { path: operation.path } };
        },
      });
    case "config-set-ref":
      return await applyPersistentOperation({
        auditOperation: "config.setRef",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          await runConfigSetOperation({ operation, ctx });
          return {
            summary: `Set config ${operation.path} SecretRef`,
            details: {
              path: operation.path,
              source: operation.source,
              provider: operation.provider ?? "default",
            },
          };
        },
      });
    case "plugin-install":
      return await executePluginInstall(operation, runtime, opts);
    case "plugin-uninstall": {
      const result = await applyPersistentOperation({
        auditOperation: "plugin.uninstall",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runPluginUninstall =
            ctx.deps?.runPluginUninstall ??
            (async (pluginId: string, pluginRuntime: RuntimeEnv) => {
              const { runPluginUninstallCommand } =
                await import("../cli/plugins-uninstall-command.js");
              await runPluginUninstallCommand(pluginId, { force: true }, pluginRuntime);
            });
          await runPluginUninstall(operation.pluginId, createNoExitRuntime(ctx.runtime));
          return {
            summary: `Uninstalled plugin ${operation.pluginId}`,
            details: { pluginId: operation.pluginId },
          };
        },
      });
      if (result.applied) {
        runtime.log("Restart the Gateway to apply plugin changes.");
      }
      return result;
    }
    case "create-agent": {
      const workspace = resolveUserPath(operation.workspace ?? process.cwd());
      return await applyPersistentOperation({
        auditOperation: "agents.create",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runAgentsAdd =
            ctx.deps?.runAgentsAdd ??
            (await import("../commands/agents.commands.add.js")).agentsAddCommand;
          await runAgentsAdd(
            {
              name: operation.agentId,
              workspace,
              ...(operation.model ? { model: operation.model } : {}),
              nonInteractive: true,
            },
            ctx.runtime,
            { hasFlags: true },
          );
          return {
            summary: `Created agent ${operation.agentId}`,
            details: {
              agentId: operation.agentId,
              workspace,
              ...(operation.model ? { model: operation.model } : {}),
            },
          };
        },
      });
    }
    case "doctor": {
      const runDoctor =
        opts.deps?.runDoctor ?? (await import("../commands/doctor.js")).doctorCommand;
      await runDoctor(runtime, { nonInteractive: true });
      return { applied: false };
    }
    case "doctor-fix":
      return await applyPersistentOperation({
        auditOperation: "doctor.fix",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runDoctor =
            ctx.deps?.runDoctor ?? (await import("../commands/doctor.js")).doctorCommand;
          await runDoctor(ctx.runtime, { nonInteractive: true, repair: true, yes: true });
          return { summary: "Ran doctor repairs" };
        },
      });
    case "status": {
      const { statusCommand } = await import("../commands/status.command.js");
      await statusCommand({ timeoutMs: 10_000 }, runtime);
      return { applied: false };
    }
    case "health": {
      const { healthCommand } = await import("../commands/health.js");
      await healthCommand({ timeoutMs: 10_000 }, runtime);
      return { applied: false };
    }
    case "gateway-status": {
      const overview = await loadOverviewForOperation(opts.deps);
      runtime.log(formatGatewayStatusLine(overview));
      return { applied: false };
    }
    case "gateway-start":
      return await applyPersistentOperation({
        auditOperation: "gateway.start",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runGatewayStart = ctx.deps?.runGatewayStart ?? (() => runGatewayLifecycle("start"));
          await runGatewayStart();
          return { summary: "Started Gateway" };
        },
      });
    case "gateway-stop":
      return await applyPersistentOperation({
        auditOperation: "gateway.stop",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runGatewayStop = ctx.deps?.runGatewayStop ?? (() => runGatewayLifecycle("stop"));
          await runGatewayStop();
          return { summary: "Stopped Gateway" };
        },
      });
    case "gateway-restart":
      return await applyPersistentOperation({
        auditOperation: "gateway.restart",
        operation,
        runtime,
        opts,
        run: async (ctx) => {
          const runGatewayRestart =
            ctx.deps?.runGatewayRestart ?? (() => runGatewayLifecycle("restart"));
          await runGatewayRestart();
          return { summary: "Restarted Gateway" };
        },
      });
    case "open-tui": {
      const agentId = await resolveTuiAgentId({
        requestedAgentId: operation.agentId,
        requestedWorkspace: operation.workspace,
        deps: opts.deps,
      });
      const session = agentId ? buildAgentMainSessionKey({ agentId }) : undefined;
      const runTui = opts.deps?.runTui ?? (await import("../tui/tui.js")).runTui;
      const result = await runTui({ local: true, session, deliver: false, historyLimit: 200 });
      if (result?.exitReason === "return-to-crestodian") {
        runtime.log(
          result.crestodianMessage
            ? `[crestodian] returned from agent with request: ${result.crestodianMessage}`
            : "[crestodian] returned from agent",
        );
        return { applied: false, nextInput: result.crestodianMessage };
      }
      return { applied: false, exitsInteractive: true };
    }
    case "set-default-model":
      return await executeSetDefaultModel(operation, runtime, opts);
    default:
      return { applied: false };
  }
}
