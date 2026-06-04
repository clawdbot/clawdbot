/** Fetch mock shape used by tests that replace global fetch. */
export type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

export function withFetchPreconnect<T extends typeof fetch>(fn: T): T & FetchWithPreconnect;
export function withFetchPreconnect<T extends object>(
  fn: T,
): T & FetchWithPreconnect & typeof fetch;
export function withFetchPreconnect(fn: object) {
  return Object.assign(fn, {
    preconnect: (_url: string | URL, _options?: FetchPreconnectOptions) => {},
    __openclawAcceptsDispatcher: true as const,
  });
}
