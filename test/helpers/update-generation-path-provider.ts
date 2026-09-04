/**
 * Test-only pathname implementation of the confined filesystem contract.
 *
 * Production code must not import this module. It exists only to exercise the
 * state-machine contract while the protected broker provider is developed in
 * its own prerequisite.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  digestUpdateGenerationBrokerReceiptPayload,
  digestUpdateGenerationBrokerRequest,
  UpdateGenerationConfinedFilesystem,
  type UpdateGenerationBrokerReceipt,
  type UpdateGenerationBrokerRequest,
  type UpdateGenerationRetainedPair,
} from "../../src/infra/update-generation-confined-filesystem.js";
import type { UpdateGenerationSelection } from "../../src/infra/update-generation-contract.js";
import { syncUpdateGenerationPath } from "./update-generation-path-manifest.js";
import {
  captureUpdateGenerationManifest,
  materializeUpdateGeneration,
  readUpdateGenerationSelector,
  removeObsoleteUpdateGeneration,
  replaceUpdateGenerationSelector,
} from "./update-generation-path-store.js";

const TEST_SIGNATURE = Buffer.alloc(64, 11).toString("base64");

type WithoutSignature<Receipt> = Receipt extends unknown ? Omit<Receipt, "signature"> : never;
type ReceiptWithoutSignature = WithoutSignature<UpdateGenerationBrokerReceipt>;

function signTestReceipt(receipt: ReceiptWithoutSignature) {
  const signed = {
    ...receipt,
    signature: {
      algorithm: "ed25519" as const,
      keyId: "test-path-provider-key",
      signedPayloadSha256: "0".repeat(64),
      valueBase64: TEST_SIGNATURE,
    },
  } as UpdateGenerationBrokerReceipt;
  signed.signature.signedPayloadSha256 = digestUpdateGenerationBrokerReceiptPayload(signed);
  return signed;
}

export class TestOnlyPathUpdateGenerationProvider extends UpdateGenerationConfinedFilesystem {
  readonly brokerId: string;
  readonly namespaceKey: string;
  readonly #namespaceRoot: string;
  readonly #sourceArtifacts: ReadonlyMap<string, string>;
  readonly #replays = new Map<
    string,
    { requestSha256: string; receipt: UpdateGenerationBrokerReceipt }
  >();
  #revision: string | null;
  #revisionSequence = 0;

  constructor(params: {
    namespaceRoot: string;
    sourceArtifacts: ReadonlyMap<string, string>;
    initialRevision?: string | null;
    brokerId: string;
    namespaceKey: string;
  }) {
    super();
    this.brokerId = params.brokerId;
    this.namespaceKey = params.namespaceKey;
    this.#namespaceRoot = path.resolve(params.namespaceRoot);
    this.#sourceArtifacts = params.sourceArtifacts;
    this.#revision = params.initialRevision ?? null;
  }

  protected async verifyBrokerSignature(receipt: UpdateGenerationBrokerReceipt): Promise<boolean> {
    return (
      receipt.signature.keyId === "test-path-provider-key" &&
      receipt.signature.valueBase64 === TEST_SIGNATURE
    );
  }

  protected async invokeBroker(
    request: UpdateGenerationBrokerRequest,
  ): Promise<UpdateGenerationBrokerReceipt> {
    const requestSha256 = digestUpdateGenerationBrokerRequest(request);
    const replay = this.#replays.get(request.operationId);
    if (replay) {
      if (replay.requestSha256 !== requestSha256) {
        throw new Error("Test broker operation id was replayed with different content");
      }
      return replay.receipt;
    }
    if (request.expectedRevision !== this.#revision) {
      throw new Error("Test broker namespace revision changed");
    }
    const previousRevision = this.#revision;
    if (request.kind !== "observe-recovery" && request.kind !== "verify-retained-pair") {
      this.#revisionSequence += 1;
    }
    const revision =
      request.kind === "observe-recovery" || request.kind === "verify-retained-pair"
        ? previousRevision
        : `test-path-revision-${this.#revisionSequence}`;
    const base = {
      formatVersion: 1 as const,
      kind: request.kind,
      brokerId: request.brokerId,
      namespaceKey: request.namespaceKey,
      transactionId: request.transactionId,
      operationId: request.operationId,
      requestSha256,
      previousRevision,
      revision,
      recordedAtMs: 1_788_301_000_000 + this.#revisionSequence,
    };
    let unsigned: ReceiptWithoutSignature;
    if (request.kind === "materialize-generation") {
      const sourceRoot = this.#sourceArtifacts.get(request.sourceArtifactId);
      if (!sourceRoot) {
        throw new Error(`Unknown test source artifact ${request.sourceArtifactId}`);
      }
      const materialized = await materializeUpdateGeneration({
        namespaceRoot: this.#namespaceRoot,
        sourceRoot,
        generationId: request.generation.generationId,
        expectedManifest: request.manifest,
        packageVersion: request.generation.packageVersion,
        entrypointRelativePath: request.generation.entrypointRelativePath,
      });
      unsigned = {
        ...base,
        kind: request.kind,
        role: request.role,
        sourceArtifactId: request.sourceArtifactId,
        manifest: request.manifest,
        generation: materialized.generation,
      };
    } else if (request.kind === "sync-parent-directory") {
      const directory =
        request.parent === "generations"
          ? path.join(this.#namespaceRoot, "generations")
          : this.#namespaceRoot;
      await syncUpdateGenerationPath(directory);
      unsigned = {
        ...base,
        kind: request.kind,
        parent: request.parent,
        afterOperationId: request.afterOperationId,
        durable: true,
      };
    } else if (request.kind === "switch-selector") {
      await replaceUpdateGenerationSelector({
        namespaceRoot: this.#namespaceRoot,
        expected: request.expected,
        next: request.next,
      });
      unsigned = {
        ...base,
        kind: request.kind,
        previous: request.expected,
        selected: request.next,
      };
    } else if (request.kind === "cleanup-generations") {
      const removedGenerationIds: string[] = [];
      const deferred: Array<{ generationId: string; reason: string }> = [];
      for (const generationId of request.generationIds) {
        try {
          if (
            await removeObsoleteUpdateGeneration({
              namespaceRoot: this.#namespaceRoot,
              generationId,
              protectedGenerationIds: request.protectedGenerationIds,
            })
          ) {
            removedGenerationIds.push(generationId);
          } else {
            deferred.push({ generationId, reason: "not present" });
          }
        } catch (error) {
          deferred.push({
            generationId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      unsigned = {
        ...base,
        kind: request.kind,
        generationIds: request.generationIds,
        removedGenerationIds,
        deferred,
        protectedGenerationIds: request.protectedGenerationIds,
      };
    } else if (request.kind === "verify-retained-pair") {
      await this.#verifySelection(request.selected);
      await this.#verifySelection(request.rollback);
      unsigned = {
        ...base,
        kind: request.kind,
        retainedPair: this.#retainedPair(request.selected, request.rollback),
      };
    } else {
      const selector = await readUpdateGenerationSelector(this.#namespaceRoot);
      const generations = await this.#observeGenerations();
      const rollback = selector
        ? generations.find((generation) => generation.generationId !== selector.generationId)
        : null;
      let retained: UpdateGenerationRetainedPair | null = null;
      if (selector && rollback) {
        retained = this.#retainedPair(selector, {
          formatVersion: 1,
          generationId: rollback.generationId,
          manifestSha256: rollback.manifestSha256,
          entrypointRelativePath: selector.entrypointRelativePath,
        });
      }
      unsigned = {
        ...base,
        kind: request.kind,
        selector,
        selectorDurable: true,
        generations,
        retainedPair: retained,
      };
    }
    const receipt = signTestReceipt(unsigned);
    this.#revision = revision;
    this.#replays.set(request.operationId, { requestSha256, receipt });
    return receipt;
  }

  #retainedPair(
    selected: UpdateGenerationSelection,
    rollback: UpdateGenerationSelection,
  ): UpdateGenerationRetainedPair {
    return {
      selected,
      rollback,
      selectedManifestVerified: true,
      rollbackManifestVerified: true,
    };
  }

  async #verifySelection(selection: UpdateGenerationSelection): Promise<void> {
    const manifest = await captureUpdateGenerationManifest(
      path.join(this.#namespaceRoot, "generations", selection.generationId, "payload"),
    );
    if (manifest.digest !== selection.manifestSha256) {
      throw new Error(`Test generation ${selection.generationId} manifest changed`);
    }
  }

  async #observeGenerations() {
    const generationsRoot = path.join(this.#namespaceRoot, "generations");
    const entries = await fs.readdir(generationsRoot, { withFileTypes: true }).catch(() => []);
    const generations = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/u.test(entry.name)) {
        continue;
      }
      const manifest = await captureUpdateGenerationManifest(
        path.join(generationsRoot, entry.name, "payload"),
      );
      generations.push({
        generationId: entry.name,
        manifestSha256: manifest.digest,
        parentDirectoryDurable: true,
      });
    }
    return generations;
  }
}
