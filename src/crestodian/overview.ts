import {
  listAgentEntries,
  resolveAgentEffectiveModelPrimary,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  OPENCLAW_DOCS_URL,
  OPENCLAW_SOURCE_URL,
  resolveOpenClawReferencePaths,
} from "../agents/docs-path.js";
import {
  readConfigFileSnapshot,
  resolveConfigPath,
  resolveGatewayPort,
  type ConfigFileSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { probeGatewayUrl, probeLocalCommand, type LocalCommandProbe } from "./probes.js";

export type CrestodianAgentSummary = {
  id: string;
  name?: string;
  isDefault: boolean;
  model?: string;
  workspace?: string;
};

export type CrestodianOverview = {
  config: {
    path: string;
    exists: boolean;
    valid: boolean;
    issues: string[];
    hash: string | null;
  };
  agents: CrestodianAgentSummary[];
  defaultAgentId: string;
  defaultModel?: string;
  tools: {
    codex: LocalCommandProbe;
    claude: LocalCommandProbe;
    apiKeys: {
      openai: boolean;
      anthropic: boolean;
    };
  };
  gateway: {
    url: string;
    source: string;
    reachable: boolean;
    error?: string;
  };
  references: {
    docsPath?: string;
    docsUrl: string;
    sourcePath?: string;
    sourceUrl: string;
  };
};

type OpenClawReferencePaths = Awaited<ReturnType<typeof resolveOpenClawReferencePaths>>;

type GatewayConnectionDetails = {
  url: string;
  urlSource: string;
  remoteFallbackNote?: string;
};

type CrestodianOverviewDependencies = {
  readConfigFileSnapshot?: typeof readConfigFileSnapshot;
  resolveConfigPath?: typeof resolveConfigPath;
  resolveGatewayPort?: typeof resolveGatewayPort;
  buildGatewayConnectionDetails?: (input: {
    config: OpenClawConfig;
    configPath: string;
  }) => GatewayConnectionDetails;
  probeLocalCommand?: typeof probeLocalCommand;
  probeGatewayUrl?: typeof probeGatewayUrl;
  resolveOpenClawReferencePaths?: typeof resolveOpenClawReferencePaths;
};

function issueMessages(snapshot: ConfigFileSnapshot): string[] {
  return snapshot.issues.map((issue) => {
    const path = issue.path ? `${issue.path}: ` : "";
    return `${path}${issue.message}`;
  });
}

function buildAgentSummaries(cfg: OpenClawConfig): CrestodianAgentSummary[] {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const entries = listAgentEntries(cfg);
  if (entries.length === 0) {
    return [
      {
        id: defaultAgentId,
        isDefault: true,
        model: resolveAgentEffectiveModelPrimary(cfg, defaultAgentId),
      },
    ];
  }
  const seen = new Set<string>();
  const summaries: CrestodianAgentSummary[] = [];
  for (const entry of entries) {
    const id = normalizeAgentId(entry.id);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const summary: CrestodianAgentSummary = {
      id,
      isDefault: id === defaultAgentId,
    };
    if (typeof entry.name === "string") {
      summary.name = entry.name;
    }
    const model = resolveAgentEffectiveModelPrimary(cfg, id);
    if (model) {
      summary.model = model;
    }
    if (typeof entry.workspace === "string") {
      summary.workspace = entry.workspace;
    }
    summaries.push(summary);
  }
  return summaries;
}

function resolveFastTestReferences(env: NodeJS.ProcessEnv): OpenClawReferencePaths | undefined {
  if (env.OPENCLAW_TEST_FAST !== "1") {
    return undefined;
  }
  const sourcePath = process.cwd();
  return {
    sourcePath,
    docsPath: `${sourcePath}/docs`,
  };
}

export async function loadCrestodianOverview(
  opts: { env?: NodeJS.ProcessEnv; deps?: CrestodianOverviewDependencies } = {},
): Promise<CrestodianOverview> {
  const env = opts.env ?? process.env;
  const deps = opts.deps ?? {};
  const readSnapshot = deps.readConfigFileSnapshot ?? readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  const cfg = snapshot.runtimeConfig ?? snapshot.sourceConfig ?? {};
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const defaultModel =
    resolveAgentEffectiveModelPrimary(cfg, defaultAgentId) ??
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
  const configPath = snapshot.path || (deps.resolveConfigPath ?? resolveConfigPath)(env);
  let gatewayUrl = `ws://127.0.0.1:${(deps.resolveGatewayPort ?? resolveGatewayPort)(cfg, env)}`;
  let gatewaySource = "local loopback";
  let gatewayError: string | undefined;
  try {
    const buildGatewayConnectionDetails =
      deps.buildGatewayConnectionDetails ??
      (await import("../gateway/call.js")).buildGatewayConnectionDetails;
    const details = buildGatewayConnectionDetails({ config: cfg, configPath });
    gatewayUrl = details.url;
    gatewaySource = details.urlSource;
    gatewayError = details.remoteFallbackNote;
  } catch (err) {
    gatewayError = err instanceof Error ? err.message : String(err);
  }
  const resolveReferences = deps.resolveOpenClawReferencePaths ?? resolveOpenClawReferencePaths;
  const commandProbe = deps.probeLocalCommand ?? probeLocalCommand;
  const [codex, claude, gateway, references] = await Promise.all([
    commandProbe("codex"),
    commandProbe("claude"),
    (deps.probeGatewayUrl ?? probeGatewayUrl)(gatewayUrl),
    resolveFastTestReferences(env) ??
      resolveReferences({
        argv1: process.argv[1],
        cwd: process.cwd(),
        moduleUrl: import.meta.url,
      }),
  ]);
  return {
    config: {
      path: configPath,
      exists: snapshot.exists,
      valid: snapshot.valid,
      issues: issueMessages(snapshot),
      hash: snapshot.hash ?? null,
    },
    agents: buildAgentSummaries(cfg),
    defaultAgentId,
    defaultModel,
    tools: {
      codex,
      claude,
      apiKeys: {
        openai: Boolean(env.OPENAI_API_KEY?.trim()),
        anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim()),
      },
    },
    gateway: {
      url: gateway.url,
      source: gatewaySource,
      reachable: gateway.reachable,
      error: gateway.error ?? gatewayError,
    },
    references: {
      docsPath: references.docsPath ?? undefined,
      docsUrl: OPENCLAW_DOCS_URL,
      sourcePath: references.sourcePath ?? undefined,
      sourceUrl: OPENCLAW_SOURCE_URL,
    },
  };
}

function formatCommandProbe(probe: LocalCommandProbe): string {
  if (!probe.found) {
    return "not found";
  }
  if (probe.version) {
    return probe.version;
  }
  return probe.error ? `found (${probe.error})` : "found";
}

export function formatCrestodianOverview(overview: CrestodianOverview): string {
  const agentLines = overview.agents.map((agent) => {
    const bits = [
      agent.id,
      agent.isDefault ? "default" : undefined,
      agent.name ? `name=${agent.name}` : undefined,
      agent.model ? `model=${agent.model}` : undefined,
      agent.workspace ? `workspace=${agent.workspace}` : undefined,
    ].filter(Boolean);
    return `  - ${bits.join(" | ")}`;
  });
  const configStatus = overview.config.valid
    ? overview.config.exists
      ? "valid"
      : "missing (configless rescue mode)"
    : "invalid";
  const issueLines =
    overview.config.issues.length > 0
      ? ["Config issues:", ...overview.config.issues.map((issue) => `  - ${issue}`)]
      : [];
  return [
    "Crestodian online. Little claws, typed tools.",
    "",
    `Config: ${configStatus}`,
    `Path: ${overview.config.path}`,
    `Default agent: ${overview.defaultAgentId}`,
    `Default model: ${overview.defaultModel ?? "not configured"}`,
    "Agents:",
    ...agentLines,
    `Codex: ${formatCommandProbe(overview.tools.codex)}`,
    `Claude Code: ${formatCommandProbe(overview.tools.claude)}`,
    `API keys: OpenAI ${overview.tools.apiKeys.openai ? "found" : "not found"}, Anthropic ${
      overview.tools.apiKeys.anthropic ? "found" : "not found"
    }`,
    `Planner: ${
      overview.defaultModel
        ? `model-assisted via ${overview.defaultModel} for fuzzy local commands`
        : "deterministic only until a model is configured"
    }`,
    `Docs: ${overview.references.docsPath ?? overview.references.docsUrl}`,
    overview.references.sourcePath
      ? `Source: ${overview.references.sourcePath}`
      : `Source: ${overview.references.sourceUrl}`,
    `Gateway: ${overview.gateway.reachable ? "reachable" : "not reachable"} (${overview.gateway.url}, ${overview.gateway.source})`,
    overview.gateway.error ? `Gateway note: ${overview.gateway.error}` : undefined,
    `Next: ${recommendCrestodianNextStep(overview)}`,
    ...issueLines,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function recommendCrestodianNextStep(overview: CrestodianOverview): string {
  if (!overview.config.exists) {
    return 'run "setup" to create a starter config';
  }
  if (!overview.config.valid) {
    return 'run "validate config" or "doctor" to inspect the config';
  }
  if (!overview.defaultModel) {
    return 'run "setup" or "set default model <provider/model>"';
  }
  if (!overview.gateway.reachable) {
    return 'run "gateway status" or "restart gateway"';
  }
  return 'run "talk to agent" to enter your default agent';
}

function formatStartupConfigStatus(overview: CrestodianOverview): string {
  if (!overview.config.exists) {
    return "missing";
  }
  return overview.config.valid ? "valid" : "invalid";
}

function formatStartupUse(overview: CrestodianOverview): string {
  if (overview.defaultModel) {
    return `Using: ${overview.defaultModel} for fuzzy local planning.`;
  }
  return "Using: deterministic typed commands until we configure a model.";
}

function formatStartupGatewayStatus(overview: CrestodianOverview): string {
  if (overview.gateway.reachable) {
    return `Gateway: reachable at ${overview.gateway.url}.`;
  }
  return `Gateway: not reachable at ${overview.gateway.url}; I already did the first probe.`;
}

function formatStartupAction(overview: CrestodianOverview): string {
  if (!overview.config.exists) {
    return "I can start by creating a starter config with `setup`.";
  }
  if (!overview.config.valid) {
    return "I can start debugging with `validate config` or `doctor`.";
  }
  if (!overview.defaultModel) {
    return "I can start by choosing a model with `setup`.";
  }
  if (!overview.gateway.reachable) {
    return "I can start debugging with `gateway status`, or queue `restart gateway` for approval.";
  }
  return "Everything basic is reachable. Use `talk to agent` when you want the normal agent.";
}

export function formatCrestodianStartupMessage(overview: CrestodianOverview): string {
  const agent = overview.agents.find((entry) => entry.id === overview.defaultAgentId);
  const agentLabel = agent?.name
    ? `${overview.defaultAgentId} (${agent.name})`
    : overview.defaultAgentId;
  return [
    "## Hi, I'm Crestodian.",
    "",
    "- Start me when setup, config, Gateway, model choice, or agent routing feels off.",
    `- ${formatStartupUse(overview)}`,
    `- Config: ${formatStartupConfigStatus(overview)}. Default agent: ${agentLabel}.`,
    `- ${formatStartupGatewayStatus(overview)}`,
    "",
    formatStartupAction(overview),
  ].join("\n");
}
