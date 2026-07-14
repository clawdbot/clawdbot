/**
 * Shared approval helpers for gateway and node exec hosts.
 * Owns pending-state construction, policy merging, unavailable-route handling,
 * follow-up dispatch, and approval-pending tool result rendering.
 */
import crypto from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { isApprovalNotFoundError } from "../infra/approval-errors.js";
import { formatErrorMessage } from "../infra/errors.js";
import { buildExecApprovalUnavailableReplyPayload } from "../infra/exec-approval-reply.js";
import {
  type ExecApprovalInitiatingSurfaceState,
  resolveExecApprovalInitiatingSurfaceState,
} from "../infra/exec-approval-surface.js";
import {
  minSecurity,
  maxAsk,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalsLocked,
  resolveExecApprovalsTranscriptPath,
  type ExecAsk,
  type ExecApprovalDecision,
  type ExecApprovalsResolved,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { logWarn } from "../logger.js";
import { registerExecApprovalFollowupRuntimeHandoff } from "./bash-tools.exec-approval-followup-state.js";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import {
  type ExecApprovalRegistration,
  resolveRegisteredExecApprovalDecision,
} from "./bash-tools.exec-approval-request.js";
import { buildApprovalPendingMessage } from "./bash-tools.exec-runtime.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./bash-tools.exec-runtime.js";
import type { ExecElevatedDefaults, ExecToolDetails } from "./bash-tools.exec-types.js";
import { isExecDeniedResultText } from "./exec-approval-result.js";
import type { AgentToolResult } from "./runtime/index.js";

/** Cap for deduplicating repeated follow-up dispatch failure log keys. */
const MAX_EXEC_APPROVAL_FOLLOWUP_FAILURE_LOG_KEYS = 256;
const loggedExecApprovalFollowupFailures = new Set<string>();

function rememberExecApprovalFollowupFailureKey(key: string): boolean {
  if (loggedExecApprovalFollowupFailures.has(key)) {
    return false;
  }
  loggedExecApprovalFollowupFailures.add(key);
  // Bound memory growth for long-lived processes that see many unique approval failures.
  if (loggedExecApprovalFollowupFailures.size > MAX_EXEC_APPROVAL_FOLLOWUP_FAILURE_LOG_KEYS) {
    const oldestKey = loggedExecApprovalFollowupFailures.values().next().value;
    if (typeof oldestKey === "string") {
      loggedExecApprovalFollowupFailures.delete(oldestKey);
    }
  }
  return true;
}

/** Effective approval policy after caller config and approvals file are merged. */
type ExecHostApprovalContext = {
  approvals: ExecApprovalsResolved;
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback: ExecApprovalsResolved["agent"]["askFallback"];
};

/** Pending approval state shared by gateway/node exec hosts. */
type ExecApprovalPendingState = {
  warningText: string;
  expiresAtMs: number;
  preResolvedDecision: string | null | undefined;
};

/** Pending approval state plus human-readable notice timing. */
type ExecApprovalRequestState = ExecApprovalPendingState & {
  noticeSeconds: number;
};

const EXPIRED_EXEC_APPROVAL_EXPIRES_AT_MS = 0;

/** Why an approval request cannot be delivered interactively. */
type ExecApprovalUnavailableReason =
  | "no-approval-route"
  | "initiating-platform-disabled"
  | "initiating-platform-unsupported";

function isHeadlessExecTrigger(trigger?: string): boolean {
  return trigger === "cron";
}

/** Context returned after a default approval request is registered. */
type RegisteredExecApprovalRequestContext = {
  approvalId: string;
  approvalSlug: string;
  warningText: string;
  expiresAtMs: number;
  preResolvedDecision: string | null | undefined;
  initiatingSurface: ExecApprovalInitiatingSurfaceState;
  sentApproverDms: boolean;
  unavailableReason: ExecApprovalUnavailableReason | null;
};

/** Destination and context for async exec approval follow-up delivery. */
type ExecApprovalFollowupTarget = {
  approvalId: string;
  sessionKey?: string;
  /** Session UUID active when the approval was requested. Lets the followup be
   *  dropped if `/new` or `/reset` rebinds the session key to a new session. */
  expectedSessionId?: string;
  /** Session-store template, so the direct/denied path can resolve the key's
   *  current sessionId and drop a rebound followup before sending. */
  sessionStore?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  direct?: boolean;
  bashElevated?: ExecElevatedDefaults;
};

/** Test seam for follow-up delivery and warning logging. */
type ExecApprovalFollowupResultDeps = {
  sendExecApprovalFollowup?: typeof sendExecApprovalFollowup;
  logWarn?: typeof logWarn;
};

/** Common arguments used to build default approval request contexts. */
type DefaultExecApprovalRequestArgs = {
  warnings: string[];
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
};

/** Builds pending approval state with warnings and a bounded expiry. */
function createExecApprovalPendingState(params: {
  warnings: string[];
  timeoutMs: number;
}): ExecApprovalPendingState {
  const expiresAtMs =
    resolveExpiresAtMsFromDurationMs(params.timeoutMs) ?? EXPIRED_EXEC_APPROVAL_EXPIRES_AT_MS;
  return {
    warningText: params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "",
    expiresAtMs,
    preResolvedDecision: undefined,
  };
}

/** Builds pending approval state plus rounded notice duration. */
function createExecApprovalRequestState(params: {
  warnings: string[];
  timeoutMs: number;
  approvalRunningNoticeMs: number;
}): ExecApprovalRequestState {
  const pendingState = createExecApprovalPendingState({
    warnings: params.warnings,
    timeoutMs: params.timeoutMs,
  });
  return {
    ...pendingState,
    noticeSeconds: Math.max(1, Math.round(params.approvalRunningNoticeMs / 1000)),
  };
}

/** Creates a fresh approval id/slug/context key for a pending request. */
function createExecApprovalRequestContext(params: {
  warnings: string[];
  timeoutMs: number;
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
}): ExecApprovalRequestState & {
  approvalId: string;
  approvalSlug: string;
  contextKey: string;
} {
  const approvalId = crypto.randomUUID();
  const pendingState = createExecApprovalRequestState({
    warnings: params.warnings,
    timeoutMs: params.timeoutMs,
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
  });
  return {
    ...pendingState,
    approvalId,
    approvalSlug: params.createApprovalSlug(approvalId),
    contextKey: `exec:${approvalId}`,
  };
}

/** Creates a pending approval context using the default approval timeout. */
function createDefaultExecApprovalRequestContext(params: {
  warnings: string[];
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
}) {
  return createExecApprovalRequestContext({
    warnings: params.warnings,
    timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
    createApprovalSlug: params.createApprovalSlug,
  });
}

/** Converts a raw approval decision plus fallback policy into execution state. */
function resolveBaseExecApprovalDecision(params: {
  decision: string | null;
  askFallback: ExecApprovalsResolved["agent"]["askFallback"];
}): {
  approvedByAsk: boolean;
  deniedReason: string | null;
  timedOut: boolean;
} {
  if (params.decision === "deny") {
    return { approvedByAsk: false, deniedReason: "user-denied", timedOut: false };
  }
  if (!params.decision) {
    if (params.askFallback === "full") {
      return { approvedByAsk: true, deniedReason: null, timedOut: true };
    }
    if (params.askFallback === "deny") {
      return { approvedByAsk: false, deniedReason: "approval-timeout", timedOut: true };
    }
    return { approvedByAsk: false, deniedReason: null, timedOut: true };
  }
  return { approvedByAsk: false, deniedReason: null, timedOut: false };
}

/** Resolves effective exec policy for a gateway/node host. */
export async function resolveExecHostApprovalContext(params: {
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  host: "gateway" | "node";
}): Promise<ExecHostApprovalContext> {
  const approvals = await resolveExecApprovalsLocked(params.agentId, {
    security: params.security,
    ask: params.ask,
  });
  // Session/config tool policy is the caller's requested contract. The host file
  // may tighten that contract, but it must not silently broaden it.
  const hostSecurity = minSecurity(params.security, approvals.agent.security);
  const hostAsk = maxAsk(params.ask, approvals.agent.ask);
  const askFallback = minSecurity(hostSecurity, approvals.agent.askFallback);
  if (hostSecurity === "deny") {
    throw new Error(`exec denied: host=${params.host} security=deny`);
  }
  return { approvals, hostSecurity, hostAsk, askFallback };
}

/** Waits for approval while converting wait failures to an undefined sentinel. */
export async function resolveApprovalDecisionOrUndefined(params: {
  approvalId: string;
  preResolvedDecision: string | null | undefined;
  onFailure: () => void;
}): Promise<string | null | undefined> {
  try {
    return await resolveRegisteredExecApprovalDecision({
      approvalId: params.approvalId,
      preResolvedDecision: params.preResolvedDecision,
    });
  } catch {
    params.onFailure();
    return undefined;
  }
}

/** Resolves approval delivery availability for the initiating channel/account. */
function resolveExecApprovalUnavailableState(params: {
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
  preResolvedDecision: string | null | undefined;
}): {
  initiatingSurface: ExecApprovalInitiatingSurfaceState;
  sentApproverDms: boolean;
  unavailableReason: ExecApprovalUnavailableReason | null;
} {
  const initiatingSurface = resolveExecApprovalInitiatingSurfaceState({
    channel: params.turnSourceChannel,
    accountId: params.turnSourceAccountId,
  });
  // Native approval runtimes emit routed-elsewhere notices after actual delivery.
  // Avoid claiming approver DMs were sent from config-only guesses here.
  const sentApproverDms = false;
  const unavailableReason =
    params.preResolvedDecision === null
      ? "no-approval-route"
      : initiatingSurface.kind === "disabled"
        ? "initiating-platform-disabled"
        : initiatingSurface.kind === "unsupported"
          ? "initiating-platform-unsupported"
          : null;
  return {
    initiatingSurface,
    sentApproverDms,
    unavailableReason,
  };
}

/** Creates, registers, and normalizes a default approval request context. */
export async function createAndRegisterDefaultExecApprovalRequest(params: {
  warnings: string[];
  approvalRunningNoticeMs: number;
  createApprovalSlug: (approvalId: string) => string;
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
  register: (approvalId: string) => Promise<ExecApprovalRegistration>;
}): Promise<RegisteredExecApprovalRequestContext> {
  const {
    approvalId,
    approvalSlug,
    warningText,
    expiresAtMs: defaultExpiresAtMs,
    preResolvedDecision: defaultPreResolvedDecision,
  } = createDefaultExecApprovalRequestContext({
    warnings: params.warnings,
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
    createApprovalSlug: params.createApprovalSlug,
  });
  const registration = await params.register(approvalId);
  const preResolvedDecision = registration.finalDecision;
  const { initiatingSurface, sentApproverDms, unavailableReason } =
    resolveExecApprovalUnavailableState({
      turnSourceChannel: params.turnSourceChannel,
      turnSourceAccountId: params.turnSourceAccountId,
      preResolvedDecision,
    });

  return {
    approvalId,
    approvalSlug,
    warningText,
    expiresAtMs: registration.expiresAtMs ?? defaultExpiresAtMs,
    preResolvedDecision:
      registration.finalDecision === undefined
        ? defaultPreResolvedDecision
        : registration.finalDecision,
    initiatingSurface,
    sentApproverDms,
    unavailableReason,
  };
}

/** Builds the shared argument shape passed into default approval registration. */
export function buildDefaultExecApprovalRequestArgs(
  params: DefaultExecApprovalRequestArgs,
): DefaultExecApprovalRequestArgs {
  return {
    warnings: params.warnings,
    approvalRunningNoticeMs: params.approvalRunningNoticeMs,
    createApprovalSlug: params.createApprovalSlug,
    turnSourceChannel: params.turnSourceChannel,
    turnSourceAccountId: params.turnSourceAccountId,
  };
}

/** Builds the immutable follow-up target passed to async approval continuations. */
export function buildExecApprovalFollowupTarget(
  params: ExecApprovalFollowupTarget,
): ExecApprovalFollowupTarget {
  return {
    approvalId: params.approvalId,
    sessionKey: params.sessionKey,
    expectedSessionId: params.expectedSessionId,
    sessionStore: params.sessionStore,
    turnSourceChannel: params.turnSourceChannel,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
    direct: params.direct,
    bashElevated: params.bashElevated,
  };
}

/** Builds mutable approval decision state from a raw decision. */
export function createExecApprovalDecisionState(params: {
  decision: string | null | undefined;
  askFallback: ExecApprovalsResolved["agent"]["askFallback"];
}) {
  const baseDecision = resolveBaseExecApprovalDecision({
    decision: params.decision ?? null,
    askFallback: params.askFallback,
  });
  return {
    baseDecision,
    approvedByAsk: baseDecision.approvedByAsk,
    deniedReason: baseDecision.deniedReason,
  };
}

/** Prevents fallback approval from satisfying strict inline-eval/human-review paths. */
export function enforceStrictInlineEvalApprovalBoundary(params: {
  baseDecision: {
    timedOut: boolean;
  };
  approvedByAsk: boolean;
  deniedReason: string | null;
  requiresInlineEvalApproval: boolean;
  requiresAutoReviewHumanApproval?: boolean;
}): {
  approvedByAsk: boolean;
  deniedReason: string | null;
} {
  const requiresRealApproval =
    params.requiresInlineEvalApproval || params.requiresAutoReviewHumanApproval === true;
  if (!params.baseDecision.timedOut || !requiresRealApproval || !params.approvedByAsk) {
    return {
      approvedByAsk: params.approvedByAsk,
      deniedReason: params.deniedReason,
    };
  }
  return {
    approvedByAsk: false,
    deniedReason: params.deniedReason ?? "approval-timeout",
  };
}

/** Returns true when a headless run should resolve an unavailable approval inline. */
export function shouldResolveExecApprovalUnavailableInline(params: {
  trigger?: string;
  unavailableReason: ExecApprovalUnavailableReason | null;
  preResolvedDecision: string | null | undefined;
}): boolean {
  return (
    isHeadlessExecTrigger(params.trigger) &&
    params.unavailableReason === "no-approval-route" &&
    params.preResolvedDecision === null
  );
}

/** Builds the denial copy for headless runs that cannot wait for approval. */
export function buildHeadlessExecApprovalDeniedMessage(params: {
  trigger?: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  askFallback: ExecApprovalsResolved["agent"]["askFallback"];
}): string {
  const runLabel = params.trigger === "cron" ? "Cron runs" : "Headless runs";
  return [
    `exec denied: ${runLabel} cannot wait for interactive exec approval.`,
    `Effective host exec policy: security=${params.security} ask=${params.ask} askFallback=${params.askFallback}`,
    `Stricter values from tools.exec and ${resolveExecApprovalsTranscriptPath()} both apply.`,
    "Fix one of these:",
    '- align both files to security="full" and ask="off" for trusted local automation',
    "- keep allowlist mode and add an explicit allowlist entry for this command",
    "- enable Web UI, terminal UI, or chat exec approvals and rerun interactively",
    'Tip: run "openclaw doctor" and "openclaw approvals get --gateway" to inspect the effective policy.',
  ].join("\n");
}

/** Sends async approval follow-up results with deduped warning logs on failure. */
export async function sendExecApprovalFollowupResult(
  target: ExecApprovalFollowupTarget,
  resultText: string,
  deps: ExecApprovalFollowupResultDeps = {},
): Promise<void> {
  const send = deps.sendExecApprovalFollowup ?? sendExecApprovalFollowup;
  const warn = deps.logWarn ?? logWarn;
  const runtimeHandoff =
    target.direct === true || !target.sessionKey || isExecDeniedResultText(resultText)
      ? undefined
      : registerExecApprovalFollowupRuntimeHandoff({
          approvalId: target.approvalId,
          sessionKey: target.sessionKey,
          bashElevated: target.bashElevated,
        });
  await send({
    approvalId: target.approvalId,
    sessionKey: target.sessionKey,
    expectedSessionId: target.expectedSessionId,
    sessionStore: target.sessionStore,
    turnSourceChannel: target.turnSourceChannel,
    turnSourceTo: target.turnSourceTo,
    turnSourceAccountId: target.turnSourceAccountId,
    turnSourceThreadId: target.turnSourceThreadId,
    resultText,
    direct: target.direct,
    ...(runtimeHandoff
      ? {
          internalRuntimeHandoffId: runtimeHandoff.handoffId,
          idempotencyKey: runtimeHandoff.idempotencyKey,
        }
      : {}),
  }).catch((error: unknown) => {
    if (isApprovalNotFoundError(error)) {
      return;
    }
    const message = formatErrorMessage(error);
    const key = `${target.approvalId}:${message}`;
    if (!rememberExecApprovalFollowupFailureKey(key)) {
      return;
    }
    warn(`exec approval followup dispatch failed (id=${target.approvalId}): ${message}`);
  });
}

/** Renders an approval-pending or approval-unavailable exec tool result. */
export function buildExecApprovalPendingToolResult(params: {
  host: "gateway" | "node";
  command: string;
  cwd: string | undefined;
  warningText: string;
  approvalId: string;
  approvalSlug: string;
  expiresAtMs: number;
  initiatingSurface: ExecApprovalInitiatingSurfaceState;
  sentApproverDms: boolean;
  unavailableReason: ExecApprovalUnavailableReason | null;
  allowedDecisions?: readonly ExecApprovalDecision[];
  nodeId?: string;
}): AgentToolResult<ExecToolDetails> {
  const allowedDecisions = params.allowedDecisions ?? resolveExecApprovalAllowedDecisions();
  return {
    content: [
      {
        type: "text",
        text:
          params.unavailableReason !== null
            ? (buildExecApprovalUnavailableReplyPayload({
                warningText: params.warningText,
                reason: params.unavailableReason,
                channel: params.initiatingSurface.channel,
                channelLabel: params.initiatingSurface.channelLabel,
                accountId: params.initiatingSurface.accountId,
                sentApproverDms: params.sentApproverDms,
                host: params.host,
                nodeId: params.nodeId,
              }).text ?? "")
            : buildApprovalPendingMessage({
                warningText: params.warningText,
                approvalSlug: params.approvalSlug,
                approvalId: params.approvalId,
                allowedDecisions,
                command: params.command,
                cwd: params.cwd,
                host: params.host,
                nodeId: params.nodeId,
              }),
      },
    ],
    details:
      params.unavailableReason !== null
        ? ({
            status: "approval-unavailable",
            reason: params.unavailableReason,
            channel: params.initiatingSurface.channel,
            channelLabel: params.initiatingSurface.channelLabel,
            accountId: params.initiatingSurface.accountId,
            sentApproverDms: params.sentApproverDms,
            host: params.host,
            command: params.command,
            cwd: params.cwd,
            nodeId: params.nodeId,
            warningText: params.warningText,
          } satisfies ExecToolDetails)
        : ({
            status: "approval-pending",
            approvalId: params.approvalId,
            approvalSlug: params.approvalSlug,
            expiresAtMs: params.expiresAtMs,
            allowedDecisions,
            host: params.host,
            command: params.command,
            cwd: params.cwd,
            nodeId: params.nodeId,
            warningText: params.warningText,
          } satisfies ExecToolDetails),
  };
}
