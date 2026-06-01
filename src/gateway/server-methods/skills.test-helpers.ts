import { vi } from "vitest";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

export type CapturedGatewayResponse = {
  ok: boolean | null;
  response: unknown;
  error: unknown;
};

function makeGatewayHandlerTestContext(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    logGateway: vi.fn(),
  } as unknown as GatewayRequestContext;
}

export async function callGatewayHandler(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown>,
): Promise<CapturedGatewayResponse> {
  let ok: boolean | null = null;
  let response: unknown;
  let error: unknown;
  const handler = handlers[method];

  if (!handler) {
    throw new Error(`unknown gateway handler: ${method}`);
  }

  await handler({
    params,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
    context: makeGatewayHandlerTestContext(),
    respond: (success, result, err) => {
      ok = success;
      response = result;
      error = err;
    },
  });

  return { ok, response, error };
}
