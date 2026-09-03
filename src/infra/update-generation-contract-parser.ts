/** Strict decoding plus transition rebuilding for durable transaction records. */
import { updateGenerationTransactionRecordSchema } from "./update-generation-contract-schema.js";
import {
  appendUpdateGenerationReceipt,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";

export function parseUpdateGenerationTransactionRecord(
  value: unknown,
): UpdateGenerationTransactionRecord {
  if (value !== null && typeof value === "object" && Reflect.get(value, "formatVersion") === 1) {
    throw new TypeError(
      "Legacy path-backed update generation records cannot be promoted to broker evidence",
    );
  }
  const decoded = updateGenerationTransactionRecordSchema.parse(value);
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
