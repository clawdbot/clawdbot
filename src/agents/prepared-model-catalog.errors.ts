export class PreparedModelCatalogConfigReplacedError extends Error {
  constructor(agentDir: string) {
    super(`prepared model catalog owner config was replaced during the read (${agentDir})`);
    this.name = "PreparedModelCatalogConfigReplacedError";
  }
}
