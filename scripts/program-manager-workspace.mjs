#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSON5 from "json5";

const execFile = promisify(execFileCallback);
const canonicalValidationCache = new Map();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOURCE_ROOT = path.resolve(SCRIPT_DIR, "..", "control", "program-manager");

export const MANAGED_FILES = Object.freeze([
  "CONTRACT.md",
  "workspace/AGENTS.md",
  "workspace/TOOLS.md",
  "workspace/SOUL.md",
  "workspace/IDENTITY.md",
  "workspace/USER.md",
  "workspace/HEARTBEAT.md",
]);

const BOOTSTRAP_FILES = Object.freeze(
  MANAGED_FILES.filter((entry) => entry.startsWith("workspace/")),
);
const ALLOWED_TOOLS = Object.freeze([
  "get_goal",
  "progress_card",
  "read",
  "sessions_spawn",
  "sessions_yield",
]);
const REQUIRED_DENIED_TOOLS = Object.freeze([
  "apply_patch",
  "browser",
  "code_execution",
  "cron",
  "edit",
  "exec",
  "message",
  "process",
  "session_status",
  "sessions_send",
  "web_fetch",
  "web_search",
  "write",
]);
const CONFIG_MANAGED_FIELDS = Object.freeze([
  "skills",
  "skillsLimits",
  "bootstrapMaxChars",
  "bootstrapTotalMaxChars",
  "contextLimits",
  "model",
  "params",
  "thinkingDefault",
  "subagents",
  "tools",
]);
const MAX_BOOTSTRAP_FILE_BYTES = 4_000;
const MAX_BOOTSTRAP_TOTAL_BYTES = 10_000;
const SECRET_KEY = /token|password|cookie|credential|secret|private/i;

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sorted(values) {
  return values.toSorted((left, right) => left.localeCompare(right));
}

function findSecretKey(value, currentPath = []) {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findSecretKey(entry, [...currentPath, String(index)]);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isObject(value)) {
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      return [...currentPath, key].join(".");
    }
    const found = findSecretKey(entry, [...currentPath, key]);
    if (found) {
      return found;
    }
  }
  return null;
}

async function readFileIfPresent(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function lstatIfPresent(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fileExists(filePath) {
  const stat = await lstatIfPresent(filePath);
  return Boolean(stat?.isFile());
}

async function assertNoSymlinkPath(targetPath, boundaryRoot, label) {
  const target = path.resolve(targetPath);
  const boundary = path.resolve(boundaryRoot);
  const relative = path.relative(boundary, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its allowed root.`);
  }
  const paths = [];
  let cursor = target;
  while (true) {
    paths.push(cursor);
    if (cursor === boundary || cursor === path.dirname(cursor)) {
      break;
    }
    cursor = path.dirname(cursor);
  }
  for (const candidate of paths.toReversed()) {
    const stat = await lstatIfPresent(candidate);
    if (stat?.isSymbolicLink()) {
      throw new Error(`${label} contains a symlinked path: ${candidate}`);
    }
  }
}

async function assertRegularFile(filePath, label) {
  const stat = await lstatIfPresent(filePath);
  if (!stat) {
    throw new Error(`${label} is missing.`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink.`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
}

function assertSafeRelativePath(relativePath) {
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe managed path: ${relativePath}`);
  }
}

function destinationFor(workspaceRoot, relativePath) {
  assertSafeRelativePath(relativePath);
  const destination = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(path.resolve(workspaceRoot), destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Managed path escapes workspace: ${relativePath}`);
  }
  return destination;
}

function workspaceRelativePath(relativePath) {
  return relativePath.startsWith("workspace/")
    ? relativePath.slice("workspace/".length)
    : relativePath;
}

function parseJson(text, label) {
  try {
    return JSON5.parse(text);
  } catch (error) {
    return { parseError: `${label}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function configuredAgentEntry(config, agentId) {
  if (Array.isArray(config?.agents?.list)) {
    return config.agents.list.find((entry) => entry?.id === agentId);
  }
  if (isObject(config?.agents?.entries)) {
    return config.agents.entries[agentId];
  }
  return undefined;
}

function configuredAgentEntries(config) {
  if (Array.isArray(config?.agents?.list)) {
    return config.agents.list.filter((entry) => isObject(entry) && typeof entry.id === "string");
  }
  if (isObject(config?.agents?.entries)) {
    return Object.entries(config.agents.entries).map(([id, entry]) =>
      Object.assign({}, isObject(entry) ? entry : {}, { id }),
    );
  }
  return [];
}

function validateConfiguredAgentRegistry(config) {
  const entries = configuredAgentEntries(config);
  const issues = [];
  if (entries.length === 0) {
    issues.push(
      issue("agent_registry_missing", "Config must define agents.list or agents.entries."),
    );
  }
  const ids = new Set(entries.map((entry) => entry.id));
  const programManager = entries.find((entry) => entry.id === "program-manager");
  if (!programManager) {
    issues.push(issue("agent_missing", "Configured Program Manager entry was not found."));
  }
  for (const target of ["builder-agent", "research-brief-agent"]) {
    if (!ids.has(target)) {
      issues.push(
        issue(
          "delegation_target_unconfigured",
          `Configured delegation target is missing from the agent registry: ${target}.`,
          { agentId: target },
        ),
      );
    }
  }
  return { entries, programManager, issues };
}

async function validateCanonicalConfig(configPath) {
  const stat = await lstatIfPresent(configPath);
  const cacheKey = stat
    ? `${path.resolve(configPath)}:${stat.size}:${stat.mtimeNs ?? stat.mtimeMs}`
    : `${path.resolve(configPath)}:missing`;
  const cached = canonicalValidationCache.get(cacheKey);
  if (cached) {
    return [...cached];
  }
  const validationScript = [
    'import fs from "node:fs/promises";',
    'import { parseConfigJson5 } from "./src/config/config.ts";',
    'import { validateConfigObjectRawWithPlugins } from "./src/config/validation.ts";',
    'const source = await fs.readFile(process.argv[1], "utf8");',
    "const parsed = parseConfigJson5(source);",
    'if (!parsed.ok) { console.log(JSON.stringify({ valid: false, issues: [{ path: "<root>", message: "Config parsing failed." }] })); process.exitCode = 1; }',
    'else { const result = validateConfigObjectRawWithPlugins(parsed.parsed, { pluginValidation: "core-only", semanticValidation: "strict" }); console.log(JSON.stringify({ valid: result.ok, issues: result.ok ? [] : result.issues })); if (!result.ok) process.exitCode = 1; }',
  ].join(" ");
  try {
    const { stdout } = await execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", validationScript, "--", configPath],
      {
        cwd: path.resolve(SCRIPT_DIR, ".."),
        env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
        maxBuffer: 512 * 1024,
      },
    );
    const result = JSON.parse(stdout);
    if (result?.valid === true && result?.ok !== false) {
      canonicalValidationCache.set(cacheKey, []);
      return [];
    }
    const reportedIssues = Array.isArray(result?.issues) ? result.issues : [];
    if (reportedIssues.length === 0) {
      const issues = [
        issue("config_schema_invalid", "Canonical OpenClaw config validation failed."),
      ];
      canonicalValidationCache.set(cacheKey, issues);
      return [...issues];
    }
    const issues = reportedIssues.map((entry) =>
      issue("config_schema_invalid", "Canonical OpenClaw config validation failed.", {
        path: typeof entry?.path === "string" ? entry.path : "<unknown>",
      }),
    );
    canonicalValidationCache.set(cacheKey, issues);
    return [...issues];
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    try {
      const result = JSON.parse(stdout);
      const reportedIssues = Array.isArray(result?.issues) ? result.issues : [];
      if (reportedIssues.length > 0) {
        const issues = reportedIssues.map((entry) =>
          issue("config_schema_invalid", "Canonical OpenClaw config validation failed.", {
            path: typeof entry?.path === "string" ? entry.path : "<unknown>",
          }),
        );
        canonicalValidationCache.set(cacheKey, issues);
        return [...issues];
      }
    } catch {
      // Fall through to a stable, non-sensitive error below.
    }
    const issues = [
      issue("config_validation_failed", "Canonical OpenClaw config validation could not run."),
    ];
    canonicalValidationCache.set(cacheKey, issues);
    return [...issues];
  }
}

export function validateState(value) {
  const issues = [];
  if (!isObject(value)) {
    return [issue("state_not_object", "Program Manager state must be a JSON object.")];
  }
  const required = [
    "schemaVersion",
    "status",
    "evidenceStatus",
    "objective",
    "scope",
    "priorities",
    "blockers",
    "dependencies",
    "lastKnownGood",
    "unknowns",
    "source",
    "updatedAt",
  ];
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      issues.push(issue("state_field_missing", `State is missing ${key}.`, { field: key }));
    }
  }
  if (value.schemaVersion !== 1) {
    issues.push(issue("state_schema_unsupported", "State schemaVersion must be 1."));
  }
  if (!["Unknown", "Planning", "Blocked", "Complete"].includes(value.status)) {
    issues.push(issue("state_status_invalid", "State status is not a supported value."));
  }
  if (!["Unknown", "Confirmed"].includes(value.evidenceStatus)) {
    issues.push(
      issue("state_evidence_invalid", "State evidenceStatus must be Unknown or Confirmed."),
    );
  }
  if (
    !Array.isArray(value.scope) ||
    !Array.isArray(value.priorities) ||
    !Array.isArray(value.blockers) ||
    !Array.isArray(value.dependencies) ||
    !Array.isArray(value.unknowns)
  ) {
    issues.push(
      issue(
        "state_lists_invalid",
        "State scope, priorities, blockers, dependencies, and unknowns must be arrays.",
      ),
    );
  }
  if (
    !isObject(value.source) ||
    typeof value.source.kind !== "string" ||
    typeof value.source.label !== "string"
  ) {
    issues.push(issue("state_source_invalid", "State source must include kind and label."));
  }
  if (value.evidenceStatus === "Confirmed" && typeof value.source?.verifiedAt !== "string") {
    issues.push(
      issue("state_confirmation_without_time", "Confirmed state requires source.verifiedAt."),
    );
  }
  const secretPath = findSecretKey(value);
  if (secretPath) {
    issues.push(
      issue("state_secret_like_key", `State contains a disallowed sensitive key at ${secretPath}.`),
    );
  }
  return issues;
}

export function validateRuntimeEntry(value) {
  const issues = [];
  if (!isObject(value)) {
    return [issue("runtime_entry_invalid", "Program Manager config entry must be an object.")];
  }
  if (!Array.isArray(value.skills) || value.skills.length !== 0) {
    issues.push(issue("skills_not_empty", "Program Manager skills must be explicitly empty."));
  }
  if (value.skillsLimits?.maxSkillsPromptChars !== 0) {
    issues.push(issue("skills_budget_missing", "Program Manager maxSkillsPromptChars must be 0."));
  }
  if (value.bootstrapMaxChars !== 3500 || value.bootstrapTotalMaxChars !== 10000) {
    issues.push(
      issue(
        "bootstrap_budget_changed",
        "Bootstrap budgets must remain 3500 per file and 10000 total.",
      ),
    );
  }
  if (
    value.contextLimits?.memoryGetMaxChars !== 6000 ||
    value.contextLimits?.postCompactionMaxChars !== 2500
  ) {
    issues.push(
      issue(
        "context_budget_changed",
        "Context budgets must remain 6000 memory chars and 2500 post-compaction chars.",
      ),
    );
  }
  if (
    value.params?.maxTokens !== 1024 ||
    value.params?.text_verbosity !== "low" ||
    value.params?.cacheRetention !== "short" ||
    value.params?.chat_template_kwargs?.enable_thinking !== false ||
    value.params?.chat_template_kwargs?.preserve_thinking !== false
  ) {
    issues.push(
      issue(
        "model_budget_changed",
        "Model parameters must keep the bounded low-verbosity, thinking-off profile.",
      ),
    );
  }
  if (typeof value.model?.primary !== "string" || value.model.primary.length === 0) {
    issues.push(issue("model_primary_missing", "Program Manager must define a primary model ref."));
  }
  if (
    !Array.isArray(value.model?.fallbacks) ||
    value.model.fallbacks.some((modelRef) => typeof modelRef !== "string" || modelRef.length === 0)
  ) {
    issues.push(
      issue("model_fallbacks_invalid", "Program Manager model fallbacks must be non-empty refs."),
    );
  }
  if (value.thinkingDefault !== "low") {
    issues.push(issue("thinking_default_changed", "thinkingDefault must be low."));
  }
  const configuredAllowed = sorted(value.tools?.alsoAllow ?? []);
  if (JSON.stringify(configuredAllowed) !== JSON.stringify(sorted(ALLOWED_TOOLS))) {
    issues.push(
      issue(
        "tool_allowlist_changed",
        "Program Manager allowed tools must match the bounded allowlist.",
      ),
    );
  }
  const denied = new Set(value.tools?.deny ?? []);
  for (const tool of REQUIRED_DENIED_TOOLS) {
    if (!denied.has(tool)) {
      issues.push(issue("tool_deny_missing", `Program Manager must deny ${tool}.`, { tool }));
    }
  }
  if (value.tools?.exec?.security !== "deny" || value.tools?.exec?.ask !== "always") {
    issues.push(
      issue("execution_policy_changed", "Execution must remain denied and approval-gated."),
    );
  }
  if (value.tools?.fs?.workspaceOnly !== true || value.tools?.profile !== "minimal") {
    issues.push(
      issue(
        "filesystem_policy_changed",
        "Program Manager must use the minimal workspace-only profile.",
      ),
    );
  }
  if (value.subagents?.delegationMode !== "suggest" || value.subagents?.requireAgentId !== true) {
    issues.push(
      issue(
        "delegation_policy_changed",
        "Delegation must be suggest-only and require an explicit target.",
      ),
    );
  }
  if (
    JSON.stringify(sorted(value.subagents?.allowAgents ?? [])) !==
    JSON.stringify(["builder-agent", "research-brief-agent"])
  ) {
    issues.push(
      issue(
        "delegation_targets_changed",
        "Delegation targets must remain the two approved worker agents.",
      ),
    );
  }
  return issues;
}

export async function checkSource(sourceRoot = DEFAULT_SOURCE_ROOT) {
  const issues = [];
  let totalBootstrapBytes = 0;
  let largestBootstrapBytes = 0;
  for (const relativePath of MANAGED_FILES) {
    const filePath = path.join(sourceRoot, relativePath);
    if (!(await fileExists(filePath))) {
      issues.push(
        issue("managed_file_missing", `Managed file is missing: ${relativePath}.`, {
          file: relativePath,
        }),
      );
    }
  }
  for (const relativePath of BOOTSTRAP_FILES) {
    const filePath = path.join(sourceRoot, relativePath);
    const text = await readFileIfPresent(filePath);
    if (text === null) {
      continue;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    totalBootstrapBytes += bytes;
    largestBootstrapBytes = Math.max(largestBootstrapBytes, bytes);
    if (bytes > MAX_BOOTSTRAP_FILE_BYTES) {
      issues.push(
        issue("bootstrap_file_too_large", `${relativePath} exceeds its context budget.`, {
          file: relativePath,
          bytes,
        }),
      );
    }
    if (text.includes("control/state/") || text.includes("PROGRAM_MANAGER_STATUS")) {
      issues.push(
        issue(
          "external_state_reference",
          `${relativePath} references a retired external state surface.`,
          { file: relativePath },
        ),
      );
    }
  }
  if (totalBootstrapBytes > MAX_BOOTSTRAP_TOTAL_BYTES) {
    issues.push(
      issue("bootstrap_total_too_large", "Bootstrap files exceed the total context budget.", {
        bytes: totalBootstrapBytes,
      }),
    );
  }
  const statePath = path.join(sourceRoot, "state/program-manager.json");
  const stateText = await readFileIfPresent(statePath);
  if (stateText === null) {
    issues.push(issue("state_fixture_missing", "Program Manager state fixture is missing."));
  } else {
    const parsed = parseJson(stateText, "state/program-manager.json");
    if (parsed.parseError) {
      issues.push(issue("state_invalid_json", parsed.parseError));
    } else {
      issues.push(...validateState(parsed));
    }
  }
  const runtimePath = path.join(sourceRoot, "runtime-config.json");
  try {
    const runtimeResult = await checkRuntimeConfig(runtimePath);
    issues.push(...runtimeResult.issues);
  } catch (error) {
    issues.push(
      issue(
        "runtime_config_unreadable",
        `Unable to read runtime-config.json: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const contract = await readFileIfPresent(path.join(sourceRoot, "CONTRACT.md"));
  if (contract !== null) {
    for (const term of ["PLAN", "STATUS", "HANDOFF", "COMPLETION", "Unknown", "local model"]) {
      if (!contract.includes(term)) {
        issues.push(issue("contract_term_missing", `CONTRACT.md is missing ${term}.`, { term }));
      }
    }
  }
  const tools = await readFileIfPresent(path.join(sourceRoot, "workspace/TOOLS.md"));
  if (
    tools?.includes("Required output") ||
    tools?.includes("Milestones") ||
    tools?.includes("Acceptance Criteria")
  ) {
    issues.push(
      issue("tool_policy_duplication", "TOOLS.md must not repeat semantic output policy."),
    );
  }
  return {
    ok: issues.length === 0,
    issues,
    metrics: {
      managedFiles: MANAGED_FILES.length,
      bootstrapFiles: BOOTSTRAP_FILES.length,
      totalBootstrapBytes,
      largestBootstrapBytes,
      maxBootstrapFileBytes: MAX_BOOTSTRAP_FILE_BYTES,
      maxBootstrapTotalBytes: MAX_BOOTSTRAP_TOTAL_BYTES,
    },
  };
}

export async function checkRuntimeConfig(configPath) {
  let text;
  try {
    text = await fsp.readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, issues: [issue("config_missing", "Runtime config file is missing.")] };
    }
    throw error;
  }
  const config = parseJson(text, configPath);
  if (config.parseError) {
    return { ok: false, issues: [issue("config_invalid_json", config.parseError)] };
  }
  const canonicalIssues = await validateCanonicalConfig(configPath);
  if (canonicalIssues.length > 0) {
    return { ok: false, issues: canonicalIssues };
  }
  const registry = validateConfiguredAgentRegistry(config);
  const result = validateRuntimeEntry(registry.programManager);
  const issues = [...registry.issues, ...result];
  return { ok: issues.length === 0, issues };
}

function configIssues(config) {
  const registry = validateConfiguredAgentRegistry(config);
  return [...registry.issues, ...validateRuntimeEntry(registry.programManager)];
}

function replaceRuntimeFields(target, source) {
  for (const field of CONFIG_MANAGED_FIELDS) {
    target[field] = structuredClone(source[field]);
  }
}

async function writeTextAtomically(filePath, text, mode) {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.program-manager-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await fsp.writeFile(temporary, text, { encoding: "utf8", mode });
    await fsp.chmod(temporary, mode);
    await fsp.rename(temporary, filePath);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function prepareConfigBackup(configPath, backupRoot) {
  if (!configPath || !backupRoot) {
    throw new Error("config apply/rollback requires --config and --backup-dir");
  }
  await assertNoSymlinkPath(configPath, path.dirname(path.resolve(configPath)), "Config path");
  await assertRegularFile(configPath, "Config file");
  await assertNoSymlinkPath(
    backupRoot,
    path.dirname(path.resolve(backupRoot)),
    "Config backup root",
  );
  const backupRootInitiallyPresent = Boolean(await lstatIfPresent(backupRoot));
  await fsp.mkdir(backupRoot, { recursive: true });
  await assertNoSymlinkPath(
    backupRoot,
    path.dirname(path.resolve(backupRoot)),
    "Config backup root",
  );
  const backupFile = path.join(backupRoot, "config.before.json5");
  const restorePath = path.join(backupRoot, "restore.json");
  if ((await lstatIfPresent(backupFile)) || (await lstatIfPresent(restorePath))) {
    throw new Error("Config backup directory is already in use.");
  }
  await fsp.copyFile(configPath, backupFile);
  const stat = await fsp.stat(configPath);
  await fsp.writeFile(
    restorePath,
    `${JSON.stringify(
      {
        configPath: path.resolve(configPath),
        backupFile: "config.before.json5",
        mode: stat.mode & 0o777,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { backupRootInitiallyPresent, backupFile, restorePath, mode: stat.mode & 0o777 };
}

async function restoreConfigBackup({ configPath, backupRoot, restorePath }) {
  await assertNoSymlinkPath(configPath, path.dirname(path.resolve(configPath)), "Config path");
  await assertNoSymlinkPath(
    backupRoot,
    path.dirname(path.resolve(backupRoot)),
    "Config backup root",
  );
  await assertNoSymlinkPath(restorePath, backupRoot, "Config restore record");
  await assertRegularFile(restorePath, "Config restore record");
  const restore = JSON.parse(await fsp.readFile(restorePath, "utf8"));
  if (
    !isObject(restore) ||
    restore.configPath !== path.resolve(configPath) ||
    restore.backupFile !== "config.before.json5" ||
    typeof restore.mode !== "number"
  ) {
    throw new Error("Config restore record is invalid.");
  }
  const backupFile = path.join(backupRoot, restore.backupFile);
  await assertNoSymlinkPath(backupFile, backupRoot, "Config backup file");
  await assertRegularFile(backupFile, "Config backup file");
  const backupText = await fsp.readFile(backupFile, "utf8");
  if (parseJson(backupText, backupFile).parseError) {
    throw new Error("Config backup file is not valid JSON5.");
  }
  await writeTextAtomically(configPath, backupText, restore.mode);
  return { ok: true, restoredConfig: path.resolve(configPath), backupRoot };
}

export async function applyRuntimeConfig({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  configPath,
  backupRoot,
}) {
  const sourceCheck = await checkSource(sourceRoot);
  if (!sourceCheck.ok) {
    throw new Error(`Source check failed: ${JSON.stringify(sourceCheck.issues)}`);
  }
  const sourceText = await fsp.readFile(path.join(sourceRoot, "runtime-config.json"), "utf8");
  const sourceConfig = parseJson(sourceText, "runtime-config.json");
  if (sourceConfig.parseError) {
    throw new Error(sourceConfig.parseError);
  }
  const sourceEntry = configuredAgentEntry(sourceConfig, "program-manager");
  if (!isObject(sourceEntry)) {
    throw new Error("Source runtime config has no Program Manager entry.");
  }

  const originalText = await fsp.readFile(configPath, "utf8");
  const config = parseJson(originalText, configPath);
  if (config.parseError) {
    throw new Error(config.parseError);
  }
  const beforeIssues = configIssues(config);
  if (
    beforeIssues.some(
      (entry) =>
        entry.code === "agent_registry_missing" ||
        entry.code === "agent_missing" ||
        entry.code === "delegation_target_unconfigured",
    )
  ) {
    throw new Error(`Active config registry check failed: ${JSON.stringify(beforeIssues)}`);
  }
  const target = configuredAgentEntry(config, "program-manager");
  if (!isObject(target)) {
    throw new Error("Active config has no Program Manager entry.");
  }
  const backup = await prepareConfigBackup(configPath, backupRoot);
  try {
    replaceRuntimeFields(target, sourceEntry);
    const updatedText = `${JSON.stringify(config, null, 2)}\n`;
    await writeTextAtomically(configPath, updatedText, backup.mode);
    const updated = parseJson(await fsp.readFile(configPath, "utf8"), configPath);
    if (updated.parseError) {
      throw new Error(updated.parseError);
    }
    const issues = configIssues(updated);
    if (issues.length > 0) {
      throw new Error(`Updated config contract check failed: ${JSON.stringify(issues)}`);
    }
    return {
      ok: true,
      configPath: path.resolve(configPath),
      backupRoot,
      managedFields: CONFIG_MANAGED_FIELDS,
    };
  } catch (error) {
    try {
      await restoreConfigBackup({ configPath, backupRoot, restorePath: backup.restorePath });
      if (!backup.backupRootInitiallyPresent) {
        await fsp.rm(backupRoot, { recursive: true, force: true });
      }
    } catch (rollbackError) {
      throw new Error(
        `Config apply failed and automatic rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

export async function rollbackRuntimeConfig({ configPath, backupRoot }) {
  const restorePath = path.join(backupRoot, "restore.json");
  return restoreConfigBackup({ configPath, backupRoot, restorePath });
}

async function prepareDestination(destination, workspaceRoot, label) {
  await assertNoSymlinkPath(destination, workspaceRoot, label);
  const stat = await lstatIfPresent(destination);
  if (stat?.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink.`);
  }
  if (stat && !stat.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  return Boolean(stat);
}

async function restoreWorkspaceEntries({ workspaceRoot, backupRoot, files }) {
  const allowed = new Set(MANAGED_FILES.map(workspaceRelativePath));
  for (const entry of files.toReversed()) {
    if (
      !isObject(entry) ||
      typeof entry.relativePath !== "string" ||
      !allowed.has(entry.relativePath)
    ) {
      throw new Error("Backup restore record contains an unexpected managed path.");
    }
    const destination = destinationFor(workspaceRoot, entry.relativePath);
    await prepareDestination(
      destination,
      workspaceRoot,
      `Workspace destination ${entry.relativePath}`,
    );
    if (entry.existed === true) {
      const backup = path.join(backupRoot, "files", entry.relativePath);
      await assertNoSymlinkPath(backup, backupRoot, `Backup file ${entry.relativePath}`);
      await assertRegularFile(backup, `Backup file ${entry.relativePath}`);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.copyFile(backup, destination);
    } else if (entry.existed === false) {
      if (await fileExists(destination)) {
        await fsp.unlink(destination);
      }
    } else {
      throw new Error("Backup restore record contains an invalid existed flag.");
    }
  }
}

export async function verifyInstalledWorkspace({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  workspaceRoot,
}) {
  if (!workspaceRoot) {
    throw new Error("verify-install requires --workspace");
  }
  const issues = [];
  for (const relativePath of MANAGED_FILES) {
    const destinationRelativePath = workspaceRelativePath(relativePath);
    const destination = destinationFor(workspaceRoot, destinationRelativePath);
    try {
      await prepareDestination(
        destination,
        workspaceRoot,
        `Workspace destination ${destinationRelativePath}`,
      );
    } catch (error) {
      issues.push(
        issue(
          "installed_destination_invalid",
          error instanceof Error ? error.message : String(error),
          {
            file: destinationRelativePath,
          },
        ),
      );
      continue;
    }
    const sourceText = await readFileIfPresent(path.join(sourceRoot, relativePath));
    const destinationText = await readFileIfPresent(destination);
    if (sourceText === null || destinationText === null) {
      issues.push(
        issue(
          "installed_file_missing",
          `Installed managed file is missing: ${destinationRelativePath}.`,
          {
            file: destinationRelativePath,
          },
        ),
      );
    } else if (sourceText !== destinationText) {
      issues.push(
        issue(
          "installed_file_mismatch",
          `Installed managed file differs from source: ${destinationRelativePath}.`,
          {
            file: destinationRelativePath,
          },
        ),
      );
    }
  }
  return { ok: issues.length === 0, issues, managedFiles: MANAGED_FILES.length };
}

export async function installWorkspace({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  workspaceRoot,
  backupRoot,
}) {
  if (!workspaceRoot || !backupRoot) {
    throw new Error("install requires --workspace and --backup-dir");
  }
  const sourceCheck = await checkSource(sourceRoot);
  if (!sourceCheck.ok) {
    throw new Error(`Source check failed: ${JSON.stringify(sourceCheck.issues)}`);
  }
  await assertNoSymlinkPath(backupRoot, path.dirname(path.resolve(backupRoot)), "Backup root");
  const restorePath = path.join(backupRoot, "restore.json");
  const existingRestore = await lstatIfPresent(restorePath);
  if (existingRestore) {
    throw new Error("Backup directory is already in use.");
  }
  const backupRootInitiallyPresent = Boolean(await lstatIfPresent(backupRoot));
  await fsp.mkdir(path.join(backupRoot, "files"), { recursive: true });
  await assertNoSymlinkPath(path.join(backupRoot, "files"), backupRoot, "Backup files root");
  const restore = { files: [] };
  try {
    for (const relativePath of MANAGED_FILES) {
      const destinationRelativePath = workspaceRelativePath(relativePath);
      const destination = destinationFor(workspaceRoot, destinationRelativePath);
      const source = path.join(sourceRoot, relativePath);
      await assertRegularFile(source, `Source file ${relativePath}`);
      const existed = await prepareDestination(
        destination,
        workspaceRoot,
        `Workspace destination ${destinationRelativePath}`,
      );
      if (existed) {
        const backup = path.join(backupRoot, "files", destinationRelativePath);
        await assertNoSymlinkPath(backup, backupRoot, `Backup file ${destinationRelativePath}`);
        await fsp.mkdir(path.dirname(backup), { recursive: true });
        await fsp.copyFile(destination, backup);
      }
      restore.files.push({ relativePath: destinationRelativePath, existed });
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.copyFile(source, destination);
    }

    const verification = await verifyInstalledWorkspace({ sourceRoot, workspaceRoot });
    if (!verification.ok) {
      throw new Error(`Install verification failed: ${JSON.stringify(verification.issues)}`);
    }
    await fsp.writeFile(restorePath, `${JSON.stringify(restore, null, 2)}\n`, "utf8");
    return { ok: true, managedFiles: MANAGED_FILES.length, backupRoot };
  } catch (error) {
    try {
      await restoreWorkspaceEntries({ workspaceRoot, backupRoot, files: restore.files });
      if (!backupRootInitiallyPresent) {
        await fsp.rm(backupRoot, { recursive: true, force: true });
      }
    } catch (rollbackError) {
      throw new Error(
        `Install failed and automatic rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

export async function rollbackWorkspace({ workspaceRoot, backupRoot }) {
  if (!workspaceRoot || !backupRoot) {
    throw new Error("rollback requires --workspace and --backup-dir");
  }
  await assertNoSymlinkPath(backupRoot, path.dirname(path.resolve(backupRoot)), "Backup root");
  const restorePath = path.join(backupRoot, "restore.json");
  await assertNoSymlinkPath(restorePath, backupRoot, "Restore record");
  await assertRegularFile(restorePath, "Restore record");
  const restoreText = await fsp.readFile(restorePath, "utf8");
  const restore = JSON.parse(restoreText);
  if (!Array.isArray(restore.files)) {
    throw new Error("Backup restore record is invalid.");
  }
  await restoreWorkspaceEntries({ workspaceRoot, backupRoot, files: restore.files });
  return { ok: true, restoredFiles: restore.files.length };
}

function parseArgs(argv) {
  const args = { command: "check", sourceRoot: DEFAULT_SOURCE_ROOT, json: false };
  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    args.command = argv[index++];
  }
  while (index < argv.length) {
    const arg = argv[index++];
    if (arg === "--source") {
      args.sourceRoot = argv[index++];
    } else if (arg === "--workspace") {
      args.workspaceRoot = argv[index++];
    } else if (arg === "--backup-dir") {
      args.backupRoot = argv[index++];
    } else if (arg === "--config") {
      args.configPath = argv[index++];
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Program Manager workspace: ${result.ok ? "passed" : "failed"}`);
  if (result.metrics) {
    console.log(
      `Bootstrap bytes: ${result.metrics.totalBootstrapBytes}/${result.metrics.maxBootstrapTotalBytes}`,
    );
  }
  for (const entry of result.issues ?? []) {
    console.log(`- ${entry.code}: ${entry.message}`);
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Usage: node scripts/program-manager-workspace.mjs [check|check-config|apply-config|rollback-config|install|verify-install|rollback] [options]",
    );
    return;
  }
  let result;
  if (args.command === "check") {
    result = await checkSource(args.sourceRoot);
  } else if (args.command === "check-config") {
    if (!args.configPath) {
      throw new Error("check-config requires --config");
    }
    result = await checkRuntimeConfig(args.configPath);
  } else if (args.command === "apply-config") {
    result = await applyRuntimeConfig({
      sourceRoot: args.sourceRoot,
      configPath: args.configPath,
      backupRoot: args.backupRoot,
    });
  } else if (args.command === "rollback-config") {
    result = await rollbackRuntimeConfig({
      configPath: args.configPath,
      backupRoot: args.backupRoot,
    });
  } else if (args.command === "install") {
    result = await installWorkspace({
      sourceRoot: args.sourceRoot,
      workspaceRoot: args.workspaceRoot,
      backupRoot: args.backupRoot,
    });
  } else if (args.command === "verify-install") {
    result = await verifyInstalledWorkspace({
      sourceRoot: args.sourceRoot,
      workspaceRoot: args.workspaceRoot,
    });
  } else if (args.command === "rollback") {
    result = await rollbackWorkspace({
      workspaceRoot: args.workspaceRoot,
      backupRoot: args.backupRoot,
    });
  } else {
    throw new Error(`Unknown command: ${args.command}`);
  }
  printResult(result, args.json);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function handleMainError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(handleMainError);
}
