/**
 * Small gateway-handler invocation harness for skills method tests.
 */
import { vi } from "vitest";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

/** Captured JSON-RPC response tuple emitted by a gateway request handler. */
type CapturedGatewayResponse = {
  ok: boolean | null;
  response: unknown;
  error: unknown;
};

function makeGatewayHandlerTestContext(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    logGateway: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as GatewayRequestContext;
}

/** Invokes a named gateway handler with a minimal context and captures its response. */
export async function callGatewayHandler(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown>,
  options: {
    client?: GatewayClient | null;
    context?: Partial<GatewayRequestContext>;
  } = {},
): Promise<CapturedGatewayResponse> {
  let ok: boolean | null = null;
  let response: unknown;
  let error: unknown;
  const handler = handlers[method];

  if (!handler) {
    throw new Error(`unknown gateway handler: ${method}`);
  }

  const baseContext = makeGatewayHandlerTestContext();
  await handler({
    params,
    req: {} as never,
    client: options.client ?? null,
    isWebchatConnect: () => false,
    context: { ...baseContext, ...options.context } as GatewayRequestContext,
    respond: (success, result, err) => {
      ok = success;
      response = result;
      error = err;
    },
  });

  return { ok, response, error };
}
