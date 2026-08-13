import { spawn } from "node:child_process";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  evaluateShellAllowlistWithAuthorization,
  resolveExecApprovalsLocked,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { evaluateSystemRunPolicy } from "../node-host/exec-policy.js";
import { createCronRunDiagnosticsFromError } from "./run-diagnostics.js";
import type { CronJobPrecheck } from "./types-shared.js";
import type { CronRunDiagnostics, CronRunOutcome } from "./types.js";

/** Default shell for precheck command strings. */
const IS_WINDOWS = process.platform === "win32";

function resolveShellCommand(command: string): { shell: string; args: string[] } {
  if (IS_WINDOWS) {
    const shell = process.env.ComSpec?.trim() || "cmd.exe";
    return { shell, args: ["/d", "/s", "/c", command] };
  }
  const shell = process.env.SHELL?.trim() || "/bin/sh";
  return { shell, args: ["-c", command] };
}

/** Stable skip / error reason codes for run logs and operators. */
export const PRECHECK_NO_WORK_REASON = "precheck-no-work";
export const PRECHECK_POLICY_DENIED_REASON = "precheck-policy-denied";
const PRECHECK_ERROR_REASON = "precheck-error";
const PRECHECK_TIMEOUT_REASON = "precheck-timeout";
const PRECHECK_INVALID_REASON = "precheck-invalid";
const PRECHECK_TRIGGERS_DISABLED =
  "cron precheck is a host-shell command and is disabled; set cron.triggers.enabled=true to allow unattended precheck scripts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_CAPTURE_CHARS = 4_000;

/** Result of evaluating a cron job precheck gate (no model involved). */
type CronJobPrecheckResult =
  | { decision: "run"; exitCode: number | null; stdout: string; stderr: string }
  | {
      decision: "skip";
      reason: typeof PRECHECK_NO_WORK_REASON;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }
  | {
      decision: "error";
      reason: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    };

function clip(text: string, max = MAX_CAPTURE_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

function resolveTimeoutMs(precheck: CronJobPrecheck): number {
  const raw = precheck.timeoutMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Parse a finish/line-oriented precheck protocol from command output.
 * Prefer exit codes when contract is exit-code; begin-line prefixes always win when present.
 */
export function interpretPrecheckOutput(params: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  contract?: CronJobPrecheck["contract"];
  workExitCodes?: number[];
  noWorkExitCodes?: number[];
  workStdoutPrefix?: string;
  noWorkStdoutPrefix?: string;
  onError?: CronJobPrecheck["onError"];
}): CronJobPrecheckResult {
  const stdout = params.stdout ?? "";
  const stderr = params.stderr ?? "";
  const head = stdout.trimStart();
  const workPrefix = params.workStdoutPrefix ?? "WORK_NEEDED";
  const noWorkPrefix = params.noWorkStdoutPrefix ?? "NO_WORK";

  if (head.startsWith(noWorkPrefix)) {
    return {
      decision: "skip",
      reason: PRECHECK_NO_WORK_REASON,
      exitCode: params.exitCode,
      stdout,
      stderr,
    };
  }
  if (head.startsWith(workPrefix)) {
    return { decision: "run", exitCode: params.exitCode, stdout, stderr };
  }

  const contract = params.contract ?? "exit-code";
  const workCodes = params.workExitCodes?.length ? params.workExitCodes : [0];
  const noWorkCodes = params.noWorkExitCodes?.length ? params.noWorkExitCodes : [2];
  const code = params.exitCode ?? 1;

  if (contract === "stdout-prefix") {
    // No recognized prefix — treat as error unless exit 0 and empty = no work.
    if (code === 0 && !stdout.trim()) {
      return {
        decision: "skip",
        reason: PRECHECK_NO_WORK_REASON,
        exitCode: code,
        stdout,
        stderr,
      };
    }
    return {
      decision: "error",
      reason: `${PRECHECK_ERROR_REASON}: stdout did not start with ${workPrefix} or ${noWorkPrefix}`,
      exitCode: code,
      stdout,
      stderr,
    };
  }

  // exit-code (default) or dual when no prefix matched
  if (noWorkCodes.includes(code)) {
    return {
      decision: "skip",
      reason: PRECHECK_NO_WORK_REASON,
      exitCode: code,
      stdout,
      stderr,
    };
  }
  if (workCodes.includes(code)) {
    return { decision: "run", exitCode: code, stdout, stderr };
  }

  const onError = params.onError ?? "fail";
  if (onError === "skip") {
    return {
      decision: "skip",
      reason: PRECHECK_NO_WORK_REASON,
      exitCode: code,
      stdout,
      stderr,
    };
  }
  return {
    decision: "error",
    reason: `${PRECHECK_ERROR_REASON}: unexpected exit code ${code}`,
    exitCode: code,
    stdout,
    stderr,
  };
}

type CronJobPrecheckAuthz = {
  /** Operator must enable unattended cron scripts/triggers (same gate as script payloads). */
  triggersEnabled: boolean;
  /** Optional agent id for exec-approvals agent scope. */
  agentId?: string;
  /**
   * Caller's requested exec security contract (tools.exec.security). Host approvals
   * file may only tighten further via minSecurity inside resolve. Defaults to the
   * resolved approvals agent security when omitted.
   */
  security?: ExecSecurity;
  /**
   * When true, skip live approvals resolution and use `security` (or deny) only.
   * Tests inject this to assert policy denial without host file side effects.
   */
  securityOverrideOnly?: boolean;
};

/** Normalize security strings; invalid values fail closed to deny. */
function normalizeExecSecurity(value: unknown): ExecSecurity | undefined {
  if (value === "deny" || value === "allowlist" || value === "full") {
    return value;
  }
  return undefined;
}

/**
 * Authorize a cron precheck command under the same host-shell policy surface as
 * the gateway exec tool: `cron.triggers.enabled` plus exec security
 * deny|allowlist|full (allowlist analysis via evaluateShellAllowlist*).
 * Unattended cron never prompts for approvals — ask paths deny.
 */
export async function authorizeCronJobPrecheckCommand(params: {
  command: string;
  cwd?: string;
  authz: CronJobPrecheckAuthz;
  env?: NodeJS.ProcessEnv;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (!params.authz.triggersEnabled) {
    return { allowed: false, reason: PRECHECK_TRIGGERS_DISABLED };
  }

  const requested = normalizeExecSecurity(params.authz.security);

  if (params.authz.securityOverrideOnly) {
    const security = requested ?? "deny";
    if (security === "deny") {
      return {
        allowed: false,
        reason: `${PRECHECK_POLICY_DENIED_REASON}: exec denied host=gateway security=deny`,
      };
    }
    if (security === "full") {
      return { allowed: true };
    }
    // allowlist without live file → evaluate command against empty allowlist
    const safeBinPolicy = resolveExecSafeBinRuntimePolicy({});
    const allowlistEval = await evaluateShellAllowlistWithAuthorization({
      command: params.command,
      allowlist: [],
      safeBins: safeBinPolicy.safeBins,
      safeBinProfiles: safeBinPolicy.safeBinProfiles,
      trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
      cwd: params.cwd,
      env: params.env ?? process.env,
      platform: process.platform,
    });
    const decision = evaluateSystemRunPolicy({
      security: "allowlist",
      ask: "off",
      analysisOk: allowlistEval.analysisOk,
      allowlistSatisfied: allowlistEval.allowlistSatisfied,
      approvalDecision: null,
      isWindows: process.platform === "win32",
      cmdInvocation: false,
      shellWrapperInvocation: false,
    });
    if (!decision.allowed) {
      return {
        allowed: false,
        reason: `${PRECHECK_POLICY_DENIED_REASON}: ${decision.errorMessage}`,
      };
    }
    return { allowed: true };
  }

  // Mirror resolveExecHostApprovalContext: caller security is a ceiling;
  // approvals file can only tighten. Unattended → ask=off (no interactive path).
  const approvals = await resolveExecApprovalsLocked(params.authz.agentId, {
    security: requested,
    ask: "off",
  });
  const approvalsSecurity = normalizeExecSecurity(approvals.agent.security) ?? "deny";
  const hostSecurity =
    requested === undefined
      ? approvalsSecurity
      : requested === "deny" || approvalsSecurity === "deny"
        ? "deny"
        : requested === "allowlist" || approvalsSecurity === "allowlist"
          ? "allowlist"
          : "full";

  if (hostSecurity === "deny") {
    return {
      allowed: false,
      reason: `${PRECHECK_POLICY_DENIED_REASON}: exec denied host=gateway security=deny`,
    };
  }

  const safeBinPolicy = resolveExecSafeBinRuntimePolicy({});
  const allowlistEval = await evaluateShellAllowlistWithAuthorization({
    command: params.command,
    allowlist: approvals.allowlist,
    safeBins: safeBinPolicy.safeBins,
    safeBinProfiles: safeBinPolicy.safeBinProfiles,
    trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
    cwd: params.cwd,
    env: params.env ?? process.env,
    platform: process.platform,
  });

  const decision = evaluateSystemRunPolicy({
    security: hostSecurity,
    ask: "off",
    analysisOk: allowlistEval.analysisOk,
    allowlistSatisfied: hostSecurity === "allowlist" ? allowlistEval.allowlistSatisfied : true,
    durableApprovalSatisfied: false,
    approvalDecision: null,
    isWindows: process.platform === "win32",
    cmdInvocation: false,
    shellWrapperInvocation: false,
  });

  if (!decision.allowed) {
    return {
      allowed: false,
      reason: `${PRECHECK_POLICY_DENIED_REASON}: ${decision.errorMessage}`,
    };
  }
  return { allowed: true };
}

/** Run the precheck shell command and map protocol → run | skip | error. */
export async function runCronJobPrecheck(
  precheck: CronJobPrecheck,
  opts?: {
    abortSignal?: AbortSignal;
    spawnImpl?: typeof spawn;
    /** Required for host execution: triggers + exec security policy. */
    authz?: CronJobPrecheckAuthz;
  },
): Promise<CronJobPrecheckResult> {
  const command = normalizeOptionalString(precheck.command) ?? "";
  if (!command) {
    return {
      decision: "error",
      reason: `${PRECHECK_INVALID_REASON}: empty command`,
      exitCode: null,
      stdout: "",
      stderr: "",
    };
  }

  if (opts?.abortSignal?.aborted) {
    return {
      decision: "error",
      reason: PRECHECK_TIMEOUT_REASON,
      exitCode: null,
      stdout: "",
      stderr: "aborted",
    };
  }

  const cwd = normalizeOptionalString(precheck.cwd) || undefined;

  // Fail closed: without authz (or explicitly allow via tests spawn only),
  // production timer path always passes authz. Direct API callers must pass it.
  const authz: CronJobPrecheckAuthz = opts?.authz ?? {
    triggersEnabled: false,
    security: "deny",
    securityOverrideOnly: true,
  };
  const auth = await authorizeCronJobPrecheckCommand({
    command,
    cwd,
    authz,
  });
  if (!auth.allowed) {
    return {
      decision: "error",
      reason: auth.reason,
      exitCode: null,
      stdout: "",
      stderr: auth.reason,
    };
  }

  const timeoutMs = resolveTimeoutMs(precheck);
  const spawnFn = opts?.spawnImpl ?? spawn;
  const { shell, args: shellArgs } = resolveShellCommand(command);

  return await new Promise<CronJobPrecheckResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawnFn(shell, shellArgs, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result: CronJobPrecheckResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      opts?.abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish({
        decision: "error",
        reason: PRECHECK_TIMEOUT_REASON,
        exitCode: null,
        stdout: clip(stdout),
        stderr: clip(stderr),
      });
    }, timeoutMs);

    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish({
        decision: "error",
        reason: PRECHECK_TIMEOUT_REASON,
        exitCode: null,
        stdout: clip(stdout),
        stderr: clip(stderr || "aborted"),
      });
    };
    opts?.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_CHARS * 2) {
        stdout += chunk;
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_CHARS * 2) {
        stderr += chunk;
      }
    });

    child.on("error", (err) => {
      finish({
        decision: "error",
        reason: `${PRECHECK_ERROR_REASON}: ${err.message}`,
        exitCode: null,
        stdout: clip(stdout),
        stderr: clip(stderr || err.message),
      });
    });

    child.on("close", (code) => {
      if (timedOut || settled) {
        return;
      }
      const result = interpretPrecheckOutput({
        exitCode: code,
        stdout: clip(stdout),
        stderr: clip(stderr),
        contract: precheck.contract,
        workExitCodes: precheck.workExitCodes,
        noWorkExitCodes: precheck.noWorkExitCodes,
        workStdoutPrefix: precheck.workStdoutPrefix,
        noWorkStdoutPrefix: precheck.noWorkStdoutPrefix,
        onError: precheck.onError,
      });
      finish(result);
    });
  });
}

/** Map a precheck result into a CronRunOutcome (+ diagnostics) for the timer path. */
export function cronRunOutcomeFromPrecheck(
  result: CronJobPrecheckResult,
  nowMs: () => number = () => Date.now(),
): CronRunOutcome {
  if (result.decision === "run") {
    return { status: "ok" };
  }
  if (result.decision === "skip") {
    const ts = nowMs();
    const diagnostics: CronRunDiagnostics = {
      summary: result.reason,
      entries: [
        {
          ts,
          source: "cron-preflight",
          severity: "info",
          message: result.reason,
          exitCode: result.exitCode,
        },
        ...(result.stdout.trim()
          ? [
              {
                ts,
                source: "exec" as const,
                severity: "info" as const,
                message: clip(result.stdout, 500),
              },
            ]
          : []),
      ],
    };
    return {
      status: "skipped",
      error: result.reason,
      summary: result.reason,
      diagnostics,
    };
  }
  return {
    status: "error",
    error: result.reason,
    diagnostics: createCronRunDiagnosticsFromError("cron-preflight", result.reason, {
      severity: "error",
      nowMs,
      exitCode: result.exitCode,
    }),
  };
}

/** Lightweight structural validation / normalization of a precheck object. */
export function normalizeCronJobPrecheck(value: unknown): CronJobPrecheck | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const command = normalizeOptionalString(rec.command);
  if (!command) {
    return undefined;
  }
  const kind = rec.kind === "exec" || rec.kind === undefined ? ("exec" as const) : undefined;
  if (!kind) {
    return undefined;
  }
  const timeoutMs =
    typeof rec.timeoutMs === "number" && Number.isFinite(rec.timeoutMs) && rec.timeoutMs > 0
      ? Math.min(Math.floor(rec.timeoutMs), MAX_TIMEOUT_MS)
      : undefined;
  const contract =
    rec.contract === "exit-code" || rec.contract === "stdout-prefix" || rec.contract === "dual"
      ? rec.contract
      : undefined;
  const onError = rec.onError === "fail" || rec.onError === "skip" ? rec.onError : undefined;
  const toIntList = (v: unknown): number[] | undefined => {
    if (!Array.isArray(v)) {
      return undefined;
    }
    const nums = v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    return nums.length ? nums.map((n) => Math.trunc(n)) : undefined;
  };
  const workExitCodes = toIntList(rec.workExitCodes);
  const noWorkExitCodes = toIntList(rec.noWorkExitCodes);
  const cwd = normalizeOptionalString(rec.cwd);
  const workStdoutPrefix = normalizeOptionalString(rec.workStdoutPrefix);
  const noWorkStdoutPrefix = normalizeOptionalString(rec.noWorkStdoutPrefix);
  return {
    kind: "exec",
    command,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(contract ? { contract } : {}),
    ...(onError ? { onError } : {}),
    ...(workExitCodes ? { workExitCodes } : {}),
    ...(noWorkExitCodes ? { noWorkExitCodes } : {}),
    ...(cwd ? { cwd } : {}),
    ...(workStdoutPrefix ? { workStdoutPrefix } : {}),
    ...(noWorkStdoutPrefix ? { noWorkStdoutPrefix } : {}),
  };
}
