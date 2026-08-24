import type {
  AcpPermissionDecision,
  AcpPermissionHandler,
  AcpPermissionRequest,
} from "@openclaw/acp-core/runtime/types";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentHarnessHostCapabilities } from "../../agents/harness/host-capability-types.js";
import {
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalWarningText,
} from "../../infra/exec-approval-command-display.js";

const ACP_PERMISSION_TIMEOUT_MS = 600_000;
const ACP_PERMISSION_TRANSPORT_TIMEOUT_MS = ACP_PERMISSION_TIMEOUT_MS + 5_000;

type AcpApprovalHost = Pick<
  AgentHarnessHostCapabilities,
  "assertActive" | "requestApproval" | "waitForApproval"
>;

function readCommand(request: AcpPermissionRequest): string | undefined {
  const input = asNullableRecord(request.toolCall.rawInput);
  const command =
    typeof input?.command === "string"
      ? input.command.trim()
      : typeof input?.cmd === "string"
        ? input.cmd.trim()
        : "";
  if (!command) {
    return undefined;
  }
  const args = Array.isArray(input?.args)
    ? input.args.filter((value): value is string => typeof value === "string")
    : [];
  return [command, ...args].join(" ");
}

function approvalDisplay(request: AcpPermissionRequest, cwd: string | undefined) {
  const kind = request.inferredKind ?? request.toolCall.kind ?? "other";
  const command = readCommand(request);
  const rawTitle = command || request.toolCall.title?.trim() || `ACP ${kind} permission`;
  const details = [
    `ACP tool kind: ${kind}.`,
    cwd ? `Working directory: ${cwd}.` : null,
    command ? `Command: ${command}` : null,
  ].filter((value): value is string => Boolean(value));
  return {
    kind,
    title: sanitizeExecApprovalDisplayText(rawTitle),
    description: sanitizeExecApprovalWarningText(details.join(" ")),
  };
}

function mapApprovalDecision(
  decision: "allow-once" | "allow-always" | "deny" | null | undefined,
): AcpPermissionDecision {
  if (decision === "allow-once") {
    return { outcome: "allow_once" };
  }
  if (decision === "allow-always") {
    return { outcome: "allow_always" };
  }
  if (decision === "deny") {
    return { outcome: "reject_once" };
  }
  return { outcome: "cancel" };
}

/** Creates the turn-owned bridge from ACP permission RPCs to plugin approvals. */
export function createAcpPermissionHandler(params: {
  host: AcpApprovalHost;
  cwd?: string;
}): AcpPermissionHandler {
  return async (request, context) => {
    const kind = request.inferredKind ?? request.toolCall.kind;
    if (kind === "read" || kind === "search") {
      return undefined;
    }
    if (context.signal.aborted) {
      return { outcome: "cancel" };
    }
    try {
      params.host.assertActive();
      const display = approvalDisplay(request, params.cwd);
      const requested = await params.host.requestApproval({
        title: display.title,
        description: display.description,
        severity: display.kind === "think" || display.kind === "other" ? "info" : "warning",
        toolName: `acp:${display.kind}`,
        toolCallId: request.toolCall.toolCallId,
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: ACP_PERMISSION_TIMEOUT_MS,
        transportTimeoutMs: ACP_PERMISSION_TRANSPORT_TIMEOUT_MS,
      });
      if (context.signal.aborted) {
        return { outcome: "cancel" };
      }
      if (requested?.decision) {
        return mapApprovalDecision(requested.decision);
      }
      if (!requested?.id) {
        return { outcome: "cancel" };
      }
      const resolved = await params.host.waitForApproval({
        approvalId: requested.id,
        timeoutMs: ACP_PERMISSION_TIMEOUT_MS,
        transportTimeoutMs: ACP_PERMISSION_TRANSPORT_TIMEOUT_MS,
        signal: context.signal,
      });
      return context.signal.aborted
        ? { outcome: "cancel" }
        : mapApprovalDecision(resolved?.decision);
    } catch {
      return { outcome: "cancel" };
    }
  };
}
