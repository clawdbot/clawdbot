import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TestOnlyPathUpdateGenerationProvider } from "../../test/helpers/update-generation-path-provider.js";
import { captureUpdateGenerationManifest } from "../../test/helpers/update-generation-path-store.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import * as confinedFilesystemModule from "./update-generation-confined-filesystem.js";
import {
  assertUpdateGenerationBrokerReceiptIsValid,
  digestUpdateGenerationBrokerReceiptPayload,
  digestUpdateGenerationBrokerRequest,
  performUpdateGenerationBrokerOperation,
  UpdateGenerationConfinedFilesystem,
  type UpdateGenerationBrokerReceipt,
  type UpdateGenerationBrokerRequest,
} from "./update-generation-confined-filesystem.js";

const SIGNATURE = Buffer.alloc(64, 3).toString("base64");

async function makeFixtureWritable(root: string): Promise<void> {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat || stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    await fs.chmod(root, stat.mode | 0o700);
    for (const entry of await fs.readdir(root)) {
      await makeFixtureWritable(path.join(root, entry));
    }
  } else {
    await fs.chmod(root, stat.mode | 0o600);
  }
}

function selection(character: string) {
  return {
    formatVersion: 1 as const,
    generationId: character.repeat(32),
    manifestSha256: character.repeat(64),
    entrypointRelativePath: "openclaw.mjs",
  };
}

function materializationRequest(): Extract<
  UpdateGenerationBrokerRequest,
  { kind: "materialize-generation" }
> {
  return {
    formatVersion: 1,
    kind: "materialize-generation",
    brokerId: "protected-update-broker",
    namespaceKey: "openclaw-global-owner",
    transactionId: "transaction-1",
    operationId: "operation-1",
    expectedRevision: "revision-7",
    role: "candidate",
    sourceArtifactId: "staging-artifact-1",
    manifest: {
      algorithm: "sha256",
      digest: "b".repeat(64),
      entryCount: 2,
      totalBytes: 100,
    },
    generation: {
      ...selection("b"),
      packageVersion: "2.0.0",
    },
  };
}

function signedMaterializationReceipt(
  request: ReturnType<typeof materializationRequest>,
): Extract<UpdateGenerationBrokerReceipt, { kind: "materialize-generation" }> {
  const placeholder: Extract<UpdateGenerationBrokerReceipt, { kind: "materialize-generation" }> = {
    formatVersion: 1,
    kind: request.kind,
    brokerId: request.brokerId,
    namespaceKey: request.namespaceKey,
    transactionId: request.transactionId,
    operationId: request.operationId,
    requestSha256: digestUpdateGenerationBrokerRequest(request),
    previousRevision: request.expectedRevision,
    revision: "revision-8",
    recordedAtMs: 1_788_300_000_000,
    role: request.role,
    sourceArtifactId: request.sourceArtifactId,
    manifest: request.manifest,
    generation: request.generation,
    signature: {
      algorithm: "ed25519",
      keyId: "broker-signing-key-1",
      signedPayloadSha256: "0".repeat(64),
      valueBase64: SIGNATURE,
    },
  };
  placeholder.signature.signedPayloadSha256 =
    digestUpdateGenerationBrokerReceiptPayload(placeholder);
  return placeholder;
}

function signReceipt<Receipt extends UpdateGenerationBrokerReceipt>(receipt: Receipt): Receipt {
  receipt.signature.signedPayloadSha256 = digestUpdateGenerationBrokerReceiptPayload(receipt);
  return receipt;
}

function testSignature() {
  return {
    algorithm: "ed25519" as const,
    keyId: "broker-signing-key-1",
    signedPayloadSha256: "0".repeat(64),
    valueBase64: SIGNATURE,
  };
}

function signedParentSyncReceipt(): UpdateGenerationBrokerReceipt {
  const request: Extract<UpdateGenerationBrokerRequest, { kind: "sync-parent-directory" }> = {
    formatVersion: 1,
    kind: "sync-parent-directory",
    brokerId: "protected-update-broker",
    namespaceKey: "openclaw-global-owner",
    transactionId: "transaction-1",
    operationId: "sync-operation",
    expectedRevision: "revision-8",
    parent: "generations",
    afterOperationId: "materialize-operation",
  };
  return signReceipt({
    formatVersion: 1,
    kind: request.kind,
    brokerId: request.brokerId,
    namespaceKey: request.namespaceKey,
    transactionId: request.transactionId,
    operationId: request.operationId,
    requestSha256: digestUpdateGenerationBrokerRequest(request),
    previousRevision: request.expectedRevision,
    revision: "revision-9",
    recordedAtMs: 1_788_300_000_001,
    parent: request.parent,
    afterOperationId: request.afterOperationId,
    durable: true,
    signature: testSignature(),
  });
}

function retainedPair() {
  return {
    selected: selection("b"),
    rollback: selection("a"),
    selectedManifestVerified: true as const,
    rollbackManifestVerified: true as const,
  };
}

function signedRetainedPairReceipt(): UpdateGenerationBrokerReceipt {
  const pair = retainedPair();
  const request: Extract<UpdateGenerationBrokerRequest, { kind: "verify-retained-pair" }> = {
    formatVersion: 1,
    kind: "verify-retained-pair",
    brokerId: "protected-update-broker",
    namespaceKey: "openclaw-global-owner",
    transactionId: "transaction-1",
    operationId: "retained-operation",
    expectedRevision: "revision-9",
    selected: pair.selected,
    rollback: pair.rollback,
  };
  return signReceipt({
    formatVersion: 1,
    kind: request.kind,
    brokerId: request.brokerId,
    namespaceKey: request.namespaceKey,
    transactionId: request.transactionId,
    operationId: request.operationId,
    requestSha256: digestUpdateGenerationBrokerRequest(request),
    previousRevision: request.expectedRevision,
    revision: request.expectedRevision,
    recordedAtMs: 1_788_300_000_002,
    retainedPair: pair,
    signature: testSignature(),
  });
}

function signedRecoveryObservation(): UpdateGenerationBrokerReceipt {
  const pair = retainedPair();
  const request: Extract<UpdateGenerationBrokerRequest, { kind: "observe-recovery" }> = {
    formatVersion: 1,
    kind: "observe-recovery",
    brokerId: "protected-update-broker",
    namespaceKey: "openclaw-global-owner",
    transactionId: "transaction-1",
    operationId: "observation-operation",
    expectedRevision: "revision-9",
  };
  return signReceipt({
    formatVersion: 1,
    kind: request.kind,
    brokerId: request.brokerId,
    namespaceKey: request.namespaceKey,
    transactionId: request.transactionId,
    operationId: request.operationId,
    requestSha256: digestUpdateGenerationBrokerRequest(request),
    previousRevision: request.expectedRevision,
    revision: request.expectedRevision,
    recordedAtMs: 1_788_300_000_003,
    selector: pair.selected,
    selectorDurable: true,
    generations: [pair.selected, pair.rollback].map((entry) => ({
      generationId: entry.generationId,
      manifestSha256: entry.manifestSha256,
      parentDirectoryDurable: true,
    })),
    retainedPair: pair,
    signature: testSignature(),
  });
}

class FixtureConfinedFilesystem extends UpdateGenerationConfinedFilesystem {
  readonly brokerId: string;
  readonly namespaceKey: string;

  constructor(
    private readonly receipt: UpdateGenerationBrokerReceipt,
    private readonly signatureValid = true,
  ) {
    super();
    this.brokerId = receipt.brokerId;
    this.namespaceKey = receipt.namespaceKey;
  }

  protected async invokeBroker(): Promise<UpdateGenerationBrokerReceipt> {
    return this.receipt;
  }

  protected async verifyBrokerSignature(): Promise<boolean> {
    return this.signatureValid;
  }
}

describe("confined update-generation filesystem contract", () => {
  it("exports no production pathname backend or construction factory", async () => {
    expect(Object.keys(confinedFilesystemModule).toSorted()).toEqual([
      "UpdateGenerationConfinedFilesystem",
      "assertUpdateGenerationBrokerReceiptIsValid",
      "buildUpdateGenerationBrokerOperationId",
      "digestUpdateGenerationBrokerReceiptPayload",
      "digestUpdateGenerationBrokerRequest",
      "performUpdateGenerationBrokerOperation",
    ]);
    const productionOwnerFiles = (await fs.readdir(import.meta.dirname))
      .filter(
        (name) =>
          name.startsWith("update-generation-") &&
          name.endsWith(".ts") &&
          !name.endsWith(".test.ts"),
      )
      .toSorted();
    expect(productionOwnerFiles).toEqual([
      "update-generation-confined-filesystem.ts",
      "update-generation-contract-parser.ts",
      "update-generation-contract-schema.ts",
      "update-generation-contract.ts",
      "update-generation-evidence.ts",
      "update-generation-ledger-hook.ts",
      "update-generation-recovery.ts",
    ]);
    const providerSource = await fs.readFile(
      path.join(import.meta.dirname, "update-generation-confined-filesystem.ts"),
      "utf8",
    );
    expect(providerSource).not.toMatch(/from "node:(?:fs|path)(?:\/promises)?"/u);
  });

  it("cannot perform a state-changing operation without a confined provider", async () => {
    await expect(
      performUpdateGenerationBrokerOperation({
        filesystem: null,
        request: materializationRequest(),
      }),
    ).rejects.toThrow("requires a confined filesystem provider");
  });

  it("accepts only a broker-signed receipt bound to the request and namespace revision", async () => {
    const request = materializationRequest();
    const receipt = signedMaterializationReceipt(request);
    await expect(
      performUpdateGenerationBrokerOperation({
        filesystem: new FixtureConfinedFilesystem(receipt),
        request,
      }),
    ).resolves.toEqual(receipt);

    const staleRevision = signedMaterializationReceipt(request);
    staleRevision.previousRevision = "revision-6";
    staleRevision.signature.signedPayloadSha256 =
      digestUpdateGenerationBrokerReceiptPayload(staleRevision);
    await expect(
      performUpdateGenerationBrokerOperation({
        filesystem: new FixtureConfinedFilesystem(staleRevision),
        request,
      }),
    ).rejects.toThrow("differs from its operation request");

    await expect(
      performUpdateGenerationBrokerOperation({
        filesystem: new FixtureConfinedFilesystem(receipt, false),
        request,
      }),
    ).rejects.toThrow("signature was not authenticated");
  });

  it("rejects invalid mutating revisions even when re-signed", () => {
    for (const invalid of ["", "   ", 0, { revision: "revision-8" }]) {
      const request = materializationRequest();
      const receipt = signedMaterializationReceipt(request);
      Reflect.set(receipt, "revision", invalid);
      signReceipt(receipt);
      expect(
        () => assertUpdateGenerationBrokerReceiptIsValid(receipt),
        `revision: ${typeof invalid}`,
      ).toThrow("must advance the namespace revision");
    }
  });

  it("rejects forged non-boolean crash-durability claims even when re-signed", () => {
    const forgeries: Array<{
      label: string;
      receipt: () => UpdateGenerationBrokerReceipt;
      mutate: (receipt: UpdateGenerationBrokerReceipt, value: unknown) => void;
    }> = [
      {
        label: "parent sync durable",
        receipt: signedParentSyncReceipt,
        mutate: (receipt, value) => Reflect.set(receipt, "durable", value),
      },
      {
        label: "selector durable",
        receipt: signedRecoveryObservation,
        mutate: (receipt, value) => Reflect.set(receipt, "selectorDurable", value),
      },
      {
        label: "generation parent durable",
        receipt: signedRecoveryObservation,
        mutate: (receipt, value) => {
          if (receipt.kind !== "observe-recovery" || !receipt.generations[0]) {
            throw new Error("expected recovery generation");
          }
          Reflect.set(receipt.generations[0], "parentDirectoryDurable", value);
        },
      },
      {
        label: "selected manifest verified",
        receipt: signedRetainedPairReceipt,
        mutate: (receipt, value) => {
          if (receipt.kind !== "verify-retained-pair") {
            throw new Error("expected retained pair");
          }
          Reflect.set(receipt.retainedPair, "selectedManifestVerified", value);
        },
      },
      {
        label: "rollback manifest verified",
        receipt: signedRetainedPairReceipt,
        mutate: (receipt, value) => {
          if (receipt.kind !== "verify-retained-pair") {
            throw new Error("expected retained pair");
          }
          Reflect.set(receipt.retainedPair, "rollbackManifestVerified", value);
        },
      },
    ];
    for (const forgery of forgeries) {
      for (const invalid of ["false", { value: false }, 1]) {
        const receipt = forgery.receipt();
        forgery.mutate(receipt, invalid);
        signReceipt(receipt);
        expect(
          () => assertUpdateGenerationBrokerReceiptIsValid(receipt),
          `${forgery.label}: ${typeof invalid}`,
        ).toThrow();
      }
    }
  });

  it("keeps the pathname-backed implementation in test support", async () => {
    await withTestDir({ prefix: "update-generation-confined-" }, async (root) => {
      try {
        const sourceRoot = path.join(root, "source");
        const namespaceRoot = path.join(root, "namespace");
        await fs.mkdir(sourceRoot, { recursive: true });
        await fs.writeFile(path.join(sourceRoot, "openclaw.mjs"), 'console.log("2.0.0");\n');
        const manifest = await captureUpdateGenerationManifest(sourceRoot);
        const request = materializationRequest();
        request.expectedRevision = null;
        request.manifest = manifest;
        request.generation.manifestSha256 = manifest.digest;
        const filesystem = new TestOnlyPathUpdateGenerationProvider({
          namespaceRoot,
          sourceArtifacts: new Map([[request.sourceArtifactId, sourceRoot]]),
          brokerId: request.brokerId,
          namespaceKey: request.namespaceKey,
        });
        const materialized = await performUpdateGenerationBrokerOperation({ filesystem, request });
        const syncRequest: Extract<
          UpdateGenerationBrokerRequest,
          { kind: "sync-parent-directory" }
        > = {
          formatVersion: 1,
          kind: "sync-parent-directory",
          brokerId: request.brokerId,
          namespaceKey: request.namespaceKey,
          transactionId: request.transactionId,
          operationId: "operation-2",
          expectedRevision: materialized.revision,
          parent: "generations",
          afterOperationId: materialized.operationId,
        };
        await expect(
          performUpdateGenerationBrokerOperation({ filesystem, request: syncRequest }),
        ).resolves.toMatchObject({
          kind: "sync-parent-directory",
          durable: true,
          afterOperationId: materialized.operationId,
        });
      } finally {
        await makeFixtureWritable(root);
      }
    });
  });
});
