import { describe, expect, it } from "vitest";
import { createTestConfinedFilesystemForAuthentication } from "../../test/helpers/update-generation-broker-fixture.js";
import { TestUpdateGenerationMemoryLedger as MemoryLedger } from "../../test/helpers/update-generation-memory-ledger.js";
import {
  appendUpdateGenerationReceipt,
  buildUpdateGenerationReceiptId,
  type UpdateGenerationManifest,
  type UpdateGenerationSelection,
  type UpdateGenerationTransactionReceipt,
} from "./update-generation-contract.js";
import { persistUpdateGenerationReceipt } from "./update-generation-ledger-hook.js";

const TRANSACTION_ID = "update-transaction-admission";
const NAMESPACE_KEY = "openclaw-global-owner";
const FILESYSTEM = createTestConfinedFilesystemForAuthentication();

type ReceiptKind = UpdateGenerationTransactionReceipt["kind"];
type ReceiptOf<Kind extends ReceiptKind> = Extract<
  UpdateGenerationTransactionReceipt,
  { kind: Kind }
>;
type ReceiptFields<Kind extends ReceiptKind> = Omit<
  ReceiptOf<Kind>,
  "formatVersion" | "transactionId" | "sequence" | "receiptId" | "recordedAtMs" | "kind"
>;

function receipt<Kind extends ReceiptKind>(
  kind: Kind,
  sequence: number,
  fields: ReceiptFields<Kind>,
): ReceiptOf<Kind> {
  return {
    formatVersion: 2,
    transactionId: TRANSACTION_ID,
    sequence,
    receiptId: buildUpdateGenerationReceiptId({ transactionId: TRANSACTION_ID, sequence, kind }),
    recordedAtMs: 1_788_300_100_000 + sequence,
    kind,
    ...fields,
  } as ReceiptOf<Kind>;
}

function selection(character: string): UpdateGenerationSelection {
  return {
    formatVersion: 1,
    generationId: character.repeat(32),
    manifestSha256: character.repeat(64),
    entrypointRelativePath: "openclaw.mjs",
  };
}

function manifest(character: string): UpdateGenerationManifest {
  return {
    algorithm: "sha256",
    digest: character.repeat(64),
    entryCount: 2,
    totalBytes: 100,
  };
}

function intent(previous: UpdateGenerationSelection) {
  return receipt("intent", 0, {
    namespaceKey: NAMESPACE_KEY,
    serviceBefore: { managed: true, running: true, enabled: true },
    previousSelection: previous,
    previousPackageVersion: "1.0.0",
    stableBindingAlreadyVerified: true,
    brokerId: "test-broker",
    brokerRevision: null,
  });
}

function candidateIntent(generationId = selection("b").generationId) {
  return receipt("generation-materialization-intent", 1, {
    role: "candidate",
    sourceArtifactId: "stage:candidate",
    generationId,
    manifest: manifest(generationId[0] ?? "b"),
    packageVersion: "2.0.0",
    entrypointRelativePath: "openclaw.mjs",
  });
}

describe("update generation durable admission", () => {
  it("rejects blank materialization fields before durable admission", async () => {
    const ledger = new MemoryLedger();
    const snapshot = await persistUpdateGenerationReceipt({
      filesystem: FILESYSTEM,
      ledger,
      snapshot: null,
      receipt: intent(selection("a")),
    });
    const valid = candidateIntent();

    for (const malformed of [
      { ...valid, sourceArtifactId: " \t " },
      { ...valid, packageVersion: "\n" },
    ]) {
      await expect(
        persistUpdateGenerationReceipt({
          filesystem: FILESYSTEM,
          ledger,
          snapshot,
          receipt: malformed,
        }),
      ).rejects.toThrow();
      await expect(ledger.read(NAMESPACE_KEY)).resolves.toEqual(snapshot);
    }
  });

  it("rejects a candidate generation that aliases the retained generation", () => {
    const previous = selection("a");
    const record = appendUpdateGenerationReceipt(null, intent(previous));
    expect(() =>
      appendUpdateGenerationReceipt(record, candidateIntent(previous.generationId)),
    ).toThrow("Candidate materialization requires a distinct retained generation");
    expect(() => appendUpdateGenerationReceipt(record, candidateIntent())).not.toThrow();
  });
});
