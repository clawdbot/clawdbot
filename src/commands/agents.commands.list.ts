// Implements `openclaw agents list` text and JSON summaries.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../cli/command-format.js";
import { listRouteBindings } from "../config/bindings.js";
import type { AgentRouteBinding, OpenClawConfig } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson, defaultRuntime } from "../runtime.js";
import {
  listAgentProvenance,
  readAgentProvenance,
  type AgentProvenance,
} from "../state/agent-provenance.js";
import { shortenHomePath } from "../utils.js";
import { describeBinding } from "./agents.bindings.js";
import type { AgentSummary } from "./agents.config.js";
import { buildAgentSummaries } from "./agents.config.js";
import {
  buildProviderStatusIndex,
  buildProviderSummaryMetadataIndex,
  listProvidersForAgent,
  summarizeBindings,
} from "./agents.providers.js";
import { validateCommandConfigSnapshot } from "./config-validation.js";

type AgentsListOptions = {
  json?: boolean;
  bindings?: boolean;
  tree?: boolean;
};

function formatSummaryHeader(summary: AgentSummary): string {
  const safe = sanitizeTerminalText;
  const defaultTag = summary.isDefault ? " (default)" : "";
  return summary.name && summary.name !== summary.id
    ? `${safe(summary.id)}${defaultTag} (${safe(summary.name)})`
    : `${safe(summary.id)}${defaultTag}`;
}

function formatSummary(summary: AgentSummary) {
  const safe = sanitizeTerminalText;
  const header = formatSummaryHeader(summary);

  const identityParts = [];
  if (summary.identityEmoji) {
    identityParts.push(safe(summary.identityEmoji));
  }
  if (summary.identityName) {
    identityParts.push(safe(summary.identityName));
  }
  const identityLine = identityParts.length > 0 ? identityParts.join(" ") : null;
  const identitySource =
    summary.identitySource === "identity"
      ? "IDENTITY.md"
      : summary.identitySource === "config"
        ? "config"
        : null;

  const lines = [`- ${header}`];
  if (identityLine) {
    lines.push(`  Identity: ${identityLine}${identitySource ? ` (${identitySource})` : ""}`);
  }
  lines.push(`  Workspace: ${safe(shortenHomePath(summary.workspace))}`);
  lines.push(`  Agent dir: ${safe(shortenHomePath(summary.agentDir))}`);
  if (summary.model) {
    lines.push(`  Model: ${safe(summary.model)}`);
  }
  lines.push(`  Routing rules: ${summary.bindings}`);

  if (summary.routes?.length) {
    lines.push(`  Routing: ${summary.routes.map(safe).join(", ")}`);
  }
  if (summary.providers?.length) {
    lines.push("  Providers:");
    for (const provider of summary.providers) {
      lines.push(`    - ${safe(provider)}`);
    }
  }

  if (summary.bindingDetails?.length) {
    lines.push("  Routing rules:");
    for (const binding of summary.bindingDetails) {
      lines.push(`    - ${safe(binding)}`);
    }
  }
  return lines.join("\n");
}

function formatAgentTree(summaries: AgentSummary[], provenance: AgentProvenance[]): string[] {
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const provenanceById = new Map(provenance.map((record) => [record.agentId, record]));
  const childrenById = new Map<string, AgentSummary[]>();
  const roots: AgentSummary[] = [];

  for (const summary of summaries) {
    const creatorAgentId = provenanceById.get(summary.id)?.creatorAgentId;
    if (creatorAgentId && creatorAgentId !== summary.id && summaryById.has(creatorAgentId)) {
      const children = childrenById.get(creatorAgentId) ?? [];
      children.push(summary);
      childrenById.set(creatorAgentId, children);
    } else {
      roots.push(summary);
    }
  }

  const lines: string[] = [];
  const visited = new Set<string>();
  const append = (summary: AgentSummary, depth: number): void => {
    if (visited.has(summary.id)) {
      return;
    }
    visited.add(summary.id);
    lines.push(`${"  ".repeat(depth)}- ${formatSummaryHeader(summary)}`);
    for (const child of childrenById.get(summary.id) ?? []) {
      append(child, depth + 1);
    }
  };
  roots.forEach((summary) => append(summary, 0));
  // Corrupt or manually rewritten provenance can form a cycle. Keep every
  // configured agent visible by promoting the first unseen member to a root.
  summaries.forEach((summary) => append(summary, 0));
  return lines;
}

/** Print configured agent summaries with optional binding/provider detail enrichment. */
export async function agentsListCommand(
  opts: AgentsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const { withCommandConfigSnapshot } = await import("../cli/command-config-snapshot.js");
  return await withCommandConfigSnapshot({}, async (snapshot) => {
    const cfg = validateCommandConfigSnapshot(snapshot, runtime)?.config;
    if (cfg) {
      await printAgentSummaries(cfg, opts, runtime);
    }
  });
}

async function printAgentSummaries(
  cfg: OpenClawConfig,
  opts: AgentsListOptions,
  runtime: RuntimeEnv,
) {
  const summaries = buildAgentSummaries(cfg);
  const provenance = opts.tree ? listAgentProvenance() : [];
  if (opts.json) {
    for (const summary of summaries) {
      const record = readAgentProvenance(summary.id);
      if (record) {
        summary.createdVia = record.createdVia;
        summary.creatorAgentId = record.creatorAgentId;
        summary.createdAt = record.createdAtMs;
      }
    }
  }
  const bindingMap = new Map<string, AgentRouteBinding[]>();
  for (const binding of listRouteBindings(cfg)) {
    const agentId = normalizeAgentId(binding.agentId);
    const list = bindingMap.get(agentId) ?? [];
    list.push(binding);
    bindingMap.set(agentId, list);
  }

  if (opts.bindings) {
    for (const summary of summaries) {
      const bindings = bindingMap.get(summary.id) ?? [];
      if (bindings.length > 0) {
        summary.bindingDetails = bindings.map((binding) => describeBinding(binding));
      }
    }
  }

  // Provider details are only used for human text output
  // (`summary.providers` is rendered in the text formatter). JSON callers
  // (dashboards, monitors, IDE plugins) poll the config/state-derived fields, so
  // skip the provider detail pass unless they explicitly ask for enrichment.
  // This keeps JSON and tree output off the bundled plugin runtime path.
  const includeProviderDetails = (!opts.json && !opts.tree) || opts.bindings === true;
  const providerStatus = includeProviderDetails ? await buildProviderStatusIndex(cfg) : null;
  const providerMetadata = includeProviderDetails ? buildProviderSummaryMetadataIndex(cfg) : null;

  for (const summary of summaries) {
    const bindings = bindingMap.get(summary.id) ?? [];
    if (includeProviderDetails && providerStatus && providerMetadata) {
      const routes = summarizeBindings(cfg, bindings, providerMetadata);
      if (routes.length > 0) {
        summary.routes = routes;
      } else if (summary.isDefault) {
        summary.routes = ["default (no explicit rules)"];
      }

      const providerLines = listProvidersForAgent({
        summaryIsDefault: summary.isDefault,
        cfg,
        bindings,
        providerStatus,
        providerMetadata,
      });
      if (providerLines.length > 0) {
        summary.providers = providerLines;
      }
    }
  }

  if (opts.json) {
    writeRuntimeJson(runtime, summaries);
    return;
  }

  if (opts.tree) {
    runtime.log(["Agents:", ...formatAgentTree(summaries, provenance)].join("\n"));
    return;
  }

  const lines = ["Agents:", ...summaries.map(formatSummary)];
  lines.push("Routing rules map channel/account/peer to an agent. Use --bindings for full rules.");
  lines.push(
    `Channel status reflects local config/creds. For live health: ${formatCliCommand("openclaw channels status --probe")}.`,
  );
  runtime.log(lines.join("\n"));
}
