// OpenClaw overview gathers config, agent, tool, docs, source, and gateway status.
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
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { probeGatewayUrl, probeLocalCommand, type LocalCommandProbe } from "./probes.js";

type SystemAgentSummary = {
  id: string;
  name?: string;
  isDefault: boolean;
  model?: string;
  workspace?: string;
};

export type SystemAgentOverview = {
  config: {
    path: string;
    exists: boolean;
    valid: boolean;
    issues: string[];
    hash: string | null;
  };
  agents: SystemAgentSummary[];
  defaultAgentId: string;
  defaultModel?: string;
  tools: {
    codex: LocalCommandProbe;
    claude: LocalCommandProbe;
    gemini: LocalCommandProbe;
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

type SystemAgentOverviewDependencies = {
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

function buildAgentSummaries(cfg: OpenClawConfig): SystemAgentSummary[] {
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
  const summaries: SystemAgentSummary[] = [];
  // Agent ids are normalized and deduped so config aliases do not produce duplicate setup choices.
  for (const entry of entries) {
    const id = normalizeAgentId(entry.id);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const summary: SystemAgentSummary = {
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
  if (!isFastTestRuntimeEnv(env)) {
    return undefined;
  }
  const sourcePath = process.cwd();
  return {
    sourcePath,
    docsPath: `${sourcePath}/docs`,
  };
}

export async function loadSystemAgentOverview(
  opts: { env?: NodeJS.ProcessEnv; deps?: SystemAgentOverviewDependencies } = {},
): Promise<SystemAgentOverview> {
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
  const [codex, claude, gemini, gateway, references] = await Promise.all([
    // Probes run in parallel; each individual probe is timeout-bounded in probes.ts.
    commandProbe("codex"),
    commandProbe("claude"),
    commandProbe("gemini"),
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
      gemini,
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

export function formatSystemAgentOverview(overview: SystemAgentOverview): string {
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
      : "missing"
    : "invalid";
  const issueLines =
    overview.config.issues.length > 0
      ? ["Config issues:", ...overview.config.issues.map((issue) => `  - ${issue}`)]
      : [];
  return [
    "OpenClaw online. Little claws, typed tools.",
    "",
    `Config: ${configStatus}`,
    `Path: ${overview.config.path}`,
    `Default agent: ${overview.defaultAgentId}`,
    `Default model: ${overview.defaultModel ?? "not configured"}`,
    "Agents:",
    ...agentLines,
    `Codex: ${formatCommandProbe(overview.tools.codex)}`,
    `Claude Code: ${formatCommandProbe(overview.tools.claude)}`,
    `Gemini CLI: ${formatCommandProbe(overview.tools.gemini)}`,
    `API keys: OpenAI ${overview.tools.apiKeys.openai ? "found" : "not found"}, Anthropic ${
      overview.tools.apiKeys.anthropic ? "found" : "not found"
    }`,
    `AI: ${
      overview.defaultModel
        ? `conversation runs on ${overview.defaultModel}`
        : "inference unavailable; run openclaw onboard before starting OpenClaw"
    }`,
    `Docs: ${overview.references.docsPath ?? overview.references.docsUrl}`,
    overview.references.sourcePath
      ? `Source: ${overview.references.sourcePath}`
      : `Source: ${overview.references.sourceUrl}`,
    `Gateway: ${overview.gateway.reachable ? "reachable" : "not reachable"} (${overview.gateway.url}, ${overview.gateway.source})`,
    overview.gateway.error ? `Gateway note: ${overview.gateway.error}` : undefined,
    `Next: ${recommendSystemAgentNextStep(overview)}`,
    ...issueLines,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function recommendSystemAgentNextStep(overview: SystemAgentOverview): string {
  if (!overview.config.exists) {
    return 'run "openclaw onboard" to establish inference';
  }
  if (!overview.config.valid) {
    return 'run "validate config" or "doctor" to inspect the config';
  }
  if (!overview.defaultModel) {
    return 'run "openclaw onboard" to establish inference';
  }
  if (!overview.gateway.reachable) {
    return 'run "gateway status" or "restart gateway"';
  }
  return 'run "talk to agent" to enter your default agent';
}

function formatStartupConfigStatus(overview: SystemAgentOverview): string {
  if (!overview.config.exists) {
    return "missing";
  }
  return overview.config.valid ? "valid" : "invalid";
}

function formatStartupGatewayStatus(overview: SystemAgentOverview): string {
  if (overview.gateway.reachable) {
    return `Gateway: reachable at ${overview.gateway.url}.`;
  }
  return `Gateway: not reachable at ${overview.gateway.url}; I already did the first probe.`;
}

function formatStartupAction(overview: SystemAgentOverview): string | undefined {
  if (!overview.config.valid) {
    return "Config needs attention. Run `doctor` to inspect it.";
  }
  if (!overview.defaultModel) {
    return "Inference is unavailable. Run `openclaw onboard` and complete a live model check.";
  }
  return undefined;
}

/**
 * Welcome shown right after inference activation. OpenClaw owns the
 * remaining workspace, Gateway, channel, and agent setup.
 */
export function formatSystemAgentOnboardingWelcome(overview: SystemAgentOverview): string {
  return [
    "## Inference is ready.",
    "",
    `- Verified model: ${overview.defaultModel ?? "not configured"}.`,
    `- ${overview.gateway.reachable ? `Gateway: running at ${overview.gateway.url}.` : "Gateway: not configured or reachable yet."}`,
    "- I can now finish your workspace, Gateway, channels, agents, plugins, and other optional setup.",
    "- Connect how you want to talk: say `connect whatsapp`, `connect telegram`, `connect slack`, `connect discord` — or `channels` for the full list.",
    "",
    "Say `talk to agent` to meet your agent right here, or `help` for everything I can do.",
  ].join("\n");
}

export function formatSystemAgentStartupMessage(overview: SystemAgentOverview): string {
  const agent = overview.agents.find((entry) => entry.id === overview.defaultAgentId);
  const agentLabel = agent?.name
    ? `${overview.defaultAgentId} (${agent.name})`
    : overview.defaultAgentId;
  return [
    "Hi, I'm OpenClaw — caretaker of this gateway, config, channels, and agents.",
    // Inference status stays independent of the recovery action line: with an
    // invalid config AND no model, both problems must be visible.
    overview.defaultModel ? `Model: ${overview.defaultModel}.` : "Inference is unavailable.",
    `Config: ${formatStartupConfigStatus(overview)}. Default agent: ${agentLabel}.`,
    formatStartupGatewayStatus(overview),
    formatStartupAction(overview),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
