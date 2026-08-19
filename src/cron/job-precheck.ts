import { spawn } from "node:child_process";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  evaluateShellAllowlistWithAuthorization,
  resolveExecApprovalsLocked,
  resolveExecModePolicy,
  maxAsk,
  minSecurity,
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { applyExecPolicyLayer } from "../infra/exec-policy.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import { evaluateSystemRunPolicy } from "../node-host/exec-policy.js";
import { killProcessTree } from "../process/kill-tree.js";
import { resolveTrustedWindowsCmdExe } from "../process/windows-command.js";
import { createCronRunDiagnosticsFromError } from "./run-diagnostics.js";
import type { CronJobPrecheck } from "./types-shared.js";
import type { CronRunDiagnostics, CronRunOutcome } from "./types.js";

/** Default shell for precheck command strings. */
const IS_WINDOWS = process.platform === "win32";

function resolveShellCommand(command: string): { shell: string; args: string[] } {
  if (IS_WINDOWS) {
    // Fixed trusted transport — never inherit %ComSpec% for unattended precheck.
    const shell = resolveTrustedWindowsCmdExe();
    return { shell, args: ["/d", "/s", "/c", command] };
  }
  // Fixed trusted transport — never inherit $SHELL for unattended precheck.
  return { shell: "/bin/sh", args: ["-c", command] };
}

/** Canonical host-exec env for allowlist analysis + spawn (no raw process.env). */
function resolvePrecheckExecEnv(
  baseEnv?: Record<string, string | undefined>,
): Record<string, string> {
  return sanitizeHostExecEnv({ baseEnv: baseEnv ?? process.env });
}

/** Stable skip / error reason codes for run logs and operators. */
export const PRECHECK_NO_WORK_REASON = "precheck-no-work";
/** onError=skip for unexpected probe failures — distinct from quiet no-work. */
export const PRECHECK_SKIPPED_ERROR_REASON = "precheck-skipped-error";
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
      reason: typeof PRECHECK_NO_WORK_REASON | typeof PRECHECK_SKIPPED_ERROR_REASON;
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
      reason: PRECHECK_SKIPPED_ERROR_REASON,
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

type ExecToolConfigLayer = {
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
  /** Same fields as tools.exec / system-run safe-bin policy scopes. */
  safeBins?: string[] | null;
  safeBinProfiles?: Record<string, unknown> | null;
  safeBinTrustedDirs?: string[] | null;
};

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
   * Global `tools.exec` config layer (same as system.run). Applied before agent layer.
   * When set, layered policy becomes the requested security ceiling (not approvals alone).
   */
  toolsExec?: ExecToolConfigLayer;
  /**
   * Per-agent `agents.entries.<id>.tools.exec` config layer (same as system.run).
   */
  agentToolsExec?: ExecToolConfigLayer;
  /**
   * When true, skip live approvals resolution and use `security` (or deny) only.
   * Tests inject this to assert policy denial without host file side effects.
   */
  securityOverrideOnly?: boolean;
};

/** Safe-bin scopes from tools.exec layers (parity with system-run). */
function resolvePrecheckSafeBinPolicy(authz: CronJobPrecheckAuthz) {
  return resolveExecSafeBinRuntimePolicy({
    global: authz.toolsExec
      ? {
          safeBins: authz.toolsExec.safeBins,
          safeBinProfiles: authz.toolsExec.safeBinProfiles as never,
          safeBinTrustedDirs: authz.toolsExec.safeBinTrustedDirs,
        }
      : undefined,
    local: authz.agentToolsExec
      ? {
          safeBins: authz.agentToolsExec.safeBins,
          safeBinProfiles: authz.agentToolsExec.safeBinProfiles as never,
          safeBinTrustedDirs: authz.agentToolsExec.safeBinTrustedDirs,
        }
      : undefined,
  });
}

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
    const safeBinPolicy = resolvePrecheckSafeBinPolicy(params.authz);
    const allowlistEval = await evaluateShellAllowlistWithAuthorization({
      command: params.command,
      allowlist: [],
      safeBins: safeBinPolicy.safeBins,
      safeBinProfiles: safeBinPolicy.safeBinProfiles,
      trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
      cwd: params.cwd,
      env: params.env ?? resolvePrecheckExecEnv(),
      platform: process.platform,
    });
    const isWindows = process.platform === "win32";
    const decision = evaluateSystemRunPolicy({
      security: "allowlist",
      ask: "off",
      analysisOk: allowlistEval.analysisOk,
      allowlistSatisfied: allowlistEval.allowlistSatisfied,
      approvalDecision: null,
      isWindows,
      // Precheck always launches via cmd.exe /d /s /c on Windows — classify as such.
      cmdInvocation: isWindows,
      shellWrapperInvocation: isWindows,
    });
    if (!decision.allowed) {
      return {
        allowed: false,
        reason: `${PRECHECK_POLICY_DENIED_REASON}: ${decision.errorMessage}`,
      };
    }
    return { allowed: true };
  }

  // Mirror resolveEffectiveSystemRunExecPolicy / resolveExecHostApprovalContext:
  // 1) start from OpenClaw defaults (full/off) or an explicit security ceiling
  // 2) layer global + per-agent tools.exec (canonical system.run path)
  // 3) resolveExecModePolicy — preserve effective ask (do not force off)
  // 4) approvals file may only tighten via minSecurity
  // Unattended cron cannot prompt: if effective ask is not off, fail closed.
  const normalizeLayer = (
    layer: ExecToolConfigLayer | undefined,
  ): ExecToolConfigLayer | undefined => {
    if (!layer) {
      return undefined;
    }
    return {
      mode:
        layer.mode === "deny" ||
        layer.mode === "allowlist" ||
        layer.mode === "ask" ||
        layer.mode === "auto" ||
        layer.mode === "full"
          ? layer.mode
          : undefined,
      security: normalizeExecSecurity(layer.security),
      ask:
        layer.ask === "off" || layer.ask === "on-miss" || layer.ask === "always"
          ? layer.ask
          : undefined,
    };
  };
  const toolsExecLayer = normalizeLayer(params.authz.toolsExec);
  const agentToolsExecLayer = normalizeLayer(params.authz.agentToolsExec);
  const hasConfigLayers = toolsExecLayer !== undefined || agentToolsExecLayer !== undefined;
  // Canonical system.run default is allowlist when exec security is unspecified
  // (node-host/invoke.ts). Do not widen unconfigured prechecks to full.
  const defaultSecurity: ExecSecurity = "allowlist";
  const basePolicy = {
    security: requested ?? defaultSecurity,
    ask: "off" as const,
  };
  const layered = hasConfigLayers
    ? applyExecPolicyLayer(applyExecPolicyLayer(basePolicy, toolsExecLayer), agentToolsExecLayer)
    : basePolicy;
  // Explicit authz.security remains a hard ceiling when config layers are also present.
  const ceilingSecurity =
    requested !== undefined
      ? minSecurity(normalizeExecSecurity(layered.security) ?? "allowlist", requested)
      : (normalizeExecSecurity(layered.security) ?? "allowlist");
  const layeredMode: ExecMode | undefined =
    "mode" in layered &&
    (layered.mode === "deny" ||
      layered.mode === "allowlist" ||
      layered.mode === "ask" ||
      layered.mode === "auto" ||
      layered.mode === "full")
      ? layered.mode
      : undefined;
  const layeredAsk: ExecAsk =
    "ask" in layered &&
    (layered.ask === "off" || layered.ask === "on-miss" || layered.ask === "always")
      ? layered.ask
      : "off";
  const modePolicy = resolveExecModePolicy({
    mode: layeredMode,
    security: ceilingSecurity ?? "allowlist",
    ask: layeredAsk,
  });
  const approvals = await resolveExecApprovalsLocked(params.authz.agentId, {
    security: modePolicy.security,
    ask: modePolicy.ask,
  });
  const hostSecurity = minSecurity(
    modePolicy.security,
    normalizeExecSecurity(approvals.agent.security) ?? "deny",
  );
  // Approvals may only tighten ask (system-run maxAsk), never weaken tools.exec.ask.
  const approvalsAsk: ExecAsk =
    approvals.agent.ask === "off" ||
    approvals.agent.ask === "on-miss" ||
    approvals.agent.ask === "always"
      ? approvals.agent.ask
      : modePolicy.ask;
  const effectiveAsk: ExecAsk = maxAsk(modePolicy.ask, approvalsAsk);

  if (hostSecurity === "deny") {
    return {
      allowed: false,
      reason: `${PRECHECK_POLICY_DENIED_REASON}: exec denied host=gateway security=deny`,
    };
  }

  // Cron precheck is unattended — never spawn a host shell when ask would require
  // interactive confirmation (ClawSweeper P1 / security).
  if (effectiveAsk !== "off") {
    return {
      allowed: false,
      reason: `${PRECHECK_POLICY_DENIED_REASON}: unattended precheck denied host=gateway ask=${effectiveAsk}`,
    };
  }

  const safeBinPolicy = resolvePrecheckSafeBinPolicy(params.authz);
  const allowlistEval = await evaluateShellAllowlistWithAuthorization({
    command: params.command,
    allowlist: approvals.allowlist,
    safeBins: safeBinPolicy.safeBins,
    safeBinProfiles: safeBinPolicy.safeBinProfiles,
    trustedSafeBinDirs: safeBinPolicy.trustedSafeBinDirs,
    cwd: params.cwd,
    env: params.env ?? resolvePrecheckExecEnv(),
    platform: process.platform,
  });

  const isWindows = process.platform === "win32";
  const decision = evaluateSystemRunPolicy({
    security: hostSecurity,
    ask: effectiveAsk,
    analysisOk: allowlistEval.analysisOk,
    allowlistSatisfied: hostSecurity === "allowlist" ? allowlistEval.allowlistSatisfied : true,
    durableApprovalSatisfied: false,
    approvalDecision: null,
    isWindows,
    // Precheck always launches via cmd.exe /d /s /c on Windows — classify as such.
    cmdInvocation: isWindows,
    shellWrapperInvocation: isWindows,
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
    /**
     * Optional currency fence invoked after awaited authorization and again
     * immediately before host-shell spawn (ClawSweeper P1 receipt revalidation).
     * Throw or throw-like errors are mapped to a fail-closed error decision.
     */
    assertStillCurrent?: () => void;
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

  // Recheck cancellation after awaited authorization — cancel during authz must
  // not still spawn a host shell (ClawSweeper P1).
  if (opts?.abortSignal?.aborted) {
    return {
      decision: "error",
      reason: PRECHECK_TIMEOUT_REASON,
      exitCode: null,
      stdout: "",
      stderr: "aborted",
    };
  }

  // Receipt/config currency fence immediately before spawn (ClawSweeper P1):
  // authorization can await; a job edit/clear during that window must not run
  // the stale host command.
  try {
    opts?.assertStillCurrent?.();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: "error",
      reason: `${PRECHECK_INVALID_REASON}: stale run receipt before spawn (${message})`,
      exitCode: null,
      stdout: "",
      stderr: message,
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

    // Detached process group on POSIX so timeout/abort can terminate the full tree
    // (shell + background descendants), matching system-run lifecycle.
    const child = spawnFn(shell, shellArgs, {
      cwd,
      env: resolvePrecheckExecEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const terminateChildTree = () => {
      const pid = child.pid;
      if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
        try {
          killProcessTree(pid, {
            force: true,
            detached: process.platform !== "win32",
          });
        } catch {
          // fall through to direct kill
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    };

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
      terminateChildTree();
      finish({
        decision: "error",
        reason: PRECHECK_TIMEOUT_REASON,
        exitCode: null,
        stdout: clip(stdout),
        stderr: clip(stderr),
      });
    }, timeoutMs);

    const onAbort = () => {
      terminateChildTree();
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

export { normalizeCronJobPrecheck } from "./job-precheck-normalize.js";
