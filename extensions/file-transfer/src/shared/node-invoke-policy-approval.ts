import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { appendFileTransferAudit, type FileTransferAuditOp } from "./audit.js";
import type { FileTransferNodeInvokeCommand } from "./node-invoke-policy-commands.js";
import { evaluateFilePolicy, type FilePolicyKind } from "./policy.js";

export type GrantedAuthorization = {
  ok: true;
  source: "authored" | "literal" | "approval";
  persist: boolean;
  expectedCanonicalPath?: string;
  pendingReapprovalSelector?: string;
  followSymlinks: boolean;
  maxBytes?: number;
};

export function commandKind(command: FileTransferNodeInvokeCommand): FilePolicyKind {
  return command === "file.write" ? "write" : "read";
}

export function promptVerb(command: FileTransferNodeInvokeCommand): string {
  switch (command) {
    case "dir.fetch":
      return "Fetch directory";
    case "dir.list":
      return "List directory";
    case "file.write":
      return "Write file";
    case "file.fetch":
      return "Read file";
  }
  return command;
}

export async function requestApproval(input: {
  ctx: OpenClawPluginNodeInvokePolicyContext;
  op: FileTransferAuditOp;
  kind: FilePolicyKind;
  path: string;
  startedAt: number;
}): Promise<GrantedAuthorization | { ok: false; message: string; code: string }> {
  const nodeDisplayName = input.ctx.node?.displayName;
  const decision = evaluateFilePolicy({
    nodeId: input.ctx.nodeId,
    nodeDisplayName,
    kind: input.kind,
    command: input.op,
    path: input.path,
    pluginConfig: input.ctx.pluginConfig,
  });

  if (decision.ok && decision.reason === "matched-allow") {
    return {
      ok: true,
      source: "authored",
      persist: false,
      followSymlinks: decision.followSymlinks,
      maxBytes: decision.maxBytes,
    };
  }
  if (decision.ok && decision.reason === "matched-literal") {
    return {
      ok: true,
      source: "literal",
      persist: false,
      expectedCanonicalPath: decision.expectedCanonicalPath,
      followSymlinks: decision.followSymlinks,
      maxBytes: decision.maxBytes,
    };
  }

  const shouldAsk =
    (decision.ok && decision.reason === "ask-always") || (!decision.ok && decision.askable);
  if (!shouldAsk) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.path,
      decision:
        !decision.ok && decision.code === "NO_POLICY" ? "denied:no_policy" : "denied:policy",
      errorCode: decision.ok ? undefined : decision.code,
      reason: decision.reason,
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      code: decision.ok ? "POLICY_DENIED" : decision.code,
      message: `${input.op} ${decision.ok ? "POLICY_DENIED" : decision.code}: ${decision.reason}`,
    };
  }

  const approvals = input.ctx.approvals;
  if (!approvals) {
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.path,
      decision: "denied:approval",
      reason: "plugin approvals unavailable",
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      code: "APPROVAL_UNAVAILABLE",
      message: `${input.op} APPROVAL_UNAVAILABLE: plugin approvals unavailable`,
    };
  }

  const verb = promptVerb(input.op);
  const subject = nodeDisplayName ?? input.ctx.nodeId;
  const approval = await approvals.request({
    title: `${verb}: ${input.path}`,
    description: `${
      input.op === "dir.fetch"
        ? `Allow ${verb.toLowerCase()} on ${subject}\nPath: ${input.path}\n\nThis fetch includes descendants of this directory; deny rules still apply.`
        : `Allow ${verb.toLowerCase()} on ${subject}\nPath: ${input.path}`
    }\nNode ID: ${input.ctx.nodeId}\n\n"allow-always" saves this exact command and path for this node.`,
    severity: input.kind === "write" ? "warning" : "info",
    toolName: input.op,
  });
  const approvalDecision: unknown = approval.decision;

  if (approvalDecision !== "allow-once" && approvalDecision !== "allow-always") {
    const unavailable = approvalDecision === null || approvalDecision === undefined;
    const deniedByOperator = approvalDecision === "deny";
    const reason = deniedByOperator
      ? "operator denied"
      : unavailable
        ? "no operator available"
        : "invalid approval decision";
    await appendFileTransferAudit({
      op: input.op,
      nodeId: input.ctx.nodeId,
      nodeDisplayName,
      requestedPath: input.path,
      decision: "denied:approval",
      reason,
      durationMs: Date.now() - input.startedAt,
    });
    return {
      ok: false,
      code: unavailable ? "APPROVAL_UNAVAILABLE" : "APPROVAL_DENIED",
      message: unavailable
        ? `${input.op} APPROVAL_UNAVAILABLE: no operator client connected to approve the request`
        : deniedByOperator
          ? `${input.op} APPROVAL_DENIED: operator denied the prompt`
          : `${input.op} APPROVAL_DENIED: invalid approval decision`,
    };
  }

  await appendFileTransferAudit({
    op: input.op,
    nodeId: input.ctx.nodeId,
    nodeDisplayName,
    requestedPath: input.path,
    decision: approvalDecision === "allow-always" ? "allowed:always" : "allowed:once",
    durationMs: Date.now() - input.startedAt,
  });
  return {
    ok: true,
    source: "approval",
    persist: approvalDecision === "allow-always",
    followSymlinks: decision.followSymlinks ?? false,
    maxBytes: decision.maxBytes,
    pendingReapprovalSelector: decision.pendingReapprovalSelector,
  };
}
