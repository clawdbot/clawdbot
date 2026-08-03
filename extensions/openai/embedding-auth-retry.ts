// Openai helper module retries memory embedding calls once after token expiry.

type RefreshableOpenAiEmbeddingClient = {
  refreshClient?: (params?: { forceRefresh?: boolean }) => Promise<unknown>;
};

function isOpenAiEmbeddingTokenExpiredError(error: unknown): boolean {
  const status =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (
    (status === 401 || /\b401\b/.test(message)) &&
    /\btoken[_ -]?expired\b|\bexpired token\b/i.test(message)
  );
}

export async function retryOpenAiEmbeddingTokenExpiredOnce<T>(params: {
  client: RefreshableOpenAiEmbeddingClient;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await params.run();
  } catch (error) {
    if (
      !isOpenAiEmbeddingTokenExpiredError(error) ||
      typeof params.client.refreshClient !== "function"
    ) {
      throw error;
    }
    await params.client.refreshClient({ forceRefresh: true });
    return await params.run();
  }
}
