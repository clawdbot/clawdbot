import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../../../dist/gateway/protocol/index.js";
import { waitForWebSocketOpen } from "../websocket-open.mjs";
import { readGatewayNetworkClientConnectTimeoutMs } from "./limits.mjs";

const url = process.env.GW_URL;
const token = process.env.GW_TOKEN;
if (!url || !token) {
  throw new Error("missing GW_URL/GW_TOKEN");
}

const deadline = Date.now() + readGatewayNetworkClientConnectTimeoutMs();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openSocket(timeoutMs = 10_000) {
  const ws = new WebSocket(url);
  await waitForWebSocketOpen(ws, timeoutMs, "ws open timeout");
  return ws;
}

function onceFrame(ws, filter, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("timeout"));
    }, timeoutMs);
    const handler = (data) => {
      const obj = JSON.parse(String(data));
      if (!filter(obj)) {
        return;
      }
      clearTimeout(timer);
      ws.off("message", handler);
      resolve(obj);
    };
    ws.on("message", handler);
  });
}

function responseError(method, response) {
  const message = response.error?.message ?? "unknown";
  return new Error(`${method} failed: ${message}`);
}

function isRetryableStartupError(message) {
  return (
    message.includes("gateway starting") ||
    message.includes("closed before open") ||
    message.includes("ws open timeout") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("timeout")
  );
}

let lastError;
while (Date.now() < deadline) {
  let ws;
  try {
    ws = await openSocket();
    ws.send(
      JSON.stringify({
        type: "req",
        id: "c1",
        method: "connect",
        params: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "test",
            displayName: "docker-net-e2e",
            version: "dev",
            platform: process.platform,
            mode: "test",
          },
          caps: [],
          auth: { token },
        },
      }),
    );

    const connectRes = await onceFrame(ws, (frame) => frame?.type === "res" && frame?.id === "c1");
    if (!connectRes.ok) {
      lastError = responseError("connect", connectRes);
      if (!isRetryableStartupError(lastError.message)) {
        throw lastError;
      }
    } else {
      ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
      const healthRes = await onceFrame(
        ws,
        (frame) => frame?.type === "res" && frame?.id === "h1",
      );
      if (healthRes.ok) {
        ws.close();
        console.log("ok");
        process.exit(0);
      }

      throw responseError("health", healthRes);
    }
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error));
    if (!isRetryableStartupError(lastError.message)) {
      throw lastError;
    }
  } finally {
    ws?.close();
  }

  await delay(500);
}

throw lastError ?? new Error("connect failed: timeout");
