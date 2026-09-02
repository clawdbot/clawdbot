// Lazy core handler families keep gateway startup metadata-only until first use.
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

export function lazyHandlerModule<T>(
  loadModule: () => Promise<T>,
  selectHandlers: (module: T) => GatewayRequestHandlers,
): () => Promise<GatewayRequestHandlers> {
  let handlersPromise: Promise<GatewayRequestHandlers> | null = null;
  // Cache the first import so concurrent calls to one family share its load.
  return () => (handlersPromise ??= loadModule().then(selectHandlers));
}

export function createLazyCoreHandlers(params: {
  methods: readonly string[];
  loadHandlers: () => Promise<GatewayRequestHandlers>;
}): GatewayRequestHandlers {
  return Object.fromEntries(
    params.methods.map((method) => [
      method,
      async (opts: GatewayRequestHandlerOptions) => {
        const handlers = await params.loadHandlers();
        const handler = handlers[method];
        if (!handler) {
          // Advertised core methods must exist once their family resolves.
          throw new Error(`lazy gateway handler not found: ${method}`);
        }
        await handler(opts);
      },
    ]),
  );
}
