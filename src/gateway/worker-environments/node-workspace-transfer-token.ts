import { createHmac, timingSafeEqual } from "node:crypto";

export type NodeWorkspaceTransferDirection = "download" | "upload";

const TOKEN_VERSION = "v1";
const TOKEN_PATTERN = /^v1\.([0-9]{1,16})\.([A-Za-z0-9_-]{43})$/u;
const NODE_WORKSPACE_TRANSFER_TOKEN_TTL_MS = 5 * 60_000;

function tokenPayload(params: {
  environmentId: string;
  ownerEpoch: number;
  direction: NodeWorkspaceTransferDirection;
  expiresAtMs: number;
}): string {
  return [
    TOKEN_VERSION,
    params.environmentId,
    String(params.ownerEpoch),
    params.direction,
    String(params.expiresAtMs),
  ].join("\0");
}

function signature(params: {
  credentialHash: string;
  environmentId: string;
  ownerEpoch: number;
  direction: NodeWorkspaceTransferDirection;
  expiresAtMs: number;
}): string {
  return createHmac("sha256", params.credentialHash)
    .update(tokenPayload(params))
    .digest("base64url");
}

/** Mint a stateless bearer scoped to one credential owner and transfer direction. */
export function mintNodeWorkspaceTransferToken(params: {
  credentialHash: string;
  credentialExpiresAtMs: number;
  environmentId: string;
  ownerEpoch: number;
  direction: NodeWorkspaceTransferDirection;
  nowMs?: number;
}): { token: string; expiresAtMs: number } {
  const nowMs = params.nowMs ?? Date.now();
  const expiresAtMs = Math.min(
    params.credentialExpiresAtMs,
    nowMs + NODE_WORKSPACE_TRANSFER_TOKEN_TTL_MS,
  );
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new Error("Worker workspace transfer credential is expired");
  }
  const digest = signature({ ...params, expiresAtMs });
  return { token: `${TOKEN_VERSION}.${expiresAtMs}.${digest}`, expiresAtMs };
}

/** Opaque verification: callers deliberately collapse every mismatch to not-found. */
export function verifyNodeWorkspaceTransferToken(params: {
  token: string;
  credentialHash: string;
  credentialExpiresAtMs: number;
  environmentId: string;
  ownerEpoch: number;
  direction: NodeWorkspaceTransferDirection;
  nowMs?: number;
}): boolean {
  const match = TOKEN_PATTERN.exec(params.token);
  if (!match) {
    return false;
  }
  const expiresAtMs = Number(match[1]);
  const nowMs = params.nowMs ?? Date.now();
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= nowMs ||
    expiresAtMs > params.credentialExpiresAtMs ||
    expiresAtMs > nowMs + NODE_WORKSPACE_TRANSFER_TOKEN_TTL_MS
  ) {
    return false;
  }
  const expected = Buffer.from(signature({ ...params, expiresAtMs }));
  const actual = Buffer.from(match[2]!);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
