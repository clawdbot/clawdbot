/**
 * Shared type contracts for bash exec tools.
 * Defines defaults, approval follow-up payloads, elevated policy defaults, and
 * tool result details consumed across exec hosts and process controls.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { EventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import type {
  ExecAsk,
  ExecHost,
  ExecMode,
  ExecSecurity,
  ExecTarget,
} from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import type { SafeBinProfileFixture } from "../infra/exec-safe-bin-policy.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";
import type { TerminationReason } from "../process/supervisor/types.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import type { EmbeddedFullAccessBlockedReason } from "./embedded-agent-runner/types.js";
import type { ExecReviewerConfig } from "./exec-auto-reviewer.js";

/** Runtime defaults passed into exec/process tool factories. */
export type ExecToolDefaults = {
  hasCronTool?: boolean;
  host?: ExecTarget;
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
  trigger?: string;
  node?: string;
  /** Default working directory for node-host execution only. */
  nodeCwd?: string;
  pathPrepend?: string[];
  safeBins?: string[];
  strictInlineEval?: boolean;
  commandHighlighting?: boolean;
  safeBinTrustedDirs?: string[];
  safeBinProfiles?: Record<string, SafeBinProfileFixture>;
  reviewer?: ExecReviewerConfig;
  config?: OpenClawConfig;
  autoReviewer?: ExecAutoReviewer;
  agentId?: string;
  backgroundMs?: number;
  timeoutSec?: number;
  approvalWarningText?: string;
  approvalFollowupText?: string;
  approvalFollowup?: ExecApprovalFollowupFactory;
  approvalFollowupMode?: "agent" | "direct";
  approvalRunningNoticeMs?: number;
  sandbox?: BashSandboxConfig;
  elevated?: ExecElevatedDefaults;
  allowBackground?: boolean;
  scopeKey?: string;
  sessionKey?: string;
  /** Stable agent run that owns any approval created by this tool. */
  runId?: string;
  /** Durable session that receives detached exec completion events and approval followups. */
  notifySessionKey?: string;
  /** Ephemeral session UUID active when this exec tool was built. Regenerated
   *  on `/new` and `/reset`, so it pins exec-approval followups to the original
   *  session instance and lets stale followups drop after a session rebind. */
  sessionId?: string;
  /** `session.store` template from the runtime config. Lets the direct/denied
   *  exec approval followup path resolve the session key's current sessionId and
   *  drop the followup when the key was rebound by `/new` or `/reset`. */
  sessionStore?: string;
  /** `session.mainKey` from the runtime config; passed through into
   *  runExecProcess so background-exit notifications can remap cron-run
   *  session keys to the agent's main queue without an ambient config load. */
  mainKey?: string;
  /** `session.scope` from the runtime config; passed alongside `mainKey`
   *  so the cron-run remap can route global-scope agents to the "global"
   *  queue instead of agent-main. */
  sessionScope?: "per-sender" | "global";
  /** Start-time routing policy for detached exec system events. */
  eventRouting?: EventSessionRoutingPolicy;
  messageProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  /** Channel-owned sender/chat metadata. Exec subprocesses receive only sender/chat IDs. */
  channelContext?: PluginHookChannelContext;
  accountId?: string;
  approvalReviewerDeviceId?: string;
  /** Deny approval-requiring commands without creating operator approval events. */
  nonInteractiveApproval?: boolean;
  notifyOnExit?: boolean;
  notifyOnExitEmptySuccess?: boolean;
  cwd?: string;
};

/** Outcome passed to approval follow-up factories after approved async exec. */
export type ExecApprovalFollowupOutcome = {
  status: "completed" | "failed";
  exitCode: number | null;
  exitReason?: TerminationReason;
  timedOut: boolean;
  aggregated: string;
  reason?: string;
};

type ExecApprovalFollowupContext = {
  approvalId: string;
  sessionId: string;
  trigger?: string;
  outcome: ExecApprovalFollowupOutcome;
};

/** Hook that can append domain-specific text to approval follow-up messages. */
export type ExecApprovalFollowupFactory = (
  context: ExecApprovalFollowupContext,
) => string | undefined | Promise<string | undefined>;

/** Effective elevated-exec defaults derived from config/runtime policy. */
export type ExecElevatedDefaults = {
  enabled: boolean;
  allowed: boolean;
  defaultLevel: "on" | "off" | "ask" | "full";
  fullAccessAvailable?: boolean;
  fullAccessBlockedReason?: EmbeddedFullAccessBlockedReason;
};

/** Structured details returned by exec tool calls. */
export type ExecToolDetails =
  | {
      status: "running";
      sessionId: string;
      pid?: number;
      startedAt: number;
      cwd?: string;
      tail?: string;
    }
  | {
      status: "completed" | "failed";
      exitCode: number | null;
      exitSignal?: NodeJS.Signals | number | null;
      failureKind?: string;
      exitReason?: TerminationReason;
      durationMs: number;
      aggregated: string;
      timedOut?: boolean;
      noOutputTimedOut?: boolean;
      cwd?: string;
    }
  | {
      status: "approval-pending";
      approvalId: string;
      approvalSlug: string;
      expiresAtMs: number;
      allowedDecisions?: readonly ExecApprovalDecision[];
      host: ExecHost;
      command: string;
      cwd?: string;
      nodeId?: string;
      warningText?: string;
    }
  | {
      status: "approval-unavailable";
      reason:
        | "initiating-platform-disabled"
        | "initiating-platform-unsupported"
        | "no-approval-route";
      channel?: string;
      channelLabel?: string;
      accountId?: string;
      sentApproverDms?: boolean;
      host: ExecHost;
      command: string;
      cwd?: string;
      nodeId?: string;
      warningText?: string;
    };
