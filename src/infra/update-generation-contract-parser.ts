/** Strict decoding plus transition rebuilding for durable transaction records. */
import { updateGenerationTransactionRecordSchema } from "./update-generation-contract-schema.js";
import {
  appendUpdateGenerationReceipt,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";
import { brokerReceiptsInEvidence } from "./update-generation-evidence.js";

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
): UpdateGenerationTransactionRecord {
  let rebuilt: UpdateGenerationTransactionRecord | null = null;
  for (const decodedReceipt of decoded.receipts) {
    const receipt: UpdateGenerationTransactionReceipt = decodedReceipt;
    rebuilt = appendUpdateGenerationReceipt(rebuilt, receipt);
  }
  if (
    !rebuilt ||
    rebuilt.transactionId !== decoded.transactionId ||
    rebuilt.namespaceKey !== decoded.namespaceKey
  ) {
    throw new TypeError("Update generation transaction envelope disagrees with its receipts");
  }
  return rebuilt;
}

export function parseUpdateGenerationTransactionRecord(
  value: unknown,
): UpdateGenerationTransactionRecord {
  return rebuildUpdateGenerationTransactionRecord(decodeUpdateGenerationTransactionRecord(value));
}

export async function parseAuthenticatedUpdateGenerationTransactionRecord(
  value: unknown,
  authenticate: (receipt: ReturnType<typeof brokerReceiptsInEvidence>[number]) => Promise<void>,
): Promise<UpdateGenerationTransactionRecord> {
  const decoded = decodeUpdateGenerationTransactionRecord(value);
  for (const receipt of decoded.receipts) {
    if (!("evidence" in receipt)) {
      continue;
    }
    for (const brokerReceipt of brokerReceiptsInEvidence(receipt.evidence)) {
      await authenticate(brokerReceipt);
    }
  }
  return rebuildUpdateGenerationTransactionRecord(decoded);
}
