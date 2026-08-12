/** Doctor health note for Claude CLI binary, auth, and workspace/project directories. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
} from "../agents/agent-scope.js";
import { CLAUDE_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
import { resolveAuthStorePathForDisplay } from "../agents/auth-profiles/paths.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import type {
  AuthProfileStore,
  OAuthCredential,
  TokenCredential,
} from "../agents/auth-profiles/types.js";
import {
  formatCliBackendVersionAdvisory,
  resolveCliBackendVersionGuidance,
} from "../agents/cli-backend-version-support.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import { readClaudeCliCredentialsCached } from "../agents/cli-credentials.js";
import { resolveClaudeCliProjectDirForWorkspace } from "../agents/command/claude-cli-project-dir.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isErrno } from "../infra/errors.js";
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

function resolveCommandVersion(
  commandPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  const result = spawnSync(commandPath, [...args], {
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024,
    timeout: 1_500,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return output.split(/\r?\n/u)[0]?.trim() || undefined;
}

function probeDirectoryHealth(dirPath: string): ClaudeCliDirHealth {
  let candidate = dirPath; // A missing leaf can conceal a broken ancestor symlink.
  while (true) {
    let isSymlink = false;
    try {
      const entry = fs.lstatSync(candidate);
      isSymlink = entry.isSymbolicLink();
      const stat = isSymlink ? fs.statSync(candidate) : entry;
      if (!stat.isDirectory()) {
        return "not_directory";
      }
      break;
    } catch (error) {
      if (isErrno(error) && error.code === "ENOENT") {
        if (isSymlink) {
          return "not_directory";
        }
        const parent = path.dirname(candidate);
        if (parent === candidate) {
          return "missing";
        }
        candidate = parent;
        continue;
      }
      return isErrno(error) && error.code === "ENOTDIR" ? "not_directory" : "unreadable";
    }
  }
  try {
    // Missing children need parent search/write; existing directories also need read access.
    // X_OK has no effect on Windows.
    const readableAccess =
      (candidate === dirPath ? fs.constants.R_OK : fs.constants.F_OK) |
      (process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    fs.accessSync(candidate, readableAccess);
  } catch {
    return "unreadable";
  }
  try {
    fs.accessSync(candidate, fs.constants.W_OK);
  } catch {
    return "readonly";
  }
  return candidate === dirPath ? "present" : "missing";
}

function formatDirectoryProblemLine(
  dirPath: string,
  health: ClaudeCliDirHealth,
  label: string,
): string | null {
  if (health === "present" || health === "missing") {
    return null;
  }
  const display = shortenHomePath(dirPath);
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
    resolveCommandVersion?: (
      commandPath: string,
      args: readonly string[],
      env: NodeJS.ProcessEnv,
    ) => string | undefined;
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
  const backend = resolveCliBackendConfig(CLAUDE_CLI_PROVIDER, cfg);
  const command = backend?.config.command ?? "claude";
  const resolveCommandPath =
    deps?.resolveCommandPath ??
    ((rawCommand: string, nextEnv?: NodeJS.ProcessEnv) =>
      resolveExecutablePath(rawCommand, { env: nextEnv }));
  const commandPath = resolveCommandPath(command, env);
  const authStorePath = resolveAuthStorePathForDisplay();
  const storedProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];
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

  const liveSessionRequirement = backend?.liveSessionRequirement;
  if (commandPath && liveSessionRequirement) {
    const versionOutput = (deps?.resolveCommandVersion ?? resolveCommandVersion)(
      commandPath,
      liveSessionRequirement.versionArgs,
      env,
    );
    const guidance = resolveCliBackendVersionGuidance(versionOutput, liveSessionRequirement);
    if (guidance.status === "below-known-floor") {
      lines.push(
        `- Binary version advisory: ${formatCliBackendVersionAdvisory({
          label: "Claude Code",
          requirement: liveSessionRequirement,
          version: guidance.version,
        })}`,
      );
    }
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
    const workspaceProblem = formatDirectoryProblemLine(
      target.workspaceDir,
      target.workspaceHealth,
      agentLabel ? `Agent ${agentLabel} workspace` : "Workspace",
    );
    if (workspaceProblem) {
      lines.push(workspaceProblem);
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
      const requiredAccess = target.projectDirHealth === "readonly" ? "writable" : "readable";
      fixHints.push(
        `- Fix: make ${
          agentLabel ? `agent ${agentLabel}'s Claude project dir` : "the Claude project dir"
        } ${requiredAccess}, or remove the broken path and let Claude recreate it.`,
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
