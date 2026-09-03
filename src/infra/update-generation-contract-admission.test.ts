import { describe, expect, it } from "vitest";
import {
  attachTestBrokerEvidence,
  createTestConfinedFilesystemForAuthentication,
} from "../../test/helpers/update-generation-broker-fixture.js";
import { TestUpdateGenerationMemoryLedger as MemoryLedger } from "../../test/helpers/update-generation-memory-ledger.js";
import { UPDATE_GENERATION_BROKER_MAX_ARRAY_LENGTH } from "./update-generation-broker-decoder.js";
import { parseUpdateGenerationTransactionReceipt } from "./update-generation-contract-parser.js";
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
  | "formatVersion"
  | "transactionId"
  | "sequence"
  | "receiptId"
  | "recordedAtMs"
  | "kind"
  | "evidence"
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

function candidateIntent(generationId = selection("b").generationId, sequence = 1) {
  return receipt("generation-materialization-intent", sequence, {
    role: "candidate",
    sourceArtifactId: "stage:candidate",
    generationId,
    manifest: manifest(generationId[0] ?? "b"),
    packageVersion: "2.0.0",
    entrypointRelativePath: "openclaw.mjs",
  });
}

describe("update generation durable admission", () => {
  it("bounds cleanup arrays to the broker decoder limit", () => {
    const oversized = Array.from(
      { length: UPDATE_GENERATION_BROKER_MAX_ARRAY_LENGTH + 1 },
      (_, index) => index.toString(16).padStart(32, "0"),
    );
    const valid = receipt("cleanup-intent", 1, {
      generationIds: [],
      protectedGenerationIds: [],
    });
    for (const field of ["generationIds", "protectedGenerationIds"] as const) {
      expect(() =>
        parseUpdateGenerationTransactionReceipt({ ...valid, [field]: oversized }),
      ).toThrow();
    }
  });

  it("rejects explicit undefined service enablement before durable admission", async () => {
    const ledger = new MemoryLedger();
    const malformed = {
      ...intent(selection("a")),
      serviceBefore: { managed: true, running: true, enabled: undefined },
    };
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: FILESYSTEM,
        ledger,
        snapshot: null,
        receipt: malformed,
      }),
    ).rejects.toThrow("enablement must be omitted or boolean");
    await expect(ledger.read(NAMESPACE_KEY)).resolves.toBeNull();
  });

  it("rejects blank materialization fields before durable admission", async () => {
    const ledger = new MemoryLedger();
    const snapshot = await persistUpdateGenerationReceipt({
      filesystem: FILESYSTEM,
      ledger,
      snapshot: null,
      receipt: intent(selection("a")),
    });
    const valid = candidateIntent();

    const unsafeEntrypoints = [
      "openclaw.mjs\0ignored",
      "entry:payload.mjs",
      "dir/CON",
      "dir/CONIN$.mjs",
      "dir/CONOUT$",
      "dir/CON .mjs",
      "dir/aux.mjs",
      "dir/entry.",
      "dir/entry ",
      "dir/entry?.mjs",
      "dir/entry\u001f.mjs",
    ];
    const malformedReceipts = [
      { ...valid, sourceArtifactId: " \t " },
      { ...valid, packageVersion: "\n" },
    ];
    for (const entrypointRelativePath of unsafeEntrypoints) {
      malformedReceipts.push({ ...valid, entrypointRelativePath });
    }
    for (const malformed of malformedReceipts) {
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

  it("does not let ordinary progress supersede an unresolved failure", () => {
    const record = appendUpdateGenerationReceipt(null, intent(selection("a")));
    const failed = appendUpdateGenerationReceipt(
      record,
      receipt("failure", 1, {
        operation: "materialize-generation",
        reason: "broker outcome requires adjudication",
        serviceRestored: true,
      }),
    );
    expect(() => appendUpdateGenerationReceipt(failed, candidateIntent(undefined, 2))).toThrow(
      "Unresolved update generation failure requires durable adjudication",
    );
    const adjudication = receipt("failure-adjudicated", 2, {
      failedReceiptId: failed.receipts[1]!.receiptId,
      resumeFromReceiptId: failed.receipts[0]!.receiptId,
    });
    expect(() =>
      appendUpdateGenerationReceipt(
        failed,
        attachTestBrokerEvidence(failed, {
          ...adjudication,
          resumeFromReceiptId: "wrong-transition",
        }),
      ),
    ).toThrow("does not match the unresolved transition");
    const adjudicated = appendUpdateGenerationReceipt(
      failed,
      attachTestBrokerEvidence(failed, adjudication),
    );
    expect(() =>
      appendUpdateGenerationReceipt(adjudicated, candidateIntent(undefined, 3)),
    ).not.toThrow();
  });
});
