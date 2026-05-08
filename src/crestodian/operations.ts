import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { ConfigSetOptions } from "../cli/config-set-input.js";
import type { DoctorOptions } from "../commands/doctor.types.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TuiResult } from "../tui/tui-types.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { appendCrestodianAuditEntry, resolveCrestodianAuditPath } from "./audit.js";
import type { CrestodianOverview } from "./overview.js";

type ConfigModule = typeof import("../config/config.js");
type ConfigFileSnapshot = Awaited<ReturnType<ConfigModule["readConfigFileSnapshot"]>>;
type CrestodianOverviewLoader = () => Promise<CrestodianOverview>;
type CrestodianOverviewFormatter = (overview: CrestodianOverview) => string;

export type CrestodianOperation =
  | { kind: "none"; message: string }
  | { kind: "overview" }
  | { kind: "doctor" }
  | { kind: "doctor-fix" }
  | { kind: "status" }
  | { kind: "health" }
  | { kind: "config-validate" }
  | { kind: "config-set"; path: string; value: string }
  | {
      kind: "config-set-ref";
      path: string;
      source: "env" | "file" | "exec";
      id: string;
      provider?: string;
    }
  | { kind: "setup"; workspace?: string; model?: string }
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

export type CrestodianOperationResult = {
  applied: boolean;
  exitsInteractive?: boolean;
  message?: string;
  nextInput?: string;
};

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
};

const SET_MODEL_RE = /(?:set|configure|use)\s+(?:the\s+)?(?:default\s+)?model\s+(.+)/i;
const CONFIGURE_MODELS_RE = /(?:set|configure|use)\s+models?\s+(?<model>\S+)/i;
const CREATE_AGENT_RE =
  /(?:create|add|setup|set\s+up)\s+(?:(?:an?|new|my)\s+)?agent\s+(?<agent>[a-z0-9_-]+)/i;
const TALK_AGENT_RE =
  /(?:talk\s+to|switch\s+to|open|enter)\s+(?:(?:my|the)\s+)?(?:(?<agent>[a-z0-9_-]+)\s+)?agent/i;
const WORKSPACE_RE = /(?:workspace|workdir|cwd|for|in)\s+(?<workspace>"[^"]+"|'[^']+'|\S+)/i;
const MODEL_RE = /\bmodel\s+(?<model>\S+)/i;
const CONFIG_SET_RE =
  /^(?:config\s+set|set\s+config)\s+(?<path>[A-Za-z0-9_.[\]-]+)\s+(?<value>.+)$/i;
const CONFIG_SET_REF_RE =
  /^(?:config\s+set-ref|set\s+secretref|set\s+secret\s+ref)\s+(?<path>[A-Za-z0-9_.[\]-]+)\s+(?:(?<source>env|file|exec)\s+)?(?<id>\S+)(?:\s+provider\s+(?<provider>[A-Za-z0-9_-]+))?$/i;
const SETUP_RE =
  /^(?:setup(?!\s+agent\b)|set\s+me\s+up|set\s+up\s+openclaw|onboard|onboard\s+me|bootstrap|first\s+run)(?:\b|$)/i;
const PLUGIN_LIST_RE = /^(?:plugins?|clawhub)\s+list$|^list\s+plugins?$/i;
const PLUGIN_SEARCH_RE =
  /^(?:(?:plugins?|clawhub)\s+search|search\s+plugins?(?:\s+for)?)\s+(?<query>.+)$/i;
const PLUGIN_INSTALL_RE =
  /^(?:(?:plugins?)\s+install|install\s+(?:(?<source>npm|clawhub)\s+)?plugins?)\s+(?<spec>\S+)$/i;
const PLUGIN_UNINSTALL_RE =
  /^(?:(?:plugins?)\s+(?:uninstall|remove)|(?:uninstall|remove)\s+plugins?)\s+(?<pluginId>[A-Za-z0-9_.@/-]+)$/i;

const OPENAI_API_DEFAULT_MODEL_REF = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
const ANTHROPIC_API_DEFAULT_MODEL_REF = "anthropic/claude-opus-4-7";
const CLAUDE_CLI_DEFAULT_MODEL_REF = "claude-cli/claude-opus-4-7";
const CODEX_CLI_DEFAULT_MODEL_REF = "codex-cli/gpt-5.5";

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
  if (lower === "audit" || lower.includes("audit log")) {
    return { kind: "audit" };
  }
  const configSetRefMatch = trimmed.match(CONFIG_SET_REF_RE);
  if (configSetRefMatch?.groups?.path && configSetRefMatch.groups.id?.trim()) {
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
  if (
    lower === "config validate" ||
    lower === "validate config" ||
    lower.includes("validate config")
  ) {
    return { kind: "config-validate" };
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
  if (SETUP_RE.test(lower)) {
    const workspace = trimShellishToken(trimmed.match(WORKSPACE_RE)?.groups?.workspace);
    const model = trimmed.match(MODEL_RE)?.groups?.model;
    return {
      kind: "setup",
      ...(workspace ? { workspace } : {}),
      ...(model ? { model } : {}),
    };
  }
  if (lower.includes("doctor")) {
    if (lower.includes("fix") || lower.includes("repair")) {
      return { kind: "doctor-fix" };
    }
    return { kind: "doctor" };
  }
  if (lower.includes("health")) {
    return { kind: "health" };
  }
  if (lower.includes("gateway")) {
    if (lower.includes("restart")) {
      return { kind: "gateway-restart" };
    }
    if (lower.includes("start")) {
      return { kind: "gateway-start" };
    }
    if (lower.includes("stop")) {
      return { kind: "gateway-stop" };
    }
    return { kind: "gateway-status" };
  }
  if (lower.includes("status")) {
    return { kind: "status" };
  }
  if (lower.includes("agent")) {
    const createMatch = trimmed.match(CREATE_AGENT_RE);
    if (createMatch?.groups?.agent) {
      const workspace = trimShellishToken(trimmed.match(WORKSPACE_RE)?.groups?.workspace);
      const model = trimmed.match(MODEL_RE)?.groups?.model;
      return {
        kind: "create-agent",
        agentId: normalizeAgentId(createMatch.groups.agent),
        ...(workspace ? { workspace } : {}),
        ...(model ? { model } : {}),
      };
    }
    const talkMatch = trimmed.match(TALK_AGENT_RE);
    if (talkMatch) {
      const workspace = trimShellishToken(trimmed.match(WORKSPACE_RE)?.groups?.workspace);
      return {
        kind: "open-tui",
        agentId: talkMatch.groups?.agent,
        ...(workspace ? { workspace } : {}),
      };
    }
    return { kind: "agents" };
  }
  if (lower.includes("model")) {
    const match = trimmed.match(SET_MODEL_RE);
    const pluralMatch = trimmed.match(CONFIGURE_MODELS_RE);
    const model = match?.[1]?.trim() ?? pluralMatch?.groups?.model?.trim();
    if (model) {
      return { kind: "set-default-model", model };
    }
    return { kind: "models" };
  }
  if (lower === "tui" || lower.includes("open tui") || lower.includes("chat")) {
    return { kind: "open-tui" };
  }
  if (lower === "quit" || lower === "exit") {
    return { kind: "none", message: "Crestodian retracts into shell. Bye." };
  }
  return {
    kind: "none",
    message:
      "I can run doctor/status/health, check or restart Gateway, list agents/models, set default model, show audit, or switch to your agent TUI.",
  };
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
    return "Crestodian plugin install accepts npm or ClawHub package specs only.";
  }
  return null;
}

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

export function formatCrestodianPersistentPlan(operation: CrestodianOperation): string {
  return `Plan: ${describeCrestodianPersistentOperation(operation)}. Say yes to apply.`;
}

function formatCreateAgentWorkspace(workspace: string | undefined): string {
  return workspace ? shortenHomePath(resolveUserPath(workspace)) : shortenHomePath(process.cwd());
}

function formatConfigSetValueForPlan(configPath: string, value: string): string {
  if (/(secret|token|password|key|credential)/i.test(configPath)) {
    return "<redacted>";
  }
  return value;
}

function formatSetupPlanDescription(
  operation: Extract<CrestodianOperation, { kind: "setup" }>,
): string {
  const workspace = shortenHomePath(resolveUserPath(operation.workspace ?? process.cwd()));
  const model = operation.model ? ` and default model ${operation.model}` : "";
  return `bootstrap OpenClaw setup for workspace ${workspace}${model}`;
}

function chooseSetupModel(
  overview: CrestodianOverview,
  requestedModel: string | undefined,
): {
  model?: string;
  source: string;
} {
  if (requestedModel?.trim()) {
    return { model: requestedModel.trim(), source: "requested" };
  }
  if (overview.defaultModel) {
    return { source: "existing default model" };
  }
  if (overview.tools.apiKeys.openai) {
    return { model: OPENAI_API_DEFAULT_MODEL_REF, source: "OPENAI_API_KEY" };
  }
  if (overview.tools.apiKeys.anthropic) {
    return { model: ANTHROPIC_API_DEFAULT_MODEL_REF, source: "ANTHROPIC_API_KEY" };
  }
  if (overview.tools.claude.found) {
    return { model: CLAUDE_CLI_DEFAULT_MODEL_REF, source: "Claude Code CLI" };
  }
  if (overview.tools.codex.found) {
    return { model: CODEX_CLI_DEFAULT_MODEL_REF, source: "Codex CLI" };
  }
  return { source: "none" };
}

function logQueued(runtime: RuntimeEnv, operation: string): void {
  runtime.log(`[crestodian] queued: ${operation}`);
  runtime.log(`[crestodian] running: ${operation}`);
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
  const { readConfigFileSnapshot } = await import("../config/config.js");
  return await readConfigFileSnapshot();
}

async function loadOverviewForOperation(
  deps: CrestodianCommandDeps | undefined,
): Promise<CrestodianOverview> {
  if (deps?.loadOverview) {
    return await deps.loadOverview();
  }
  const { loadCrestodianOverview } = await import("./overview.js");
  return await loadCrestodianOverview();
}

async function formatOverviewForOperation(
  overview: CrestodianOverview,
  deps: CrestodianCommandDeps | undefined,
): Promise<string> {
  if (deps?.formatOverview) {
    return deps.formatOverview(overview);
  }
  const { formatCrestodianOverview } = await import("./overview.js");
  return formatCrestodianOverview(overview);
}

async function loadConfigFileMutationHelpers(): Promise<{
  mutateConfigFile: ConfigModule["mutateConfigFile"];
  readConfigFileSnapshot: ConfigModule["readConfigFileSnapshot"];
}> {
  const { mutateConfigFile, readConfigFileSnapshot } = await import("../config/config.js");
  return { mutateConfigFile, readConfigFileSnapshot };
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

export async function executeCrestodianOperation(
  operation: CrestodianOperation,
  runtime: RuntimeEnv,
  opts: {
    approved?: boolean;
    deps?: CrestodianCommandDeps;
    auditDetails?: Record<string, unknown>;
  } = {},
): Promise<CrestodianOperationResult> {
  if (operation.kind === "none") {
    runtime.log(operation.message);
    return { applied: false, exitsInteractive: operation.message.includes("Bye.") };
  }
  if (operation.kind === "overview") {
    const overview = await loadOverviewForOperation(opts.deps);
    runtime.log(await formatOverviewForOperation(overview, opts.deps));
    return { applied: false };
  }
  if (operation.kind === "agents") {
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
  if (operation.kind === "models") {
    const overview = await loadOverviewForOperation(opts.deps);
    runtime.log(
      [
        `Default model: ${overview.defaultModel ?? "not configured"}`,
        `Codex: ${overview.tools.codex.found ? "found" : "not found"}`,
        `Claude Code: ${overview.tools.claude.found ? "found" : "not found"}`,
        `OpenAI key: ${overview.tools.apiKeys.openai ? "found" : "not found"}`,
        `Anthropic key: ${overview.tools.apiKeys.anthropic ? "found" : "not found"}`,
      ].join("\n"),
    );
    return { applied: false };
  }
  if (operation.kind === "plugin-list") {
    logQueued(runtime, "plugins.list");
    const runPluginsList =
      opts.deps?.runPluginsList ??
      (async (pluginRuntime: RuntimeEnv) => {
        const { runPluginsListCommand } = await import("../cli/plugins-list-command.js");
        await runPluginsListCommand({}, pluginRuntime);
      });
    await runPluginsList(runtime);
    runtime.log("[crestodian] done: plugins.list");
    return { applied: false };
  }
  if (operation.kind === "plugin-search") {
    logQueued(runtime, "plugins.search");
    const runPluginsSearch =
      opts.deps?.runPluginsSearch ??
      (async (query: string, pluginRuntime: RuntimeEnv) => {
        const { runPluginsSearchCommand } = await import("../cli/plugins-search-command.js");
        await runPluginsSearchCommand(query, {}, pluginRuntime);
      });
    await runPluginsSearch(operation.query, runtime);
    runtime.log("[crestodian] done: plugins.search");
    return { applied: false };
  }
  if (operation.kind === "audit") {
    runtime.log(`Audit log: ${resolveCrestodianAuditPath()}`);
    runtime.log("Only applied writes/actions are recorded; discovery stays quiet.");
    return { applied: false };
  }
  if (operation.kind === "config-validate") {
    const snapshot = await readConfigFileSnapshotLazy();
    runtime.log(formatConfigValidationLine(snapshot));
    return { applied: false };
  }
  if (operation.kind === "setup") {
    const overview = await loadOverviewForOperation(opts.deps);
    const setupModel = chooseSetupModel(overview, operation.model);
    if (!opts.approved) {
      const message = [
        formatCrestodianPersistentPlan(operation),
        setupModel.model
          ? `Model choice: ${setupModel.model} (${setupModel.source}).`
          : setupModel.source === "existing default model"
            ? `Model choice: keep existing default ${overview.defaultModel}.`
            : "Model choice: none found yet. I will only set the workspace; install/login Codex or Claude Code, or set OPENAI_API_KEY/ANTHROPIC_API_KEY, then run setup again.",
      ].join("\n");
      runtime.log(message);
      return { applied: false, message };
    }
    logQueued(runtime, "crestodian.setup");
    const { mutateConfigFile, readConfigFileSnapshot } = await loadConfigFileMutationHelpers();
    const before = await readConfigFileSnapshot();
    const workspace = resolveUserPath(operation.workspace ?? process.cwd());
    const applyDefaultModelPrimaryUpdate = setupModel.model
      ? (await import("../commands/models/shared.js")).applyDefaultModelPrimaryUpdate
      : undefined;
    const result = await mutateConfigFile({
      base: "source",
      mutate: (cfg) => {
        let next = cfg;
        if (setupModel.model && applyDefaultModelPrimaryUpdate) {
          next = applyDefaultModelPrimaryUpdate({
            cfg: next,
            modelRaw: setupModel.model,
            field: "model",
          });
        }
        next = {
          ...next,
          agents: {
            ...next.agents,
            defaults: {
              ...next.agents?.defaults,
              workspace,
            },
          },
        };
        Object.assign(cfg, next);
      },
    });
    const after = await readConfigFileSnapshot();
    await appendCrestodianAuditEntry({
      operation: "crestodian.setup",
      summary: setupModel.model
        ? `Bootstrapped setup with ${setupModel.model}`
        : "Bootstrapped setup workspace",
      configPath: result.path,
      configHashBefore: before.hash ?? result.previousHash,
      configHashAfter: after.hash ?? null,
      details: {
        ...opts.auditDetails,
        workspace,
        modelSource: setupModel.source,
        ...(setupModel.model ? { model: setupModel.model } : {}),
      },
    });
    runtime.log(`Updated ${result.path}`);
    runtime.log(`Workspace: ${shortenHomePath(workspace)}`);
    if (setupModel.model) {
      runtime.log(`Default model: ${setupModel.model} (${setupModel.source})`);
    } else if (overview.defaultModel) {
      runtime.log(`Default model: ${overview.defaultModel} (kept)`);
    } else {
      runtime.log("Default model: not configured yet");
    }
    runtime.log("[crestodian] done: crestodian.setup");
    return { applied: true };
  }
  if (operation.kind === "config-set") {
    if (!opts.approved) {
      const message = formatCrestodianPersistentPlan(operation);
      runtime.log(message);
      return { applied: false, message };
    }
    logQueued(runtime, "config.set");
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const before = await readConfigFileSnapshot();
    const runConfigSet =
      opts.deps?.runConfigSet ??
      (async (setOpts: { path?: string; value?: string; cliOptions: ConfigSetOptions }) => {
        const { runConfigSet: importedRunConfigSet } = await import("../cli/config-cli.js");
        await importedRunConfigSet({
          ...setOpts,
          runtime: createNoExitRuntime(runtime),
        });
      });
    await runConfigSet({
      path: operation.path,
      value: operation.value,
      cliOptions: {},
    });
    const after = await readConfigFileSnapshot();
    await appendCrestodianAuditEntry({
      operation: "config.set",
      summary: `Set config ${operation.path}`,
      configPath: after.path || before.path || undefined,
      configHashBefore: before.hash ?? null,
      configHashAfter: after.hash ?? null,
      details: {
        ...opts.auditDetails,
        path: operation.path,
      },
    });
    runtime.log("[crestodian] done: config.set");
    return { applied: true };
  }
  if (operation.kind === "config-set-ref") {
    if (!opts.approved) {
      const message = formatCrestodianPersistentPlan(operation);
      runtime.log(message);
      return { applied: false, message };
    }
    logQueued(runtime, "config.setRef");
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const before = await readConfigFileSnapshot();
    const runConfigSet =
      opts.deps?.runConfigSet ??
      (async (setOpts: { path?: string; value?: string; cliOptions: ConfigSetOptions }) => {
        const { runConfigSet: importedRunConfigSet } = await import("../cli/config-cli.js");
        await importedRunConfigSet({
          ...setOpts,
          runtime: createNoExitRuntime(runtime),
        });
      });
    await runConfigSet({
      path: operation.path,
      cliOptions: {
        refProvider: operation.provider ?? "default",
        refSource: operation.source,
        refId: operation.id,
      },
    });
    const after = await readConfigFileSnapshot();
    await appendCrestodianAuditEntry({
      operation: "config.setRef",
      summary: `Set config ${operation.path} SecretRef`,
      configPath: after.path || before.path || undefined,
      configHashBefore: before.hash ?? null,
      configHashAfter: after.hash ?? null,
      details: {
        ...opts.auditDetails,
        path: operation.path,
        source: operation.source,
        provider: operation.provider ?? "default",
      },
    });
    runtime.log("[crestodian] done: config.setRef");
    return { applied: true };
  }
  if (operation.kind === "plugin-install") {
    if (!opts.approved) {
      const message = formatCrestodianPersistentPlan(operation);
      runtime.log(message);
      return { applied: false, message };
    }
    const validationError = validateCrestodianPluginInstallSpec(operation.spec);
    if (validationError) {
      runtime.error(validationError);
      runtime.exit(1);
      return { applied: false };
    }
    logQueued(runtime, "plugin.install");
    const before = await readConfigFileSnapshotLazy();
    const runPluginInstall =
      opts.deps?.runPluginInstall ??
      (async (spec: string, pluginRuntime: RuntimeEnv) => {
        const { runPluginInstallCommand } = await import("../cli/plugins-install-command.js");
        await runPluginInstallCommand({ raw: spec, opts: {}, runtime: pluginRuntime });
      });
    await runPluginInstall(operation.spec, createNoExitRuntime(runtime));
    const after = await readConfigFileSnapshotLazy();
    await appendCrestodianAuditEntry({
      operation: "plugin.install",
      summary: `Installed plugin ${operation.spec}`,
      configPath: after.path || before.path || undefined,
      configHashBefore: before.hash ?? null,
      configHashAfter: after.hash ?? null,
      details: {
        ...opts.auditDetails,
        spec: operation.spec,
      },
    });
    runtime.log("[crestodian] done: plugin.install");
    runtime.log("Restart the Gateway to apply installed plugin changes.");
    return { applied: true };
  }
  if (operation.kind === "plugin-uninstall") {
    if (!opts.approved) {
      const message = formatCrestodianPersistentPlan(operation);
      runtime.log(message);
      return { applied: false, message };
    }
    logQueued(runtime, "plugin.uninstall");
    const before = await readConfigFileSnapshotLazy();
    const runPluginUninstall =
      opts.deps?.runPluginUninstall ??
      (async (pluginId: string, pluginRuntime: RuntimeEnv) => {
        const { runPluginUninstallCommand } = await import("../cli/plugins-uninstall-command.js");
        await runPluginUninstallCommand(pluginId, { force: true }, pluginRuntime);
      });
    await runPluginUninstall(operation.pluginId, createNoExitRuntime(runtime));
    const after = await readConfigFileSnapshotLazy();
    await appendCrestodianAuditEntry({
      operation: "plugin.uninstall",
      summary: `Uninstalled plugin ${operation.pluginId}`,
      configPath: after.path || before.path || undefined,
      configHashBefore: before.hash ?? null,
      configHashAfter: after.hash ?? null,
      details: {
        ...opts.auditDetails,
        pluginId: operation.pluginId,
      },
    });
    runtime.log("[crestodian] done: plugin.uninstall");
    runtime.log("Restart the Gateway to apply plugin changes.");
    return { applied: true };
  }
  if (operation.kind === "create-agent") {
    if (!opts.approved) {
      const message = formatCrestodianPersistentPlan(operation);
      runtime.log(message);
      return { applied: false, message };
    }
    logQueued(runtime, "agents.create");
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const before = await readConfigFileSnapshot();
    const workspace = resolveUserPath(operation.workspace ?? process.cwd());
    const runAgentsAdd =
      opts.deps?.runAgentsAdd ??
      (await import("../commands/agents.commands.add.js")).agentsAddCommand;
    await runAgentsAdd(
      {
        name: operation.agentId,
        workspace,
        ...(operation.model ? { model: operation.model } : {}),
        nonInteractive: true,
      },
      runtime,
      { hasFlags: true },
    );
    const after = await readConfigFileSnapshot();
    await appendCrestodianAuditEntry({
      operation: "agents.create",
      summary: `Created agent ${operation.agentId}`,
      configPath: after.path || before.path || undefined,
      configHashBefore: before.hash ?? null,
      configHashAfter: after.hash ?? null,
      details: {
        ...opts.auditDetails,
        agentId: operation.agentId,
        workspace,
        ...(operation.model ? { model: operation.model } : {}),
      },
    });
    runtime.log("[crestodian] done: agents.create");
    return { applied: true };
  }
  if (operation.kind === "doctor") {
    logQueued(runtime, "doctor");
    const runDoctor = opts.deps?.runDoctor ?? (await import("../commands/doctor.js")).doctorCommand;
    await runDoctor(runtime, { nonInteractive: true });
    runtime.log("[crestodian] done: doctor");
    return { applied: false };
  }
  if (operation.kind === "doctor-fix") {
    if (!opts.approved) {
      const message = formatCrestodianPersistentPlan(operation);
      runtime.log(message);
      return { applied: false, message };
    }
    logQueued(runtime, "doctor.fix");
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const before = await readConfigFileSnapshot();
    const runDoctor = opts.deps?.runDoctor ?? (await import("../commands/doctor.js")).doctorCommand;
    await runDoctor(runtime, { nonInteractive: true, repair: true, yes: true });
    const after = await readConfigFileSnapshot();
    await appendCrestodianAuditEntry({
      operation: "doctor.fix",
      summary: "Ran doctor repairs",
      configPath: after.path || before.path || undefined,
      configHashBefore: before.hash ?? null,
      configHashAfter: after.hash ?? null,
      details: opts.auditDetails,
    });
    runtime.log("[crestodian] done: doctor.fix");
    return { applied: true };
  }
  if (operation.kind === "status") {
    logQueued(runtime, "status.check");
    const { statusCommand } = await import("../commands/status.command.js");
    await statusCommand({ timeoutMs: 10_000 }, runtime);
    runtime.log("[crestodian] done: status.check");
    return { applied: false };
  }
  if (operation.kind === "health") {
    logQueued(runtime, "health.check");
    const { healthCommand } = await import("../commands/health.js");
    await healthCommand({ timeoutMs: 10_000 }, runtime);
    runtime.log("[crestodian] done: health.check");
    return { applied: false };
  }
  if (operation.kind === "gateway-status") {
    const overview = await loadOverviewForOperation(opts.deps);
    runtime.log(formatGatewayStatusLine(overview));
    return { applied: false };
  }
  if (operation.kind === "gateway-start") {
    if (!opts.approved) {
      const message = formatCrestodianPersistentPlan(operation);
      runtime.log(message);
      return { applied: false, message };
    }
    logQueued(runtime, "gateway.start");
    const runGatewayStart = opts.deps?.runGatewayStart ?? (() => runGatewayLifecycle("start"));
    await runGatewayStart();
    await appendCrestodianAuditEntry({
      operation: "gateway.start",
      summary: "Started Gateway",
      details: opts.auditDetails,
    });
    runtime.log("[crestodian] done: gateway.start");
    return { applied: true };
  }
  if (operation.kind === "gateway-stop") {
    if (!opts.approved) {
      const message = formatCrestodianPersistentPlan(operation);
      runtime.log(message);
      return { applied: false, message };
    }
    logQueued(runtime, "gateway.stop");
    const runGatewayStop = opts.deps?.runGatewayStop ?? (() => runGatewayLifecycle("stop"));
    await runGatewayStop();
    await appendCrestodianAuditEntry({
      operation: "gateway.stop",
      summary: "Stopped Gateway",
      details: opts.auditDetails,
    });
    runtime.log("[crestodian] done: gateway.stop");
    return { applied: true };
  }
  if (operation.kind === "gateway-restart") {
    if (!opts.approved) {
      const message = formatCrestodianPersistentPlan(operation);
      runtime.log(message);
      return { applied: false, message };
    }
    logQueued(runtime, "gateway.restart");
    const runGatewayRestart =
      opts.deps?.runGatewayRestart ?? (() => runGatewayLifecycle("restart"));
    await runGatewayRestart();
    await appendCrestodianAuditEntry({
      operation: "gateway.restart",
      summary: "Restarted Gateway",
      details: opts.auditDetails,
    });
    runtime.log("[crestodian] done: gateway.restart");
    return { applied: true };
  }
  if (operation.kind === "open-tui") {
    logQueued(runtime, "tui.open");
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
      return {
        applied: false,
        nextInput: result.crestodianMessage,
      };
    }
    return { applied: false, exitsInteractive: true };
  }
  if (operation.kind === "set-default-model") {
    if (!opts.approved) {
      const message = formatCrestodianPersistentPlan(operation);
      runtime.log(message);
      return { applied: false, message };
    }
    logQueued(runtime, "config.setDefaultModel");
    const { mutateConfigFile, readConfigFileSnapshot } = await loadConfigFileMutationHelpers();
    const before = await readConfigFileSnapshot();
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
    const after = await readConfigFileSnapshot();
    const { resolveAgentModelPrimaryValue } = await import("../config/model-input.js");
    const effectiveModel = resolveAgentModelPrimaryValue(result.nextConfig.agents?.defaults?.model);
    await appendCrestodianAuditEntry({
      operation: "config.setDefaultModel",
      summary: `Set default model to ${operation.model}`,
      configPath: result.path,
      configHashBefore: before.hash ?? result.previousHash,
      configHashAfter: after.hash ?? null,
      details: {
        ...opts.auditDetails,
        requestedModel: operation.model,
        effectiveModel,
      },
    });
    runtime.log(`Updated ${result.path}`);
    runtime.log(`Default model: ${effectiveModel ?? operation.model}`);
    runtime.log("[crestodian] done: config.setDefaultModel");
    return { applied: true };
  }
  return { applied: false };
}
