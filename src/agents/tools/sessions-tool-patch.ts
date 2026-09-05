import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  SESSIONS_PATCH_MANY_MAX_TARGETS,
  type SessionsPatchManyResult,
  type SessionsPatchManyTarget,
  type SessionsPatchMutation,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../config/sessions/lifecycle.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import { readToolStringParam, ToolInputError } from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { recordSessionToolActionFact } from "./sessions-access.js";

const SESSIONS_TOOL_RESULT_MAX_BYTES = 3_840;

export function sessionsToolResultFitsBudget(payload: Record<string, unknown>): boolean {
  const compactSize = boundedJsonUtf8Bytes(payload, SESSIONS_TOOL_RESULT_MAX_BYTES);
  return (
    compactSize.complete &&
    compactSize.bytes <= SESSIONS_TOOL_RESULT_MAX_BYTES &&
    Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8") <= SESSIONS_TOOL_RESULT_MAX_BYTES
  );
}

export function readSessionsToolPatch(params: Record<string, unknown>): SessionsPatchMutation {
  const patch: SessionsPatchMutation = {};
  for (const field of ["label", "icon", "color", "group", "statusNote"] as const) {
    const value = params[field];
    if (value === undefined) {
      continue;
    }
    if (value !== null && typeof value !== "string") {
      throw new ToolInputError(`${field} must be a string`);
    }
    // The Gateway owns the persisted/wire spelling; agent tools use sidebar groups.
    patch[field === "group" ? "category" : field] = value?.trim() || null;
  }
  if (params.attention !== undefined) {
    const attention = readToolStringParam(params, "attention", { required: true });
    patch.attention = attention === "clear" ? null : attention;
  }
  if (params.ttlMinutes !== undefined) {
    if (!Number.isInteger(params.ttlMinutes)) {
      throw new ToolInputError("ttlMinutes must be an integer");
    }
    // SAFETY: Number.isInteger accepts only integer numbers.
    patch.ttlMinutes = params.ttlMinutes as number;
  }
  for (const field of ["pinned", "archived"] as const) {
    const value = params[field];
    if (value !== undefined) {
      if (typeof value !== "boolean") {
        throw new ToolInputError(`${field} must be boolean`);
      }
      patch[field] = value;
    }
  }
  for (const field of ["model", "thinkingLevel"] as const) {
    if (params[field] !== undefined) {
      patch[field] = readToolStringParam(params, field, { required: true });
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new ToolInputError("Patch setting required");
  }
  return patch;
}

type ResolvedPatchTarget = {
  agentId: string;
  key: string;
  isRequesterSession: boolean;
};

export async function runSessionsToolPatchMany(params: {
  targets: unknown;
  patch: SessionsPatchMutation;
  resolveTarget: (sessionKey: string) => Promise<ResolvedPatchTarget>;
  callGateway: AgentToolGatewayRequestCaller;
}) {
  if (
    !Array.isArray(params.targets) ||
    params.targets.length === 0 ||
    params.targets.length > SESSIONS_PATCH_MANY_MAX_TARGETS
  ) {
    throw new ToolInputError(`targets must contain 1–${SESSIONS_PATCH_MANY_MAX_TARGETS} sessions`);
  }
  const targets: Array<{ index: number; agentId: string; target: SessionsPatchManyTarget }> = [];
  const failures = new Map<number, string>();
  for (const [index, input] of params.targets.entries()) {
    try {
      if (!isRecord(input)) {
        throw new ToolInputError("Target must contain sessionKey and optional expectedSessionId");
      }
      const target = await params.resolveTarget(
        readToolStringParam(input, "sessionKey", { required: true }),
      );
      if (params.patch.archived === true && target.isRequesterSession) {
        throw new ToolInputError(
          "Archive the current session with a single patch; it is deferred until this run finishes.",
        );
      }
      const expectedSessionId = normalizeOptionalString(
        readToolStringParam(input, "expectedSessionId"),
      );
      if (typeof params.patch.archived === "boolean" && !expectedSessionId) {
        throw new ToolInputError("Session lifecycle action requires a durable session identity");
      }
      targets.push({
        index,
        agentId: target.agentId,
        target: {
          key: target.key,
          ...(parseAgentSessionKey(target.key) ? {} : { agentId: target.agentId }),
          ...(expectedSessionId ? { expectedSessionId } : {}),
        },
      });
    } catch (error) {
      failures.set(index, formatErrorMessage(error));
    }
  }
  const succeeded: number[] = [];
  if (targets.length > 0) {
    const result = await params.callGateway<SessionsPatchManyResult>({
      method: "sessions.patchMany",
      params: { targets: targets.map(({ target }) => target), patch: params.patch },
    });
    const operation =
      params.patch.archived === true
        ? "archive"
        : params.patch.archived === false
          ? "restore"
          : "patch";
    for (const [position, outcome] of result.outcomes.entries()) {
      const target = targets[position]!;
      if (outcome.ok) {
        succeeded.push(target.index);
      } else {
        failures.set(target.index, outcome.error.message);
      }
      if (
        outcome.ok ||
        (isRecord(outcome.error.details) &&
          outcome.error.details.reason === SESSION_LIFECYCLE_CHANGED_ERROR_REASON)
      ) {
        recordSessionToolActionFact({
          operation,
          fact: outcome.ok ? "committed" : "conflict",
          targetAgentId: target.agentId,
          targetSessionKey: target.target.key,
        });
      }
    }
  }
  const failed = [...failures.keys()].toSorted((a, b) => a - b);
  const errors: Array<{ index: number; message: string }> = [];
  const result = {
    status: failed.length === 0 ? "updated" : succeeded.length === 0 ? "error" : "partial",
    succeeded,
    failed,
    errors,
    ...(failed.length > 0
      ? { warning: "Patch failed indexes separately for any omitted error details." }
      : {}),
  };
  // Index arrays account for every input even when individual diagnostics exhaust the budget.
  for (const index of failed) {
    const error = failures.get(index)!;
    const prefix = truncateUtf8Prefix(error, 512);
    const detail = { index, message: prefix === error ? error : `${prefix}…` };
    if (!sessionsToolResultFitsBudget({ ...result, errors: [...result.errors, detail] })) {
      break;
    }
    result.errors.push(detail);
  }
  if (result.errors.length === failed.length) {
    delete result.warning;
  }
  return result;
}
