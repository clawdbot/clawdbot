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
} from "../../infra/exec-approval-text-sanitize.js";

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

type AcpPermissionOptionKind = AcpPermissionRequest["options"][number]["kind"];
type AcpApprovalDecision = NonNullable<
  NonNullable<Parameters<AcpApprovalHost["requestApproval"]>[0]["allowedDecisions"]>[number]
>;

/**
 * ACP decisions carry only an outcome, so the harness resolves it against the
 * offered options and falls back across persistence (allow_once -> allow_always,
 * reject_once -> reject_always). Returning an outcome whose exact kind was not
 * offered would therefore grant persistence the operator never selected.
 */
function offeredOptionKinds(request: AcpPermissionRequest): Set<AcpPermissionOptionKind> {
  return new Set(request.options.map((option) => option.kind));
}

/**
 * Mirrors the harness capabilities the same way the Codex app-server bridge
 * derives its decisions. `reject_always` is intentionally absent: OpenClaw has no
 * persistent-denial decision, so labeling it "deny" would hide a standing block
 * the operator did not ask for and cannot inspect from OpenClaw.
 */
function offeredDecisions(offeredKinds: Set<AcpPermissionOptionKind>): AcpApprovalDecision[] {
  const decisions: AcpApprovalDecision[] = [];
  if (offeredKinds.has("allow_once")) {
    decisions.push("allow-once");
  }
  if (offeredKinds.has("allow_always")) {
    decisions.push("allow-always");
  }
  if (offeredKinds.has("reject_once")) {
    decisions.push("deny");
  }
  return decisions;
}

function mapApprovalDecision(
  decision: "allow-once" | "allow-always" | "deny" | null | undefined,
  offeredKinds: Set<AcpPermissionOptionKind>,
): AcpPermissionDecision {
  if (decision === "allow-once") {
    return offeredKinds.has("allow_once") ? { outcome: "allow_once" } : { outcome: "cancel" };
  }
  if (decision === "allow-always") {
    return offeredKinds.has("allow_always") ? { outcome: "allow_always" } : { outcome: "cancel" };
  }
  if (decision === "deny") {
    return offeredKinds.has("reject_once") ? { outcome: "reject_once" } : { outcome: "cancel" };
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
    const offeredKinds = offeredOptionKinds(request);
    const allowedDecisions = offeredDecisions(offeredKinds);
    // Nothing the operator could choose maps onto an offered option, so there is
    // no honest prompt to show.
    if (allowedDecisions.length === 0) {
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
        allowedDecisions,
        timeoutMs: ACP_PERMISSION_TIMEOUT_MS,
        transportTimeoutMs: ACP_PERMISSION_TRANSPORT_TIMEOUT_MS,
      });
      if (context.signal.aborted) {
        return { outcome: "cancel" };
      }
      if (requested?.decision) {
        return mapApprovalDecision(requested.decision, offeredKinds);
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
        : mapApprovalDecision(resolved?.decision, offeredKinds);
    } catch {
      return { outcome: "cancel" };
    }
  };
}
