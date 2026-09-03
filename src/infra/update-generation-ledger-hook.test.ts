import { describe, expect, it } from "vitest";
import {
  attachTestBrokerEvidence,
  createTestConfinedFilesystemForAuthentication,
} from "../../test/helpers/update-generation-broker-fixture.js";
import { TestUpdateGenerationMemoryLedger as MemoryLedger } from "../../test/helpers/update-generation-memory-ledger.js";
import {
  appendUpdateGenerationReceipt,
  buildUpdateGenerationReceiptId,
  projectUpdateGenerationTransaction,
  type UpdateGenerationManifest,
  type UpdateGenerationSelection,
  type UpdateGenerationTransactionReceipt,
  type UpdateGenerationTransactionRecord,
} from "./update-generation-contract.js";
import { persistUpdateGenerationReceipt } from "./update-generation-ledger-hook.js";

const TRANSACTION_ID = "update-transaction-1";
const NAMESPACE_KEY = "openclaw-global-owner";
const AUTHENTICATION_FILESYSTEM = createTestConfinedFilesystemForAuthentication();

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
    formatVersion: 1,
    transactionId: TRANSACTION_ID,
    sequence,
    receiptId: buildUpdateGenerationReceiptId({ transactionId: TRANSACTION_ID, sequence, kind }),
    recordedAtMs: 1_788_300_000_000 + sequence,
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

function intent(previousSelection: UpdateGenerationSelection | null, stable: boolean) {
  return receipt("intent", 0, {
    namespaceKey: NAMESPACE_KEY,
    serviceBefore: { managed: true, running: true, enabled: true },
    previousSelection,
    previousPackageVersion: previousSelection ? "1.0.0" : null,
    stableBindingAlreadyVerified: stable,
    brokerId: "test-broker",
    brokerRevision: null,
  });
}

function append(
  record: UpdateGenerationTransactionRecord | null,
  next: UpdateGenerationTransactionReceipt,
): UpdateGenerationTransactionRecord {
  return appendUpdateGenerationReceipt(record, attachTestBrokerEvidence(record, next));
}

describe("update generation ledger hook", () => {
  it("requires CAS and makes receipt replay idempotent", async () => {
    const ledger = new MemoryLedger();
    const firstReceipt = intent(selection("a"), true);
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: null,
        ledger,
        snapshot: null,
        receipt: firstReceipt,
      }),
    ).rejects.toThrow("requires a confined filesystem provider");
    const first = await persistUpdateGenerationReceipt({
      filesystem: AUTHENTICATION_FILESYSTEM,
      ledger,
      snapshot: null,
      receipt: firstReceipt,
    });
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: null,
        receipt: firstReceipt,
      }),
    ).resolves.toEqual(first);
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: first,
        receipt: firstReceipt,
      }),
    ).resolves.toEqual(first);
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: null,
        receipt: {
          ...firstReceipt,
          serviceBefore: { ...firstReceipt.serviceBefore, running: false },
        },
      }),
    ).rejects.toThrow("replayed different receipt content");

    const candidateIntent = receipt("generation-materialization-intent", 1, {
      role: "candidate",
      sourceArtifactId: "stage:candidate",
      generationId: "b".repeat(32),
      manifest: manifest("b"),
      packageVersion: "2.0.0",
      entrypointRelativePath: "openclaw.mjs",
    });
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: { ...first, revision: "stale" },
        receipt: candidateIntent,
      }),
    ).rejects.toThrow("ledger revision changed");
    await expect(ledger.read(NAMESPACE_KEY)).resolves.toEqual(first);
  });

  it("atomically rolls a cleaned namespace into a new transaction", async () => {
    const previous = selection("a");
    const candidate = selection("b");
    let priorRecord = append(null, intent(previous, true));
    priorRecord = append(
      priorRecord,
      receipt("generation-materialization-intent", 1, {
        role: "candidate",
        sourceArtifactId: "stage:candidate",
        generationId: candidate.generationId,
        manifest: manifest("b"),
        packageVersion: "2.0.0",
        entrypointRelativePath: candidate.entrypointRelativePath,
      }),
    );
    priorRecord = append(
      priorRecord,
      receipt("generation-materialized", 2, {
        role: "candidate",
        generation: { ...candidate, packageVersion: "2.0.0" },
      }),
    );
    priorRecord = append(
      priorRecord,
      receipt("candidate-selection-intent", 3, { from: previous, to: candidate }),
    );
    priorRecord = append(priorRecord, receipt("candidate-selected", 4, { selection: candidate }));
    priorRecord = append(
      priorRecord,
      receipt("completion", 5, {
        packageVersion: "2.0.0",
        launcherVersion: "2.0.0",
        serviceRunning: true,
        serviceEnabled: true,
      }),
    );
    priorRecord = append(
      priorRecord,
      receipt("cleanup-intent", 6, {
        generationIds: [],
        protectedGenerationIds: [previous.generationId, candidate.generationId],
      }),
    );
    priorRecord = append(
      priorRecord,
      receipt("cleanup-completed", 7, { removedGenerationIds: [], deferred: [] }),
    );
    const priorSnapshot = { revision: "8", record: priorRecord };
    const ledger = new MemoryLedger(priorSnapshot);
    const nextTransactionId = "update-transaction-2";
    const nextIntent = {
      ...intent(candidate, true),
      transactionId: nextTransactionId,
      receiptId: buildUpdateGenerationReceiptId({
        transactionId: nextTransactionId,
        sequence: 0,
        kind: "intent",
      }),
      previousPackageVersion: "2.0.0",
      brokerRevision: projectUpdateGenerationTransaction(priorRecord).brokerRevision,
    };

    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: priorSnapshot,
        receipt: { ...nextIntent, brokerRevision: "stale-broker-revision" },
      }),
    ).rejects.toThrow("continue its broker revision chain");
    await expect(ledger.read(NAMESPACE_KEY)).resolves.toEqual(priorSnapshot);

    const next = await persistUpdateGenerationReceipt({
      filesystem: AUTHENTICATION_FILESYSTEM,
      ledger,
      snapshot: priorSnapshot,
      receipt: nextIntent,
    });
    expect(next.record).toEqual({
      formatVersion: 1,
      transactionId: nextTransactionId,
      namespaceKey: NAMESPACE_KEY,
      receipts: [nextIntent],
    });
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: priorSnapshot,
        receipt: nextIntent,
      }),
    ).resolves.toEqual(next);
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger,
        snapshot: next,
        receipt: {
          ...nextIntent,
          transactionId: "foreign-transaction",
          receiptId: buildUpdateGenerationReceiptId({
            transactionId: "foreign-transaction",
            sequence: 0,
            kind: "intent",
          }),
          namespaceKey: "foreign-namespace",
        },
      }),
    ).rejects.toThrow("snapshot belongs to a different namespace");
    await expect(
      persistUpdateGenerationReceipt({
        filesystem: AUTHENTICATION_FILESYSTEM,
        ledger: new MemoryLedger({ revision: "5", record: priorRecord }),
        snapshot: {
          revision: "5",
          record: { ...priorRecord, receipts: priorRecord.receipts.slice(0, -2) },
        },
        receipt: nextIntent,
      }),
    ).rejects.toThrow("requires completed prior cleanup");
  });
});
