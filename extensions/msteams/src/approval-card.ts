import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type {
  ApprovalMetadataView,
  ChannelApprovalKind,
  ExpiredApprovalView,
  PendingApprovalView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  formatApprovalDecisionLabel,
  formatChannelApprovalResolvedLabel,
  type ExecApprovalDecision,
} from "openclaw/plugin-sdk/approval-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { msTeamsApprovalControls } from "./approval-card-actions.js";

export type MSTeamsApprovalActionToken = {
  token: string;
  decision: ExecApprovalDecision;
};

export type MSTeamsPendingApprovalCard = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  expiresAtMs: number;
  card: Record<string, unknown>;
  actionTokens: MSTeamsApprovalActionToken[];
  allowedDecisions: readonly ExecApprovalDecision[];
};

type MSTeamsApprovalBodyItem = Record<string, unknown>;

function buildCardHeading(title: string, subtitle: string): MSTeamsApprovalBodyItem[] {
  return [
    { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
    { type: "TextBlock", text: subtitle, isSubtle: true, wrap: true },
  ];
}

function buildApprovalSubject(
  view: PendingApprovalView | ResolvedApprovalView | ExpiredApprovalView,
): MSTeamsApprovalBodyItem[] {
  if (view.approvalKind === "system-agent") {
    return [
      { type: "TextBlock", text: "Change", weight: "Bolder", wrap: true },
      { type: "TextBlock", text: view.operationSummary, wrap: true },
    ];
  }
  if (view.approvalKind === "exec") {
    return [
      { type: "TextBlock", text: "Command", weight: "Bolder", wrap: true },
      { type: "TextBlock", text: view.commandText, fontType: "Monospace", wrap: true },
      ...(view.commandPreview && view.commandPreview !== view.commandText
        ? [
            { type: "TextBlock", text: "Preview", weight: "Bolder", wrap: true },
            { type: "TextBlock", text: view.commandPreview, fontType: "Monospace", wrap: true },
          ]
        : []),
    ];
  }
  return [
    { type: "TextBlock", text: "Request", weight: "Bolder", wrap: true },
    { type: "TextBlock", text: view.title, weight: "Bolder", wrap: true },
    ...(view.description ? [{ type: "TextBlock", text: view.description, wrap: true }] : []),
  ];
}

function buildApprovalMetadata(
  approvalId: string,
  metadata: readonly ApprovalMetadataView[],
): MSTeamsApprovalBodyItem {
  return {
    type: "FactSet",
    facts: [{ title: "Approval ID:", value: approvalId }].concat(
      metadata.map(({ label, value }) => ({ title: `${label}:`, value })),
    ),
  };
}

function buildAdaptiveCard(
  body: MSTeamsApprovalBodyItem[],
  actions?: MSTeamsApprovalBodyItem[],
): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    version: "1.5",
    body,
    ...(actions?.length ? { actions } : {}),
  };
}

export function buildMSTeamsPendingApprovalCard(params: {
  view: PendingApprovalView;
  nowMs: number;
}): MSTeamsPendingApprovalCard {
  const { view, nowMs } = params;
  const kindLabel =
    view.approvalKind === "plugin"
      ? "Plugin"
      : view.approvalKind === "system-agent"
        ? "OpenClaw Change"
        : "Exec";
  const actionTokens: MSTeamsApprovalActionToken[] = [];
  const actions = view.actions.map(({ decision, label }) => {
    const token = msTeamsApprovalControls.createToken();
    actionTokens.push({ token, decision });
    return {
      type: "Action.Submit",
      title: label,
      data: { openclawAction: "approval", token },
    };
  });
  const remainingSeconds = Math.max(0, Math.ceil((view.expiresAtMs - nowMs) / 1000));
  const body = [
    ...buildCardHeading(`${kindLabel} Approval Required`, `Expires in ${remainingSeconds}s`),
    ...buildApprovalSubject(view),
    buildApprovalMetadata(view.approvalId, view.metadata),
  ];
  return {
    approvalId: view.approvalId,
    approvalKind: view.approvalKind,
    expiresAtMs: view.expiresAtMs,
    card: buildAdaptiveCard(body, actions),
    actionTokens,
    allowedDecisions: view.actions.map(({ decision }) => decision),
  };
}

export function buildMSTeamsResolvedApprovalCard(
  view: ResolvedApprovalView,
): Record<string, unknown> {
  const kindLabel =
    view.approvalKind === "plugin"
      ? "Plugin"
      : view.approvalKind === "system-agent"
        ? "OpenClaw Change"
        : "Exec";
  const resolvedBy = normalizeOptionalString(view.resolvedBy);
  const decisionLabel = formatChannelApprovalResolvedLabel(view);
  return buildAdaptiveCard([
    ...buildCardHeading(
      `${kindLabel} Approval: ${decisionLabel}`,
      resolvedBy ? `Resolved by ${resolvedBy}` : "Resolved",
    ),
    ...buildApprovalSubject(view),
    buildApprovalMetadata(view.approvalId, view.metadata),
  ]);
}

export function buildMSTeamsExpiredApprovalCard(
  view: ExpiredApprovalView,
): Record<string, unknown> {
  const kindLabel =
    view.approvalKind === "plugin"
      ? "Plugin"
      : view.approvalKind === "system-agent"
        ? "OpenClaw Change"
        : "Exec";
  return buildAdaptiveCard([
    ...buildCardHeading(
      `${kindLabel} Approval Expired`,
      "This approval request expired before it was resolved.",
    ),
    ...buildApprovalSubject(view),
    buildApprovalMetadata(view.approvalId, view.metadata),
  ]);
}

export function buildMSTeamsCanonicalApprovalTerminalCard(
  result: ApprovalResolveResult,
): Record<string, unknown> {
  const { approval } = result;
  const { presentation } = approval;
  const kindLabel =
    presentation.kind === "exec"
      ? "Exec"
      : presentation.kind === "plugin"
        ? "Plugin"
        : "System Agent";
  const outcome =
    approval.status === "allowed"
      ? formatApprovalDecisionLabel(approval.decision)
      : approval.status === "denied"
        ? "Denied"
        : approval.status === "expired"
          ? "Expired"
          : "Cancelled";
  const subject: MSTeamsApprovalBodyItem[] =
    presentation.kind === "exec"
      ? [
          { type: "TextBlock", text: "Command", weight: "Bolder", wrap: true },
          {
            type: "TextBlock",
            text: presentation.commandPreview ?? presentation.commandText,
            fontType: "Monospace",
            wrap: true,
          },
        ]
      : [
          { type: "TextBlock", text: presentation.title, weight: "Bolder", wrap: true },
          { type: "TextBlock", text: presentation.description, wrap: true },
        ];
  const metadata = [
    { label: "Status", value: approval.status },
    ...("decision" in approval ? [{ label: "Decision", value: approval.decision }] : []),
    { label: "Reason", value: approval.reason },
  ];
  return buildAdaptiveCard([
    ...buildCardHeading(
      `${kindLabel} Approval: ${outcome}`,
      result.applied ? "Resolved by this action" : "Already resolved",
    ),
    ...subject,
    buildApprovalMetadata(approval.id, metadata),
  ]);
}
