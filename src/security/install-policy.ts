// Checks install policy constraints for package and plugin operations.
import fs from "node:fs/promises";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig, SecurityConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { normalizePositiveInt, normalizePositiveTimerMs } from "../secrets/shared.js";
import { resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { inspectPathPermissions, safeStat } from "./audit-fs.js";
import { isPathInside } from "./scan-paths.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const MAX_REASON_CHARS = 1000;
const MAX_FINDINGS = 100;
const MAX_FINDING_TEXT_CHARS = 1000;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
const POLICY_INTERPRETER_NAMES = new Set([
  "bash",
  "bun",
  "deno",
  "env",
  "fish",
  "node",
  "perl",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "ruby",
  "sh",
  "zsh",
]);
const POLICY_SCRIPT_ARG_PATTERN = /\.(?:bash|cjs|cts|js|mjs|mts|pl|ps1|py|rb|sh|ts|zsh)$/i;

type InstallPolicyTarget = "skill" | "plugin";
export type InstallPolicyRequestKind =
  | "skill-install"
  | "plugin-dir"
  | "plugin-archive"
  | "plugin-file"
  | "plugin-npm"
  | "plugin-git";

export type InstallPolicyOrigin = {
  type: string;
  [key: string]: string | number | boolean | null | undefined;
};

export type InstallPolicySource = {
  kind:
    | "archive"
    | "bundled"
    | "clawhub"
    | "file"
    | "git"
    | "local-path"
    | "managed"
    | "npm"
    | "upload"
    | "workspace";
  authority: "openclaw" | "official" | "third-party" | "unknown" | "user";
  mutable: boolean;
  network: boolean;
};

export type InstallPolicyFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
};

type InstallPolicyRequest = {
  targetType: InstallPolicyTarget;
  targetName: string;
  sourcePath: string;
  sourcePathKind: "file" | "directory";
  source?: InstallPolicySource;
  origin: InstallPolicyOrigin;
  request: {
    kind: InstallPolicyRequestKind;
    mode: "install" | "update";
    requestedSpecifier?: string;
  };
  skill?: {
    installId: string;
    installSpec?: {
      id?: string;
      kind: "brew" | "node" | "go" | "uv" | "download";
      label?: string;
      bins?: string[];
      os?: string[];
      formula?: string;
      package?: string;
      module?: string;
      url?: string;
      archive?: string;
      extract?: boolean;
      stripComponents?: number;
      targetDir?: string;
    };
  };
  plugin?: {
    pluginId: string;
    contentType: "bundle" | "package" | "file" | "dependency-tree";
    packageName?: string;
    manifestId?: string;
    version?: string;
    extensions?: string[];
  };
};

type InstallPolicyResult =
  | { blocked?: undefined; findings?: InstallPolicyFinding[] }
  | {
      blocked: {
        code: "security_scan_blocked" | "security_scan_failed";
        reason: string;
      };
      findings?: InstallPolicyFinding[];
    };

type InstallPolicyExecConfig = NonNullable<NonNullable<SecurityConfig["installPolicy"]>["exec"]>;

type InstallPolicyValidationIssue = {
  severity: "error" | "warning";
  message: string;
};

export type InstallPolicyStaticValidation = {
  enabled: boolean;
  targets: InstallPolicyTarget[];
  issues: InstallPolicyValidationIssue[];
};

function isAbsolutePathname(value: string): boolean {
  if (path.isAbsolute(value)) {
    return true;
  }
  return (
    process.platform === "win32" &&
    (WINDOWS_ABS_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value))
  );
}

function executableName(commandPath: string): string {
  return path
    .basename(commandPath)
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function isPolicyScriptArg(value: string): boolean {
  return (
    isAbsolutePathname(value) ||
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\") ||
    POLICY_SCRIPT_ARG_PATTERN.test(value)
  );
}

function resolvePolicyScriptArg(params: {
  command: string;
  args: string[];
}):
  | { kind: "scripts"; scripts: Array<{ index: number; path: string }> }
  | { kind: "unsupported"; message: string }
  | undefined {
  const interpreterName = executableName(params.command);
  const startIndex = 0;
  if (interpreterName === "env") {
    return {
      kind: "unsupported",
      message:
        "security.installPolicy.exec.command must not use env; configure the policy executable directly.",
    };
  }
  if (!POLICY_INTERPRETER_NAMES.has(interpreterName) || interpreterName === "env") {
    return undefined;
  }
  const scripts: Array<{ index: number; path: string }> = [];
  for (let index = startIndex; index < params.args.length; index += 1) {
    const arg = params.args[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith("-")) {
      const equalsIndex = arg.indexOf("=");
      if (equalsIndex > 0) {
        const optionValue = arg.slice(equalsIndex + 1);
        if (isPolicyScriptArg(optionValue)) {
          scripts.push({ index, path: optionValue });
        }
      }
      continue;
    }
    if (isPolicyScriptArg(arg)) {
      scripts.push({ index, path: arg });
    }
  }
  return scripts.length > 0 ? { kind: "scripts", scripts } : undefined;
}

async function readFileStatOrThrow(pathname: string, label: string) {
  const stat = await safeStat(pathname);
  if (!stat.ok) {
    throw new Error(`${label} is not readable: ${pathname}`);
  }
  if (stat.isDir) {
    throw new Error(`${label} must be a file: ${pathname}`);
  }
  return stat;
}

function collectPathAncestorDirs(targetPath: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(path.dirname(targetPath));
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
}

async function assertSecureCommandAncestorDirs(params: {
  targetPath: string;
  label: string;
}): Promise<void> {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  for (const dir of collectPathAncestorDirs(params.targetPath)) {
    const perms = await inspectPathPermissions(dir);
    if (!perms.ok) {
      throw new Error(`${params.label} parent directory permissions could not be verified: ${dir}`);
    }
    let sticky = false;
    if (process.platform !== "win32" && (perms.worldWritable || perms.groupWritable)) {
      try {
        sticky = ((await fs.stat(dir)).mode & 0o1000) !== 0;
      } catch {
        sticky = false;
      }
    }
    if ((perms.worldWritable || perms.groupWritable) && !sticky) {
      throw new Error(`${params.label} parent directory permissions are too open: ${dir}`);
    }
    if (process.platform !== "win32" && currentUid !== undefined) {
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(dir);
      } catch {
        throw new Error(`${params.label} parent directory ownership could not be verified: ${dir}`);
      }
      if (stat.uid !== 0 && stat.uid !== currentUid) {
        throw new Error(`${params.label} parent directory owner is not trusted: ${dir}`);
      }
    }
    if (process.platform === "win32" && perms.source === "unknown") {
      throw new Error(
        `${params.label} parent directory ACL verification unavailable on Windows for ${dir}. Set allowInsecurePath=true for this policy to bypass this check when the path is trusted.`,
      );
    }
  }
}

async function assertSecureCommandPath(params: {
  targetPath: string;
  label: string;
  trustedDirs?: string[];
  allowInsecurePath?: boolean;
  allowSymlinkPath?: boolean;
}): Promise<string> {
  if (!isAbsolutePathname(params.targetPath)) {
    throw new Error(`${params.label} must be an absolute path.`);
  }

  let effectivePath = params.targetPath;
  let stat = await readFileStatOrThrow(effectivePath, params.label);
  if (stat.isSymlink) {
    if (!params.allowSymlinkPath) {
      throw new Error(`${params.label} must not be a symlink: ${effectivePath}`);
    }
    try {
      effectivePath = await fs.realpath(effectivePath);
    } catch {
      throw new Error(`${params.label} symlink target is not readable: ${params.targetPath}`);
    }
    if (!isAbsolutePathname(effectivePath)) {
      throw new Error(`${params.label} resolved symlink target must be an absolute path.`);
    }
    stat = await readFileStatOrThrow(effectivePath, params.label);
    if (stat.isSymlink) {
      throw new Error(`${params.label} symlink target must not be a symlink: ${effectivePath}`);
    }
  }

  if (params.trustedDirs && params.trustedDirs.length > 0) {
    const trusted = params.trustedDirs.map((entry) => resolveUserPath(entry));
    const inTrustedDir = trusted.some((dir) => isPathInside(dir, effectivePath));
    if (!inTrustedDir) {
      throw new Error(`${params.label} is outside trustedDirs: ${effectivePath}`);
    }
  }
  if (params.allowInsecurePath) {
    return effectivePath;
  }

  const perms = await inspectPathPermissions(effectivePath);
  if (!perms.ok) {
    throw new Error(`${params.label} permissions could not be verified: ${effectivePath}`);
  }
  if (perms.worldWritable || perms.groupWritable) {
    throw new Error(`${params.label} permissions are too open: ${effectivePath}`);
  }
  await assertSecureCommandAncestorDirs({ targetPath: effectivePath, label: params.label });

  if (process.platform === "win32" && perms.source === "unknown") {
    throw new Error(
      `${params.label} ACL verification unavailable on Windows for ${effectivePath}. Set allowInsecurePath=true for this policy to bypass this check when the path is trusted.`,
    );
  }

  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid != null) {
    const uid = process.getuid();
    if (stat.uid !== uid && stat.uid !== 0) {
      throw new Error(
        `${params.label} must be owned by the current user (uid=${uid}) or root: ${effectivePath}`,
      );
    }
  }
  return effectivePath;
}

async function assertSecurePolicyScriptArg(params: {
  command: string;
  args: string[];
  trustedDirs?: string[];
  allowInsecurePath?: boolean;
  allowSymlinkPath?: boolean;
}): Promise<void> {
  const scriptArg = resolvePolicyScriptArg({ command: params.command, args: params.args });
  if (!scriptArg) {
    return;
  }
  if (scriptArg.kind === "unsupported") {
    throw new Error(scriptArg.message);
  }
  for (const script of scriptArg.scripts) {
    await assertSecureCommandPath({
      targetPath: script.path,
      label: `security.installPolicy.exec.args[${script.index}]`,
      trustedDirs: params.trustedDirs,
      allowInsecurePath: params.allowInsecurePath,
      allowSymlinkPath: false,
    });
  }
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${truncateUtf16Safe(value, maxChars)}...`;
}

function createPolicyChildEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  void sourceEnv;
  return {};
}

function readPassEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = env[key];
  if (exact !== undefined || process.platform !== "win32") {
    return exact;
  }
  const lowerKey = key.toLowerCase();
  const matchedKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
  return matchedKey ? env[matchedKey] : undefined;
}

function blockedByFailure(message: string): InstallPolicyResult {
  return {
    blocked: {
      code: "security_scan_failed",
      reason: `install policy failed closed: ${truncateText(message, MAX_REASON_CHARS)}`,
    },
  };
}

function blockedByPolicy(reason: string, findings?: InstallPolicyFinding[]): InstallPolicyResult {
  return {
    blocked: {
      code: "security_scan_blocked",
      reason: `blocked by install policy: ${truncateText(reason, MAX_REASON_CHARS)}`,
    },
    ...(findings && findings.length > 0 ? { findings } : {}),
  };
}

function isTargetEnabled(params: {
  policy: NonNullable<SecurityConfig["installPolicy"]>;
  targetType: InstallPolicyTarget;
}): boolean {
  const targets = params.policy.targets;
  if (!targets || targets.length === 0) {
    return true;
  }
  return targets.includes(params.targetType);
}

function resolvePolicy(
  config: OpenClawConfig | undefined,
  targetType: InstallPolicyTarget,
):
  | { kind: "disabled" }
  | { kind: "configured"; exec: InstallPolicyExecConfig }
  | { kind: "failure"; result: InstallPolicyResult } {
  const policy = config?.security?.installPolicy;
  if (!policy || policy.enabled !== true) {
    return { kind: "disabled" };
  }
  if (!isTargetEnabled({ policy, targetType })) {
    return { kind: "disabled" };
  }
  if (!policy.exec) {
    return {
      kind: "failure",
      result: blockedByFailure(
        "security.installPolicy is enabled but security.installPolicy.exec is not configured",
      ),
    };
  }
  return { kind: "configured", exec: policy.exec };
}

function resolveConfiguredTargets(
  policy: NonNullable<SecurityConfig["installPolicy"]>,
): InstallPolicyTarget[] {
  const targets = policy.targets;
  return targets && targets.length > 0 ? [...new Set(targets)] : ["skill", "plugin"];
}

export async function validateInstallPolicyStatic(
  config: OpenClawConfig | undefined,
): Promise<InstallPolicyStaticValidation> {
  const policy = config?.security?.installPolicy;
  if (!policy || policy.enabled !== true) {
    return { enabled: false, targets: [], issues: [] };
  }
  const targets = resolveConfiguredTargets(policy);
  const issues: InstallPolicyValidationIssue[] = [];
  if (!policy.exec) {
    issues.push({
      severity: "error",
      message:
        "security.installPolicy is enabled but security.installPolicy.exec is not configured.",
    });
    return { enabled: true, targets, issues };
  }
  if (!isAbsolutePathname(policy.exec.command)) {
    issues.push({
      severity: "error",
      message: "security.installPolicy.exec.command must be an absolute path.",
    });
    return { enabled: true, targets, issues };
  }
  try {
    await assertSecureCommandPath({
      targetPath: policy.exec.command,
      label: "security.installPolicy.exec.command",
      trustedDirs: policy.exec.trustedDirs,
      allowSymlinkPath: false,
    });
  } catch (err) {
    issues.push({
      severity: "error",
      message: formatErrorMessage(err),
    });
  }
  try {
    await assertSecurePolicyScriptArg({
      command: policy.exec.command,
      args: policy.exec.args ?? [],
      trustedDirs: policy.exec.trustedDirs,
      allowSymlinkPath: false,
    });
  } catch (err) {
    issues.push({
      severity: "error",
      message: formatErrorMessage(err),
    });
  }
  return { enabled: true, targets, issues };
}

function normalizeFinding(value: unknown): InstallPolicyFinding | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const ruleId = typeof record.ruleId === "string" ? record.ruleId.trim() : "";
  const severity = record.severity;
  const file = typeof record.file === "string" ? record.file.trim() : "";
  const lineNumber =
    typeof record.line === "number" && Number.isFinite(record.line)
      ? Math.max(1, Math.floor(record.line))
      : undefined;
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (
    !ruleId ||
    !message ||
    (severity !== "info" && severity !== "warn" && severity !== "critical")
  ) {
    return null;
  }
  const evidence = typeof record.evidence === "string" ? record.evidence.trim() : "";
  return {
    ruleId: truncateText(ruleId, MAX_FINDING_TEXT_CHARS),
    severity,
    message: truncateText(message, MAX_FINDING_TEXT_CHARS),
    ...(file ? { file: truncateText(file, MAX_FINDING_TEXT_CHARS) } : {}),
    ...(lineNumber ? { line: lineNumber } : {}),
    ...(evidence ? { evidence: truncateText(evidence, MAX_FINDING_TEXT_CHARS) } : {}),
  };
}

function parsePolicyResponse(stdout: string): InstallPolicyResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return blockedByFailure("policy command returned empty stdout");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (err) {
    return blockedByFailure(`policy command returned invalid JSON (${formatErrorMessage(err)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return blockedByFailure("policy response must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.protocolVersion !== 1) {
    return blockedByFailure("policy response protocolVersion must be 1");
  }
  const decision = record.decision;
  if (decision !== "allow" && decision !== "block") {
    return blockedByFailure('policy response decision must be "allow" or "block"');
  }
  const findings = Array.isArray(record.findings)
    ? record.findings.slice(0, MAX_FINDINGS).map(normalizeFinding).filter(Boolean)
    : [];
  const normalizedFindings = findings as InstallPolicyFinding[];
  if (decision === "allow") {
    return normalizedFindings.length > 0 ? { findings: normalizedFindings } : {};
  }
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (!reason) {
    return blockedByFailure('policy response decision "block" requires a non-empty reason');
  }
  return blockedByPolicy(reason, normalizedFindings);
}

export async function runInstallPolicy(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  request: InstallPolicyRequest;
}): Promise<InstallPolicyResult | undefined> {
  const decisionContext = formatDecisionContext(params.request);
  const logBlocked = (result: InstallPolicyResult): InstallPolicyResult => {
    if (result.blocked) {
      params.logger?.warn?.(`Install policy ${decisionContext}: ${result.blocked.reason}`);
    }
    return result;
  };
  const failClosed = (message: string): InstallPolicyResult =>
    logBlocked(blockedByFailure(message));

  let config = params.config;
  if (!config) {
    try {
      const { getRuntimeConfig } = await import("../config/io.js");
      config = getRuntimeConfig({ skipPluginValidation: true });
    } catch (err) {
      return failClosed(`could not load OpenClaw config (${formatErrorMessage(err)})`);
    }
  }

  const policy = resolvePolicy(config, params.request.targetType);
  if (policy.kind === "disabled") {
    return undefined;
  }
  if (policy.kind === "failure") {
    return logBlocked(policy.result);
  }

  const input = JSON.stringify({
    protocolVersion: 1,
    openclawVersion: resolveRuntimeServiceVersion(params.env ?? process.env),
    ...params.request,
  });
  if (Buffer.byteLength(input, "utf8") > DEFAULT_MAX_REQUEST_BYTES) {
    return failClosed(`policy request exceeded maxInputBytes (${DEFAULT_MAX_REQUEST_BYTES})`);
  }

  const commandPath = policy.exec.command;
  if (!isAbsolutePathname(commandPath)) {
    return failClosed("security.installPolicy.exec.command must be an absolute path.");
  }
  let secureCommandPath: string;
  try {
    secureCommandPath = await assertSecureCommandPath({
      targetPath: commandPath,
      label: "security.installPolicy.exec.command",
      trustedDirs: policy.exec.trustedDirs,
      allowSymlinkPath: false,
    });
  } catch (err) {
    return failClosed(formatErrorMessage(err));
  }
  try {
    await assertSecurePolicyScriptArg({
      command: secureCommandPath,
      args: policy.exec.args ?? [],
      trustedDirs: policy.exec.trustedDirs,
      allowSymlinkPath: false,
    });
  } catch (err) {
    return failClosed(formatErrorMessage(err));
  }

  const env = params.env ?? process.env;
  const childEnv = createPolicyChildEnv(env);
  for (const key of policy.exec.passEnv ?? []) {
    const value = readPassEnvValue(env, key);
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(policy.exec.env ?? {})) {
    childEnv[key] = value;
  }

  const timeoutMs = normalizePositiveTimerMs(policy.exec.timeoutMs, DEFAULT_TIMEOUT_MS);
  const noOutputTimeoutMs = normalizePositiveTimerMs(policy.exec.noOutputTimeoutMs, timeoutMs);
  const maxOutputBytes = normalizePositiveInt(policy.exec.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const cwd = path.dirname(secureCommandPath);
  let result: Awaited<ReturnType<typeof runCommandWithTimeout>>;
  try {
    result = await runCommandWithTimeout([secureCommandPath, ...(policy.exec.args ?? [])], {
      baseEnv: {},
      cwd,
      env: childEnv,
      input,
      killProcessTree: true,
      maxCombinedOutputBytes: maxOutputBytes,
      maxOutputBytes,
      noOutputTimeoutMs,
      outputCapture: "head",
      terminateOnOutputLimit: true,
      timeoutMs,
    });
  } catch (err) {
    return failClosed(formatErrorMessage(err));
  }
  if (result.termination === "timeout") {
    return failClosed(`policy command timed out after ${timeoutMs}ms`);
  }
  if (result.termination === "no-output-timeout") {
    return failClosed(`policy command produced no output for ${noOutputTimeoutMs}ms`);
  }
  if (result.outputLimitExceeded) {
    return failClosed(`output exceeded maxOutputBytes (${maxOutputBytes})`);
  }
  if (result.code !== 0) {
    return failClosed(`policy command exited with code ${String(result.code)}`);
  }

  const parsed = parsePolicyResponse(result.stdout);
  if (parsed.blocked) {
    return logBlocked(parsed);
  }
  params.logger?.debug?.(`Install policy ${decisionContext}: allowed`);
  return parsed;
}

function formatDecisionContext(request: InstallPolicyRequest): string {
  const source = request.source ? ` source=${request.source.kind}/${request.source.authority}` : "";
  const origin = typeof request.origin.type === "string" ? request.origin.type : "unknown";
  return [
    `target=${request.targetType}:${request.targetName}`,
    `request=${request.request.kind}/${request.request.mode}`,
    `origin=${origin}`,
    `pathKind=${request.sourcePathKind}`,
    source.trim(),
  ]
    .filter(Boolean)
    .join(" ");
}

export async function probeInstallPolicy(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  sourcePath: string;
}): Promise<InstallPolicyResult | undefined> {
  const validation = await validateInstallPolicyStatic(params.config);
  if (!validation.enabled || validation.issues.some((issue) => issue.severity === "error")) {
    return undefined;
  }
  const targetType = validation.targets.includes("skill") ? "skill" : validation.targets[0];
  if (!targetType) {
    return undefined;
  }
  return await runInstallPolicy({
    config: params.config,
    env: params.env,
    logger: params.logger,
    request: {
      targetType,
      targetName: "doctor-install-policy-probe",
      sourcePath: params.sourcePath,
      sourcePathKind: "directory",
      origin: { type: "doctor" },
      request: {
        kind: targetType === "skill" ? "skill-install" : "plugin-dir",
        mode: "install",
        requestedSpecifier: "doctor:install-policy-probe",
      },
    },
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
