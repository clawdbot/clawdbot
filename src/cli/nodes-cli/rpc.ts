// Gateway RPC helpers for node CLI commands, including lazy runtime loading and option parsing.
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

/** Attach shared Gateway connection/json options to a node command. */
export const nodesCallOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", String(defaults?.timeoutMs ?? 10_000))
    .option("--json", "Output JSON", false);

/** Call a Gateway method through the lazily loaded node CLI RPC runtime. */
export const callGatewayCli = async (
  method: string,
  opts: NodesRpcOpts,
  params?: unknown,
  callOpts?: { transportTimeoutMs?: number },
) => {
  const runtime = await loadNodesCliRpcRuntime();
  return await runtime.callGatewayCliRuntime(method, opts, params, callOpts);
};

/** Call pairing approval methods with explicit operator scopes. */
export const callNodePairApprovalGatewayCli = async (
  method: "node.pair.list" | "node.pair.approve",
  opts: NodesRpcOpts,
  params: unknown,
  callOpts: { scopes: OperatorScope[]; transportTimeoutMs?: number },
) => {
  const runtime = await loadNodesCliRpcRuntime();
  return await runtime.callNodePairApprovalGatewayCliRuntime(method, opts, params, callOpts);
};

/** Build a node.invoke payload with an idempotency key and optional timeout. */
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

/** Parse an optional positive integer node CLI flag. */
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

/** Parse an optional non-negative integer node CLI flag. */
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

/** Parse an optional finite number node CLI flag with optional bounds. */
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

/** Return the local-development hint for known unsigned Peekaboo bridge authorization failures. */
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

/** Resolve a node query to a node id via live node list or paired-node fallback. */
export async function resolveNodeId(opts: NodesRpcOpts, query: string) {
  return (await resolveNode(opts, query)).nodeId;
}

/** Resolve a node query to the best available node record. */
export async function resolveNode(opts: NodesRpcOpts, query: string): Promise<NodeListNode> {
  let nodes: NodeListNode[];
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
