// Whatsapp socket shutdown confirms the underlying Baileys transport is closed.
import type { WASocket } from "baileys";

const SOCKET_CLOSE_TIMEOUT_MS = 15_000;

async function withCloseTimeout(task: Promise<unknown>, operationName: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    task,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`WhatsApp ${operationName} timed out`)),
        SOCKET_CLOSE_TIMEOUT_MS,
      );
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function waitForTransportClose(
  ws: Pick<WASocket["ws"], "isClosed" | "once" | "removeListener">,
  operation: unknown,
  operationName: string,
): Promise<void> {
  let onClose: (() => void) | undefined;
  const closed = ws.isClosed
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        onClose = resolve;
        ws.once("close", onClose);
        if (ws.isClosed) {
          onClose();
        }
      });
  try {
    await withCloseTimeout(Promise.all([Promise.resolve(operation), closed]), operationName);
  } finally {
    if (onClose) {
      ws.removeListener("close", onClose);
    }
  }
}

/** Close Baileys and verify the transport state before connection ownership moves. */
export async function closeWhatsAppSocketAndWait(
  sock: Pick<WASocket, "end" | "ws">,
  reason: string,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    const endResult: unknown = sock.end(new Error(reason));
    if (sock.ws.isClosed) {
      await waitForTransportClose(sock.ws, endResult, "socket end");
      return;
    }
    if (sock.ws.isClosing) {
      await waitForTransportClose(sock.ws, endResult, "socket end");
    } else {
      await withCloseTimeout(Promise.resolve(endResult), "socket end");
    }
  } catch (error) {
    errors.push(error);
  }
  if (sock.ws.isClosed) {
    return;
  }
  try {
    const closeResult: unknown = sock.ws.close();
    await waitForTransportClose(sock.ws, closeResult, "WebSocket close");
  } catch (error) {
    errors.push(error);
  }
  if (sock.ws.isClosed) {
    return;
  }
  throw new AggregateError(errors, "WhatsApp socket close could not be confirmed");
}
