/**
 * Public facade for before_tool_call policy and execution handling.
 *
 * Implementation is split by ownership: approval transport, ordered policy
 * orchestration, diagnostics/telemetry, and wrapped execution/finalization.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { DiagnosticToolTerminalReason } from "../infra/diagnostic-events.js";
import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type {
  PluginHookBeforeToolCallResult,
  PluginHookToolRequesterContext,
} from "../plugins/types.js";
import type { SkillSnapshot, SkillTelemetrySource, SkillUsagePath } from "../skills/types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

export type ToolOutcomeObservation = {
  toolName: string;
  argsHash: string;
  resultHash: string;
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

export {
  consumeAdjustedParamsForToolCall,
  consumePreExecutionBlockedToolCall,
  peekAdjustedParamsForToolCall,
} from "./agent-tools.before-tool-call.state.js";
export {
  copyBeforeToolCallHookMarker,
  isToolWrappedWithBeforeToolCallHook,
  setBeforeToolCallDiagnosticsEnabled,
} from "./before-tool-call-metadata.js";
export { finalizeToolTerminalPresentation } from "./agent-tools.before-tool-call.diagnostics.js";
export {
  cancelDeferredPluginToolApproval,
  requestDeferredPluginToolApproval,
} from "./agent-tools.before-tool-call.approval.js";
export {
  getBeforeToolCallPolicyDiagnosticState,
  hasBeforeToolCallPolicy,
  runBeforeToolCallHook,
} from "./agent-tools.before-tool-call.policy.js";
export {
  buildBlockedToolResult,
  getBeforeToolCallFailureDisposition,
  isBeforeToolCallBlockedError,
  isPreExecutionBlockedToolResult,
  recordAdjustedParamsForToolCall,
  recordStructuredReplayTrustForToolCall,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.wrapper.js";
