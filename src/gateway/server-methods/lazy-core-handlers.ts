import type { GatewayRequestEntry } from "../server-request-entry.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

const preparations = new WeakMap<GatewayRequestHandler, () => Promise<GatewayRequestHandler>>();

/** Resolve forwarding wrappers without mistaking them for actual handler entry. */
export async function prepareGatewayRequestHandler(
  handler: GatewayRequestHandler,
  entry?: GatewayRequestEntry,
): Promise<GatewayRequestHandler> {
  let preparedHandler = handler;
  let prepare = preparations.get(preparedHandler);
  while (prepare) {
    entry?.assertOpen();
    preparedHandler = await prepare();
    prepare = preparations.get(preparedHandler);
  }
  return preparedHandler;
}

export function createLazyCoreHandlers(params: {
  methods: readonly string[];
  loadHandlers: () => Promise<GatewayRequestHandlers>;
}): GatewayRequestHandlers {
  return Object.fromEntries(
    params.methods.map((method) => {
      const forwarding: GatewayRequestHandler = async (opts) => {
        const entry = opts.context.requestEntryLifetime?.enter(opts);
        try {
          const handler = await prepareGatewayRequestHandler(forwarding, entry);
          entry?.assertOpen();
          entry?.release();
          await handler(opts);
        } finally {
          entry?.release();
        }
      };
      preparations.set(forwarding, async () => {
        const handlers = await params.loadHandlers();
        const handler = handlers[method];
        if (!handler) {
          // Advertised core methods must exist once their family resolves.
          throw new Error(`lazy gateway handler not found: ${method}`);
        }
        return handler;
      });
      return [method, forwarding];
    }),
  );
}
