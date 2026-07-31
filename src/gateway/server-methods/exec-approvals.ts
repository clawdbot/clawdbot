// Exec approvals config methods read and write command approval defaults with
// base-hash protection for admin-edited allowlists.
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateExecApprovalsGetParams,
  validateExecApprovalsNodeGetParams,
  validateExecApprovalsNodeSnapshot,
  validateExecApprovalsNodeSetParams,
  validateExecApprovalsSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  ensureExecApprovalsSnapshot,
  mergeExecApprovalsSocketDefaults,
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  updateExecApprovals,
  type ExecApprovalsFile,
  type ExecApprovalsSnapshot,
} from "../../infra/exec-approvals.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import type { NodeSession } from "../node-registry.js";
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
  const baseHash = resolveBaseHashParam(params);
  if (!snapshot.exists) {
    if (baseHash && baseHash !== snapshot.hash) {
      respondApprovalsChanged(respond);
      return false;
    }
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
    respondApprovalsChanged(respond);
    return false;
  }
  return true;
}

function respondApprovalsChanged(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      "exec approvals changed since last load; re-run exec.approvals.get and retry",
    ),
  );
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

function isMacAppNode(session: NodeSession | undefined): boolean {
  const platform = session?.platform?.trim().toLowerCase();
  return (
    session?.clientId === GATEWAY_CLIENT_IDS.MACOS_APP &&
    session.clientMode === GATEWAY_CLIENT_MODES.NODE &&
    (platform === "macos" || platform?.startsWith("macos ") === true)
  );
}

async function respondWithExecApprovalsNodePayload<TParams extends { nodeId: string }>(params: {
  method: string;
  rawParams: unknown;
  validate: Validator<TParams>;
  context: GatewayRequestContext;
  respond: RespondFn;
  command: "system.execApprovals.get" | "system.execApprovals.set";
  commandParams: (
    parsedParams: TParams,
    nodeSession: NodeSession | undefined,
  ) => Record<string, unknown>;
  readPayload: (response: { payload?: unknown; payloadJSON?: string | null }) => unknown;
  validatePayload?: (payload: unknown) => boolean;
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
  const nodeSession = params.context.nodeRegistry.get(nodeId);
  if (nodeSession) {
    const allowed = isNodeCommandAllowed({
      command: params.command,
      declaredCommands: nodeSession.commands,
      allowlist: resolveNodeCommandAllowlist(params.context.getRuntimeConfig(), {
        ...nodeSession,
        approvedCommands: nodeSession.commands,
      }),
    });
    if (!allowed.ok) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `node command not allowed: ${params.command} (${allowed.reason})`,
          { details: { command: params.command, reason: allowed.reason } },
        ),
      );
      return;
    }
  }
  await respondUnavailableOnThrow(params.respond, async () => {
    const res = await params.context.nodeRegistry.invoke({
      nodeId,
      ...(nodeSession
        ? {
            expectedConnId: nodeSession.connId,
            ...(nodeSession.pairingGeneration
              ? { expectedPairingGeneration: nodeSession.pairingGeneration }
              : {}),
          }
        : {}),
      command: params.command,
      params: params.commandParams(parsedParams, nodeSession),
    });
    if (!respondUnavailableOnNodeInvokeError(params.respond, res)) {
      return;
    }
    const payload = params.readPayload(res);
    if (params.validatePayload && !params.validatePayload(payload)) {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "node returned invalid exec approvals payload"),
      );
      return;
    }
    params.respond(true, payload, undefined);
  });
}

export const execApprovalsHandlers: GatewayRequestHandlers = {
  "exec.approvals.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateExecApprovalsGetParams, "exec.approvals.get", respond)) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const snapshot = await ensureExecApprovalsSnapshot();
      respond(true, toExecApprovalsPayload(snapshot), undefined);
    });
  },
  "exec.approvals.set": async ({ params, respond }) => {
    if (!assertValidParams(params, validateExecApprovalsSetParams, "exec.approvals.set", respond)) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      // Do not ensure/create state before checking freshness: a rejected stale
      // save must not recreate a file that an operator deleted.
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
      const nextSnapshot = await updateExecApprovals({
        baseHash: snapshot.hash,
        update: (current) => mergeExecApprovalsSocketDefaults({ normalized, current }),
      });
      if (!nextSnapshot) {
        // The locked CAS already proved this write lost a race. A later read can
        // observe bytes restored to the old hash and must not suppress the reply.
        respondApprovalsChanged(respond);
        return;
      }
      respond(true, toExecApprovalsPayload(nextSnapshot), undefined);
    });
  },
  "exec.approvals.node.get": async ({ params, respond, context }) => {
    await respondWithExecApprovalsNodePayload({
      method: "exec.approvals.node.get",
      rawParams: params,
      validate: validateExecApprovalsNodeGetParams,
      context,
      respond,
      command: "system.execApprovals.get",
      // New Mac nodes expand this response only when asked, so older Gateways
      // continue receiving the strict legacy snapshot shape.
      commandParams: (_parsedParams, nodeSession) =>
        isMacAppNode(nodeSession) ? { includeResolvedDefaults: true } : {},
      // Node invocations can return structured payloads or JSON strings
      // depending on the transport; normalize before echoing the RPC response.
      readPayload: (res) => (res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload),
      validatePayload: validateExecApprovalsNodeSnapshot,
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
      // Host-native nodes own a different policy model. Preserve that model at
      // the node boundary instead of pretending it is an OpenClaw approvals file.
      commandParams: (parsedParams) =>
        "native" in parsedParams
          ? { ...parsedParams.native, baseHash: parsedParams.baseHash }
          : { file: parsedParams.file, baseHash: parsedParams.baseHash },
      readPayload: (res) => (res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload),
    });
  },
};
