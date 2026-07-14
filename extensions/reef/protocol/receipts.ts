import { ed25519 } from "@noble/curves/ed25519.js";
import { appendAudit, type AuditEntry, type AuditStore } from "./audit.js";
import { canonicalBytes } from "./canonical.js";
import { base64, fromBase64, fromBase64url } from "./encoding.js";

export interface ReceiptBody {
  id: string;
  bodyHash: string;
  auditHead: string;
  status: "accepted" | "rejected";
  category?: string;
}

export interface SignedReceipt extends ReceiptBody {
  signature: string;
}

export function signReceipt(body: ReceiptBody, recipientSigningSecretKey: string): SignedReceipt {
  validateReceiptBody(body);
  return {
    ...body,
    signature: base64(ed25519.sign(canonicalBytes(body), fromBase64url(recipientSigningSecretKey))),
  };
}

export function verifyReceipt(receipt: SignedReceipt, recipientSigningPublicKey: string): boolean {
  try {
    validateSignedReceipt(receipt);
    const { signature, ...body } = receipt;
    return ed25519.verify(
      fromBase64(signature),
      canonicalBytes(body),
      fromBase64url(recipientSigningPublicKey),
    );
  } catch {
    return false;
  }
}

export async function confirmDelivery(
  receipt: SignedReceipt,
  recipientSigningPublicKey: string,
  audit: AuditStore,
): Promise<AuditEntry> {
  if (!verifyReceipt(receipt, recipientSigningPublicKey)) {
    throw new Error("invalid delivery receipt");
  }
  return appendAudit(audit, "confirm_delivery", {
    receipt,
    status: receipt.status,
    category: receipt.category,
  });
}

function validateReceiptBody(value: unknown): asserts value is ReceiptBody {
  if (
    !isExactReceiptObject(value, false) ||
    typeof value.id !== "string" ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.id) ||
    typeof value.bodyHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.bodyHash) ||
    typeof value.auditHead !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.auditHead) ||
    (value.status !== "accepted" && value.status !== "rejected") ||
    (Object.hasOwn(value, "category") &&
      (typeof value.category !== "string" ||
        value.category.length < 1 ||
        value.category.length > 64))
  ) {
    throw new Error("invalid receipt");
  }
}

function validateSignedReceipt(value: unknown): asserts value is SignedReceipt {
  if (
    !isExactReceiptObject(value, true) ||
    typeof value.signature !== "string" ||
    value.signature.length !== 88
  ) {
    throw new Error("invalid receipt");
  }
  const { signature, ...body } = value;
  validateReceiptBody(body);
  if (fromBase64(signature).length !== 64) {
    throw new Error("invalid receipt");
  }
}

function isExactReceiptObject(value: unknown, signed: boolean): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const required = signed
    ? ["id", "bodyHash", "auditHead", "status", "signature"]
    : ["id", "bodyHash", "auditHead", "status"];
  const allowed = new Set([...required, "category"]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
  );
}
