import fs from "node:fs";
import path from "node:path";

import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { DEFAULT_IDENTITY_FILENAME } from "../agents/workspace.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "../discord/accounts.js";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "../imessage/accounts.js";
import {
  type ChatProviderId,
  getChatProviderMeta,
  normalizeChatProviderId,
} from "../providers/registry.js";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_AGENT_ID,
  normalizeAgentId,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../signal/accounts.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
} from "../slack/accounts.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "../telegram/accounts.js";
import { resolveUserPath } from "../utils.js";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAuthDir,
} from "../web/accounts.js";
import { webAuthExists } from "../web/session.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { applyAuthChoice, warnIfModelConfigLooksOff } from "./auth-choice.js";
import { buildAuthChoiceOptions } from "./auth-choice-options.js";
import { ensureWorkspaceAndSessions, moveToTrash } from "./onboard-helpers.js";
import { setupProviders } from "./onboard-providers.js";
import type { AuthChoice, ProviderChoice } from "./onboard-types.js";

type AgentsListOptions = {
  json?: boolean;
  bindings?: boolean;
};

type AgentsAddOptions = {
  name?: string;
  workspace?: string;
  model?: string;
  agentDir?: string;
  bind?: string[];
  nonInteractive?: boolean;
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
  identityName?: string;
  identityEmoji?: string;
  identitySource?: "identity" | "config";
  workspace: string;
  agentDir: string;
  model?: string;
  bindings: number;
  bindingDetails?: string[];
  routes?: string[];
  providers?: string[];
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

type AgentIdentity = {
  name?: string;
  emoji?: string;
  creature?: string;
  vibe?: string;
};

type ProviderAccountStatus = {
  provider: ChatProviderId;
  accountId: string;
  name?: string;
  state:
    | "linked"
    | "not linked"
    | "configured"
    | "not configured"
    | "enabled"
    | "disabled";
  enabled?: boolean;
  configured?: boolean;
};

function createQuietRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return { ...runtime, log: () => {} };
}

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

function parseIdentityMarkdown(content: string): AgentIdentity {
  const identity: AgentIdentity = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:-\s*)?([A-Za-z ]+):\s*(.+?)\s*$/);
    if (!match) continue;
    const label = match[1]?.trim().toLowerCase();
    const value = match[2]?.trim();
    if (!value) continue;
    if (label === "name") identity.name = value;
    if (label === "emoji") identity.emoji = value;
    if (label === "creature") identity.creature = value;
    if (label === "vibe") identity.vibe = value;
  }
  return identity;
}

function loadAgentIdentity(workspace: string): AgentIdentity | null {
  const identityPath = path.join(workspace, DEFAULT_IDENTITY_FILENAME);
  try {
    const content = fs.readFileSync(identityPath, "utf-8");
    const parsed = parseIdentityMarkdown(content);
    if (!parsed.name && !parsed.emoji) return null;
    return parsed;
  } catch {
    return null;
  }
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

  return ordered.map((id) => {
    const workspace = resolveAgentWorkspaceDir(cfg, id);
    const identity = loadAgentIdentity(workspace);
    const fallbackIdentity = id === defaultAgentId ? cfg.identity : undefined;
    const identityName = identity?.name ?? fallbackIdentity?.name?.trim();
    const identityEmoji = identity?.emoji ?? fallbackIdentity?.emoji?.trim();
    const identitySource = identity
      ? "identity"
      : fallbackIdentity && (identityName || identityEmoji)
        ? "config"
        : undefined;
    return {
      id,
      name: resolveAgentName(cfg, id),
      identityName,
      identityEmoji,
      identitySource,
      workspace,
      agentDir: resolveAgentDir(cfg, id),
      model: resolveAgentModel(cfg, id),
      bindings: bindingCounts.get(id) ?? 0,
      isDefault: id === defaultAgentId,
    };
  });
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
  const defaultTag = summary.isDefault ? " (default)" : "";
  const header =
    summary.name && summary.name !== summary.id
      ? `${summary.id}${defaultTag} (${summary.name})`
      : `${summary.id}${defaultTag}`;

  const identityParts = [];
  if (summary.identityEmoji) identityParts.push(summary.identityEmoji);
  if (summary.identityName) identityParts.push(summary.identityName);
  const identityLine =
    identityParts.length > 0 ? identityParts.join(" ") : null;
  const identitySource =
    summary.identitySource === "identity"
      ? "IDENTITY.md"
      : summary.identitySource === "config"
        ? "config"
        : null;

  const lines = [`- ${header}`];
  if (identityLine) {
    lines.push(
      `  Identity: ${identityLine}${identitySource ? ` (${identitySource})` : ""}`,
    );
  }
  lines.push(`  Workspace: ${summary.workspace}`);
  lines.push(`  Agent dir: ${summary.agentDir}`);
  if (summary.model) lines.push(`  Model: ${summary.model}`);
  lines.push(`  Routing rules: ${summary.bindings}`);

  if (summary.routes?.length) {
    lines.push(`  Routing: ${summary.routes.join(", ")}`);
  }
  if (summary.providers?.length) {
    lines.push("  Providers:");
    for (const provider of summary.providers) {
      lines.push(`    - ${provider}`);
    }
  }

  if (summary.bindingDetails?.length) {
    lines.push("  Routing rules:");
    for (const binding of summary.bindingDetails) {
      lines.push(`    - ${binding}`);
    }
  }
  return lines.join("\n");
}

function providerAccountKey(provider: ChatProviderId, accountId?: string) {
  return `${provider}:${accountId ?? DEFAULT_ACCOUNT_ID}`;
}

function formatProviderAccountLabel(params: {
  provider: ChatProviderId;
  accountId: string;
  name?: string;
}): string {
  const label = getChatProviderMeta(params.provider).label;
  const account = params.name?.trim()
    ? `${params.accountId} (${params.name.trim()})`
    : params.accountId;
  return `${label} ${account}`;
}

function formatProviderState(entry: ProviderAccountStatus): string {
  const parts = [entry.state];
  if (entry.enabled === false && entry.state !== "disabled") {
    parts.push("disabled");
  }
  return parts.join(", ");
}

async function buildProviderStatusIndex(
  cfg: ClawdbotConfig,
): Promise<Map<string, ProviderAccountStatus>> {
  const map = new Map<string, ProviderAccountStatus>();

  for (const accountId of listWhatsAppAccountIds(cfg)) {
    const { authDir } = resolveWhatsAppAuthDir({ cfg, accountId });
    const linked = await webAuthExists(authDir);
    const enabled =
      cfg.whatsapp?.accounts?.[accountId]?.enabled ?? cfg.web?.enabled ?? true;
    const hasConfig = Boolean(cfg.whatsapp);
    map.set(providerAccountKey("whatsapp", accountId), {
      provider: "whatsapp",
      accountId,
      name: cfg.whatsapp?.accounts?.[accountId]?.name,
      state: linked ? "linked" : "not linked",
      enabled,
      configured: linked || hasConfig,
    });
  }

  for (const accountId of listTelegramAccountIds(cfg)) {
    const account = resolveTelegramAccount({ cfg, accountId });
    const configured = Boolean(account.token);
    map.set(providerAccountKey("telegram", accountId), {
      provider: "telegram",
      accountId,
      name: account.name,
      state: configured ? "configured" : "not configured",
      enabled: account.enabled,
      configured,
    });
  }

  for (const accountId of listDiscordAccountIds(cfg)) {
    const account = resolveDiscordAccount({ cfg, accountId });
    const configured = Boolean(account.token);
    map.set(providerAccountKey("discord", accountId), {
      provider: "discord",
      accountId,
      name: account.name,
      state: configured ? "configured" : "not configured",
      enabled: account.enabled,
      configured,
    });
  }

  for (const accountId of listSlackAccountIds(cfg)) {
    const account = resolveSlackAccount({ cfg, accountId });
    const configured = Boolean(account.botToken && account.appToken);
    map.set(providerAccountKey("slack", accountId), {
      provider: "slack",
      accountId,
      name: account.name,
      state: configured ? "configured" : "not configured",
      enabled: account.enabled,
      configured,
    });
  }

  for (const accountId of listSignalAccountIds(cfg)) {
    const account = resolveSignalAccount({ cfg, accountId });
    map.set(providerAccountKey("signal", accountId), {
      provider: "signal",
      accountId,
      name: account.name,
      state: account.configured ? "configured" : "not configured",
      enabled: account.enabled,
      configured: account.configured,
    });
  }

  for (const accountId of listIMessageAccountIds(cfg)) {
    const account = resolveIMessageAccount({ cfg, accountId });
    map.set(providerAccountKey("imessage", accountId), {
      provider: "imessage",
      accountId,
      name: account.name,
      state: account.enabled ? "enabled" : "disabled",
      enabled: account.enabled,
      configured: Boolean(cfg.imessage),
    });
  }

  return map;
}

function resolveDefaultAccountId(
  cfg: ClawdbotConfig,
  provider: ChatProviderId,
): string {
  switch (provider) {
    case "whatsapp":
      return resolveDefaultWhatsAppAccountId(cfg) || DEFAULT_ACCOUNT_ID;
    case "telegram":
      return resolveDefaultTelegramAccountId(cfg) || DEFAULT_ACCOUNT_ID;
    case "discord":
      return resolveDefaultDiscordAccountId(cfg) || DEFAULT_ACCOUNT_ID;
    case "slack":
      return resolveDefaultSlackAccountId(cfg) || DEFAULT_ACCOUNT_ID;
    case "signal":
      return resolveDefaultSignalAccountId(cfg) || DEFAULT_ACCOUNT_ID;
    case "imessage":
      return resolveDefaultIMessageAccountId(cfg) || DEFAULT_ACCOUNT_ID;
  }
}

function shouldShowProviderEntry(
  entry: ProviderAccountStatus,
  cfg: ClawdbotConfig,
): boolean {
  if (entry.provider === "whatsapp") {
    return entry.state === "linked" || Boolean(cfg.whatsapp);
  }
  if (entry.provider === "imessage") {
    return Boolean(cfg.imessage);
  }
  return Boolean(entry.configured);
}

function formatProviderEntry(entry: ProviderAccountStatus): string {
  const label = formatProviderAccountLabel({
    provider: entry.provider,
    accountId: entry.accountId,
    name: entry.name,
  });
  return `${label}: ${formatProviderState(entry)}`;
}

function summarizeBindings(
  cfg: ClawdbotConfig,
  bindings: AgentBinding[],
): string[] {
  if (bindings.length === 0) return [];
  const seen = new Map<string, string>();
  for (const binding of bindings) {
    const provider = normalizeChatProviderId(binding.match.provider);
    if (!provider) continue;
    const accountId =
      binding.match.accountId ?? resolveDefaultAccountId(cfg, provider);
    const key = providerAccountKey(provider, accountId);
    if (!seen.has(key)) {
      const label = formatProviderAccountLabel({
        provider,
        accountId,
      });
      seen.set(key, label);
    }
  }
  return [...seen.values()];
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
  const bindingMap = new Map<string, AgentBinding[]>();
  for (const binding of cfg.routing?.bindings ?? []) {
    const agentId = normalizeAgentId(binding.agentId);
    const list = bindingMap.get(agentId) ?? [];
    list.push(binding as AgentBinding);
    bindingMap.set(agentId, list);
  }

  if (opts.bindings) {
    for (const summary of summaries) {
      const bindings = bindingMap.get(summary.id) ?? [];
      if (bindings.length > 0) {
        summary.bindingDetails = bindings.map((binding) =>
          describeBinding(binding as AgentBinding),
        );
      }
    }
  }

  const providerStatus = await buildProviderStatusIndex(cfg);
  const allProviderEntries = [...providerStatus.values()];

  for (const summary of summaries) {
    const bindings = bindingMap.get(summary.id) ?? [];
    const routes = summarizeBindings(cfg, bindings);
    if (routes.length > 0) {
      summary.routes = routes;
    } else if (summary.isDefault) {
      summary.routes = ["default (no explicit rules)"];
    }

    const providerLines: string[] = [];
    if (bindings.length > 0) {
      const seen = new Set<string>();
      for (const binding of bindings) {
        const provider = normalizeChatProviderId(binding.match.provider);
        if (!provider) continue;
        const accountId =
          binding.match.accountId ?? resolveDefaultAccountId(cfg, provider);
        const key = providerAccountKey(provider, accountId);
        if (seen.has(key)) continue;
        seen.add(key);
        const status = providerStatus.get(key);
        if (status) {
          providerLines.push(formatProviderEntry(status));
        } else {
          providerLines.push(
            `${formatProviderAccountLabel({ provider, accountId })}: unknown`,
          );
        }
      }
    } else if (summary.isDefault) {
      for (const entry of allProviderEntries) {
        if (shouldShowProviderEntry(entry, cfg)) {
          providerLines.push(formatProviderEntry(entry));
        }
      }
    }
    if (providerLines.length > 0) {
      summary.providers = providerLines;
    }
  }

  if (opts.json) {
    runtime.log(JSON.stringify(summaries, null, 2));
    return;
  }

  const lines = ["Agents:", ...summaries.map(formatSummary)];
  lines.push(
    "Routing rules map provider/account/peer to an agent. Use --bindings for full rules.",
  );
  lines.push(
    "Provider status reflects local config/creds. For live health: clawdbot providers status --probe.",
  );
  runtime.log(lines.join("\n"));
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

function parseBindingSpecs(params: {
  agentId: string;
  specs?: string[];
  config: ClawdbotConfig;
}): { bindings: AgentBinding[]; errors: string[] } {
  const bindings: AgentBinding[] = [];
  const errors: string[] = [];
  const specs = params.specs ?? [];
  const agentId = normalizeAgentId(params.agentId);
  for (const raw of specs) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const [providerRaw, accountRaw] = trimmed.split(":", 2);
    const provider = normalizeChatProviderId(providerRaw);
    if (!provider) {
      errors.push(`Unknown provider "${providerRaw}".`);
      continue;
    }
    let accountId = accountRaw?.trim();
    if (accountRaw !== undefined && !accountId) {
      errors.push(`Invalid binding "${trimmed}" (empty account id).`);
      continue;
    }
    if (!accountId && provider === "whatsapp") {
      accountId = resolveDefaultWhatsAppAccountId(params.config);
      if (!accountId) accountId = DEFAULT_ACCOUNT_ID;
    }
    const match: AgentBinding["match"] = { provider };
    if (accountId) match.accountId = accountId;
    bindings.push({ agentId, match });
  }
  return { bindings, errors };
}

export async function agentsAddCommand(
  opts: AgentsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const workspaceFlag = opts.workspace?.trim();
  const nameInput = opts.name?.trim();
  const hasFlags = params?.hasFlags === true;
  const nonInteractive = Boolean(opts.nonInteractive || hasFlags);

  if (nonInteractive && !workspaceFlag) {
    runtime.error(
      "Non-interactive mode requires --workspace. Re-run without flags to use the wizard.",
    );
    runtime.exit(1);
    return;
  }

  if (nonInteractive) {
    if (!nameInput) {
      runtime.error("Agent name is required in non-interactive mode.");
      runtime.exit(1);
      return;
    }
    if (!workspaceFlag) {
      runtime.error(
        "Non-interactive mode requires --workspace. Re-run without flags to use the wizard.",
      );
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
    const agentDir = opts.agentDir?.trim()
      ? resolveUserPath(opts.agentDir.trim())
      : resolveAgentDir(cfg, agentId);
    const model = opts.model?.trim();
    const nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: nameInput,
      workspace: workspaceDir,
      agentDir,
      ...(model ? { model } : {}),
    });

    const bindingParse = parseBindingSpecs({
      agentId,
      specs: opts.bind,
      config: nextConfig,
    });
    if (bindingParse.errors.length > 0) {
      runtime.error(bindingParse.errors.join("\n"));
      runtime.exit(1);
      return;
    }
    const bindingResult =
      bindingParse.bindings.length > 0
        ? applyAgentBindings(nextConfig, bindingParse.bindings)
        : { config: nextConfig, added: [], skipped: [], conflicts: [] };

    await writeConfigFile(bindingResult.config);
    if (!opts.json) runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
    const quietRuntime = opts.json ? createQuietRuntime(runtime) : runtime;
    await ensureWorkspaceAndSessions(workspaceDir, quietRuntime, {
      skipBootstrap: Boolean(bindingResult.config.agent?.skipBootstrap),
      agentId,
    });

    const payload = {
      agentId,
      name: nameInput,
      workspace: workspaceDir,
      agentDir,
      model,
      bindings: {
        added: bindingResult.added.map(describeBinding),
        skipped: bindingResult.skipped.map(describeBinding),
        conflicts: bindingResult.conflicts.map(
          (conflict) =>
            `${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
        ),
      },
    };
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
    } else {
      runtime.log(`Agent: ${agentId}`);
      runtime.log(`Workspace: ${workspaceDir}`);
      runtime.log(`Agent dir: ${agentDir}`);
      if (model) runtime.log(`Model: ${model}`);
      if (bindingResult.conflicts.length > 0) {
        runtime.error(
          [
            "Skipped bindings already claimed by another agent:",
            ...bindingResult.conflicts.map(
              (conflict) =>
                `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
            ),
          ].join("\n"),
        );
      }
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
  if (!opts.json) runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);

  const quietRuntime = opts.json ? createQuietRuntime(runtime) : runtime;
  await moveToTrash(workspaceDir, quietRuntime);
  await moveToTrash(agentDir, quietRuntime);
  await moveToTrash(sessionsDir, quietRuntime);

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
