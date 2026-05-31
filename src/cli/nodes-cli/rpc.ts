import { randomUUID } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import type { OperatorScope } from "../../gateway/method-scopes.js";
import {
  parseStrictFiniteNumber,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "../../infra/parse-finite-number.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveNodeFromNodeList } from "../../shared/node-resolve.js";
import { parseNodeList, parsePairingList } from "./format.js";
import type { NodeListNode, NodesRpcOpts } from "./types.js";

type NodesCliRpcRuntimeModule = typeof import("./rpc.runtime.js");

const nodesCliRpcRuntimeLoader = createLazyImportLoader<NodesCliRpcRuntimeModule>(
  () => import("./rpc.runtime.js"),
);

async function loadNodesCliRpcRuntime(): Promise<NodesCliRpcRuntimeModule> {
  return nodesCliRpcRuntimeLoader.load();
}

export const nodesCallOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 10_000))
    .option("--json", "Output JSON", false);

export const callGatewayCli = async (
  method: string,
  opts: NodesRpcOpts,
  params?: unknown,
  callOpts?: { transportTimeoutMs?: number },
) => {
  const runtime = await loadNodesCliRpcRuntime();
  return await runtime.callGatewayCliRuntime(method, opts, params, callOpts);
};

export const callNodePairApprovalGatewayCli = async (
  method: "node.pair.list" | "node.pair.approve",
  opts: NodesRpcOpts,
  params: unknown,
  callOpts: { scopes: OperatorScope[]; transportTimeoutMs?: number },
) => {
  const runtime = await loadNodesCliRpcRuntime();
  return await runtime.callNodePairApprovalGatewayCliRuntime(method, opts, params, callOpts);
};

export function buildNodeInvokeParams(params: {
  nodeId: string;
  command: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  idempotencyKey?: string;
}): Record<string, unknown> {
  const invokeParams: Record<string, unknown> = {
    nodeId: params.nodeId,
    command: params.command,
    params: params.params,
    idempotencyKey: params.idempotencyKey ?? randomUUID(),
  };
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    invokeParams.timeoutMs = params.timeoutMs;
  }
  return invokeParams;
}

function hasOptionalValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function parseOptionalNodePositiveInteger(value: unknown, flag: string): number | undefined {
  if (!hasOptionalValue(value)) {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

export function parseOptionalNodeNonNegativeInteger(
  value: unknown,
  flag: string,
): number | undefined {
  if (!hasOptionalValue(value)) {
    return undefined;
  }
  const parsed = parseStrictNonNegativeInteger(value);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

export function parseOptionalNodeFiniteNumber(
  value: unknown,
  flag: string,
  bounds?: {
    minExclusive?: number;
    minInclusive?: number;
    maxInclusive?: number;
  },
): number | undefined {
  if (!hasOptionalValue(value)) {
    return undefined;
  }
  const parsed = parseStrictFiniteNumber(value);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a finite number.`);
  }
  if (bounds?.minExclusive !== undefined && parsed <= bounds.minExclusive) {
    throw new Error(`${flag} must be greater than ${bounds.minExclusive}.`);
  }
  if (bounds?.minInclusive !== undefined && parsed < bounds.minInclusive) {
    throw new Error(`${flag} must be at least ${bounds.minInclusive}.`);
  }
  if (bounds?.maxInclusive !== undefined && parsed > bounds.maxInclusive) {
    throw new Error(`${flag} must be at most ${bounds.maxInclusive}.`);
  }
  return parsed;
}

export function unauthorizedHintForMessage(message: string): string | null {
  const haystack = normalizeLowercaseStringOrEmpty(message);
  if (
    haystack.includes("unauthorizedclient") ||
    haystack.includes("bridge client is not authorized") ||
    haystack.includes("unsigned bridge clients are not allowed")
  ) {
    return [
      "peekaboo bridge rejected the client.",
      "sign the peekaboo CLI (TeamID Y5PE65HELJ) or launch the host with",
      "PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1 for local dev.",
    ].join(" ");
  }
  return null;
}

export async function resolveNodeId(opts: NodesRpcOpts, query: string) {
  return (await resolveNode(opts, query)).nodeId;
}

export async function resolveNode(opts: NodesRpcOpts, query: string): Promise<NodeListNode> {
  let nodes: NodeListNode[] = [];
  try {
    const res = await callGatewayCli("node.list", opts, {});
    nodes = parseNodeList(res);
  } catch {
    const res = await callGatewayCli("node.pair.list", opts, {});
    const { paired } = parsePairingList(res);
    nodes = paired.map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      platform: n.platform,
      version: n.version,
      remoteIp: n.remoteIp,
    }));
  }
  return resolveNodeFromNodeList(nodes, query);
}
