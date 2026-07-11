import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CliCatalogNodeCommand } from "./node-commands.js";

type LiveNodeCommandObservation = {
  readonly nodeId: string;
  readonly nodeName?: string;
  readonly observedAtMs?: number;
  readonly commands: readonly CliCatalogNodeCommand[];
};

const NODE_COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map(normalizeOptionalString)
        .filter((item): item is string => item !== undefined && NODE_COMMAND_ID_PATTERN.test(item)),
    ),
  ].toSorted();
}

export function buildLiveNodeCommandObservation(
  value: unknown,
  requestedNodeId: string,
): LiveNodeCommandObservation {
  const record = asRecord(value);
  const nodeId = normalizeOptionalString(record.nodeId);
  if (!nodeId || nodeId !== requestedNodeId) {
    throw new Error(`node.describe returned an unexpected node for ${requestedNodeId}`);
  }
  if (record.connected !== true) {
    throw new Error(`node ${nodeId} is not connected; live command inventory is unavailable`);
  }

  const nodeName = normalizeOptionalString(record.displayName);
  const observedAtMs =
    typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : undefined;
  const commands = stringList(record.commands).map((command): CliCatalogNodeCommand => {
    const entry: CliCatalogNodeCommand = {
      id: `node:${nodeId}:${command}`,
      command,
      title: command,
      nodeId,
      argumentHints: [],
      effects: [],
      trustBoundary: "paired-node",
      sourceKind: "node-runtime",
      sourceId: `${nodeId}:${command}`,
      discoveryMode: "runtime-node-query",
      metadataCompleteness: "identifier-only",
      visibility: ["audit", "operator"],
    };
    if (nodeName) {
      Object.assign(entry, { nodeName });
    }
    if (observedAtMs !== undefined) {
      Object.assign(entry, { observedAtMs });
    }
    return entry;
  });

  return {
    nodeId,
    ...(nodeName ? { nodeName } : {}),
    ...(observedAtMs !== undefined ? { observedAtMs } : {}),
    commands,
  };
}
