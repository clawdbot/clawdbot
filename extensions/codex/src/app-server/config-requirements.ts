import { readFileSync } from "node:fs";
import type {
  CodexAppServerApprovalPolicy,
  CodexAppServerApprovalsReviewer,
  CodexAppServerSandboxMode,
  OpenClawExecMode,
} from "./config-contracts.js";
import { resolveApprovalPolicy, resolveApprovalsReviewer } from "./config-exec-policy.js";
import { readNonEmptyString } from "./config-utils.js";

const UNIX_CODEX_REQUIREMENTS_PATH = "/etc/codex/requirements.toml";
const WINDOWS_CODEX_REQUIREMENTS_SUFFIX = "\\OpenAI\\Codex\\requirements.toml";

export function isCodexAppServerApprovalPolicyAllowedByRequirements(
  policy: CodexAppServerApprovalPolicy,
  params: {
    env?: NodeJS.ProcessEnv;
    requirementsToml?: string | null;
    requirementsPath?: string;
    readRequirementsFile?: (path: string) => string | undefined;
    platform?: NodeJS.Platform;
  } = {},
): boolean {
  const content = readCodexRequirementsToml(params);
  if (content === undefined) {
    return true;
  }
  const allowedApprovalPolicies = parseAllowedApprovalPoliciesFromCodexRequirements(content);
  return allowedApprovalPolicies === undefined || allowedApprovalPolicies.has(policy);
}

export function readCodexRequirementsToml(params: {
  env?: NodeJS.ProcessEnv;
  requirementsToml?: string | null;
  requirementsPath?: string;
  readRequirementsFile?: (path: string) => string | undefined;
  platform?: NodeJS.Platform;
}): string | undefined {
  if (params.requirementsToml !== undefined) {
    return params.requirementsToml ?? undefined;
  }
  const requirementsPath =
    readNonEmptyString(params.requirementsPath) ??
    resolveCodexRequirementsPath(params.env ?? process.env, params.platform ?? process.platform);
  try {
    if (params.readRequirementsFile) {
      return params.readRequirementsFile(requirementsPath);
    }
    return readFileSync(requirementsPath, "utf8");
  } catch {
    return undefined;
  }
}

function resolveCodexRequirementsPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const programData = readNonEmptyString(env.ProgramData) ?? "C:\\ProgramData";
    return `${programData.replace(/[\\/]+$/, "")}${WINDOWS_CODEX_REQUIREMENTS_SUFFIX}`;
  }
  return UNIX_CODEX_REQUIREMENTS_PATH;
}

export function parseAllowedSandboxModesFromCodexRequirements(
  content: string,
  hostName: string,
): Set<CodexAppServerSandboxMode> | undefined {
  const remoteSandboxModes = parseMatchingRemoteSandboxModesFromCodexRequirements(
    content,
    hostName,
  );
  if (remoteSandboxModes !== undefined) {
    return remoteSandboxModes;
  }
  const values = parseTopLevelRequirementsStringArray(content, "allowed_sandbox_modes");
  return parseRequirementsSandboxModes(values);
}

export function parseAllowedApprovalPoliciesFromCodexRequirements(
  content: string,
): Set<CodexAppServerApprovalPolicy> | undefined {
  const values = parseTopLevelRequirementsStringArray(content, "allowed_approval_policies");
  if (values === undefined) {
    return undefined;
  }
  const normalizedPolicies = values
    .map((entry) => normalizeRequirementsApprovalPolicy(entry))
    .filter((entry): entry is CodexAppServerApprovalPolicy => entry !== undefined);
  return normalizedPolicies.length > 0 ? new Set(normalizedPolicies) : undefined;
}

export function parseAllowedApprovalsReviewersFromCodexRequirements(
  content: string,
): Set<CodexAppServerApprovalsReviewer> | undefined {
  const values = parseTopLevelRequirementsStringArray(content, "allowed_approvals_reviewers");
  if (values === undefined) {
    return undefined;
  }
  const normalizedReviewers = values
    .map((entry) => normalizeRequirementsApprovalsReviewer(entry))
    .filter((entry): entry is CodexAppServerApprovalsReviewer => entry !== undefined);
  return normalizedReviewers.length > 0 ? new Set(normalizedReviewers) : undefined;
}

function parseMatchingRemoteSandboxModesFromCodexRequirements(
  content: string,
  hostName: string,
): Set<CodexAppServerSandboxMode> | undefined {
  const normalizedHostName = normalizeRequirementsHostName(hostName);
  if (normalizedHostName === undefined) {
    return undefined;
  }
  for (const section of parseTomlArrayTableSections(content, "remote_sandbox_config")) {
    const patterns = parseRequirementsStringArray(section, "hostname_patterns");
    if (!patterns || !requirementsHostNameMatchesAnyPattern(normalizedHostName, patterns)) {
      continue;
    }
    return parseRequirementsSandboxModes(
      parseRequirementsStringArray(section, "allowed_sandbox_modes"),
    );
  }
  return undefined;
}

function parseRequirementsSandboxModes(
  values: string[] | undefined,
): Set<CodexAppServerSandboxMode> | undefined {
  if (values === undefined) {
    return undefined;
  }
  const normalizedModes = values
    .map((entry) => normalizeRequirementsSandboxMode(entry))
    .filter((entry): entry is CodexAppServerSandboxMode => entry !== undefined);
  return normalizedModes.length > 0 ? new Set(normalizedModes) : undefined;
}

function parseTopLevelRequirementsStringArray(content: string, key: string): string[] | undefined {
  const topLevelContent = stripTomlLineComments(content).slice(0, firstTomlTableOffset(content));
  return parseRequirementsStringArray(topLevelContent, key);
}

export function parseTomlStringValue(content: string, key: string): string | undefined | false {
  return parseTomlStringAssignmentValue(content, tomlDottedKeyPattern(key));
}

export function parseInlineOpenAIModelProviderBaseUrl(content: string): string | undefined | false {
  return parseTomlStringAssignmentValue(
    content,
    `${tomlKeyPattern("model_providers")}\\s*=\\s*\\{[\\s\\S]*?${tomlKeyPattern("openai")}\\s*=\\s*\\{[\\s\\S]*?${tomlKeyPattern("base_url")}`,
  );
}

function parseTomlStringAssignmentValue(
  content: string,
  keyPattern: string,
): string | undefined | false {
  const assignment = content.match(new RegExp(`(?:^|\\n)\\s*${keyPattern}\\s*=\\s*([^\\r\\n]*)`));
  if (!assignment) {
    return undefined;
  }
  const rawValue = assignment[1]?.trimStart() ?? "";
  if (rawValue.startsWith('"""') || rawValue.startsWith("'''")) {
    return false;
  }
  const match = parseTomlStringAssignment(content, keyPattern);
  return match ? (match[1] ?? match[2] ?? "") : false;
}

function parseTomlStringAssignment(content: string, keyPattern: string): RegExpMatchArray | null {
  return content.match(
    new RegExp(`(?:^|\\n)\\s*${keyPattern}\\s*=\\s*(?:"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|'([^']*)')`),
  );
}

function tomlDottedKeyPattern(key: string): string {
  return key.split(".").map(tomlKeyPattern).join("\\s*\\.\\s*");
}

function tomlKeyPattern(key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:"${escaped}"|'${escaped}'|${escaped})`;
}

function parseRequirementsStringArray(content: string, key: string): string[] | undefined {
  const match = content.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) {
    return undefined;
  }
  const arrayBody = match[1] ?? "";
  const stringMatches = [...arrayBody.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g)];
  if (stringMatches.length === 0 && arrayBody.trim().length > 0) {
    return undefined;
  }
  return stringMatches.map((entry) => entry[1] ?? entry[2] ?? "");
}

export function parseTomlTableSection(content: string, table: string): string | undefined {
  const strippedContent = stripTomlLineComments(content);
  const tablePattern = tomlDottedKeyPattern(table);
  const headerPattern = new RegExp(`^\\s*\\[\\s*${tablePattern}\\s*\\]\\s*$`, "m");
  const match = headerPattern.exec(strippedContent);
  if (!match) {
    return undefined;
  }
  const sectionStart = match.index + match[0].length;
  const rest = strippedContent.slice(sectionStart);
  const nextTableOffset = rest.search(/^\s*\[/m);
  return nextTableOffset === -1 ? rest : rest.slice(0, nextTableOffset);
}

function parseTomlArrayTableSections(content: string, table: string): string[] {
  const strippedContent = stripTomlLineComments(content);
  const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = new RegExp(`^\\s*\\[\\[\\s*${escapedTable}\\s*\\]\\]\\s*$`, "gm");
  const sections: string[] = [];
  for (
    let match = headerPattern.exec(strippedContent);
    match;
    match = headerPattern.exec(strippedContent)
  ) {
    const sectionStart = headerPattern.lastIndex;
    const rest = strippedContent.slice(sectionStart);
    const nextTableOffset = rest.search(/^\s*\[/m);
    sections.push(nextTableOffset === -1 ? rest : rest.slice(0, nextTableOffset));
  }
  return sections;
}

export function firstTomlTableOffset(content: string): number {
  const match = content.match(/^\s*\[[^\]\n]/m);
  return match?.index ?? content.length;
}

export function stripTomlLineComments(value: string): string {
  let output = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (quote) {
      output += char;
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "#") {
      while (index < value.length && value[index] !== "\n") {
        index += 1;
      }
      if (value[index] === "\n") {
        output += "\n";
      }
      continue;
    }
    output += char;
  }
  return output;
}

function normalizeRequirementsSandboxMode(value: string): CodexAppServerSandboxMode | undefined {
  const compact = value.replace(/[\s_-]/g, "").toLowerCase();
  if (compact === "readonly") {
    return "read-only";
  }
  if (compact === "workspacewrite") {
    return "workspace-write";
  }
  if (compact === "dangerfullaccess") {
    return "danger-full-access";
  }
  return undefined;
}

function normalizeRequirementsHostName(value: string): string | undefined {
  const normalized = value.trim().replace(/\.+$/g, "").toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function requirementsHostNameMatchesAnyPattern(hostName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeRequirementsHostName(pattern);
    return normalizedPattern !== undefined && globPatternMatches(hostName, normalizedPattern);
  });
}

function globPatternMatches(value: string, pattern: string): boolean {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") {
      regex += ".*";
    } else if (char === "?") {
      regex += ".";
    } else {
      regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regex += "$";
  return new RegExp(regex).test(value);
}

function normalizeRequirementsApprovalPolicy(
  value: string,
): CodexAppServerApprovalPolicy | undefined {
  const normalized = value.trim().toLowerCase();
  // Codex still accepts this alias in persisted requirements, while its
  // app-server exposes only the canonical on-request value.
  if (normalized === "on-failure") {
    return "on-request";
  }
  return resolveApprovalPolicy(normalized);
}

function normalizeRequirementsApprovalsReviewer(
  value: string,
): CodexAppServerApprovalsReviewer | undefined {
  const normalized = value.trim().toLowerCase();
  return resolveApprovalsReviewer(normalized);
}

export function selectGuardianApprovalPolicy(
  allowedApprovalPolicies: Set<CodexAppServerApprovalPolicy> | undefined,
  execModeRequiringPromptingApprovals?: Extract<OpenClawExecMode, "auto" | "ask">,
): CodexAppServerApprovalPolicy {
  if (allowedApprovalPolicies === undefined || allowedApprovalPolicies.has("on-request")) {
    return "on-request";
  }
  if (execModeRequiringPromptingApprovals) {
    throw new Error(
      `tools.exec.mode=${execModeRequiringPromptingApprovals} requires Codex app-server prompting approvals`,
    );
  }
  if (allowedApprovalPolicies.has("untrusted")) {
    return "untrusted";
  }
  if (allowedApprovalPolicies.has("never")) {
    return "never";
  }
  return "on-request";
}

export function selectGuardianApprovalsReviewer(
  allowedApprovalsReviewers: Set<CodexAppServerApprovalsReviewer> | undefined,
  execModeRequiringAutoReviewer?: Extract<OpenClawExecMode, "auto">,
): CodexAppServerApprovalsReviewer {
  if (allowedApprovalsReviewers === undefined || allowedApprovalsReviewers.has("auto_review")) {
    return "auto_review";
  }
  if (allowedApprovalsReviewers.has("guardian_subagent")) {
    return "guardian_subagent";
  }
  if (execModeRequiringAutoReviewer) {
    throw new Error(
      `tools.exec.mode=${execModeRequiringAutoReviewer} requires Codex app-server auto approvals`,
    );
  }
  if (allowedApprovalsReviewers.has("user")) {
    return "user";
  }
  return "auto_review";
}

export function selectUserApprovalsReviewer(
  allowedApprovalsReviewers: Set<CodexAppServerApprovalsReviewer> | undefined,
  execModeRequiringUserReviewer?: OpenClawExecMode,
): CodexAppServerApprovalsReviewer {
  if (allowedApprovalsReviewers === undefined || allowedApprovalsReviewers.has("user")) {
    return "user";
  }
  throw new Error(
    `tools.exec.mode=${execModeRequiringUserReviewer ?? "ask"} requires Codex app-server user approvals`,
  );
}
