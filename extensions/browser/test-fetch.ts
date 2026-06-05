/**
 * Test fetch helper that adds no-op preconnect support expected by Browser tests.
 */
type FetchPreconnectOptions = {
  dns?: boolean;
  tcp?: boolean;
  http?: boolean;
  https?: boolean;
};

type FetchWithPreconnect = {
  preconnect: (url: string | URL, options?: FetchPreconnectOptions) => void;
  __openclawAcceptsDispatcher: true;
};

/** Adds Browser test preconnect metadata to a fetch-like function. */
export function withBrowserFetchPreconnect<T extends typeof fetch>(fn: T): T & FetchWithPreconnect;
export function withBrowserFetchPreconnect<T extends object>(
  fn: T,
): T & FetchWithPreconnect & typeof fetch;
export function withBrowserFetchPreconnect(fn: object) {
  return Object.assign(fn, {
    preconnect: (_url: string | URL, _options?: FetchPreconnectOptions) => {},
    __openclawAcceptsDispatcher: true as const,
  });
}
