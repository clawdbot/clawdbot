// Memory Core receives local-service acquisition from the host before provider creation.
export type MemoryCoreAcquireLocalService = (
  target: {
    providerId: string;
    baseUrl: string;
    headers?: HeadersInit;
  },
  signal?: AbortSignal | null,
) => Promise<{ release: () => void } | undefined>;

let acquireLocalService: MemoryCoreAcquireLocalService | undefined;

export function configureMemoryCoreEmbeddingLocalService(
  acquire: MemoryCoreAcquireLocalService | undefined,
): void {
  acquireLocalService = acquire;
}

export function getMemoryCoreEmbeddingLocalService(): MemoryCoreAcquireLocalService | undefined {
  return acquireLocalService;
}
