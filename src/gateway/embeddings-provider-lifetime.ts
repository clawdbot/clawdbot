import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import type { MemoryEmbeddingProvider } from "../plugins/memory-embedding-providers.js";

const EMBEDDING_PROVIDER_RETIREMENTS = new Map<string, Set<MemoryEmbeddingProvider>>();
const EMBEDDING_PROVIDER_ADMISSION_TAILS = new Map<string, Promise<void>>();

export async function acquireEmbeddingProviderLease(
  scopeKey: string,
  signal: AbortSignal,
  create: () => Promise<MemoryEmbeddingProvider>,
  holdForCleanup: (provider: MemoryEmbeddingProvider) => boolean,
): Promise<{ provider: MemoryEmbeddingProvider; release: () => void }> {
  const previous = EMBEDDING_PROVIDER_ADMISSION_TAILS.get(scopeKey) ?? Promise.resolve();
  const createLease = async () => {
    signal.throwIfAborted();
    await drainEmbeddingProviderRetirements(scopeKey);
    // Keep the cleanup fence intact, but do not create a provider for an aborted waiter.
    signal.throwIfAborted();
    const provider = await create();
    if (signal.aborted) {
      await closeEmbeddingProvider(scopeKey, provider);
      signal.throwIfAborted();
    }
    if (!holdForCleanup(provider)) {
      return { provider, lifecycle: Promise.resolve(), release: () => {} };
    }
    let release: () => void = () => {};
    const lifecycle = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { provider, lifecycle, release };
  };
  const acquired = previous.then(createLease, createLease);
  const tail = acquired
    .then(async ({ lifecycle }) => await lifecycle)
    .then(
      () => undefined,
      () => undefined,
    );
  EMBEDDING_PROVIDER_ADMISSION_TAILS.set(scopeKey, tail);
  void tail.then(() => {
    if (EMBEDDING_PROVIDER_ADMISSION_TAILS.get(scopeKey) === tail) {
      EMBEDDING_PROVIDER_ADMISSION_TAILS.delete(scopeKey);
    }
  });
  const { provider, release } = await acquired;
  return { provider, release };
}

async function drainEmbeddingProviderRetirements(scopeKey: string): Promise<void> {
  const pending = EMBEDDING_PROVIDER_RETIREMENTS.get(scopeKey);
  if (!pending || pending.size === 0) {
    return;
  }
  let firstError: unknown;
  let closeFailed = false;
  for (const provider of pending) {
    try {
      await provider.close?.();
      pending.delete(provider);
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  if (pending.size === 0) {
    EMBEDDING_PROVIDER_RETIREMENTS.delete(scopeKey);
  }
  if (closeFailed) {
    throw firstError;
  }
}

function retainEmbeddingProviderForRetirement(
  scopeKey: string,
  provider: MemoryEmbeddingProvider,
): void {
  const pending = EMBEDDING_PROVIDER_RETIREMENTS.get(scopeKey) ?? new Set();
  pending.add(provider);
  EMBEDDING_PROVIDER_RETIREMENTS.set(scopeKey, pending);
}

export async function closeEmbeddingProvider(
  scopeKey: string,
  provider: MemoryEmbeddingProvider,
): Promise<void> {
  try {
    await provider.close?.();
  } catch (closeErr) {
    retainEmbeddingProviderForRetirement(scopeKey, provider);
    logWarn(`openai-compat: failed to close embeddings provider: ${formatErrorMessage(closeErr)}`);
  }
}

export async function drainRetainedOpenAiEmbeddingProviders(): Promise<void> {
  const activeLifecycles = Array.from(EMBEDDING_PROVIDER_ADMISSION_TAILS.values());
  if (activeLifecycles.length > 0) {
    await Promise.allSettled(activeLifecycles);
  }
  let firstError: unknown;
  let closeFailed = false;
  for (const scopeKey of Array.from(EMBEDDING_PROVIDER_RETIREMENTS.keys())) {
    try {
      await drainEmbeddingProviderRetirements(scopeKey);
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  if (closeFailed) {
    throw firstError;
  }
}
