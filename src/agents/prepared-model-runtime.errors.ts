export class PreparedModelRuntimeOwnerNotPublishedError extends Error {}

export class PreparedModelRuntimePublicationSupersededError extends PreparedModelRuntimeOwnerNotPublishedError {}

/** A catalog worker rebuilt facts under a fingerprint other than its owner's generation. */
export class PreparedModelCatalogGenerationMismatchError extends Error {
  constructor(
    readonly agentDir: string,
    readonly generationFingerprint: string,
    readonly reconstructedFingerprint: string,
  ) {
    super(
      `prepared model catalog worker reconstructed a different runtime generation for ${agentDir} (owner=${generationFingerprint} worker=${reconstructedFingerprint})`,
    );
    this.name = "PreparedModelCatalogGenerationMismatchError";
  }
}
