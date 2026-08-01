export type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type PromiseConstructorWithResolvers = PromiseConstructor & {
  withResolvers<T>(): Deferred<T>;
};

const promiseWithResolvers = Promise as PromiseConstructorWithResolvers;

export function createDeferred<T = void>(): Deferred<T> {
  return promiseWithResolvers.withResolvers<T>();
}
