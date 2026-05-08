import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../../../dist/gateway/protocol/index.js";

const url = process.env.GW_URL;
const token = process.env.GW_TOKEN;
if (!url || !token) {
  throw new Error("missing GW_URL/GW_TOKEN");
}

const deadlineMs = Number.parseInt(
  process.env.OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS ??
    process.env.OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS ??
    "80000",
  10,
);
if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
  throw new Error(`invalid gateway network client timeout: ${String(deadlineMs)}`);
}
const deadline = Date.now() + Math.max(1_000, deadlineMs);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openSocket(timeoutMs = 10_000) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("ws open timeout"));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
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
    if (connectRes.ok) {
      ws.close();
      console.log("ok");
      process.exit(0);
    }

    const message = connectRes.error?.message ?? "unknown";
    lastError = new Error(`connect failed: ${message}`);
    if (
      !message.includes("gateway starting") &&
      !message.includes("ws open timeout") &&
      !message.includes("ECONNREFUSED") &&
      !message.includes("ECONNRESET") &&
      !message.includes("timeout")
    ) {
      throw lastError;
    }
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error));
    const message = lastError.message;
    if (
      !message.includes("gateway starting") &&
      !message.includes("ws open timeout") &&
      !message.includes("ECONNREFUSED") &&
      !message.includes("ECONNRESET") &&
      !message.includes("timeout")
    ) {
      throw lastError;
    }
  } finally {
    ws?.close();
  }

  await delay(500);
}

throw lastError ?? new Error("connect failed: timeout");
