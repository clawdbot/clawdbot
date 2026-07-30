/**
 * Shared contracts for before_tool_call policy and execution handling.
 * Kept separate from the facade so implementation modules do not import back
 * through the barrel that re-exports them.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { DiagnosticToolTerminalReason } from "../infra/diagnostic-events.js";
import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type {
  PluginApprovalResolution,
  PluginHookBeforeToolCallResult,
  PluginHookToolRequesterContext,
} from "../plugins/types.js";
import type { SkillSnapshot, SkillTelemetrySource, SkillUsagePath } from "../skills/types.js";
import type { AgentTool } from "./runtime/index.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

export type ToolOutcomeObservation = {
  toolName: string;
  argsHash: string;
  resultHash: string;
  resultContentSource?: AgentTool["resultContentSource"];
  /** Monotonic model-call order within the owning embedded run. */
  toolCallOrdinal?: number;
  terminalPresentation?: string;
  presentationOnly?: boolean;
};

export type ToolOutcomeObserver = (observation: ToolOutcomeObservation) => void;

export type HookContext = {
  agentId?: string;
  config?: OpenClawConfig;
  /** Tool execution cwd for host-derived path facts. */
  cwd?: string;
  /** Host workspace used to resolve relative tool params for diagnostics only. */
  workspaceDir?: string;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  /** What initiated this run, used to reject approvals on unattended surfaces. */
  trigger?: string;
  /** Device-scoped operator session allowed to review approvals initiated by this run. */
  approvalReviewerDeviceId?: string;
  trace?: DiagnosticTraceContext;
  channelId?: string;
  /** Host-derived message requester for sender-aware tool hooks. */
  requester?: PluginHookToolRequesterContext;
  /** Originating channel for approval delivery routing; mirrors exec approval turn-source fields. */
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  loopDetection?: ToolLoopDetectionConfig;
  onToolOutcome?: ToolOutcomeObserver;
  allocateToolOutcomeOrdinal?: (toolCallId?: string) => number;
  skillsSnapshot?: SkillSnapshot;
  skillUsagePaths?: SkillUsagePath[];
  skillCommand?: {
    commandName: string;
    skillFile?: string;
    skillName: string;
    skillSource?: SkillTelemetrySource;
    toolName?: string;
  };
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
};

export type BeforeToolCallFailureDisposition = "blocked" | DiagnosticToolTerminalReason;

type PluginApprovalRequest = NonNullable<PluginHookBeforeToolCallResult["requireApproval"]>;

export type DeferredPluginToolApproval = {
  approval: PluginApprovalRequest;
  toolName: string;
  toolCallId?: string;
  ctx?: HookContext;
  baseParams: unknown;
  overrideParams?: unknown;
};

export type BeforeToolCallPolicyDiagnosticState = {
  hasBeforeToolCallHook: boolean;
  trustedToolPolicies: Array<{
    id: string;
    pluginId: string;
    pluginName?: string;
  }>;
};

export type HookBlockedReason =
  | "client-voice-confirmation"
  | "plugin-before-tool-call"
  | "plugin-approval"
  | "plugin-approval-unavailable"
  | "tool-loop";

/**
 * Critical tool-loop vetoes must terminate the agent run so the model cannot
 * keep retrying the blocked tool indefinitely (issue #106231). Other veto
 * reasons (plugin/approval) stay non-terminating. Shared by
 * {@link buildBlockedToolResult} (per-result `terminate: true`) and the
 * session-level `shouldStopAfterTurn` hook (mixed-batch coverage).
 *
 * Both canonical fields are required: `details` is hook-overridable structured
 * data (`AgentToolResult.details`), so `deniedReason: "tool-loop"` alone is not
 * enough — a non-blocked result carrying that string must not end the session.
 * This matches the loop detector's own `isLoopVetoResult` classifier
 * (`tool-loop-detection.ts`), which recognizes a loop veto only when both
 * `status: "blocked"` and `deniedReason: "tool-loop"` are present.
 */
export function isCriticalToolLoopVeto(details: unknown): details is {
  status: "blocked";
  deniedReason: "tool-loop";
} {
  if (typeof details !== "object" || details === null) {
    return false;
  }
  const { status, deniedReason } = details as { status?: unknown; deniedReason?: unknown };
  return status === "blocked" && deniedReason === "tool-loop";
}

type HookBlockedOutcome = {
  blocked: true;
  deniedReason?: HookBlockedReason;
  reason: string;
  params?: unknown;
};

export type HookOutcome =
  | (HookBlockedOutcome & { kind: "veto" })
  | (HookBlockedOutcome & {
      kind: "failure";
      disposition: BeforeToolCallFailureDisposition;
    })
  | {
      blocked: false;
      params: unknown;
      approvalResolution?: PluginApprovalResolution;
      deferredApproval?: DeferredPluginToolApproval;
    };
