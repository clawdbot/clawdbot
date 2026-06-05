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
  workdir: string | undefined;
  env: Record<string, string>;
  requestedEnv?: Record<string, string>;
  requestedNode?: string;
  boundNode?: string;
  sessionKey?: string;
  bashElevated?: ExecElevatedDefaults;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  trigger?: string;
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  autoReview?: boolean;
  autoReviewer?: ExecAutoReviewer;
  strictInlineEval?: boolean;
  commandHighlighting?: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  approvalRunningNoticeMs: number;
  warnings: string[];
  notifySessionKey?: string;
  notifyOnExit?: boolean;
  trustedSafeBinDirs?: ReadonlySet<string>;
};
