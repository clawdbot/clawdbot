import { AsyncLocalStorage } from "node:async_hooks";
import {
  resolveExecApprovalCommandDisplay,
  sanitizeExecApprovalDisplayTextWithStatus,
  sanitizeExecApprovalWarningText,
} from "../infra/exec-approval-command-display.js";
import { resolveExecApprovalRequestAllowedDecisions } from "../infra/exec-approvals-policy.js";
import type {
  ExecApprovalCommandSpan,
  ExecApprovalDecision,
  ExecApprovalUnavailableDecision,
  ExecAsk,
  ExecSecurity,
  SystemRunApprovalPlan,
} from "../infra/exec-approvals.js";
import { buildSystemRunApprovalEnvBinding } from "../infra/system-run-approval-binding.js";

/** Reviewer-safe request projected to a process-local approval host. */
export type LocalExecApprovalRequest = {
  id: string;
  command: string;
  commandPreview?: string;
  envKeys?: string[];
  cwd?: string;
  nodeId?: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  warningText?: string;
  commandSpans?: ExecApprovalCommandSpan[];
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[];
  allowedDecisions: readonly ExecApprovalDecision[];
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  timeoutMs: number;
};

type LocalExecApprovalRegistrationRequest = {
  id: string;
  command?: string;
  commandArgv?: string[];
  systemRunPlan?: SystemRunApprovalPlan;
  env?: Record<string, string>;
  cwd?: string;
  nodeId?: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  warningText?: string;
  commandSpans?: ExecApprovalCommandSpan[];
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[];
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  requireDeliveryRoute?: boolean;
  suppressDelivery?: boolean;
  timeoutMs: number;
};

type LocalExecApprovalRegistration = {
  id: string;
  expiresAtMs: number;
  finalDecision?: ExecApprovalDecision | null;
};

type LocalExecApprovalHandler = (
  request: LocalExecApprovalRequest,
  signal: AbortSignal,
) => Promise<ExecApprovalDecision | null>;

type PendingApproval = {
  controller: AbortController;
  decision: Promise<ExecApprovalDecision | null>;
  expiresAtMs: number;
};

export class ExecApprovalRunAbortedError extends Error {
  constructor() {
    super("Exec approval cancelled because its run was aborted");
    this.name = "ExecApprovalRunAbortedError";
  }
}

/**
 * Owns two-phase exec approvals for one process-local agent turn.
 *
 * The existing exec engine keeps its register-then-wait contract while the
 * launching adapter supplies the actual approval UI.
 */
class LocalExecApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private active = true;

  constructor(
    private readonly requestApproval: LocalExecApprovalHandler,
    private readonly signal?: AbortSignal,
  ) {}

  register(request: LocalExecApprovalRegistrationRequest): LocalExecApprovalRegistration {
    if (!this.active) {
      throw new Error(`Exec approval "${request.id}" rejected because its local scope ended`);
    }
    if (this.pending.has(request.id)) {
      throw new Error(`Exec approval "${request.id}" is already pending`);
    }
    const commandTextSource =
      request.command ??
      (request.host === "node" ? (request.systemRunPlan?.commandText ?? "") : "");
    const sanitizedCommand = sanitizeExecApprovalDisplayTextWithStatus(commandTextSource);
    if (sanitizedCommand.truncated || sanitizedCommand.oversized) {
      throw new Error("command exceeds exec approval display limit");
    }
    const commandDisplay = resolveExecApprovalCommandDisplay({
      ...request,
      command: commandTextSource,
    });
    const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(request);
    const allowedDecisionSet = new Set(allowedDecisions);
    const envKeys = buildSystemRunApprovalEnvBinding(request.env).envKeys;
    const reviewerRequest: LocalExecApprovalRequest = {
      id: request.id,
      command: sanitizedCommand.text,
      ...(commandDisplay.commandPreview ? { commandPreview: commandDisplay.commandPreview } : {}),
      ...(envKeys.length > 0 ? { envKeys } : {}),
      cwd: request.cwd,
      nodeId: request.nodeId,
      host: request.host,
      security: request.security,
      ask: request.ask,
      warningText: request.warningText
        ? sanitizeExecApprovalWarningText(request.warningText)
        : undefined,
      commandSpans: sanitizedCommand.text === commandTextSource ? request.commandSpans : undefined,
      unavailableDecisions: request.unavailableDecisions,
      allowedDecisions: Object.freeze([...allowedDecisions]),
      agentId: request.agentId,
      resolvedPath: request.resolvedPath,
      sessionKey: request.sessionKey,
      sessionId: request.sessionId,
      runId: request.runId,
      toolCallId: request.toolCallId,
      turnSourceChannel: request.turnSourceChannel,
      turnSourceTo: request.turnSourceTo,
      turnSourceAccountId: request.turnSourceAccountId,
      turnSourceThreadId: request.turnSourceThreadId,
      timeoutMs: request.timeoutMs,
    };
    const expiresAtMs = Date.now() + request.timeoutMs;
    const controller = new AbortController();
    const timeoutReason = new Error(`Exec approval "${request.id}" expired`);
    const timeout = setTimeout(() => controller.abort(timeoutReason), request.timeoutMs);
    timeout.unref?.();
    const onAbort = () => controller.abort(this.signal?.reason);
    this.signal?.addEventListener("abort", onAbort, { once: true });
    if (this.signal?.aborted) {
      onAbort();
    }
    const aborted = new Promise<null>((resolve, reject) => {
      const settleAbort = () => {
        if (controller.signal.reason === timeoutReason) {
          resolve(null);
          return;
        }
        reject(new ExecApprovalRunAbortedError());
      };
      if (controller.signal.aborted) {
        settleAbort();
        return;
      }
      controller.signal.addEventListener("abort", settleAbort, { once: true });
    });
    const decision = Promise.race([
      Promise.resolve()
        .then(() => this.requestApproval(reviewerRequest, controller.signal))
        .then((result) => {
          if (Date.now() >= expiresAtMs) {
            return null;
          }
          if (result === null) {
            return null;
          }
          // Local hosts replace Gateway transport, not Gateway policy. An
          // excluded verdict must fail closed before exec authorization sees it.
          return allowedDecisionSet.has(result) ? result : "deny";
        }),
      aborted,
    ]).finally(() => {
      clearTimeout(timeout);
      this.signal?.removeEventListener("abort", onAbort);
    });
    this.pending.set(request.id, { controller, decision, expiresAtMs });
    void decision.catch(() => {});
    return { id: request.id, expiresAtMs };
  }

  async wait(approvalId: string): Promise<ExecApprovalDecision | null | undefined> {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      if (!this.active) {
        throw new ExecApprovalRunAbortedError();
      }
      return undefined;
    }
    try {
      if (Date.now() >= pending.expiresAtMs) {
        return null;
      }
      const decision = await pending.decision;
      if (!this.active) {
        throw new ExecApprovalRunAbortedError();
      }
      return Date.now() >= pending.expiresAtMs ? null : decision;
    } finally {
      this.pending.delete(approvalId);
    }
  }

  stop(reason: unknown = new Error("Local exec approval broker stopped")): void {
    this.active = false;
    for (const pending of this.pending.values()) {
      pending.controller.abort(reason);
    }
    this.pending.clear();
  }
}

const localExecApprovalBroker = new AsyncLocalStorage<LocalExecApprovalBroker>();

/** Runs one agent command with adapter-owned exec approvals. */
export async function runWithLocalExecApprovalHandler<T>(params: {
  handler?: LocalExecApprovalHandler;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  if (!params.handler) {
    return await params.run();
  }
  const broker = new LocalExecApprovalBroker(params.handler, params.signal);
  try {
    return await localExecApprovalBroker.run(broker, params.run);
  } finally {
    broker.stop();
  }
}

/** Returns the broker attached to the current local agent execution. */
export function getLocalExecApprovalBroker(): LocalExecApprovalBroker | undefined {
  return localExecApprovalBroker.getStore();
}
