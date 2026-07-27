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

type FetchFunction = (...args: unknown[]) => unknown;

// Bounded CDP readers consume arrayBuffer(); keep lightweight json-only test
// responses compatible without weakening the production response boundary.
function addArrayBufferFallback(response: unknown): unknown {
  if (!response || typeof response !== "object") {
    return response;
  }
  const partial = response as {
    arrayBuffer?: () => Promise<ArrayBuffer>;
    json?: () => Promise<unknown>;
  };
  if (typeof partial.arrayBuffer === "function" || typeof partial.json !== "function") {
    return response;
  }
  partial.arrayBuffer = async () =>
    new TextEncoder().encode(JSON.stringify(await partial.json!())).buffer;
  return response;
}

/** Adds Browser test preconnect metadata to a fetch-like function. */
export function withBrowserFetchPreconnect<T extends typeof fetch>(fn: T): T & FetchWithPreconnect;
export function withBrowserFetchPreconnect<T extends object>(
  fn: T,
): T & FetchWithPreconnect & typeof fetch;
export function withBrowserFetchPreconnect(fn: object) {
  const fetchFn = Object.assign(fn as FetchFunction, {
    preconnect: (_url: string | URL, _options?: FetchPreconnectOptions) => {},
    __openclawAcceptsDispatcher: true as const,
  });
  return new Proxy(fetchFn, {
    async apply(target, thisArg, args) {
      return addArrayBufferFallback(await Reflect.apply(target, thisArg, args));
    },
  });
}
