import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_AGENT_ID,
  normalizeAgentId,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { resolveDefaultWhatsAppAccountId } from "../web/accounts.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { applyAuthChoice, warnIfModelConfigLooksOff } from "./auth-choice.js";
import { buildAuthChoiceOptions } from "./auth-choice-options.js";
import { ensureWorkspaceAndSessions, moveToTrash } from "./onboard-helpers.js";
import { setupProviders } from "./onboard-providers.js";
import type { AuthChoice, ProviderChoice } from "./onboard-types.js";

type AgentsListOptions = {
  json?: boolean;
};

type AgentsAddOptions = {
  name?: string;
  workspace?: string;
  json?: boolean;
};

type AgentsDeleteOptions = {
  id: string;
  force?: boolean;
  json?: boolean;
};

export type AgentSummary = {
  id: string;
  name?: string;
  workspace: string;
  agentDir: string;
  model?: string;
  bindings: number;
  isDefault: boolean;
};

type AgentBinding = {
  agentId: string;
  match: {
    provider: string;
    accountId?: string;
    peer?: { kind: "dm" | "group" | "channel"; id: string };
    guildId?: string;
    teamId?: string;
  };
};

function resolveAgentName(cfg: ClawdbotConfig, agentId: string) {
  return cfg.routing?.agents?.[agentId]?.name?.trim() || undefined;
}

function resolveAgentModel(cfg: ClawdbotConfig, agentId: string) {
  if (agentId !== DEFAULT_AGENT_ID) {
    return cfg.routing?.agents?.[agentId]?.model?.trim() || undefined;
  }
  const raw = cfg.agent?.model;
  if (typeof raw === "string") return raw;
  return raw?.primary?.trim() || undefined;
}

export function buildAgentSummaries(cfg: ClawdbotConfig): AgentSummary[] {
  const defaultAgentId = normalizeAgentId(
    cfg.routing?.defaultAgentId ?? DEFAULT_AGENT_ID,
  );
  const agentIds = new Set<string>([
    DEFAULT_AGENT_ID,
    defaultAgentId,
    ...Object.keys(cfg.routing?.agents ?? {}),
  ]);

  const bindingCounts = new Map<string, number>();
  for (const binding of cfg.routing?.bindings ?? []) {
    const agentId = normalizeAgentId(binding.agentId);
    bindingCounts.set(agentId, (bindingCounts.get(agentId) ?? 0) + 1);
  }

  const ordered = [
    DEFAULT_AGENT_ID,
    ...[...agentIds]
      .filter((id) => id !== DEFAULT_AGENT_ID)
      .sort((a, b) => a.localeCompare(b)),
  ];

  return ordered.map((id) => ({
    id,
    name: resolveAgentName(cfg, id),
    workspace: resolveAgentWorkspaceDir(cfg, id),
    agentDir: resolveAgentDir(cfg, id),
    model: resolveAgentModel(cfg, id),
    bindings: bindingCounts.get(id) ?? 0,
    isDefault: id === defaultAgentId,
  }));
}

export function applyAgentConfig(
  cfg: ClawdbotConfig,
  params: {
    agentId: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string;
  },
): ClawdbotConfig {
  const agentId = normalizeAgentId(params.agentId);
  const existing = cfg.routing?.agents?.[agentId] ?? {};
  const name = params.name?.trim();
  return {
    ...cfg,
    routing: {
      ...cfg.routing,
      agents: {
        ...cfg.routing?.agents,
        [agentId]: {
          ...existing,
          ...(name ? { name } : {}),
          ...(params.workspace ? { workspace: params.workspace } : {}),
          ...(params.agentDir ? { agentDir: params.agentDir } : {}),
          ...(params.model ? { model: params.model } : {}),
        },
      },
    },
  };
}

function bindingMatchKey(match: AgentBinding["match"]) {
  const accountId = match.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  return [
    match.provider,
    accountId,
    match.peer?.kind ?? "",
    match.peer?.id ?? "",
    match.guildId ?? "",
    match.teamId ?? "",
  ].join("|");
}

export function applyAgentBindings(
  cfg: ClawdbotConfig,
  bindings: AgentBinding[],
): {
  config: ClawdbotConfig;
  added: AgentBinding[];
  skipped: AgentBinding[];
  conflicts: Array<{ binding: AgentBinding; existingAgentId: string }>;
} {
  const existing = cfg.routing?.bindings ?? [];
  const existingMatchMap = new Map<string, string>();
  for (const binding of existing) {
    const key = bindingMatchKey(binding.match);
    if (!existingMatchMap.has(key)) {
      existingMatchMap.set(key, normalizeAgentId(binding.agentId));
    }
  }

  const added: AgentBinding[] = [];
  const skipped: AgentBinding[] = [];
  const conflicts: Array<{ binding: AgentBinding; existingAgentId: string }> =
    [];

  for (const binding of bindings) {
    const agentId = normalizeAgentId(binding.agentId);
    const key = bindingMatchKey(binding.match);
    const existingAgentId = existingMatchMap.get(key);
    if (existingAgentId) {
      if (existingAgentId === agentId) {
        skipped.push(binding);
      } else {
        conflicts.push({ binding, existingAgentId });
      }
      continue;
    }
    existingMatchMap.set(key, agentId);
    added.push({ ...binding, agentId });
  }

  if (added.length === 0) {
    return { config: cfg, added, skipped, conflicts };
  }

  return {
    config: {
      ...cfg,
      routing: {
        ...cfg.routing,
        bindings: [...existing, ...added],
      },
    },
    added,
    skipped,
    conflicts,
  };
}

export function pruneAgentConfig(
  cfg: ClawdbotConfig,
  agentId: string,
): {
  config: ClawdbotConfig;
  removedBindings: number;
  removedAllow: number;
} {
  const id = normalizeAgentId(agentId);
  const agents = { ...cfg.routing?.agents };
  delete agents[id];
  const nextAgents = Object.keys(agents).length > 0 ? agents : undefined;

  const bindings = cfg.routing?.bindings ?? [];
  const filteredBindings = bindings.filter(
    (binding) => normalizeAgentId(binding.agentId) !== id,
  );

  const allow = cfg.routing?.agentToAgent?.allow ?? [];
  const filteredAllow = allow.filter((entry) => entry !== id);

  const nextRouting = {
    ...cfg.routing,
    ...(nextAgents ? { agents: nextAgents } : {}),
    ...(nextAgents ? {} : { agents: undefined }),
    bindings: filteredBindings.length > 0 ? filteredBindings : undefined,
    agentToAgent: cfg.routing?.agentToAgent
      ? {
          ...cfg.routing.agentToAgent,
          allow: filteredAllow.length > 0 ? filteredAllow : undefined,
        }
      : undefined,
    defaultAgentId:
      normalizeAgentId(cfg.routing?.defaultAgentId ?? DEFAULT_AGENT_ID) === id
        ? DEFAULT_AGENT_ID
        : cfg.routing?.defaultAgentId,
  };

  return {
    config: {
      ...cfg,
      routing: nextRouting,
    },
    removedBindings: bindings.length - filteredBindings.length,
    removedAllow: allow.length - filteredAllow.length,
  };
}

function formatSummary(summary: AgentSummary) {
  const name =
    summary.name && summary.name !== summary.id ? ` "${summary.name}"` : "";
  const defaultTag = summary.isDefault ? " (default)" : "";
  const parts = [
    `${summary.id}${name}${defaultTag}`,
    `workspace: ${summary.workspace}`,
    `agentDir: ${summary.agentDir}`,
    summary.model ? `model: ${summary.model}` : null,
    `bindings: ${summary.bindings}`,
  ].filter(Boolean);
  return `- ${parts.join(" | ")}`;
}

async function requireValidConfig(
  runtime: RuntimeEnv,
): Promise<ClawdbotConfig | null> {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    const issues =
      snapshot.issues.length > 0
        ? snapshot.issues
            .map((issue) => `- ${issue.path}: ${issue.message}`)
            .join("\n")
        : "Unknown validation issue.";
    runtime.error(`Config invalid:\n${issues}`);
    runtime.error("Fix the config or run clawdbot doctor.");
    runtime.exit(1);
    return null;
  }
  return snapshot.config;
}

export async function agentsListCommand(
  opts: AgentsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const summaries = buildAgentSummaries(cfg);
  if (opts.json) {
    runtime.log(JSON.stringify(summaries, null, 2));
    return;
  }

  runtime.log(["Agents:", ...summaries.map(formatSummary)].join("\n"));
}

function describeBinding(binding: AgentBinding) {
  const match = binding.match;
  const parts = [match.provider];
  if (match.accountId) parts.push(`accountId=${match.accountId}`);
  if (match.peer) parts.push(`peer=${match.peer.kind}:${match.peer.id}`);
  if (match.guildId) parts.push(`guild=${match.guildId}`);
  if (match.teamId) parts.push(`team=${match.teamId}`);
  return parts.join(" ");
}

function buildProviderBindings(params: {
  agentId: string;
  selection: ProviderChoice[];
  config: ClawdbotConfig;
  accountIds?: Partial<Record<ProviderChoice, string>>;
}): AgentBinding[] {
  const bindings: AgentBinding[] = [];
  const agentId = normalizeAgentId(params.agentId);
  for (const provider of params.selection) {
    const match: AgentBinding["match"] = { provider };
    const accountId = params.accountIds?.[provider]?.trim();
    if (accountId) {
      match.accountId = accountId;
    } else if (provider === "whatsapp") {
      const defaultId = resolveDefaultWhatsAppAccountId(params.config);
      match.accountId = defaultId || DEFAULT_ACCOUNT_ID;
    }
    bindings.push({ agentId, match });
  }
  return bindings;
}

export async function agentsAddCommand(
  opts: AgentsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const workspaceFlag = opts.workspace?.trim();
  const nameInput = opts.name?.trim();

  if (workspaceFlag) {
    if (!nameInput) {
      runtime.error("Agent name is required when --workspace is provided.");
      runtime.exit(1);
      return;
    }
    const agentId = normalizeAgentId(nameInput);
    if (agentId === DEFAULT_AGENT_ID) {
      runtime.error(`"${DEFAULT_AGENT_ID}" is reserved. Choose another name.`);
      runtime.exit(1);
      return;
    }
    if (agentId !== nameInput) {
      runtime.log(`Normalized agent id to "${agentId}".`);
    }
    if (cfg.routing?.agents?.[agentId]) {
      runtime.error(`Agent "${agentId}" already exists.`);
      runtime.exit(1);
      return;
    }

    const workspaceDir = resolveUserPath(workspaceFlag);
    const agentDir = resolveAgentDir(cfg, agentId);
    const nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: nameInput,
      workspace: workspaceDir,
      agentDir,
    });

    await writeConfigFile(nextConfig);
    runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
    await ensureWorkspaceAndSessions(workspaceDir, runtime, {
      skipBootstrap: Boolean(nextConfig.agent?.skipBootstrap),
      agentId,
    });

    const payload = {
      agentId,
      name: nameInput,
      workspace: workspaceDir,
      agentDir,
    };
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
    } else {
      runtime.log(`Agent: ${agentId}`);
      runtime.log(`Workspace: ${workspaceDir}`);
      runtime.log(`Agent dir: ${agentDir}`);
    }
    return;
  }

  const prompter = createClackPrompter();
  try {
    await prompter.intro("Add Clawdbot agent");
    const name =
      nameInput ??
      (await prompter.text({
        message: "Agent name",
        validate: (value) => {
          if (!value?.trim()) return "Required";
          const normalized = normalizeAgentId(value);
          if (normalized === DEFAULT_AGENT_ID) {
            return `"${DEFAULT_AGENT_ID}" is reserved. Choose another name.`;
          }
          return undefined;
        },
      }));

    const agentName = String(name).trim();
    const agentId = normalizeAgentId(agentName);
    if (agentName !== agentId) {
      await prompter.note(`Normalized id to "${agentId}".`, "Agent id");
    }

    const existingAgent = cfg.routing?.agents?.[agentId];
    if (existingAgent) {
      const shouldUpdate = await prompter.confirm({
        message: `Agent "${agentId}" already exists. Update it?`,
        initialValue: false,
      });
      if (!shouldUpdate) {
        await prompter.outro("No changes made.");
        return;
      }
    }

    const workspaceDefault = resolveAgentWorkspaceDir(cfg, agentId);
    const workspaceInput = await prompter.text({
      message: "Workspace directory",
      initialValue: workspaceDefault,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    const workspaceDir = resolveUserPath(
      String(workspaceInput).trim() || workspaceDefault,
    );
    const agentDir = resolveAgentDir(cfg, agentId);

    let nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: agentName,
      workspace: workspaceDir,
      agentDir,
    });

    const wantsAuth = await prompter.confirm({
      message: "Configure model/auth for this agent now?",
      initialValue: false,
    });
    if (wantsAuth) {
      const authStore = ensureAuthProfileStore(agentDir);
      const authChoice = (await prompter.select({
        message: "Model/auth choice",
        options: buildAuthChoiceOptions({
          store: authStore,
          includeSkip: true,
        }),
      })) as AuthChoice;

      const authResult = await applyAuthChoice({
        authChoice,
        config: nextConfig,
        prompter,
        runtime,
        agentDir,
        setDefaultModel: false,
        agentId,
      });
      nextConfig = authResult.config;
      if (authResult.agentModelOverride) {
        nextConfig = applyAgentConfig(nextConfig, {
          agentId,
          model: authResult.agentModelOverride,
        });
      }
    }

    await warnIfModelConfigLooksOff(nextConfig, prompter, {
      agentId,
      agentDir,
    });

    let selection: ProviderChoice[] = [];
    const providerAccountIds: Partial<Record<ProviderChoice, string>> = {};
    nextConfig = await setupProviders(nextConfig, runtime, prompter, {
      allowSignalInstall: true,
      onSelection: (value) => {
        selection = value;
      },
      promptAccountIds: true,
      onAccountId: (provider, accountId) => {
        providerAccountIds[provider] = accountId;
      },
    });

    if (selection.length > 0) {
      const wantsBindings = await prompter.confirm({
        message:
          "Route selected providers to this agent now? (routing.bindings)",
        initialValue: false,
      });
      if (wantsBindings) {
        const desiredBindings = buildProviderBindings({
          agentId,
          selection,
          config: nextConfig,
          accountIds: providerAccountIds,
        });
        const result = applyAgentBindings(nextConfig, desiredBindings);
        nextConfig = result.config;
        if (result.conflicts.length > 0) {
          await prompter.note(
            [
              "Skipped bindings already claimed by another agent:",
              ...result.conflicts.map(
                (conflict) =>
                  `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
              ),
            ].join("\n"),
            "Routing bindings",
          );
        }
      } else {
        await prompter.note(
          [
            "Routing unchanged. Add routing.bindings when you're ready.",
            "Docs: https://docs.clawd.bot/concepts/multi-agent",
          ].join("\n"),
          "Routing",
        );
      }
    }

    await writeConfigFile(nextConfig);
    runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
    await ensureWorkspaceAndSessions(workspaceDir, runtime, {
      skipBootstrap: Boolean(nextConfig.agent?.skipBootstrap),
      agentId,
    });

    const payload = {
      agentId,
      name: agentName,
      workspace: workspaceDir,
      agentDir,
    };
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
    }
    await prompter.outro(`Agent "${agentId}" ready.`);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(0);
      return;
    }
    throw err;
  }
}

export async function agentsDeleteCommand(
  opts: AgentsDeleteOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const input = opts.id?.trim();
  if (!input) {
    runtime.error("Agent id is required.");
    runtime.exit(1);
    return;
  }

  const agentId = normalizeAgentId(input);
  if (agentId !== input) {
    runtime.log(`Normalized agent id to "${agentId}".`);
  }
  if (agentId === DEFAULT_AGENT_ID) {
    runtime.error(`"${DEFAULT_AGENT_ID}" cannot be deleted.`);
    runtime.exit(1);
    return;
  }

  if (!cfg.routing?.agents?.[agentId]) {
    runtime.error(`Agent "${agentId}" not found.`);
    runtime.exit(1);
    return;
  }

  if (!opts.force) {
    if (!process.stdin.isTTY) {
      runtime.error("Non-interactive session. Re-run with --force.");
      runtime.exit(1);
      return;
    }
    const prompter = createClackPrompter();
    const confirmed = await prompter.confirm({
      message: `Delete agent "${agentId}" and prune workspace/state?`,
      initialValue: false,
    });
    if (!confirmed) {
      runtime.log("Cancelled.");
      return;
    }
  }

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const agentDir = resolveAgentDir(cfg, agentId);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);

  const result = pruneAgentConfig(cfg, agentId);
  await writeConfigFile(result.config);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);

  await moveToTrash(workspaceDir, runtime);
  await moveToTrash(agentDir, runtime);
  await moveToTrash(sessionsDir, runtime);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          agentId,
          workspace: workspaceDir,
          agentDir,
          sessionsDir,
          removedBindings: result.removedBindings,
          removedAllow: result.removedAllow,
        },
        null,
        2,
      ),
    );
  } else {
    runtime.log(`Deleted agent: ${agentId}`);
  }
}
