// File Transfer plugin module implements node tool invoke behavior.
import crypto from "node:crypto";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
  type NodeListNode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { appendFileTransferAudit, type FileTransferAuditOp } from "../shared/audit.js";
import { throwFromNodePayload } from "../shared/errors.js";
import { readGatewayCallOptions, readTrimmedString } from "../shared/params.js";

type ErrorAuditExtra = {
  sha256?: string;
  sizeBytes?: number;
};

export function readRequiredNodePath(params: Record<string, unknown>): {
  node: string;
  requestedPath: string;
} {
  const node = readTrimmedString(params, "node");
  const requestedPath = readTrimmedString(params, "path");
  if (!node) {
    throw new Error("node required");
  }
  if (!requestedPath) {
    throw new Error("path required");
  }
  return { node, requestedPath };
}

export async function invokeNodeToolPayload(input: {
  errorAuditExtra?: ErrorAuditExtra;
  invalidPayloadError?: string;
  invalidPayloadMessage?: string;
  node: string;
  params: Record<string, unknown>;
  command: FileTransferAuditOp;
  commandParams: Record<string, unknown>;
  requireOk?: boolean;
  requestedPath: string;
}): Promise<{
  nodeDisplayName: string;
  nodeId: string;
  payload: Record<string, unknown>;
  startedAt: number;
}> {
  const gatewayOpts = readGatewayCallOptions(input.params);
  const nodes: NodeListNode[] = await listNodes(gatewayOpts);
  const nodeId = resolveNodeIdFromList(nodes, input.node, false);
  const nodeMeta = nodes.find((n) => n.nodeId === nodeId);
  const nodeDisplayName = nodeMeta?.displayName ?? input.node;
  const startedAt = Date.now();

  const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
    nodeId,
    command: input.command,
    params: input.commandParams,
    idempotencyKey: crypto.randomUUID(),
  });

  const payload =
    raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    await appendFileTransferAudit({
      op: input.command,
      nodeId,
      nodeDisplayName,
      requestedPath: input.requestedPath,
      decision: "error",
      errorMessage: input.invalidPayloadMessage ?? "invalid payload",
      durationMs: Date.now() - startedAt,
      ...input.errorAuditExtra,
    });
    throw new Error(input.invalidPayloadError ?? `invalid ${input.command} payload`);
  }
  if (payload.ok === false || (input.requireOk === true && payload.ok !== true)) {
    await appendFileTransferAudit({
      op: input.command,
      nodeId,
      nodeDisplayName,
      requestedPath: input.requestedPath,
      canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : undefined,
      decision: "error",
      errorCode: typeof payload.code === "string" ? payload.code : undefined,
      errorMessage: typeof payload.message === "string" ? payload.message : undefined,
      durationMs: Date.now() - startedAt,
      ...input.errorAuditExtra,
    });
    throwFromNodePayload(input.command, payload);
  }

  return { nodeDisplayName, nodeId, payload, startedAt };
}
