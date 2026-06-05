// Node list parsing helpers normalize node inventory records from CLI output.
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import type { NodeListNode, PairedNode, PairingList, PendingRequest } from "./node-list-types.js";

/** Extracts pending and paired node arrays from permissive node.pair.list payloads. */
export function parsePairingList(value: unknown): PairingList {
  const obj = asRecord(value);
  const pending = Array.isArray(obj.pending) ? (obj.pending as PendingRequest[]) : [];
  const paired = Array.isArray(obj.paired) ? (obj.paired as PairedNode[]) : [];
  return { pending, paired };
}

/** Extracts the nodes array from a node.list response, treating malformed payloads as empty. */
export function parseNodeList(value: unknown): NodeListNode[] {
  const obj = asRecord(value);
  return Array.isArray(obj.nodes) ? (obj.nodes as NodeListNode[]) : [];
}
