import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachGatewayWsForTest,
  createGatewayWsTestLogger,
  createGatewayWsTestSocket,
} from "./ws-connection.test-helpers.js";

function moduleNotFoundError(filePath: string): Error {
  return Object.assign(new Error(`Cannot find module '${filePath}'`), {
    code: "ERR_MODULE_NOT_FOUND",
    url: pathToFileURL(filePath).href,
  });
}

async function connectWithMessageHandlerLoadError(error: Error) {
  vi.resetModules();
  vi.doMock("./ws-connection/message-handler.js", () => ({
    get attachGatewayWsMessageHandler() {
      throw error;
    },
  }));
  const { attachGatewayWsConnectionHandler } = await import("./ws-connection.js");
  const logWsControl = createGatewayWsTestLogger();
  const socket = createGatewayWsTestSocket({ closeEmits: true });

  attachGatewayWsForTest({
    attach: attachGatewayWsConnectionHandler,
    socket,
    options: { logWsControl: logWsControl as never },
  });
  await vi.dynamicImportSettled();

  return { logWsControl, socket };
}

describe("WebSocket message handler load failures", () => {
  afterEach(() => {
    vi.doUnmock("./ws-connection/message-handler.js");
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("names the restart remedy when the running install changed", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "r13");
    const missingChunk = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "missing-message-handler-chunk.js",
    );
    const { logWsControl, socket } = await connectWithMessageHandlerLoadError(
      moduleNotFoundError(missingChunk),
    );

    expect(socket.close).toHaveBeenCalledWith(
      1011,
      "gateway install changed; run: openclaw gateway restart",
    );
    expect(Buffer.byteLength(String(socket.close.mock.calls[0]?.[1]), "utf8")).toBeLessThanOrEqual(
      123,
    );
    expect(logWsControl.error).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw installation changed while the Gateway was running"),
    );
    expect(logWsControl.error).toHaveBeenCalledWith(
      expect.stringContaining("openclaw --profile r13 gateway restart"),
    );
    expect(logWsControl.warn).toHaveBeenCalledWith(
      expect.stringContaining("closed before connect"),
      expect.objectContaining({
        cause: "message-handler-load-failed",
        staleInstall: true,
        restartCommand: "openclaw --profile r13 gateway restart",
      }),
    );
  });

  it("keeps the generic 1011 behavior for an unclassified load failure", async () => {
    const { logWsControl, socket } = await connectWithMessageHandlerLoadError(
      new Error("loader exploded"),
    );

    expect(socket.close).toHaveBeenCalledWith(1011, "gateway message handler unavailable");
    expect(logWsControl.warn).toHaveBeenCalledWith(
      expect.stringContaining("closed before connect"),
      expect.not.objectContaining({ staleInstall: true }),
    );
  });
});
