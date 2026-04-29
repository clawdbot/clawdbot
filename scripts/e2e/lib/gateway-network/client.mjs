import { WebSocket } from "ws";

const PROTOCOL_VERSION = 3;

const url = process.env.GW_URL;
const token = process.env.GW_TOKEN;
if (!url || !token) {
  throw new Error("missing GW_URL/GW_TOKEN");
}

const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("ws open timeout")), 30_000);
  ws.once("open", () => {
    clearTimeout(timer);
    resolve();
  });
});

function onceFrame(filter, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
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

const connectRes = await onceFrame((frame) => frame?.type === "res" && frame?.id === "c1");
if (!connectRes.ok) {
  throw new Error(`connect failed: ${connectRes.error?.message ?? "unknown"}`);
}

ws.close();
console.log("ok");
