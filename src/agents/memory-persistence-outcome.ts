import { createHash } from "node:crypto";

export type MemoryPersistenceOutcomeObservation = Readonly<{
  attemptDigest: string;
  factDigest?: string;
  status: "confirmed" | "not-confirmed";
}>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasValidReceipt(value: unknown): boolean {
  const receipt = asRecord(value);
  const target = asRecord(receipt?.target);
  if (
    receipt?.version !== 1 ||
    (receipt.status !== "created" && receipt.status !== "already_present") ||
    typeof receipt.backend !== "string" ||
    !receipt.backend.trim() ||
    !target ||
    (target.kind !== "file" && target.kind !== "record")
  ) {
    return false;
  }
  if (target.kind === "file" && (typeof target.path !== "string" || !target.path.trim())) {
    return false;
  }
  if (target.kind === "record" && (typeof target.id !== "string" || !target.id.trim())) {
    return false;
  }
  return true;
}

export function digestMemoryPersistenceFact(text: string): string {
  const normalized = text.replace(/\r\n?/gu, "\n").normalize("NFC").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function resolveMemoryPersistenceOutcomeObservation(params: {
  toolName: string;
  memoryPersistenceReceiptVersion?: 1;
  toolCallId?: string;
  toolParams: unknown;
  result?: unknown;
  error?: unknown;
}): MemoryPersistenceOutcomeObservation | undefined {
  if (
    params.toolName.trim().toLowerCase() !== "memory_store" ||
    params.memoryPersistenceReceiptVersion !== 1
  ) {
    return undefined;
  }
  const text = asRecord(params.toolParams)?.text;
  const factDigest = typeof text === "string" ? digestMemoryPersistenceFact(text) : undefined;
  const attemptDigest = digestMemoryPersistenceFact(
    params.toolCallId ? `call:${params.toolCallId}` : `fact:${factDigest ?? "malformed"}`,
  );
  const confirmed =
    !params.error && hasValidReceipt(asRecord(asRecord(params.result)?.details)?.memoryPersistence);
  return {
    attemptDigest,
    ...(factDigest ? { factDigest } : {}),
    status: confirmed ? "confirmed" : "not-confirmed",
  };
}
