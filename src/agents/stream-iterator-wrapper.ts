type StreamIterator<T> = AsyncIterator<T, unknown, unknown>;

type IteratorHandler<T> = (
  iterator: StreamIterator<T>,
  value?: unknown,
) => IteratorResult<T, unknown> | Promise<IteratorResult<T, unknown>>;

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
