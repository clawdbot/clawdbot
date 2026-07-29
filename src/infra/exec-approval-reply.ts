import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isWellFormedApprovalId } from "../../packages/gateway-protocol/src/schema/approval-id.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type {
  MessagePresentation,
  MessagePresentationAction,
  MessagePresentationButton,
} from "../interactive/payload.js";
import { formatHumanList } from "../shared/human-list.js";
// Builds reply payloads for exec approval prompts and outcomes.
import { formatFencedCodeBlock } from "../shared/markdown-code.js";
import { formatApprovalDisplayPath } from "./approval-display-paths.js";
import {
  describeNativeExecApprovalClientSetup,
  listNativeExecApprovalClientLabels,
  supportsNativeExecApprovalClient,
} from "./exec-approval-surface.js";
import {
  resolveExecApprovalAllowedDecisions,
  type ExecApprovalDecision,
  type ExecHost,
} from "./exec-approvals.js";

export type ExecApprovalReplyDecision = ExecApprovalDecision;
export type ExecApprovalUnavailableReason =
  | "initiating-platform-disabled"
  | "initiating-platform-unsupported"
  | "no-approval-route";

export type ExecApprovalReplyMetadata = {
  approvalId: string;
  approvalSlug: string;
  approvalKind: "exec" | "plugin";
  agentId?: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  sessionKey?: string;
};

export type ExecApprovalActionDescriptor = {
  decision: ExecApprovalReplyDecision;
  label: string;
  style: NonNullable<MessagePresentationButton["style"]>;
  /** Optional semantic action; omitted by the shipped command-backed builders. */
  action?: MessagePresentationAction;
  /** Copyable text fallback retained for non-interactive approval surfaces. */
  command: string;
};

/** Approval descriptor guaranteed to carry a canonical typed approval action. */
export type TypedApprovalActionDescriptor = ExecApprovalActionDescriptor & {
  action: Extract<MessagePresentationAction, { type: "approval" }>;
};

export type ExecApprovalPendingReplyParams = {
  warningText?: string;
  approvalId: string;
  approvalSlug: string;
  approvalCommandId?: string;
  ask?: string | null;
  agentId?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  command: string;
  cwd?: string;
  host: ExecHost;
  nodeId?: string;
  sessionKey?: string | null;
  expiresAtMs?: number;
  nowMs?: number;
};

export type ExecApprovalUnavailableReplyParams = {
  warningText?: string;
  channel?: string;
  channelLabel?: string;
  accountId?: string;
  reason: ExecApprovalUnavailableReason;
  sentApproverDms?: boolean;
  host?: ExecHost;
  nodeId?: string;
};

function resolveNativeExecApprovalClientList(params?: { excludeChannel?: string }): string {
  return formatHumanList(
    listNativeExecApprovalClientLabels({
      excludeChannel: params?.excludeChannel,
    }),
  );
}

function buildGenericNativeExecApprovalFallbackText(params?: {
  excludeChannel?: string;
  host?: ExecHost;
  nodeId?: string;
}): string {
  const clients = resolveNativeExecApprovalClientList({
    excludeChannel: params?.excludeChannel,
  });
  let manualRecovery =
    "Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox.";
  if (params?.host === "node") {
    const nodeId = normalizeOptionalString(params.nodeId) ?? "<id|name|ip>";
    manualRecovery += ` Inspect the node's effective exec policy with \`openclaw approvals get --node ${nodeId}\`.`;
  }
  return clients
    ? `Approve it from the Web UI or terminal UI, or enable a native chat approval client such as ${clients}. ${manualRecovery} If those accounts already know your owner ID via allowFrom or owner config, OpenClaw can often infer approvers automatically.`
    : `Approve it from the Web UI or terminal UI. ${manualRecovery}`;
}

function resolveAllowedDecisions(params: {
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): readonly ExecApprovalReplyDecision[] {
  return params.allowedDecisions ?? resolveExecApprovalAllowedDecisions({ ask: params.ask });
}

function buildApprovalCommandFence(
  descriptors: readonly ExecApprovalActionDescriptor[],
): string | null {
  if (descriptors.length === 0) {
    return null;
  }
  return formatFencedCodeBlock(
    descriptors.map((descriptor) => descriptor.command).join("\n"),
    "txt",
  );
}

export function buildExecApprovalCommandText(params: {
  approvalCommandId: string;
  decision: ExecApprovalReplyDecision;
}): string {
  return `/approve ${params.approvalCommandId} ${params.decision}`;
}

type BuildExecApprovalActionDescriptorsParams = {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
};

function buildApprovalActionDescriptors(
  approvalCommandId: string,
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): ExecApprovalActionDescriptor[] {
  const descriptors: ExecApprovalActionDescriptor[] = [];
  const buildDescriptor = (descriptor: {
    decision: ExecApprovalReplyDecision;
    label: string;
    style: ExecApprovalActionDescriptor["style"];
  }): ExecApprovalActionDescriptor => {
    return {
      ...descriptor,
      command: buildExecApprovalCommandText({
        approvalCommandId,
        decision: descriptor.decision,
      }),
    };
  };
  if (allowedDecisions.includes("allow-once")) {
    descriptors.push(
      buildDescriptor({
        decision: "allow-once",
        label: "Allow Once",
        style: "success",
      }),
    );
  }
  if (allowedDecisions.includes("allow-always")) {
    descriptors.push(
      buildDescriptor({
        decision: "allow-always",
        label: "Allow Always",
        style: "primary",
      }),
    );
  }
  if (allowedDecisions.includes("deny")) {
    descriptors.push(
      buildDescriptor({
        decision: "deny",
        label: "Deny",
        style: "danger",
      }),
    );
  }
  return descriptors;
}

export function buildExecApprovalActionDescriptors(
  params: BuildExecApprovalActionDescriptorsParams,
): ExecApprovalActionDescriptor[] {
  const approvalCommandId = params.approvalCommandId.trim();
  return approvalCommandId
    ? buildApprovalActionDescriptors(approvalCommandId, resolveAllowedDecisions(params))
    : [];
}

/** Build approval descriptors with explicit owner-aware typed actions. */
export function buildTypedApprovalActionDescriptors(
  params: BuildExecApprovalActionDescriptorsParams & {
    approvalKind: "exec" | "plugin";
  },
): TypedApprovalActionDescriptor[] {
  const approvalId = params.approvalCommandId;
  if (!isWellFormedApprovalId(approvalId)) {
    return [];
  }
  return buildApprovalActionDescriptors(approvalId, resolveAllowedDecisions(params)).map(
    (descriptor) => {
      return {
        decision: descriptor.decision,
        label: descriptor.label,
        style: descriptor.style,
        command: descriptor.command,
        action: {
          type: "approval",
          approvalId,
          approvalKind: params.approvalKind,
          decision: descriptor.decision,
        },
      };
    },
  );
}

function buildApprovalPresentationButtons(
  descriptors: readonly ExecApprovalActionDescriptor[],
): MessagePresentationButton[] {
  return descriptors.map((descriptor) => {
    const action =
      descriptor.action ??
      ({ type: "command", command: descriptor.command } satisfies MessagePresentationAction);
    return {
      label: descriptor.label,
      action,
      ...(descriptor.action ? {} : { value: descriptor.command }),
      style: descriptor.style,
    };
  });
}

/** Build portable approval controls from decision descriptors. */
export function buildApprovalPresentationFromActionDescriptors(
  actions: readonly ExecApprovalActionDescriptor[],
): MessagePresentation | undefined {
  const buttons = buildApprovalPresentationButtons(actions);
  return buttons.length > 0 ? { blocks: [{ type: "buttons", buttons }] } : undefined;
}

type BuildApprovalPresentationParams = {
  approvalId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
};

/** Build the shipped command-backed portable approval controls. */
export function buildApprovalPresentation(
  params: BuildApprovalPresentationParams,
): MessagePresentation | undefined {
  return buildApprovalPresentationFromActionDescriptors(
    buildExecApprovalActionDescriptors({
      approvalCommandId: params.approvalId,
      ask: params.ask,
      allowedDecisions: params.allowedDecisions,
    }),
  );
}

/** Build portable approval controls with explicit owner-aware typed actions. */
export function buildTypedApprovalPresentation(
  params: BuildApprovalPresentationParams & { approvalKind: "exec" | "plugin" },
): MessagePresentation | undefined {
  return buildApprovalPresentationFromActionDescriptors(
    buildTypedApprovalActionDescriptors({
      approvalCommandId: params.approvalId,
      approvalKind: params.approvalKind,
      ask: params.ask,
      allowedDecisions: params.allowedDecisions,
    }),
  );
}

/** Build the shipped command-backed exec-approval presentation. */
export function buildExecApprovalPresentation(params: {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): MessagePresentation | undefined {
  return buildApprovalPresentation({
    approvalId: params.approvalCommandId,
    ask: params.ask,
    allowedDecisions: params.allowedDecisions,
  });
}

/** Build an exec-approval presentation with canonical typed decision actions. */
export function buildTypedExecApprovalPresentation(params: {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): MessagePresentation | undefined {
  return buildTypedApprovalPresentation({
    approvalId: params.approvalCommandId,
    approvalKind: "exec",
    ask: params.ask,
    allowedDecisions: params.allowedDecisions,
  });
}

export function getExecApprovalApproverDmNoticeText(): string {
  return "Approval required. I sent approval DMs to the approvers for this account.";
}

export function parseExecApprovalCommandText(
  raw: string,
): { approvalId: string; decision: ExecApprovalReplyDecision } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(
    /^\/?approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i,
  );
  if (!match) {
    return null;
  }
  const rawDecision = normalizeOptionalLowercaseString(match[2]) ?? "";
  return {
    approvalId: expectDefined(match[1], "exec approval reply regex capture 1"),
    decision:
      rawDecision === "always" ? "allow-always" : (rawDecision as ExecApprovalReplyDecision),
  };
}

export function formatExecApprovalExpiresIn(expiresAtMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.round((expiresAtMs - nowMs) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (hours === 0 && minutes < 5 && seconds > 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ");
}

export function getExecApprovalReplyMetadata(
  payload: ReplyPayload,
): ExecApprovalReplyMetadata | null {
  const channelData = payload.channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return null;
  }
  const execApproval = channelData.execApproval;
  if (!execApproval || typeof execApproval !== "object" || Array.isArray(execApproval)) {
    return null;
  }
  const record = execApproval as Record<string, unknown>;
  const approvalId = normalizeOptionalString(record.approvalId) ?? "";
  const approvalSlug = normalizeOptionalString(record.approvalSlug) ?? "";
  if (!approvalId || !approvalSlug) {
    return null;
  }
  const approvalKind = record.approvalKind === "plugin" ? "plugin" : "exec";
  const allowedDecisions = Array.isArray(record.allowedDecisions)
    ? record.allowedDecisions.filter(
        (value): value is ExecApprovalReplyDecision =>
          value === "allow-once" || value === "allow-always" || value === "deny",
      )
    : undefined;
  const agentId = normalizeOptionalString(record.agentId);
  const sessionKey = normalizeOptionalString(record.sessionKey);
  return {
    approvalId,
    approvalSlug,
    approvalKind,
    agentId,
    allowedDecisions,
    sessionKey,
  };
}

export function buildExecApprovalPendingReplyPayload(
  params: ExecApprovalPendingReplyParams,
): ReplyPayload {
  const approvalCommandId = params.approvalCommandId?.trim() || params.approvalSlug;
  const allowedDecisions = resolveAllowedDecisions(params);
  const descriptors = buildExecApprovalActionDescriptors({
    approvalCommandId,
    allowedDecisions,
  });
  const primaryAction = descriptors[0] ?? null;
  const secondaryActions = descriptors.slice(1);
  const lines: string[] = [];
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText);
  }
  lines.push("Approval required.");
  if (primaryAction) {
    lines.push("Run:");
    lines.push(formatFencedCodeBlock(primaryAction.command, "txt"));
  }
  lines.push("Pending command:");
  lines.push(formatFencedCodeBlock(params.command, "sh"));
  const secondaryFence = buildApprovalCommandFence(secondaryActions);
  if (secondaryFence) {
    lines.push("Other options:");
    lines.push(secondaryFence);
  }
  if (!allowedDecisions.includes("allow-always")) {
    lines.push("Allow Always is unavailable for this command.");
  }
  const info: string[] = [];
  info.push(`Host: ${params.host}`);
  if (params.nodeId) {
    info.push(`Node: ${params.nodeId}`);
  }
  if (params.cwd) {
    info.push(`CWD: ${formatApprovalDisplayPath(params.cwd)}`);
  }
  if (typeof params.expiresAtMs === "number" && Number.isFinite(params.expiresAtMs)) {
    info.push(
      `Expires in: ${formatExecApprovalExpiresIn(params.expiresAtMs, params.nowMs ?? Date.now())}`,
    );
  }
  info.push(`Full id: \`${params.approvalId}\``);
  lines.push(info.join("\n"));

  return {
    text: lines.join("\n\n"),
    presentation: buildApprovalPresentation({
      approvalId: params.approvalId,
      allowedDecisions,
    }),
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        approvalKind: "exec",
        agentId: normalizeOptionalString(params.agentId),
        allowedDecisions,
        sessionKey: normalizeOptionalString(params.sessionKey),
      },
    },
  };
}

/** Build an exec approval prompt with canonical typed decision actions. */
export function buildTypedExecApprovalPendingReplyPayload(
  params: ExecApprovalPendingReplyParams,
): ReplyPayload {
  const payload = buildExecApprovalPendingReplyPayload(params);
  return {
    ...payload,
    presentation: buildTypedExecApprovalPresentation({
      approvalCommandId: params.approvalId,
      allowedDecisions: resolveAllowedDecisions(params),
    }),
  };
}

export function buildExecApprovalUnavailableReplyPayload(
  params: ExecApprovalUnavailableReplyParams,
): ReplyPayload {
  const lines: string[] = [];
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText);
  }

  if (params.sentApproverDms) {
    lines.push(getExecApprovalApproverDmNoticeText());
    return {
      text: lines.join("\n\n"),
    };
  }

  if (params.reason === "initiating-platform-disabled") {
    lines.push(
      `Exec approval is required, but native chat exec approvals are not configured on ${params.channelLabel ?? "this platform"}.`,
    );
    const channel = normalizeOptionalLowercaseString(params.channel);
    const setupText =
      channel && params.channelLabel && supportsNativeExecApprovalClient(channel)
        ? describeNativeExecApprovalClientSetup({
            channel,
            channelLabel: params.channelLabel,
            accountId: params.accountId,
          })
        : null;
    if (setupText) {
      lines.push(setupText);
    } else {
      lines.push(
        buildGenericNativeExecApprovalFallbackText({
          host: params.host,
          nodeId: params.nodeId,
        }),
      );
    }
  } else if (params.reason === "initiating-platform-unsupported") {
    lines.push(
      `Exec approval is required, but ${params.channelLabel ?? "this platform"} does not support chat exec approvals.`,
    );
    lines.push(
      buildGenericNativeExecApprovalFallbackText({
        excludeChannel: params.channel,
        host: params.host,
        nodeId: params.nodeId,
      }),
    );
  } else {
    lines.push(
      "Exec approval is required, but no interactive approval client is currently available.",
    );
    lines.push(
      `${buildGenericNativeExecApprovalFallbackText({
        host: params.host,
        nodeId: params.nodeId,
      })} Then retry the command. You can usually leave execApprovals.approvers unset when owner config already identifies the approvers.`,
    );
  }

  return {
    text: lines.join("\n\n"),
  };
}
