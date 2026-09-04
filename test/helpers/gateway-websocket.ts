import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { WebSocket } from "ws";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

/** Termination owns errors until the actual close event, including during HTTP upgrade. */
export async function closeGatewayTestWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    // ws aborts CONNECTING with error before close. events.once(close) would
    // reject on that error and release ownership before the close event.
    const onError = () => {};
    const onClose = () => {
      cleanup();
      resolve();
    };
    ws.on("error", onError);
    ws.once("close", onClose);
    try {
      ws.terminate();
    } catch (error) {
      cleanup();
      reject(toErrorObject(error, "Gateway WebSocket termination failed"));
    }
  });
}

/** Callers install nonce observation before handing acquisition ownership here. */
export async function acquireGatewayTestWebSocket(
  ws: WebSocket,
  timeoutMs: number,
): Promise<WebSocket> {
  let cleanup = () => {};
  let failure: Error | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => resolve();
      const onError = (error: Error) => {
        failure ??= error;
        reject(error);
      };
      const onClose = (code: number, reason: Buffer) =>
        onError(new Error(`gateway websocket closed before open (${code}: ${reason.toString()})`));
      const timer = setTimeout(() => onError(new Error("timeout waiting for ws open")), timeoutMs);
      cleanup = () => {
        clearTimeout(timer);
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("close", onClose);
      };
      ws.once("open", onOpen);
      ws.on("error", onError);
      ws.once("close", onClose);
    });
    // ws can emit open and an error from the same received batch before this handoff.
    if (failure) {
      throw failure;
    }
    return ws;
  } catch (error) {
    await runQaGatewayFixture(
      async () => {
        throw error;
      },
      () => closeGatewayTestWebSocket(ws),
    );
    throw error;
  } finally {
    cleanup();
  }
}
