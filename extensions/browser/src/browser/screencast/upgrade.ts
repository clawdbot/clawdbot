import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { attachBrowserScreencastViewer } from "./session.js";
import { consumeBrowserScreencastToken } from "./tokens.js";

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

export async function handleBrowserScreencastUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/browser/screencast") {
    return false;
  }
  const params = consumeBrowserScreencastToken(url.searchParams.get("token") ?? "");
  if (!params) {
    try {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    } finally {
      socket.destroy();
    }
    return true;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const pingTimer = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 25_000);
    pingTimer.unref();
    ws.once("close", () => clearInterval(pingTimer));
    ws.on("error", () => ws.terminate());
    ws.on("message", (_data, binary) => {
      if (binary) {
        ws.close(1003, "view_only");
      }
    });
    attachBrowserScreencastViewer(params, ws);
  });
  return true;
}
