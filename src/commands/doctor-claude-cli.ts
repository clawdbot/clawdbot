/** Doctor health note for Claude CLI binary, auth, and workspace/project directories. */
import fs from "node:fs";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { CLAUDE_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
import { resolveAuthStorePathForDisplay } from "../agents/auth-profiles/paths.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import type {
  AuthProfileStore,
  OAuthCredential,
  TokenCredential,
} from "../agents/auth-profiles/types.js";
import { readClaudeCliCredentialsCached } from "../agents/cli-credentials.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../agents/command/claude-cli-project-dir.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { shortenHomePath } from "../utils.js";

const CLAUDE_CLI_PROVIDER = "claude-cli";

type ClaudeCliReadableCredential =
  | Pick<OAuthCredential, "type" | "expires">
  | Pick<TokenCredential, "type" | "expires">
  | { type: "api_key_helper" };

type ClaudeCliDirHealth = "present" | "missing" | "not_directory" | "unreadable" | "readonly";

function usesClaudeCliModelSelection(cfg: OpenClawConfig): boolean {
  const primary = resolvePrimaryStringValue(
    cfg.agents?.defaults?.model as string | { primary?: string; fallbacks?: string[] } | undefined,
  );
  if (normalizeOptionalLowercaseString(primary)?.startsWith(`${CLAUDE_CLI_PROVIDER}/`)) {
    return true;
  }
  return Object.keys(cfg.agents?.defaults?.models ?? {}).some((key) =>
    normalizeOptionalLowercaseString(key)?.startsWith(`${CLAUDE_CLI_PROVIDER}/`),
  );
}

function resolveClaudeCliCommand(cfg: OpenClawConfig): string {
  const configured = cfg.agents?.defaults?.cliBackends ?? {};
  for (const [key, entry] of Object.entries(configured)) {
    if (normalizeOptionalLowercaseString(key) !== CLAUDE_CLI_PROVIDER) {
      continue;
    }
    const command = normalizeOptionalString(entry?.command);
    if (command) {
      return command;
    }
  }
  return "claude";
}

function probeDirectoryHealth(dirPath: string): ClaudeCliDirHealth {
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return "not_directory";
    }
  } catch {
    return "missing";
  }
  try {
    fs.accessSync(dirPath, fs.constants.R_OK);
  } catch {
    return "unreadable";
  }
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
  } catch {
    return "readonly";
  }
  return "present";
}

function formatWorkspaceProblemLine(
  workspaceDir: string,
  health: ClaudeCliDirHealth,
  agentId?: string,
): string | null {
  const label = agentId ? `Agent ${agentId} workspace` : "Workspace";
  const display = shortenHomePath(workspaceDir);
  if (health === "present" || health === "missing") {
    return null;
  }
  if (health === "not_directory") {
    return `- ${label}: ${display} exists but is not a directory.`;
  }
  if (health === "unreadable") {
    return `- ${label}: ${display} is not readable by this user.`;
  }
  return `- ${label}: ${display} is not writable by this user.`;
}

function formatProjectDirProblemLine(
  projectDir: string,
  health: ClaudeCliDirHealth,
  agentId?: string,
): string | null {
  const label = agentId ? `Agent ${agentId} Claude project dir` : "Claude project dir";
  const display = shortenHomePath(projectDir);
  if (health === "present" || health === "missing") {
    return null;
  }
  if (health === "not_directory") {
    return `- ${label}: ${display} exists but is not a directory.`;
  }
  if (health === "unreadable") {
    return `- ${label}: ${display} is not readable by this user.`;
  }
  return `- ${label}: ${display} is not writable by this user.`;
}

function resolveClaudeCliAgentIds(cfg: OpenClawConfig): string[] {
  const agentIds = listAgentIds(cfg);
  const runtimeAgentIds = agentIds.filter(
    (agentId) => resolveModelAgentRuntimeMetadata({ cfg, agentId }).id === CLAUDE_CLI_PROVIDER,
  );
  if (runtimeAgentIds.length > 0) {
    return runtimeAgentIds;
  }
  if (usesClaudeCliModelSelection(cfg)) {
    return [resolveDefaultAgentId(cfg)];
  }
  return [];
}

type ClaudeCliWorkspaceTarget = {
  agentId: string;
  workspaceDir: string;
  projectDir: string;
  workspaceHealth: ClaudeCliDirHealth;
  projectDirHealth: ClaudeCliDirHealth;
};

function resolveClaudeCliWorkspaceTargets(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  workspaceDir?: string;
}): ClaudeCliWorkspaceTarget[] {
  const agentIds = resolveClaudeCliAgentIds(params.cfg);
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const seen = new Set<string>();
  return agentIds
    .filter((agentId) => {
      if (seen.has(agentId)) {
        return false;
      }
      seen.add(agentId);
      return true;
    })
    .map((agentId) => {
      const workspaceDir =
        params.workspaceDir && agentIds.length === 1 && agentId === defaultAgentId
          ? params.workspaceDir
          : resolveAgentWorkspaceDir(params.cfg, agentId, params.env);
      const projectDir = resolveClaudeCliProjectDirForWorkspace({
        workspaceDir,
        homeDir: params.homeDir,
      });
      return {
        agentId,
        workspaceDir,
        projectDir,
        workspaceHealth: probeDirectoryHealth(workspaceDir),
        projectDirHealth: probeDirectoryHealth(projectDir),
      };
    });
}

/**
 * Emits Claude CLI health diagnostics for every agent currently routed through the CLI backend.
 *
 * The optional deps let tests inject auth stores, PATH resolution, and workspace roots without
 * touching the user's real Claude credentials or filesystem.
 */
export function noteClaudeCliHealth(
  cfg: OpenClawConfig,
  deps?: {
    noteFn?: typeof note;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    store?: AuthProfileStore;
    readClaudeCliCredentials?: () => ClaudeCliReadableCredential | null;
    resolveCommandPath?: (command: string, env?: NodeJS.ProcessEnv) => string | undefined;
    workspaceDir?: string;
  },
) {
  const env = deps?.env ?? process.env;
  const workspaceTargets = resolveClaudeCliWorkspaceTargets({
    cfg,
    env,
    homeDir: deps?.homeDir,
    workspaceDir: deps?.workspaceDir,
  });
  if (workspaceTargets.length === 0) {
    return;
  }

  const store = deps?.store ?? ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
  const readClaudeCliCredentials =
    deps?.readClaudeCliCredentials ??
    (() => readClaudeCliCredentialsCached({ allowKeychainPrompt: false }));
  const credential = readClaudeCliCredentials();
  const command = resolveClaudeCliCommand(cfg);
  const resolveCommandPath =
    deps?.resolveCommandPath ??
    ((rawCommand: string, nextEnv?: NodeJS.ProcessEnv) =>
      resolveExecutablePath(rawCommand, { env: nextEnv }));
  const commandPath = resolveCommandPath(command, env);
  const authStorePath = resolveAuthStorePathForDisplay();
  const storedProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const showAgentLabels =
    workspaceTargets.length > 1 ||
    workspaceTargets.some((target) => target.agentId !== defaultAgentId);

  const lines: string[] = [];
  const fixHints: string[] = [];

  if (!commandPath) {
    lines.push(`- Binary: command "${command}" was not found on PATH.`);
    fixHints.push(
      "- Fix: install Claude CLI or set agents.defaults.cliBackends.claude-cli.command to the real binary path.",
    );
  }

  if (!credential) {
    lines.push("- Headless Claude auth: unavailable without interactive prompting.");
    fixHints.push(
      `- Fix: run ${formatCliCommand("claude auth login")}, then ${formatCliCommand(
        "openclaw models auth login --provider anthropic --method cli --set-default",
      )}.`,
    );
  }

  if (!storedProfile && credential?.type !== "api_key_helper") {
    lines.push(`- OpenClaw auth profile: missing (${CLAUDE_CLI_PROFILE_ID}) in ${authStorePath}.`);
    fixHints.push(
      `- Fix: run ${formatCliCommand(
        "openclaw models auth login --provider anthropic --method cli --set-default",
      )}.`,
    );
  } else if (storedProfile && storedProfile.provider !== CLAUDE_CLI_PROVIDER) {
    lines.push(
      `- OpenClaw auth profile: ${CLAUDE_CLI_PROFILE_ID} is wired to provider "${storedProfile.provider}" instead of "${CLAUDE_CLI_PROVIDER}".`,
    );
    fixHints.push(
      `- Fix: rerun ${formatCliCommand(
        "openclaw models auth login --provider anthropic --method cli --set-default",
      )} to rewrite the profile cleanly.`,
    );
  }

  for (const target of workspaceTargets) {
    const agentLabel = showAgentLabels ? target.agentId : undefined;
    const workspaceProblem = formatWorkspaceProblemLine(
      target.workspaceDir,
      target.workspaceHealth,
      agentLabel,
    );
    if (workspaceProblem) {
      lines.push(workspaceProblem);
    }
    if (
      target.workspaceHealth === "readonly" ||
      target.workspaceHealth === "unreadable" ||
      target.workspaceHealth === "not_directory"
    ) {
      fixHints.push(
        `- Fix: make ${
          agentLabel ? `agent ${agentLabel}'s workspace` : "the workspace"
        } a readable, writable directory for the gateway user.`,
      );
    }

    const projectDirProblem = formatProjectDirProblemLine(
      target.projectDir,
      target.projectDirHealth,
      agentLabel,
    );
    if (projectDirProblem) {
      lines.push(projectDirProblem);
    }
    if (target.projectDirHealth === "unreadable" || target.projectDirHealth === "not_directory") {
      fixHints.push(
        `- Fix: make ${
          agentLabel ? `agent ${agentLabel}'s Claude project dir` : "the Claude project dir"
        } readable, or remove the broken path and let Claude recreate it.`,
      );
    }
  }

  if (lines.length > 0 && workspaceTargets.length > 1) {
    lines.push(
      `- Agents using Claude CLI: ${workspaceTargets
        .map((target) => target.agentId)
        .toSorted((a, b) => a.localeCompare(b))
        .join(", ")}.`,
    );
  }

  if (lines.length === 0 && fixHints.length === 0) {
    return;
  }
  if (fixHints.length > 0) {
    lines.push(...fixHints);
  }

  (deps?.noteFn ?? note)(lines.join("\n"), "Claude CLI");
}
