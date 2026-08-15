/**
 * Async stream iterator wrapper.
 *
 * Lets stream decorators override next/return/throw while preserving the underlying iterator contract.
 */
type StreamIterator<T> = AsyncIterator<T, unknown, unknown>;

// Optional return/throw handlers let stream wrappers observe cleanup and errors
// while preserving the underlying iterator contract when they do not intercept.
type IteratorHandler<T> = (
  iterator: StreamIterator<T>,
  value?: unknown,
) => IteratorResult<T, unknown> | Promise<IteratorResult<T, unknown>>;

/** Wraps an async iterator with custom next/return/throw behavior. */
export function createStreamIteratorWrapper<T>(params: {
  iterator: StreamIterator<T>;
  next: (iterator: StreamIterator<T>) => Promise<IteratorResult<T, unknown>>;
  onReturn?: IteratorHandler<T>;
  onThrow?: IteratorHandler<T>;
}): AsyncIterableIterator<T> {
  const wrapper: AsyncIterableIterator<T> = {
    async next() {
      return params.next(params.iterator);
    },
    async return(value?: unknown) {
      return (
        (await params.onReturn?.(params.iterator, value)) ??
        (await params.iterator.return?.(value)) ?? { done: true as const, value: undefined }
      );
    },
    async throw(error?: unknown) {
      return (
        (await params.onThrow?.(params.iterator, error)) ??
        (await params.iterator.throw?.(error)) ?? { done: true as const, value: undefined }
      );
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return wrapper;
}
