import type { ProviderCatalogOutcome, ProviderCatalogResult } from "../plugins/types.js";

export class LiveModelCatalogHttpError extends Error {
  readonly status: number;

  constructor(providerId: string, status: number) {
    super(`${providerId} model discovery failed: HTTP ${status}`);
    this.name = "LiveModelCatalogHttpError";
    this.status = status;
  }
}

export async function runLiveProviderCatalog(params: {
  providerId: string;
  profileId?: string;
  run: () => Promise<ProviderCatalogResult>;
}): Promise<ProviderCatalogResult> {
  const identity = {
    provider: params.providerId,
    ...(params.profileId ? { profileId: params.profileId } : {}),
  };
  try {
    const result = await params.run();
    return result
      ? { ...result, outcomes: [...(result.outcomes ?? []), { ...identity, status: "ready" }] }
      : result;
  } catch (error) {
    const rejected =
      error instanceof LiveModelCatalogHttpError && (error.status === 401 || error.status === 403);
    const outcome: ProviderCatalogOutcome = rejected
      ? { ...identity, status: "auth-rejected", rejectionScope: "catalog" }
      : { ...identity, status: "unavailable" };
    return { providers: {}, outcomes: [outcome] };
  }
}
