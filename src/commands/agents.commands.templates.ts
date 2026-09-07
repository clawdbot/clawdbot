import { createAgent, validateAgentIdInput } from "../agents/agent-create.js";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  importAgentTemplateAutomations,
  validateAgentTemplateAutomations,
} from "../agents/agent-template-automations.js";
import {
  exportAgentTemplateBundle,
  loadAgentTemplateBundle,
} from "../agents/agent-template-bundle.js";
import { isTerminalInteractive } from "../cli/terminal-interactivity.js";
import { readConfigFileSnapshot, resolveConfigSnapshotHash } from "../config/config.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";

export type AgentsExportOptions = { id: string; out: string; force?: boolean; json?: boolean };
export type AgentsImportOptions = {
  directory: string;
  id?: string;
  workspace?: string;
  nonInteractive?: boolean;
  json?: boolean;
};

async function templateConfigSnapshot() {
  const snapshot = await readConfigFileSnapshot({ observe: false });
  if (!snapshot.valid) {
    throw new Error("OpenClaw config is invalid; run openclaw config validate.");
  }
  return snapshot;
}

export async function agentsExportCommand(
  opts: AgentsExportOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const { config } = await templateConfigSnapshot();
  const summary = await exportAgentTemplateBundle(config, opts.id, opts.out, opts.force);
  if (opts.json) {
    writeRuntimeJson(runtime, summary);
    return;
  }
  runtime.log(`Exported agent "${summary.agentId}" to ${summary.out}`);
  runtime.log(`Files: ${summary.files.join(", ")}`);
  runtime.log(`Automations: ${summary.automations}`);
  for (const warning of summary.warnings) {
    runtime.log(`Review before sharing: ${warning}`);
  }
  runtime.log(`Omissions:\n${summary.omissions.map((line) => `- ${line}`).join("\n")}`);
}

export async function agentsImportCommand(
  opts: AgentsImportOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const bundle = await loadAgentTemplateBundle(resolveUserPath(opts.directory));
  const { manifest } = bundle.template;
  const validatedId = validateAgentIdInput(opts.id ?? manifest.identity.name);
  if (!validatedId.ok) {
    throw new Error(validatedId.message);
  }
  const agentId = validatedId.agentId;
  const snapshot = await templateConfigSnapshot();
  const cfg = snapshot.config;
  const roster = new Set(listAgentEntries(cfg).map((entry) => entry.id));
  if (roster.has(agentId)) {
    throw new Error(`Agent "${agentId}" already exists.`);
  }
  const requested = manifest.subagents?.allowAgents;
  const retained = requested?.filter((id) => roster.has(id));
  const dropped = requested?.filter((id) => !roster.has(id)) ?? [];
  const warnings = dropped.length
    ? [`Dropped delegation targets absent from this install: ${dropped.join(", ")}`]
    : [];
  const subagents = manifest.subagents
    ? {
        ...(retained?.length || requested?.length === 0 ? { allowAgents: retained } : {}),
        ...(manifest.subagents.delegationMode
          ? { delegationMode: manifest.subagents.delegationMode }
          : {}),
      }
    : undefined;
  const workspace = opts.workspace
    ? resolveUserPath(opts.workspace)
    : resolveAgentWorkspaceDir(cfg, agentId);
  const entry = {
    id: agentId,
    name: manifest.title,
    description: manifest.summary,
    workspace,
    identity: manifest.identity,
    ...(manifest.skills !== undefined ? { skills: manifest.skills } : {}),
    ...(manifest.model !== undefined ? { model: manifest.model } : {}),
    ...(subagents ? { subagents } : {}),
  };
  const { id: _id, ...configEntry } = entry;
  const { list: _list, ...agentsConfig } = cfg.agents ?? {};
  const prospective = OpenClawSchema.safeParse({
    ...cfg,
    agents: {
      ...agentsConfig,
      entries: { ...cfg.agents?.entries, [agentId]: configEntry },
    },
  });
  if (!prospective.success) {
    throw new Error("Template would produce an invalid OpenClaw config.");
  }
  await validateAgentTemplateAutomations(cfg, agentId, bundle.automations);
  const review = "Review before enabling: imported automations are disabled.";
  if (!opts.nonInteractive) {
    const output = opts.json ? process.stderr : process.stdout;
    if (!isTerminalInteractive(output)) {
      throw new Error(
        "Template import requires confirmation; use --non-interactive without a terminal.",
      );
    }
    const summary = `Import "${manifest.title}" as ${agentId}\nWorkspace: ${workspace}\nFiles: ${manifest.files.join(", ")}\nIdentity: ${JSON.stringify(manifest.identity)}\nSkills: ${JSON.stringify(manifest.skills ?? "inherit")}\nModel: ${JSON.stringify(manifest.model ?? "inherit")}\nDelegation: ${JSON.stringify(subagents ?? "inherit")}\nAutomations: ${bundle.automations.length} disabled\n${[...warnings, review].join("\n")}`;
    if (!(await createClackPrompter(output).confirm({ message: summary, initialValue: false }))) {
      if (opts.json) {
        writeRuntimeJson(runtime, { status: "cancelled", agentId });
      } else {
        runtime.log("Template import cancelled; no files or config written.");
      }
      return;
    }
  }
  const created = await createAgent({
    entry,
    template: { ...bundle.template, manifest: { ...manifest, subagents } },
    expectedConfigHash: resolveConfigSnapshotHash(snapshot) ?? null,
  });
  if (created.status !== "created") {
    throw new Error(
      created.status === "error" ? created.message : `Agent "${agentId}" already exists.`,
    );
  }
  const automations = await importAgentTemplateAutomations(
    created.config,
    agentId,
    bundle.automations,
  );
  const failed = automations.filter((outcome) => outcome.status === "failed");
  const summary = {
    status: failed.length ? "partial" : "created",
    agentId,
    workspace: created.workspace,
    identity: manifest.identity,
    files: manifest.files,
    warnings,
    automations,
    review,
  };
  if (opts.json) {
    writeRuntimeJson(runtime, summary);
  } else {
    runtime.log(`Imported agent "${agentId}" into ${created.workspace}`);
    for (const warning of warnings) {
      runtime.log(`Warning: ${warning}`);
    }
    for (const outcome of automations) {
      runtime.log(
        outcome.status === "created"
          ? `Automation "${outcome.name}": ${outcome.id} (disabled)`
          : `Automation "${outcome.name}" failed: ${outcome.error}`,
      );
    }
    runtime.log(review);
  }
  if (failed.length) {
    runtime.exit(1, { resetStream: process.stderr });
  }
}
