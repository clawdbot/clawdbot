// Implements identity metadata updates for configured agents.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  type AgentIdentityFile,
  loadAgentIdentityFromFile,
  loadAgentIdentityFromWorkspace,
} from "../agents/identity-file.js";
import { DEFAULT_IDENTITY_FILENAME } from "../agents/workspace.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { replaceConfigFile } from "../config/config.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import { logConfigUpdated } from "../config/logging.js";
import type { AgentConfig, IdentityConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { findAgentEntryIndex, listAgentEntries } from "./agents.config.js";
import { requireValidConfigFileSnapshot } from "./config-validation.js";

type AgentsSetIdentityOptions = {
  agent?: string;
  workspace?: string;
  identityFile?: string;
  name?: string;
  emoji?: string;
  theme?: string;
  avatar?: string;
  fromIdentity?: boolean;
  json?: boolean;
};

const normalizeWorkspacePath = (input: string) => path.resolve(resolveUserPath(input));

function failAgentIdentity(message: string): never {
  throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
}

function resolveAgentIdByWorkspace(
  cfg: Parameters<typeof resolveAgentWorkspaceDir>[0],
  workspaceDir: string,
): string[] {
  const list = listAgentEntries(cfg);
  const ids =
    list.length > 0
      ? list.map((entry) => normalizeAgentId(entry.id))
      : [resolveDefaultAgentId(cfg)];
  const normalizedTarget = normalizeWorkspacePath(workspaceDir);
  return ids.filter(
    (id) => normalizeWorkspacePath(resolveAgentWorkspaceDir(cfg, id)) === normalizedTarget,
  );
}

/** Update an agent identity from flags or workspace identity markdown. */
export async function agentsSetIdentityCommand(
  opts: AgentsSetIdentityOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const cfg = migratePersistedImplicitMainRoster(
    configSnapshot.sourceConfig ?? configSnapshot.config,
  ).config as OpenClawConfig;
  const baseHash = configSnapshot.hash;

  const nameRaw = normalizeOptionalString(opts.name);
  const emojiRaw = normalizeOptionalString(opts.emoji);
  const themeRaw = normalizeOptionalString(opts.theme);
  const avatarRaw = normalizeOptionalString(opts.avatar);
  const hasExplicitIdentity = Boolean(nameRaw || emojiRaw || themeRaw || avatarRaw);

  const identityFileRaw = normalizeOptionalString(opts.identityFile);
  const workspaceRaw = normalizeOptionalString(opts.workspace);
  const wantsIdentityFile = Boolean(opts.fromIdentity || identityFileRaw || !hasExplicitIdentity);
  const normalizedAgent = opts.agent === undefined ? null : normalizeAgentIdStrict(opts.agent);
  if (normalizedAgent && !normalizedAgent.ok) {
    failAgentIdentity(`Agent "${opts.agent}" not found. Create it with \`openclaw agents add\`.`);
  }
  let agentId = normalizedAgent?.value;

  let identityFilePath: string | undefined;
  let workspaceDir: string | undefined;

  if (identityFileRaw) {
    identityFilePath = normalizeWorkspacePath(identityFileRaw);
    workspaceDir = path.dirname(identityFilePath);
  } else if (workspaceRaw) {
    workspaceDir = normalizeWorkspacePath(workspaceRaw);
  } else if (agentId && wantsIdentityFile) {
    workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  } else if (wantsIdentityFile || !agentId) {
    workspaceDir = path.resolve(process.cwd());
  }

  if (!agentId) {
    const resolvedWorkspace = expectDefined(workspaceDir, "agent workspace");
    const matches = resolveAgentIdByWorkspace(cfg, resolvedWorkspace);
    if (matches.length === 0) {
      failAgentIdentity(
        `No agent workspace matches ${shortenHomePath(resolvedWorkspace)}. Pass --agent to target a specific agent.`,
      );
    }
    if (matches.length > 1) {
      failAgentIdentity(
        `Multiple agents match ${shortenHomePath(resolvedWorkspace)}: ${matches.join(", ")}. Pass --agent to choose one.`,
      );
    }
    agentId = matches[0];
  }

  const resolvedAgentId = expectDefined(agentId, "agent id");
  const resolvedAgentIds = listAgentIds(cfg).map((id) => normalizeAgentId(id));
  if (!resolvedAgentIds.includes(resolvedAgentId)) {
    failAgentIdentity(
      `Agent "${resolvedAgentId}" not found. Create it with \`openclaw agents add\`.`,
    );
  }
  const list = listAgentEntries(cfg);
  const index = findAgentEntryIndex(list, resolvedAgentId);

  let identityFromFile: AgentIdentityFile | null = null;
  if (wantsIdentityFile) {
    if (identityFilePath) {
      try {
        identityFromFile = await loadAgentIdentityFromFile(identityFilePath);
      } catch (error) {
        failAgentIdentity(formatErrorMessage(error));
      }
    } else if (workspaceDir) {
      identityFromFile = loadAgentIdentityFromWorkspace(workspaceDir);
    }
    if (!identityFromFile) {
      const targetPath =
        identityFilePath ??
        (workspaceDir ? path.join(workspaceDir, DEFAULT_IDENTITY_FILENAME) : "IDENTITY.md");
      failAgentIdentity(`No identity data found in ${shortenHomePath(targetPath)}.`);
    }
  }

  const fileTheme =
    identityFromFile?.theme ?? identityFromFile?.creature ?? identityFromFile?.vibe ?? undefined;
  const incomingIdentity: IdentityConfig = {
    ...(nameRaw || identityFromFile?.name ? { name: nameRaw ?? identityFromFile?.name } : {}),
    ...(emojiRaw || identityFromFile?.emoji ? { emoji: emojiRaw ?? identityFromFile?.emoji } : {}),
    ...(themeRaw || fileTheme ? { theme: themeRaw ?? fileTheme } : {}),
    ...(avatarRaw || identityFromFile?.avatar
      ? { avatar: avatarRaw ?? identityFromFile?.avatar }
      : {}),
  };

  const base: AgentConfig =
    index >= 0 ? expectDefined(list[index], "agent config") : { id: resolvedAgentId };
  const nextIdentity: IdentityConfig = {
    ...base.identity,
    ...incomingIdentity,
  };

  const nextEntry = {
    ...base,
    identity: nextIdentity,
  };

  const nextList = [...list];
  if (index >= 0) {
    nextList[index] = nextEntry;
  } else {
    // An empty list still resolves to the implicit default agent; materialize only that known id.
    nextList.push(nextEntry);
  }

  const nextConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      entries: Object.fromEntries(
        nextList.map((entry) => {
          const { id, ...config } = entry;
          return [id, config];
        }),
      ),
    },
  };

  await replaceConfigFile({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });

  if (opts.json) {
    writeRuntimeJson(runtime, {
      agentId,
      identity: nextIdentity,
      workspace: workspaceDir ?? null,
      identityFile: identityFilePath ?? null,
    });
    return;
  }

  logConfigUpdated(runtime);
  runtime.log(`Agent: ${sanitizeTerminalText(resolvedAgentId)}`);
  if (nextIdentity.name) {
    runtime.log(`Name: ${sanitizeTerminalText(nextIdentity.name)}`);
  }
  if (nextIdentity.theme) {
    runtime.log(`Theme: ${sanitizeTerminalText(nextIdentity.theme)}`);
  }
  if (nextIdentity.emoji) {
    runtime.log(`Emoji: ${sanitizeTerminalText(nextIdentity.emoji)}`);
  }
  if (nextIdentity.avatar) {
    runtime.log(`Avatar: ${sanitizeTerminalText(nextIdentity.avatar)}`);
  }
  if (workspaceDir) {
    runtime.log(`Workspace: ${sanitizeTerminalText(shortenHomePath(workspaceDir))}`);
  }
}
