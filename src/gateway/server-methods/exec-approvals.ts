import {
  ErrorCodes,
  errorShape,
  validateExecApprovalsGetParams,
  validateExecApprovalsNodeGetParams,
  validateExecApprovalsNodeSetParams,
  validateExecApprovalsSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  ensureExecApprovals,
  mergeExecApprovalsSocketDefaults,
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  saveExecApprovals,
  type ExecApprovalsFile,
  type ExecApprovalsSnapshot,
} from "../../infra/exec-approvals.js";
import { resolveBaseHashParam } from "./base-hash.js";
import {
  respondUnavailableOnNodeInvokeError,
  respondUnavailableOnThrow,
  safeParseJson,
} from "./nodes.helpers.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

function requireApprovalsBaseHash(
  params: unknown,
  snapshot: ExecApprovalsSnapshot,
  respond: RespondFn,
): boolean {
  // Approval allowlists are admin-editable state. Require the caller's last
  // observed hash before writing so stale UI tabs cannot overwrite changes.
  if (!snapshot.exists) {
    return true;
  }
  if (!snapshot.hash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "exec approvals base hash unavailable; re-run exec.approvals.get and retry",
      ),
    );
    return false;
  }
  const baseHash = resolveBaseHashParam(params);
  if (!baseHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "exec approvals base hash required; re-run exec.approvals.get and retry",
      ),
    );
    return false;
  }
  if (baseHash !== snapshot.hash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "exec approvals changed since last load; re-run exec.approvals.get and retry",
      ),
    );
    return false;
  }
  return true;
}

function redactExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  // The socket token/defaults are runtime-only; expose only the path needed by
  // the editor so GET responses cannot leak connection material.
  return {
    ...file,
    socket: socketPath ? { path: socketPath } : undefined,
  };
}

function toExecApprovalsPayload(snapshot: ExecApprovalsSnapshot) {
  return {
    path: snapshot.path,
    exists: snapshot.exists,
    hash: snapshot.hash,
    file: redactExecApprovals(snapshot.file),
  };
}

async function respondWithExecApprovalsNodePayload<TParams extends { nodeId: string }>(params: {
  method: string;
  rawParams: unknown;
  validate: Validator<TParams>;
  context: GatewayRequestContext;
  respond: RespondFn;
  command: "system.execApprovals.get" | "system.execApprovals.set";
  commandParams: (parsedParams: TParams) => Record<string, unknown>;
  readPayload: (response: { payload?: unknown; payloadJSON?: string | null }) => unknown;
}): Promise<void> {
  const rawParams = params.rawParams;
  if (!assertValidParams(rawParams, params.validate, params.method, params.respond)) {
    return;
  }
  const parsedParams = rawParams;
  const nodeId = parsedParams.nodeId.trim();
  if (!nodeId) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
    return;
  }
  await respondUnavailableOnThrow(params.respond, async () => {
    const res = await params.context.nodeRegistry.invoke({
      nodeId,
      command: params.command,
      params: params.commandParams(parsedParams),
    });
    if (!respondUnavailableOnNodeInvokeError(params.respond, res)) {
      return;
    }
    params.respond(true, params.readPayload(res), undefined);
  });
}

export const execApprovalsHandlers: GatewayRequestHandlers = {
  "exec.approvals.get": ({ params, respond }) => {
    if (!assertValidParams(params, validateExecApprovalsGetParams, "exec.approvals.get", respond)) {
      return;
    }
    ensureExecApprovals();
    const snapshot = readExecApprovalsSnapshot();
    respond(true, toExecApprovalsPayload(snapshot), undefined);
  },
  "exec.approvals.set": ({ params, respond }) => {
    if (!assertValidParams(params, validateExecApprovalsSetParams, "exec.approvals.set", respond)) {
      return;
    }
    ensureExecApprovals();
    const snapshot = readExecApprovalsSnapshot();
    if (!requireApprovalsBaseHash(params, snapshot, respond)) {
      return;
    }
    const incoming = (params as { file?: unknown }).file;
    if (!incoming || typeof incoming !== "object") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "exec approvals file is required"),
      );
      return;
    }
    const normalized = normalizeExecApprovals(incoming as ExecApprovalsFile);
    const next = mergeExecApprovalsSocketDefaults({ normalized, current: snapshot.file });
    saveExecApprovals(next);
    const nextSnapshot = readExecApprovalsSnapshot();
    respond(true, toExecApprovalsPayload(nextSnapshot), undefined);
  },
  "exec.approvals.node.get": async ({ params, respond, context }) => {
    await respondWithExecApprovalsNodePayload({
      method: "exec.approvals.node.get",
      rawParams: params,
      validate: validateExecApprovalsNodeGetParams,
      context,
      respond,
      command: "system.execApprovals.get",
      commandParams: () => ({}),
      // Node invocations can return structured payloads or JSON strings
      // depending on the transport; normalize before echoing the RPC response.
      readPayload: (res) => (res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload),
    });
  },
  "exec.approvals.node.set": async ({ params, respond, context }) => {
    await respondWithExecApprovalsNodePayload({
      method: "exec.approvals.node.set",
      rawParams: params,
      validate: validateExecApprovalsNodeSetParams,
      context,
      respond,
      command: "system.execApprovals.set",
      commandParams: (parsedParams) => ({
        file: parsedParams.file,
        baseHash: parsedParams.baseHash,
      }),
      // node.set returns JSON on the command channel; keep the gateway response
      // shape aligned with local exec.approvals.set.
      readPayload: (res) => safeParseJson(res.payloadJSON ?? null),
    });
  },
};
