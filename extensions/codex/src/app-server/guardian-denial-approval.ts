import { z } from "zod";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

const CONTEXTUAL_GUARDIAN_APPROVAL_MAX_AGE_MS = 10 * 60_000;

const guardianDeniedEventSchema = z
  .object({
    id: z.string().trim().min(1),
    target_item_id: z.string().trim().min(1).optional(),
    turn_id: z.string().trim().min(1),
    started_at_ms: z.number().finite(),
    completed_at_ms: z.number().finite(),
    status: z.literal("denied"),
    risk_level: z.string().trim().min(1).optional(),
    user_authorization: z.string().trim().min(1).optional(),
    rationale: z.string().optional(),
    decision_source: z.string().trim().min(1).optional(),
    action: z.record(z.string(), z.custom<JsonValue>()),
  })
  .strict();

export const pendingGuardianDeniedActionSchema = z
  .object({
    recordedAtMs: z.number().finite().nonnegative(),
    event: guardianDeniedEventSchema,
  })
  .strict();

export type CodexPendingGuardianDeniedAction = z.infer<typeof pendingGuardianDeniedActionSchema>;

type GuardianApprovalRequest = (
  method: "thread/approveGuardianDeniedAction",
  params: { threadId: string; event: CodexPendingGuardianDeniedAction["event"] },
) => Promise<unknown>;

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(record: JsonObject, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(record: JsonObject, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function readOptionalString(record: JsonObject, key: string): string | null | undefined {
  const value = record[key];
  return value === null || typeof value === "string" ? value : undefined;
}

function normalizeGuardianCommandSource(source: string | undefined): string | undefined {
  return source === "unifiedExec" ? "unified_exec" : source === "shell" ? source : undefined;
}

function normalizeGuardianAction(action: JsonObject): JsonObject | undefined {
  const type = readString(action, "type");
  if (type === "command") {
    const source = normalizeGuardianCommandSource(readString(action, "source"));
    const command = readString(action, "command");
    const cwd = readString(action, "cwd");
    return source && command && cwd ? { type, source, command, cwd } : undefined;
  }
  if (type === "execve") {
    const source = normalizeGuardianCommandSource(readString(action, "source"));
    const program = readString(action, "program");
    const argv = readStringArray(action, "argv");
    const cwd = readString(action, "cwd");
    return source && program && argv && cwd ? { type, source, program, argv, cwd } : undefined;
  }
  if (type === "applyPatch") {
    const cwd = readString(action, "cwd");
    const files = readStringArray(action, "files");
    return cwd && files ? { type: "apply_patch", cwd, files } : undefined;
  }
  if (type === "networkAccess") {
    const target = readString(action, "target");
    const host = readString(action, "host");
    const protocol = readString(action, "protocol");
    const port = readNumber(action, "port");
    return target && host && protocol && port !== undefined
      ? { type: "network_access", target, host, protocol, port }
      : undefined;
  }
  if (type === "mcpToolCall") {
    const server = readString(action, "server");
    const toolName = readString(action, "toolName");
    const connectorId = readOptionalString(action, "connectorId");
    const connectorName = readOptionalString(action, "connectorName");
    const toolTitle = readOptionalString(action, "toolTitle");
    return server && toolName && connectorId !== undefined && connectorName !== undefined
      ? {
          type: "mcp_tool_call",
          server,
          tool_name: toolName,
          connector_id: connectorId,
          connector_name: connectorName,
          tool_title: toolTitle ?? null,
        }
      : undefined;
  }
  if (type === "requestPermissions") {
    const reason = readOptionalString(action, "reason");
    const permissions = isJsonObject(action.permissions) ? action.permissions : undefined;
    return reason !== undefined && permissions
      ? { type: "request_permissions", reason, permissions }
      : undefined;
  }
  return undefined;
}

/** Converts one terminal Codex Guardian denial notification into its exact approval RPC payload. */
export function buildPendingGuardianDeniedAction(
  params: JsonObject,
  recordedAtMs = Date.now(),
): CodexPendingGuardianDeniedAction | undefined {
  const review = isJsonObject(params.review) ? params.review : undefined;
  const action = isJsonObject(params.action) ? normalizeGuardianAction(params.action) : undefined;
  const id = readString(params, "reviewId");
  const turnId = readString(params, "turnId");
  const startedAtMs = readNumber(params, "startedAtMs");
  const completedAtMs = readNumber(params, "completedAtMs");
  if (
    !review ||
    readString(review, "status") !== "denied" ||
    !action ||
    !id ||
    !turnId ||
    startedAtMs === undefined ||
    completedAtMs === undefined
  ) {
    return undefined;
  }
  const targetItemId = readString(params, "targetItemId");
  const riskLevel = readString(review, "riskLevel");
  const userAuthorization = readString(review, "userAuthorization");
  const rationale = readOptionalString(review, "rationale");
  const decisionSource = readString(params, "decisionSource");
  return pendingGuardianDeniedActionSchema.parse({
    recordedAtMs,
    event: {
      id,
      ...(targetItemId ? { target_item_id: targetItemId } : {}),
      turn_id: turnId,
      started_at_ms: startedAtMs,
      completed_at_ms: completedAtMs,
      status: "denied",
      ...(riskLevel ? { risk_level: riskLevel } : {}),
      ...(userAuthorization ? { user_authorization: userAuthorization } : {}),
      ...(rationale !== undefined && rationale !== null ? { rationale } : {}),
      ...(decisionSource ? { decision_source: decisionSource } : {}),
      action,
    },
  });
}

/** Recognizes a narrow affirmative reply without accepting negation or generic continuation. */
export function isContextualGuardianApproval(prompt: string): boolean {
  return /^(?:yes|approved|approve|go ahead|do it)(?:[.!]|\s*(?:&|and\b).*)?$/iu.test(
    prompt.trim(),
  );
}

/** Applies one exact pending denial approval, then consumes it only after Codex accepts it. */
export async function consumePendingGuardianDeniedAction(params: {
  pending: CodexPendingGuardianDeniedAction | undefined;
  prompt: string;
  threadId: string;
  nowMs?: number;
  request: GuardianApprovalRequest;
  clear: () => Promise<boolean>;
}): Promise<"absent" | "approved" | "expired" | "unrelated"> {
  if (!params.pending) {
    return "absent";
  }
  const nowMs = params.nowMs ?? Date.now();
  if (nowMs - params.pending.recordedAtMs > CONTEXTUAL_GUARDIAN_APPROVAL_MAX_AGE_MS) {
    if (!(await params.clear())) {
      throw new Error("expired Codex Guardian approval could not be cleared");
    }
    return "expired";
  }
  if (!isContextualGuardianApproval(params.prompt)) {
    if (!(await params.clear())) {
      throw new Error("unrelated reply could not clear the pending Codex Guardian approval");
    }
    return "unrelated";
  }
  await params.request("thread/approveGuardianDeniedAction", {
    threadId: params.threadId,
    event: params.pending.event,
  });
  if (!(await params.clear())) {
    throw new Error(
      "Codex Guardian approval was accepted but its pending binding could not be consumed",
    );
  }
  return "approved";
}
