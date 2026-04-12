import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { CLAUDE_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
import { resolveAuthStorePathForDisplay } from "../agents/auth-profiles/paths.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import type {
  AuthProfileStore,
  OAuthCredential,
  TokenCredential,
} from "../agents/auth-profiles/types.js";
import { readClaudeCliCredentialsCached } from "../agents/cli-credentials.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "../shared/string-coerce.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

const CLAUDE_CLI_PROVIDER = "claude-cli";
const CLAUDE_PROJECTS_DIRNAME = path.join(".claude", "projects");
const MAX_SANITIZED_PROJECT_LENGTH = 200;

type ClaudeCliReadableCredential =
  | Pick<OAuthCredential, "type" | "expires">
  | Pick<TokenCredential, "type" | "expires">;

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

function hasClaudeCliConfigSignals(cfg: OpenClawConfig): boolean {
  if (usesClaudeCliModelSelection(cfg)) {
    return true;
  }
  const backendConfig = cfg.agents?.defaults?.cliBackends ?? {};
  if (
    Object.keys(backendConfig).some(
      (key) => normalizeOptionalLowercaseString(key) === CLAUDE_CLI_PROVIDER,
    )
  ) {
    return true;
  }
  return Object.values(cfg.auth?.profiles ?? {}).some(
    (profile) => profile?.provider === CLAUDE_CLI_PROVIDER,
  );
}

function hasClaudeCliStoreSignals(store: AuthProfileStore): boolean {
  if (store.profiles[CLAUDE_CLI_PROFILE_ID]) {
    return true;
  }
  return Object.values(store.profiles).some((profile) => profile?.provider === CLAUDE_CLI_PROVIDER);
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

function simpleHash36(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function sanitizeClaudeCliProjectKey(workspaceDir: string): string {
  const sanitized = workspaceDir.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_PROJECT_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_SANITIZED_PROJECT_LENGTH)}-${simpleHash36(workspaceDir)}`;
}

function canonicalizeWorkspaceDir(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).normalize("NFC");
  try {
    return fs.realpathSync.native(resolved).normalize("NFC");
  } catch {
    return resolved;
  }
}

export function resolveClaudeCliProjectDirForWorkspace(params: {
  workspaceDir: string;
  homeDir?: string;
}): string {
  const homeDir = normalizeOptionalString(params.homeDir) || process.env.HOME || os.homedir();
  const canonicalWorkspaceDir = canonicalizeWorkspaceDir(params.workspaceDir);
  return path.join(
    homeDir,
    CLAUDE_PROJECTS_DIRNAME,
    sanitizeClaudeCliProjectKey(canonicalWorkspaceDir),
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

function formatCredentialLabel(credential: ClaudeCliReadableCredential): string {
  if (credential.type === "oauth" || credential.type === "token") {
    return credential.type;
  }
  return "unknown";
}

function formatWorkspaceHealthLine(workspaceDir: string, health: ClaudeCliDirHealth): string {
  const display = shortenHomePath(workspaceDir);
  if (health === "present") {
    return `- Workspace: ${display} (writable).`;
  }
  if (health === "missing") {
    return `- Workspace: ${display} (missing; OpenClaw will create it on first run).`;
  }
  if (health === "not_directory") {
    return `- Workspace: ${display} exists but is not a directory.`;
  }
  if (health === "unreadable") {
    return `- Workspace: ${display} is not readable by this user.`;
  }
  return `- Workspace: ${display} is not writable by this user.`;
}

function formatProjectDirHealthLine(projectDir: string, health: ClaudeCliDirHealth): string {
  const display = shortenHomePath(projectDir);
  if (health === "present") {
    return `- Claude project dir: ${display} (present).`;
  }
  if (health === "missing") {
    return `- Claude project dir: ${display} (not created yet; it appears after the first Claude CLI turn in this workspace).`;
  }
  if (health === "not_directory") {
    return `- Claude project dir: ${display} exists but is not a directory.`;
  }
  if (health === "unreadable") {
    return `- Claude project dir: ${display} is not readable by this user.`;
  }
  return `- Claude project dir: ${display} is not writable by this user.`;
}

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
  const store = deps?.store ?? ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
  const readClaudeCliCredentials =
    deps?.readClaudeCliCredentials ??
    (() => readClaudeCliCredentialsCached({ allowKeychainPrompt: false }));
  const credential = readClaudeCliCredentials();

  if (!hasClaudeCliConfigSignals(cfg) && !hasClaudeCliStoreSignals(store) && !credential) {
    return;
  }

  const env = deps?.env ?? process.env;
  const command = resolveClaudeCliCommand(cfg);
  const resolveCommandPath =
    deps?.resolveCommandPath ??
    ((rawCommand: string, nextEnv?: NodeJS.ProcessEnv) =>
      resolveExecutablePath(rawCommand, { env: nextEnv }));
  const commandPath = resolveCommandPath(command, env);
  const workspaceDir =
    deps?.workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const projectDir = resolveClaudeCliProjectDirForWorkspace({
    workspaceDir,
    homeDir: deps?.homeDir,
  });
  const workspaceHealth = probeDirectoryHealth(workspaceDir);
  const projectDirHealth = probeDirectoryHealth(projectDir);
  const authStorePath = resolveAuthStorePathForDisplay();
  const storedProfile = store.profiles[CLAUDE_CLI_PROFILE_ID];

  const lines: string[] = [];
  const fixHints: string[] = [];

  if (commandPath) {
    lines.push(`- Binary: ${shortenHomePath(commandPath)}.`);
  } else {
    lines.push(`- Binary: command "${command}" was not found on PATH.`);
    fixHints.push(
      "- Fix: install Claude CLI or set agents.defaults.cliBackends.claude-cli.command to the real binary path.",
    );
  }

  if (credential) {
    lines.push(`- Headless Claude auth: OK (${formatCredentialLabel(credential)}).`);
  } else {
    lines.push("- Headless Claude auth: unavailable without interactive prompting.");
    fixHints.push(
      `- Fix: run ${formatCliCommand("claude auth login")}, then ${formatCliCommand(
        "openclaw models auth login --provider anthropic --method cli --set-default",
      )}.`,
    );
  }

  if (!storedProfile) {
    lines.push(`- OpenClaw auth profile: missing (${CLAUDE_CLI_PROFILE_ID}) in ${authStorePath}.`);
    fixHints.push(
      `- Fix: run ${formatCliCommand(
        "openclaw models auth login --provider anthropic --method cli --set-default",
      )}.`,
    );
  } else if (storedProfile.provider !== CLAUDE_CLI_PROVIDER) {
    lines.push(
      `- OpenClaw auth profile: ${CLAUDE_CLI_PROFILE_ID} is wired to provider "${storedProfile.provider}" instead of "${CLAUDE_CLI_PROVIDER}".`,
    );
    fixHints.push(
      `- Fix: rerun ${formatCliCommand(
        "openclaw models auth login --provider anthropic --method cli --set-default",
      )} to rewrite the profile cleanly.`,
    );
  } else {
    lines.push(
      `- OpenClaw auth profile: ${CLAUDE_CLI_PROFILE_ID} (provider ${CLAUDE_CLI_PROVIDER}).`,
    );
  }

  lines.push(formatWorkspaceHealthLine(workspaceDir, workspaceHealth));
  if (
    workspaceHealth === "readonly" ||
    workspaceHealth === "unreadable" ||
    workspaceHealth === "not_directory"
  ) {
    fixHints.push("- Fix: make the workspace a readable, writable directory for the gateway user.");
  }

  lines.push(formatProjectDirHealthLine(projectDir, projectDirHealth));
  if (projectDirHealth === "unreadable" || projectDirHealth === "not_directory") {
    fixHints.push(
      "- Fix: make the Claude project dir readable, or remove the broken path and let Claude recreate it.",
    );
  }

  if (fixHints.length > 0) {
    lines.push(...fixHints);
  }

  (deps?.noteFn ?? note)(lines.join("\n"), "Claude CLI");
}
