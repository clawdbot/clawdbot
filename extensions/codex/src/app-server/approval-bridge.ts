import {
  type AgentApprovalEventData,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  approvalRequestExplicitlyUnavailable,
  mapExecDecisionToOutcome,
  requestPluginApproval,
  type AppServerApprovalOutcome,
  waitForPluginApprovalDecision,
} from "./plugin-approval-roundtrip.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

const PERMISSION_DESCRIPTION_MAX_LENGTH = 700;
const PERMISSION_SAMPLE_LIMIT = 2;
const PERMISSION_VALUE_MAX_LENGTH = 48;
const APPROVAL_PREVIEW_SCAN_MAX_LENGTH = 4096;
const APPROVAL_PREVIEW_OMITTED = "[preview truncated or unsafe content omitted]";
const ANSI_OSC_SEQUENCE_RE = new RegExp(
  String.raw`(?:\u001b]|\u009d)[^\u001b\u009c\u0007]*(?:\u0007|\u001b\\|\u009c)`,
  "g",
);
const ANSI_CONTROL_SEQUENCE_RE = new RegExp(
  String.raw`(?:\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_])`,
  "g",
);
const CONTROL_CHARACTER_RE = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]+`, "g");
const INVISIBLE_FORMATTING_CONTROL_RE = new RegExp(
  String.raw`[\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f\u{e0100}-\u{e01ef}]`,
  "gu",
);
const DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE = new RegExp(
  String.raw`(?:\u001b\][^\u001b\u009c\u0007]*|\u009d[^\u001b\u009c\u0007]*|\u001b\[[0-?]*[ -/]*|\u009b[0-?]*[ -/]*|\u001b)$`,
);

type ApprovalPreviewSource = {
  value: string;
  clipped: boolean;
};

type SanitizedApprovalPreview = {
  text?: string;
  omitted: boolean;
};

export async function handleCodexAppServerApprovalRequest(params: {
  method: string;
  requestParams: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  const requestParams = isJsonObject(params.requestParams) ? params.requestParams : undefined;
  if (!matchesCurrentTurn(requestParams, params.threadId, params.turnId)) {
    return undefined;
  }
  if (!isSupportedAppServerApprovalMethod(params.method)) {
    return unsupportedApprovalResponse();
  }

  const context = buildApprovalContext({
    method: params.method,
    requestParams,
    paramsForRun: params.paramsForRun,
  });

  try {
    const requestResult = await requestPluginApproval({
      paramsForRun: params.paramsForRun,
      title: context.title,
      description: context.description,
      severity: context.severity,
      toolName: context.toolName,
      toolCallId: context.itemId,
    });

    const approvalId = requestResult?.id;
    if (!approvalId) {
      emitApprovalEvent(params.paramsForRun, {
        phase: "resolved",
        kind: context.kind,
        status: "unavailable",
        title: context.title,
        ...context.eventDetails,
        ...approvalEventScope(params.method, "denied"),
        message: "Codex app-server approval route unavailable.",
      });
      return buildApprovalResponse(params.method, context.requestParams, "denied");
    }

    emitApprovalEvent(params.paramsForRun, {
      phase: "requested",
      kind: context.kind,
      status: "pending",
      title: context.title,
      approvalId,
      approvalSlug: approvalId,
      ...context.eventDetails,
      message: "Codex app-server approval requested.",
    });

    const decision = approvalRequestExplicitlyUnavailable(requestResult)
      ? null
      : await waitForPluginApprovalDecision({ approvalId, signal: params.signal });
    const outcome = mapExecDecisionToOutcome(decision);

    emitApprovalEvent(params.paramsForRun, {
      phase: "resolved",
      kind: context.kind,
      status:
        outcome === "denied"
          ? "denied"
          : outcome === "unavailable"
            ? "unavailable"
            : outcome === "cancelled"
              ? "failed"
              : "approved",
      title: context.title,
      approvalId,
      approvalSlug: approvalId,
      ...context.eventDetails,
      ...approvalEventScope(params.method, outcome),
      message: approvalResolutionMessage(outcome),
    });
    return buildApprovalResponse(params.method, context.requestParams, outcome);
  } catch (error) {
    const cancelled = params.signal?.aborted === true;
    emitApprovalEvent(params.paramsForRun, {
      phase: "resolved",
      kind: context.kind,
      status: cancelled ? "failed" : "unavailable",
      title: context.title,
      ...context.eventDetails,
      ...approvalEventScope(params.method, cancelled ? "cancelled" : "denied"),
      message: cancelled
        ? "Codex app-server approval cancelled because the run stopped."
        : `Codex app-server approval route failed: ${formatErrorMessage(error)}`,
    });
    return buildApprovalResponse(
      params.method,
      context.requestParams,
      cancelled ? "cancelled" : "denied",
    );
  }
}

export function buildApprovalResponse(
  method: string,
  requestParams: JsonObject | undefined,
  outcome: AppServerApprovalOutcome,
): JsonValue {
  if (method === "item/commandExecution/requestApproval") {
    return { decision: commandApprovalDecision(requestParams, outcome) };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: fileChangeApprovalDecision(outcome) };
  }
  if (method === "item/permissions/requestApproval") {
    if (outcome === "approved-session" || outcome === "approved-once") {
      return {
        permissions: requestedPermissions(requestParams),
        scope: outcome === "approved-session" ? "session" : "turn",
      };
    }
    return { permissions: {}, scope: "turn" };
  }
  return unsupportedApprovalResponse();
}

function matchesCurrentTurn(
  requestParams: JsonObject | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!requestParams) {
    return false;
  }
  const requestThreadId =
    readString(requestParams, "threadId") ?? readString(requestParams, "conversationId");
  const requestTurnId = readString(requestParams, "turnId");
  return requestThreadId === threadId && requestTurnId === turnId;
}

function buildApprovalContext(params: {
  method: string;
  requestParams: JsonObject | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
}) {
  const itemId =
    readString(params.requestParams, "itemId") ??
    readString(params.requestParams, "callId") ??
    readString(params.requestParams, "approvalId");
  const commandPreview = sanitizeApprovalPreview(
    readDisplayCommandPreview(params.requestParams),
    180,
  );
  const reasonPreview = sanitizeApprovalPreview(
    readStringPreview(params.requestParams, "reason"),
    180,
  );
  const command = commandPreview.text;
  const reason = reasonPreview.text;
  const kind = approvalKindForMethod(params.method);
  const permissionLines =
    params.method === "item/permissions/requestApproval"
      ? describeRequestedPermissions(params.requestParams)
      : [];
  const title =
    kind === "exec"
      ? "Codex app-server command approval"
      : params.method === "item/permissions/requestApproval"
        ? "Codex app-server permission approval"
        : kind === "plugin"
          ? "Codex app-server file approval"
          : "Codex app-server approval";
  const subject =
    permissionLines[0] ??
    (command
      ? `Command: ${formatApprovalPreviewSubject(command, commandPreview.omitted)}`
      : commandPreview.omitted
        ? `Command: ${APPROVAL_PREVIEW_OMITTED}`
        : reason
          ? `Reason: ${formatApprovalPreviewSubject(reason, reasonPreview.omitted)}`
          : reasonPreview.omitted
            ? `Reason: ${APPROVAL_PREVIEW_OMITTED}`
            : `Request method: ${params.method}`);
  const description =
    permissionLines.length > 0
      ? joinDescriptionLinesWithinLimit(permissionLines, PERMISSION_DESCRIPTION_MAX_LENGTH)
      : [subject, params.paramsForRun.sessionKey && `Session: ${params.paramsForRun.sessionKey}`]
          .filter(Boolean)
          .join("\n");
  return {
    kind,
    title,
    description,
    severity: kind === "exec" ? ("warning" as const) : ("info" as const),
    toolName:
      kind === "exec"
        ? "codex_command_approval"
        : params.method === "item/permissions/requestApproval"
          ? "codex_permission_approval"
          : "codex_file_approval",
    itemId,
    requestParams: params.requestParams,
    eventDetails: {
      ...(itemId ? { itemId } : {}),
      ...(command ? { command } : {}),
      ...(commandPreview.omitted ? { commandPreviewOmitted: true } : {}),
      ...(reason ? { reason } : {}),
      ...(reasonPreview.omitted ? { reasonPreviewOmitted: true } : {}),
    },
  };
}

function commandApprovalDecision(
  requestParams: JsonObject | undefined,
  outcome: AppServerApprovalOutcome,
): JsonValue {
  if (outcome === "cancelled") {
    return "cancel";
  }
  if (outcome === "denied" || outcome === "unavailable") {
    return "decline";
  }
  if (outcome === "approved-session") {
    if (hasAvailableDecision(requestParams, "acceptForSession")) {
      return "acceptForSession";
    }
    const amendmentDecision = findAvailableCommandAmendmentDecision(requestParams);
    if (amendmentDecision) {
      return amendmentDecision;
    }
  }
  return "accept";
}

function fileChangeApprovalDecision(outcome: AppServerApprovalOutcome): JsonValue {
  if (outcome === "cancelled") {
    return "cancel";
  }
  if (outcome === "denied" || outcome === "unavailable") {
    return "decline";
  }
  return outcome === "approved-session" ? "acceptForSession" : "accept";
}

function requestedPermissions(requestParams: JsonObject | undefined): JsonObject {
  const permissions = isJsonObject(requestParams?.permissions) ? requestParams.permissions : {};
  const granted: JsonObject = {};
  if (isJsonObject(permissions.network)) {
    granted.network = permissions.network;
  }
  if (isJsonObject(permissions.fileSystem)) {
    granted.fileSystem = permissions.fileSystem;
  }
  return granted;
}

function unsupportedApprovalResponse(): JsonValue {
  return {
    decision: "decline",
    reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
  };
}

function describeRequestedPermissions(requestParams: JsonObject | undefined): string[] {
  const permissions = requestedPermissions(requestParams);
  const lines: string[] = [];
  const kinds: string[] = [];
  const risks = new Set<string>();
  if (isJsonObject(permissions.network)) {
    kinds.push("network");
  }
  if (isJsonObject(permissions.fileSystem)) {
    kinds.push("fileSystem");
  }
  if (kinds.length > 0) {
    lines.push(`Permissions: ${kinds.join(", ")}`);
  }
  if (isJsonObject(permissions.network)) {
    const networkSummary = summarizePermissionRecord(permissions.network, risks, [
      {
        key: "allowHosts",
        label: "allowHosts",
        sanitize: sanitizePermissionHostValue,
        risksFor: permissionHostRisks,
      },
    ]);
    if (networkSummary) {
      lines.push(`Network ${networkSummary}`);
    }
  }
  if (isJsonObject(permissions.fileSystem)) {
    const fileSystemSummary = summarizePermissionRecord(permissions.fileSystem, risks, [
      {
        key: "roots",
        label: "roots",
        sanitize: sanitizePermissionPathValue,
        risksFor: permissionPathRisks,
      },
      {
        key: "readPaths",
        label: "readPaths",
        sanitize: sanitizePermissionPathValue,
        risksFor: permissionPathRisks,
      },
      {
        key: "writePaths",
        label: "writePaths",
        sanitize: sanitizePermissionPathValue,
        risksFor: permissionPathRisks,
      },
    ]);
    if (fileSystemSummary) {
      lines.push(`File system ${fileSystemSummary}`);
    }
  }
  if (risks.size > 0) {
    lines.push(`High-risk targets: ${[...risks].join(", ")}`);
  }
  return lines;
}

type PermissionArrayDescriptor = {
  key: string;
  label: string;
  sanitize: (value: string) => string;
  risksFor: (value: string) => readonly string[];
};

function summarizePermissionRecord(
  permission: JsonObject,
  risks: Set<string>,
  descriptors: readonly PermissionArrayDescriptor[],
): string | undefined {
  const details: string[] = [];
  for (const descriptor of descriptors) {
    const summary = summarizePermissionArray(permission, descriptor, risks);
    if (summary) {
      details.push(summary);
    }
  }
  return details.length > 0 ? details.join("; ") : undefined;
}

function summarizePermissionArray(
  record: JsonObject,
  descriptor: PermissionArrayDescriptor,
  risks: Set<string>,
): string | undefined {
  const values = readStringArray(record, descriptor.key);
  if (values.length === 0) {
    return undefined;
  }
  for (const value of values) {
    for (const risk of descriptor.risksFor(value)) {
      risks.add(risk);
    }
  }
  const sampleValues = values
    .slice(0, PERMISSION_SAMPLE_LIMIT)
    .map(descriptor.sanitize)
    .filter(Boolean);
  if (sampleValues.length === 0) {
    return `${descriptor.label}: ${values.length}`;
  }
  const remaining = values.length - sampleValues.length;
  const remainderSuffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return `${descriptor.label}: ${sampleValues.join(", ")}${remainderSuffix}`;
}

function readStringArray(record: JsonObject, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
    : [];
}

function sanitizePermissionHostValue(value: string): string {
  const compact = sanitizePermissionScalar(value).toLowerCase();
  const withoutScheme = compact.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? withoutScheme;
  const withoutUserInfo = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  return truncate(withoutUserInfo, PERMISSION_VALUE_MAX_LENGTH);
}

function sanitizePermissionPathValue(value: string): string {
  const normalized = sanitizePermissionScalar(value);
  const homeCompacted = normalized
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
  return truncate(homeCompacted, PERMISSION_VALUE_MAX_LENGTH);
}

function sanitizePermissionScalar(value: string): string {
  return sanitizeVisibleScalar(value);
}

function permissionHostRisks(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  const risks: string[] = [];
  if (normalized.includes("*")) {
    risks.push("wildcard hosts");
    if (isPrivateNetworkHostPattern(normalized)) {
      risks.push("private-network wildcards");
    }
  }
  return risks;
}

function permissionPathRisks(value: string): string[] {
  const normalized = sanitizePermissionPathValue(value);
  const risks: string[] = [];
  if (normalized === "/" || normalized === "\\" || /^[A-Za-z]:[\\/]*$/.test(normalized)) {
    risks.push("filesystem root");
  }
  if (normalized === "~" || normalized === "~/" || normalized === "~\\") {
    risks.push("home directory");
  }
  return risks;
}

function isPrivateNetworkHostPattern(value: string): boolean {
  const normalized = value.toLowerCase();
  const wildcardStripped = normalized.replace(/^\*\./, "");
  if (
    wildcardStripped === "localhost" ||
    wildcardStripped === "local" ||
    wildcardStripped === "internal" ||
    wildcardStripped === "lan" ||
    wildcardStripped === "home" ||
    wildcardStripped === "corp" ||
    wildcardStripped === "private" ||
    wildcardStripped.endsWith(".local") ||
    wildcardStripped.endsWith(".internal") ||
    wildcardStripped.endsWith(".lan") ||
    wildcardStripped.endsWith(".home") ||
    wildcardStripped.endsWith(".corp") ||
    wildcardStripped.endsWith(".private")
  ) {
    return true;
  }
  if (
    wildcardStripped.startsWith("10.") ||
    wildcardStripped.startsWith("127.") ||
    wildcardStripped.startsWith("192.168.") ||
    wildcardStripped.startsWith("169.254.")
  ) {
    return true;
  }
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(wildcardStripped);
}

function hasAvailableDecision(requestParams: JsonObject | undefined, decision: string): boolean {
  const available = requestParams?.availableDecisions;
  if (!Array.isArray(available)) {
    return true;
  }
  return available.includes(decision);
}

function findAvailableCommandAmendmentDecision(
  requestParams: JsonObject | undefined,
): JsonValue | undefined {
  const available = requestParams?.availableDecisions;
  if (!Array.isArray(available)) {
    return undefined;
  }
  return available.find(
    (entry): entry is JsonObject =>
      isJsonObject(entry) &&
      (isJsonObject(entry.acceptWithExecpolicyAmendment) ||
        isJsonObject(entry.applyNetworkPolicyAmendment)),
  );
}

function approvalResolutionMessage(outcome: AppServerApprovalOutcome): string {
  if (outcome === "approved-session") {
    return "Codex app-server approval granted for the session.";
  }
  if (outcome === "approved-once") {
    return "Codex app-server approval granted for this turn.";
  }
  if (outcome === "cancelled") {
    return "Codex app-server approval cancelled.";
  }
  if (outcome === "unavailable") {
    return "Codex app-server approval unavailable.";
  }
  return "Codex app-server approval denied.";
}

function approvalScopeForOutcome(outcome: AppServerApprovalOutcome): "turn" | "session" {
  return outcome === "approved-session" ? "session" : "turn";
}

function approvalEventScope(
  method: string,
  outcome: AppServerApprovalOutcome,
): Pick<AgentApprovalEventData, "scope"> {
  return method === "item/permissions/requestApproval"
    ? { scope: approvalScopeForOutcome(outcome) }
    : {};
}

function approvalKindForMethod(method: string): AgentApprovalEventData["kind"] {
  if (method.includes("commandExecution") || method.includes("execCommand")) {
    return "exec";
  }
  if (method.includes("fileChange") || method.includes("Patch") || method.includes("permissions")) {
    return "plugin";
  }
  return "unknown";
}

function isSupportedAppServerApprovalMethod(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval"
  );
}

function emitApprovalEvent(params: EmbeddedRunAttemptParams, data: AgentApprovalEventData): void {
  params.onAgentEvent?.({ stream: "approval", data: data as unknown as Record<string, unknown> });
}

function readDisplayCommandPreview(
  record: JsonObject | undefined,
): ApprovalPreviewSource | undefined {
  const actionCommand = readCommandActionsPreview(record);
  if (actionCommand) {
    return actionCommand;
  }
  return readCommandPreview(record);
}

function readCommandActionsPreview(
  record: JsonObject | undefined,
): ApprovalPreviewSource | undefined {
  const actions = record?.commandActions;
  if (!Array.isArray(actions)) {
    return undefined;
  }
  let source: ApprovalPreviewSource | undefined;
  for (const action of actions) {
    const command = isJsonObject(action) ? readString(action, "command") : undefined;
    if (!command) {
      continue;
    }
    source = appendPreviewPart(source, command, " && ");
    if (source.clipped) {
      break;
    }
  }
  return source;
}

function readCommandPreview(record: JsonObject | undefined): ApprovalPreviewSource | undefined {
  const command = record?.command;
  if (typeof command === "string") {
    return previewSource(command);
  }
  if (!Array.isArray(command)) {
    return undefined;
  }
  let source: ApprovalPreviewSource | undefined;
  for (const part of command) {
    if (typeof part !== "string") {
      return undefined;
    }
    source = appendPreviewPart(source, part, " ");
    if (source.clipped) {
      break;
    }
  }
  return source;
}

function readStringPreview(
  record: JsonObject | undefined,
  key: string,
): ApprovalPreviewSource | undefined {
  const value = readString(record, key);
  return value === undefined ? undefined : previewSource(value);
}

function readString(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function previewSource(value: string): ApprovalPreviewSource {
  return {
    value: value.slice(0, APPROVAL_PREVIEW_SCAN_MAX_LENGTH),
    clipped: value.length > APPROVAL_PREVIEW_SCAN_MAX_LENGTH,
  };
}

function appendPreviewPart(
  source: ApprovalPreviewSource | undefined,
  part: string,
  separator: string,
): ApprovalPreviewSource {
  const prefix = source?.value ? `${source.value}${separator}` : "";
  const value = `${prefix}${part}`;
  const clipped = source?.clipped === true || value.length > APPROVAL_PREVIEW_SCAN_MAX_LENGTH;
  return {
    value: value.slice(0, APPROVAL_PREVIEW_SCAN_MAX_LENGTH),
    clipped,
  };
}

function sanitizeApprovalPreview(
  source: ApprovalPreviewSource | undefined,
  maxLength: number,
): SanitizedApprovalPreview {
  if (!source || !source.value) {
    return { omitted: false };
  }
  const rawPreview = source.value.replace(DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE, "");
  const sanitized = sanitizeVisibleScalar(rawPreview);
  if (!sanitized) {
    return { omitted: true };
  }
  return { text: truncate(sanitized, maxLength), omitted: source.clipped };
}

function sanitizeVisibleScalar(value: string): string {
  return value
    .replace(ANSI_OSC_SEQUENCE_RE, "")
    .replace(ANSI_CONTROL_SEQUENCE_RE, "")
    .replace(INVISIBLE_FORMATTING_CONTROL_RE, " ")
    .replace(CONTROL_CHARACTER_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatApprovalPreviewSubject(text: string, omitted: boolean): string {
  return omitted ? `${text} ${APPROVAL_PREVIEW_OMITTED}` : text;
}

function joinDescriptionLinesWithinLimit(lines: string[], maxLength: number): string {
  let description = "";
  for (const line of lines) {
    const prefix = description ? "\n" : "";
    const next = `${description}${prefix}${line}`;
    if (next.length <= maxLength) {
      description = next;
      continue;
    }
    const remaining = maxLength - description.length - prefix.length;
    if (remaining < 3) {
      break;
    }
    description += `${prefix}${truncate(line, remaining)}`;
    break;
  }
  return description;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
