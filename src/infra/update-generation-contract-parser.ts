import type { UpdateGenerationBrokerReceipt } from "./update-generation-confined-filesystem.js";
/** Strict decoding plus transition rebuilding for durable transaction records. */
import {
  updateGenerationTransactionReceiptSchema,
  updateGenerationTransactionRecordSchema,
} from "./update-generation-contract-schema.js";
import {
  appendDecodedUpdateGenerationReceipt,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";
import { brokerReceiptsInEvidence } from "./update-generation-evidence.js";

declare const authenticatedUpdateGenerationTransactionRecord: unique symbol;
export type AuthenticatedUpdateGenerationTransactionRecord = UpdateGenerationTransactionRecord & {
  readonly [authenticatedUpdateGenerationTransactionRecord]: true;
};

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function decodeUpdateGenerationTransactionRecord(
  value: unknown,
): UpdateGenerationTransactionRecord {
  if (value !== null && typeof value === "object" && Reflect.get(value, "formatVersion") === 1) {
    throw new TypeError(
      "Legacy path-backed update generation records cannot be promoted to broker evidence",
    );
  }
  return updateGenerationTransactionRecordSchema.parse(value);
}

function rebuildUpdateGenerationTransactionRecord(
  decoded: UpdateGenerationTransactionRecord,
  receipts: readonly UpdateGenerationTransactionReceipt[],
): UpdateGenerationTransactionRecord {
  let rebuilt: UpdateGenerationTransactionRecord | null = null;
  for (const receipt of receipts) {
    rebuilt = appendDecodedUpdateGenerationReceipt(rebuilt, receipt);
  }
  if (
    !rebuilt ||
    rebuilt.transactionId !== decoded.transactionId ||
    rebuilt.namespaceKey !== decoded.namespaceKey
  ) {
    throw new TypeError("Update generation transaction envelope disagrees with its receipts");
  }
  return deepFreeze(rebuilt);
}

export function parseUpdateGenerationTransactionRecord(
  value: unknown,
): UpdateGenerationTransactionRecord {
  const decoded = decodeUpdateGenerationTransactionRecord(value);
  const receipts = decoded.receipts.map((receipt) => deepFreeze(receipt));
  return rebuildUpdateGenerationTransactionRecord(decoded, receipts);
}

export function parseUpdateGenerationTransactionReceipt(
  value: unknown,
): UpdateGenerationTransactionReceipt {
  return deepFreeze(updateGenerationTransactionReceiptSchema.parse(value));
}

async function authenticateReceiptGraph(
  receipt: UpdateGenerationTransactionReceipt,
  authenticate: (receipt: UpdateGenerationBrokerReceipt) => Promise<UpdateGenerationBrokerReceipt>,
): Promise<UpdateGenerationTransactionReceipt> {
  if (!("evidence" in receipt)) {
    return deepFreeze(receipt);
  }
  const authenticatedByReceipt = new Map<
    UpdateGenerationBrokerReceipt,
    UpdateGenerationBrokerReceipt
  >();
  for (const brokerReceipt of brokerReceiptsInEvidence(receipt.evidence)) {
    authenticatedByReceipt.set(brokerReceipt, await authenticate(brokerReceipt));
  }
  const evidence = Object.fromEntries(
    Object.entries(receipt.evidence).map(([key, brokerReceipt]) => {
      const authenticated = authenticatedByReceipt.get(brokerReceipt);
      if (!authenticated) {
        throw new Error("Authenticated broker evidence is missing from its receipt graph");
      }
      return [key, authenticated];
    }),
  );
  // SAFETY: The strict receipt schema proves every evidence value is a direct broker receipt.
  return deepFreeze({ ...receipt, evidence } as UpdateGenerationTransactionReceipt);
}

export async function parseAuthenticatedUpdateGenerationTransactionRecord(
  value: unknown,
  authenticate: (receipt: UpdateGenerationBrokerReceipt) => Promise<UpdateGenerationBrokerReceipt>,
): Promise<AuthenticatedUpdateGenerationTransactionRecord> {
  const decoded = decodeUpdateGenerationTransactionRecord(value);
  const receipts: UpdateGenerationTransactionReceipt[] = [];
  for (const receipt of decoded.receipts) {
    receipts.push(await authenticateReceiptGraph(receipt, authenticate));
  }
  return rebuildUpdateGenerationTransactionRecord(
    decoded,
    receipts,
  ) as AuthenticatedUpdateGenerationTransactionRecord; // SAFETY: Every embedded broker receipt was replaced by its authenticated immutable value.
}
