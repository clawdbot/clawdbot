/** Doctor health note for Claude CLI binary, auth, and workspace/project directories. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope-config.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../agents/command/claude-cli-project-dir.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { shortenHomePath } from "../utils.js";

const CLAUDE_CLI_PROVIDER = "claude-cli";

type ClaudeCliDirHealth = "present" | "missing" | "not_directory" | "unreadable" | "readonly";

function isClaudeCliAuthenticated(commandPath: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(commandPath, ["auth", "status", "--json"], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024,
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return isRecord(parsed) && parsed.loggedIn === true;
  } catch {
    return false;
  }
}

function usesClaudeCliModelSelection(cfg: OpenClawConfig): boolean {
  const primary = resolvePrimaryStringValue(cfg.agents?.defaults?.model);
  if (normalizeOptionalLowercaseString(primary)?.startsWith(`${CLAUDE_CLI_PROVIDER}/`)) {
    return true;
  }
  return Object.keys(cfg.agents?.defaults?.models ?? {}).some((key) =>
    normalizeOptionalLowercaseString(key)?.startsWith(`${CLAUDE_CLI_PROVIDER}/`),
  );
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

function formatDirectoryProblemLine(
  dirPath: string,
  health: ClaudeCliDirHealth,
  label: string,
): string | null {
  const display = shortenHomePath(dirPath);
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
    const defaultAgentId = tryResolveDefaultAgentId(cfg);
    return defaultAgentId ? [defaultAgentId] : [];
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
  const defaultAgentId = tryResolveDefaultAgentId(params.cfg);
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
 * The optional deps let tests inject the CLI status probe, PATH resolution, and workspace roots.
 */
export function noteClaudeCliHealth(
  cfg: OpenClawConfig,
  deps?: {
    noteFn?: typeof note;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    isAuthenticated?: (commandPath: string, env: NodeJS.ProcessEnv) => boolean;
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

  const backend = resolveCliBackendConfig(CLAUDE_CLI_PROVIDER, cfg);
  const command = backend?.config.command ?? "claude";
  const resolveCommandPath =
    deps?.resolveCommandPath ??
    ((rawCommand: string, nextEnv?: NodeJS.ProcessEnv) =>
      resolveExecutablePath(rawCommand, { env: nextEnv }));
  const commandPath = resolveCommandPath(command, env);
  const authEnv = { ...env };
  for (const envName of backend?.config.clearEnv ?? []) {
    delete authEnv[envName];
  }
  const authenticated = commandPath
    ? (deps?.isAuthenticated ?? isClaudeCliAuthenticated)(commandPath, authEnv)
    : false;
  const defaultAgentId = tryResolveDefaultAgentId(cfg);
  const showAgentLabels =
    workspaceTargets.length > 1 ||
    workspaceTargets.some((target) => target.agentId !== defaultAgentId);

  const lines: string[] = [];
  const fixHints: string[] = [];

  if (!commandPath) {
    lines.push(`- Binary: command "${command}" was not found on PATH.`);
    fixHints.push(
      "- Fix: install Claude CLI on PATH for the gateway user; custom executable paths belong in a CLI backend plugin registration.",
    );
  }

  if (commandPath && !authenticated) {
    lines.push("- Claude auth: not logged in.");
    fixHints.push(`- Fix: run ${formatCliCommand("claude auth login")}.`);
  }

  for (const target of workspaceTargets) {
    const agentLabel = showAgentLabels ? target.agentId : undefined;
    const workspaceProblem = formatDirectoryProblemLine(
      target.workspaceDir,
      target.workspaceHealth,
      agentLabel ? `Agent ${agentLabel} workspace` : "Workspace",
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

    const projectDirProblem = formatDirectoryProblemLine(
      target.projectDir,
      target.projectDirHealth,
      agentLabel ? `Agent ${agentLabel} Claude project dir` : "Claude project dir",
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
