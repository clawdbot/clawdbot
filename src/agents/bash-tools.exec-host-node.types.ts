import type { ExecDenylistEntry } from "../infra/exec-approvals-denylist.js";
/**
 * Node-host exec command parameter contracts.
 * Centralizes the full host/runtime boundary so node exec callers and handlers
 * cannot drift on approval, routing, env, or timeout fields.
 */
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import type { ExecElevatedDefaults } from "./bash-tools.exec-types.js";

/** Full parameter bundle for Node-hosted exec command execution. */
export type ExecuteNodeHostCommandParams = {
  command: string;
  toolCallId?: string;
  workdir: string | undefined;
  env: Record<string, string>;
  requestedEnv?: Record<string, string>;
  requestedNode?: string;
  boundNode?: string;
  sessionKey?: string;
  /** Session UUID active when the approval was requested; pins the followup. */
  sessionId?: string;
  /** Session-store template, so the direct/denied followup can detect a rebind. */
  sessionStore?: string;
  bashElevated?: ExecElevatedDefaults;
  approvalReviewerDeviceId?: string;
  nonInteractiveApproval?: boolean;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  trigger?: string;
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  /**
   * Authorized elevated-full break-glass path. The caller may bypass ordinary
   * exec approvals only while both the requested and host policies remain
   * full/off; the node still validates its prepared policy snapshot.
   */
  bypassApprovals?: boolean;
  autoReview?: boolean;
  autoReviewer?: ExecAutoReviewer;
  signal?: AbortSignal;
  strictInlineEval?: boolean;
  commandHighlighting?: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  approvalRunningNoticeMs: number;
  warnings: string[];
  /** Warnings that apply only when the command runs inline, never while approval is pending. */
  foregroundWarnings?: string[];
  notifySessionKey?: string;
  notifyOnExit?: boolean;
  trustedSafeBinDirs?: ReadonlySet<string>;
  /**
   * openclaw.json config-layer exec denylist (`tools.exec.denylist` and the
   * per-agent `agents.list.<id>.tools.exec.denylist`).
   */
  execConfigDenylist?: ExecDenylistEntry[];
  /**
   * Re-resolves the current openclaw.json config-layer exec denylist before
   * node dispatch. Used to revoke pending approvals when hot config adds or
   * tightens a matching STOP rule.
   */
  resolveCurrentExecConfigDenylist?: () => readonly ExecDenylistEntry[];
};
