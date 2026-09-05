import type { CallGatewayOptions } from "./call.js";
import { buildMinimalGatewayHelloOkPayload } from "./minimal-gateway.test-helpers.js";

export function gatewayHealthResponse(
  params: {
    server?: Partial<Parameters<NonNullable<CallGatewayOptions["onHelloOk"]>>[0]["server"]>;
    health?: unknown;
    error?: Error;
  } = {},
) {
  return async (opts: CallGatewayOptions): Promise<unknown> => {
    const hello = buildMinimalGatewayHelloOkPayload();
    opts.onHelloOk?.({
      ...hello,
      type: "hello-ok",
      server: { ...hello.server, ...params.server },
      auth: { role: "operator", scopes: ["operator.read"] },
      snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    });
    if (params.error) {
      throw params.error;
    }
    return params.health ?? { ok: true };
  };
}
