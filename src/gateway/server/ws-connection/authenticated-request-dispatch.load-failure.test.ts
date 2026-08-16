import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayWsClient } from "../ws-types.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

function moduleNotFoundError(filePath: string): Error {
  return Object.assign(new Error(`Cannot find module '${filePath}'`), {
    code: "ERR_MODULE_NOT_FOUND",
    url: pathToFileURL(filePath).href,
  });
}

describe("authenticated request dispatcher load failures", () => {
  afterEach(() => {
    vi.doUnmock("./authenticated-request-dispatch.server-methods.runtime.js");
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("returns typed restart guidance when the running install changed", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "r13");
    const missingChunk = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "missing-request-dispatch-chunk.js",
    );
    const error = moduleNotFoundError(missingChunk);
    vi.resetModules();
    vi.doMock("./authenticated-request-dispatch.server-methods.runtime.js", () => ({
      get handleGatewayRequest() {
        throw error;
      },
    }));
    const { createGatewayAuthenticatedRequestDispatcher } =
      await import("./authenticated-request-dispatch.js");
    const send = vi.fn((_frame: unknown) => ({ kind: "sent" }) as const);
    const dispatcher = createGatewayAuthenticatedRequestDispatcher({
      handler: {
        connId: "stale-install-dispatch",
        extraHandlers: {},
        buildRequestContext: () => ({}) as never,
        send,
        close: vi.fn(),
        isClosed: () => false,
        setCloseCause: vi.fn(),
        logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } as unknown as GatewayWsMessageHandlerParams,
      isWebchatConnect: () => false,
    });
    const client = {
      socket: {},
      connId: "stale-install-dispatch",
      usesSharedGatewayAuth: false,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "gateway-client", version: "dev", platform: "test", mode: "backend" },
        role: "operator",
        scopes: ["operator.admin"],
      },
    } as GatewayWsClient;

    await dispatcher.dispatch(
      { type: "req", id: "stale-install", method: "status", params: {} },
      client,
    );

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "stale-install",
          ok: false,
          error: expect.objectContaining({
            code: "UNAVAILABLE",
            retryable: false,
            message: expect.stringContaining("openclaw --profile r13 gateway restart"),
            details: {
              code: "STALE_INSTALL",
              restartCommand: "openclaw --profile r13 gateway restart",
            },
          }),
        }),
      );
    });
  });
});
