// Defines view-model shapes for approval prompts and resolutions.
import type { InteractiveReplyButton } from "../interactive/payload.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import type { CommandExplanationSummary } from "./command-analysis/explain.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
} from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

type ApprovalPhase = "pending" | "resolved" | "expired";

/** Button or command action shown with a pending approval prompt. */
export type ApprovalActionView = {
  kind?: "command" | "decision";
  decision: ExecApprovalDecision;
  label: string;
  style: NonNullable<InteractiveReplyButton["style"]>;
  command: string;
};

/** Label/value metadata row rendered with an approval prompt. */
export type ApprovalMetadataView = {
  label: string;
  value: string;
};

type ApprovalViewBase = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  phase: ApprovalPhase;
  title: string;
  description?: string | null;
  metadata: ApprovalMetadataView[];
};

/** Shared presentation fields for exec approval views across all phases. */
export type ExecApprovalViewBase = ApprovalViewBase & {
  approvalKind: "exec";
  ask?: string | null;
  agentId?: string | null;
  warningText?: string | null;
  commandAnalysis?: CommandExplanationSummary | null;
  commandText: string;
  commandPreview?: string | null;
  cwd?: string | null;
  envKeys?: readonly string[];
  host?: string | null;
  nodeId?: string | null;
  sessionKey?: string | null;
};

/** Pending exec approval view, including executable reply actions. */
export type ExecApprovalPendingView = ExecApprovalViewBase & {
  phase: "pending";
  actions: ApprovalActionView[];
  expiresAtMs: number;
};

/** Resolved exec approval view with the recorded decision. */
export type ExecApprovalResolvedView = ExecApprovalViewBase & {
  phase: "resolved";
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
};

/** Expired exec approval view without reply actions. */
export type ExecApprovalExpiredView = ExecApprovalViewBase & {
  phase: "expired";
};

/** Shared presentation fields for plugin approval views across all phases. */
export type PluginApprovalViewBase = ApprovalViewBase & {
  approvalKind: "plugin";
  agentId?: string | null;
  pluginId?: string | null;
  toolName?: string | null;
  severity: "info" | "warning" | "critical";
};

/** Pending plugin approval view, including executable reply actions. */
export type PluginApprovalPendingView = PluginApprovalViewBase & {
  phase: "pending";
  actions: ApprovalActionView[];
  expiresAtMs: number;
};

/** Resolved plugin approval view with the recorded decision. */
export type PluginApprovalResolvedView = PluginApprovalViewBase & {
  phase: "resolved";
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
};

/** Expired plugin approval view without reply actions. */
export type PluginApprovalExpiredView = PluginApprovalViewBase & {
  phase: "expired";
};

/** Any pending approval view that still accepts a user decision. */
export type PendingApprovalView = ExecApprovalPendingView | PluginApprovalPendingView;
/** Any approval view after a decision was recorded. */
export type ResolvedApprovalView = ExecApprovalResolvedView | PluginApprovalResolvedView;
/** Any approval view after it can no longer be acted on. */
export type ExpiredApprovalView = ExecApprovalExpiredView | PluginApprovalExpiredView;
/** Discriminated approval presentation model consumed by channel/UI renderers. */
export type ApprovalViewModel = PendingApprovalView | ResolvedApprovalView | ExpiredApprovalView;

/** Stored approval request variants accepted by the view-model builders. */
export type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
/** Stored approval resolution variants accepted by resolved view builders. */
export type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
