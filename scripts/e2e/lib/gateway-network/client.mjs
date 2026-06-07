// WebSocket client helpers for gateway network E2E scenarios.
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { waitForWebSocketOpen } from "../websocket-open.mjs";
import { readGatewayNetworkClientConnectTimeoutMs } from "./limits.mjs";
import { onceFrame } from "./ws-frames.mjs";

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function openSocket(url, timeoutMs = 10_000) {
  const ws = new WebSocket(url);
  await waitForWebSocketOpen(ws, timeoutMs, "ws open timeout");
  return ws;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasGatewayHealthSummaryPayload(response) {
  if (!isRecord(response) || !isRecord(response.payload)) {
    return false;
  }
  const { payload } = response;
  return (
    payload.ok === true &&
    typeof payload.ts === "number" &&
    typeof payload.durationMs === "number" &&
    typeof payload.defaultAgentId === "string" &&
    payload.defaultAgentId.trim() !== "" &&
    Array.isArray(payload.agents) &&
    isRecord(payload.channels) &&
    Array.isArray(payload.channelOrder) &&
    isRecord(payload.sessions)
  );
}

export function responseError(method, response) {
  const message = response.error?.message ?? "unknown";
  return new Error(`${method} failed: ${message}`);
}

export function isRetryableStartupError(message) {
  return (
    message.includes("gateway starting") ||
    message.includes("closed before frame") ||
    message.includes("closed before open") ||
    message.includes("ws open timeout") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("timeout")
  );
}

async function readProtocolVersion() {
  const protocol = await import("../../../../dist/gateway/protocol/index.js");
  return protocol.PROTOCOL_VERSION;
}

export async function runGatewayNetworkClient(
  { token, url, timeoutMs = readGatewayNetworkClientConnectTimeoutMs() },
  deps = {},
) {
  const deadline = Date.now() + timeoutMs;
  const delayImpl = deps.delay ?? delay;
  const onceFrameImpl = deps.onceFrame ?? onceFrame;
  const openSocketImpl = deps.openSocket ?? ((targetUrl) => openSocket(targetUrl));
  const protocolVersion = deps.protocolVersion ?? (await readProtocolVersion());
  const stdout = deps.stdout ?? console.log;

  let lastError;
  while (Date.now() < deadline) {
    let ws;
    try {
      ws = await openSocketImpl(url);
      ws.send(
        JSON.stringify({
          type: "req",
          id: "c1",
          method: "connect",
          params: {
            minProtocol: protocolVersion,
            maxProtocol: protocolVersion,
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

      const connectRes = await onceFrameImpl(
        ws,
        (frame) => frame?.type === "res" && frame?.id === "c1",
      );
      if (!connectRes.ok) {
        lastError = responseError("connect", connectRes);
        if (!isRetryableStartupError(lastError.message)) {
          throw lastError;
        }
      } else {
        ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
        const healthRes = await onceFrameImpl(
          ws,
          (frame) => frame?.type === "res" && frame?.id === "h1",
        );
        if (healthRes.ok) {
          if (!hasGatewayHealthSummaryPayload(healthRes)) {
            throw new Error("health failed: missing health summary payload");
          }
          stdout("ok");
          return;
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

    await delayImpl(500);
  }

  throw lastError ?? new Error("connect failed: timeout");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.GW_URL;
  const token = process.env.GW_TOKEN;
  if (!url || !token) {
    throw new Error("missing GW_URL/GW_TOKEN");
  }
  await runGatewayNetworkClient({ token, url });
}
