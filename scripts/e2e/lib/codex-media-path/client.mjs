import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../../../dist/gateway/protocol/index.js";
import { renderBitmapTextPngBase64 } from "../../../../test/helpers/live-image-probe.ts";
import { createJsonlRequestTailer } from "./jsonl-request-tail.mjs";
import { readPositiveIntEnv } from "./limits.mjs";
import { waitForWebSocketOpen } from "./open-websocket.mjs";

const port = process.env.PORT;
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const appServerLog =
  process.env.OPENCLAW_CODEX_MEDIA_PATH_APP_SERVER_LOG ??
  "/tmp/openclaw-codex-media-path-app-server.jsonl";
const timeoutSeconds = readPositiveIntEnv("OPENCLAW_CODEX_MEDIA_PATH_TIMEOUT_SECONDS", 180);
const logTailMaxBytes = readPositiveIntEnv(
  "OPENCLAW_CODEX_MEDIA_PATH_LOG_TAIL_MAX_BYTES",
  2 * 1024 * 1024,
);

if (!port || !token) {
  throw new Error("missing PORT/OPENCLAW_GATEWAY_TOKEN");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256Base64(data) {
  return createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
}

const loggedRequests = createJsonlRequestTailer(appServerLog, {
  maxReadBytes: logTailMaxBytes,
});

async function waitFor(label, predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value !== undefined) {
      return value;
    }
    await delay(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function wsDataToString(data) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

async function connectGateway() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await waitForWebSocketOpen(ws, 45_000, "gateway ws open timeout");

  const pending = new Map();
  ws.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(wsDataToString(data));
    } catch {
      return;
    }
    if (frame?.type === "event" && typeof frame.event === "string") {
      return;
    }
    if (frame?.type !== "res" || typeof frame.id !== "string") {
      return;
    }
    const match = pending.get(frame.id);
    if (!match) {
      return;
    }
    pending.delete(frame.id);
    if (frame.ok === true) {
      match.resolve(frame.payload ?? frame.result);
      return;
    }
    match.reject(new Error(frame.error?.message ?? "gateway request failed"));
  });
  ws.once("close", (code, reason) => {
    const error = new Error(`gateway closed (${code}): ${wsDataToString(reason)}`);
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  });

  function request(method, params, opts = {}) {
    const id = randomUUID();
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`gateway request timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ type: "req", id, method, params: params ?? {} }));
    });
  }

  await request(
    "connect",
    {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "docker-codex-media-path",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
      auth: { token },
    },
    { timeoutMs: 60_000 },
  );
  await request("sessions.subscribe", {}, { timeoutMs: 60_000 });

  return {
    request,
    async close() {
      if (ws.readyState === WebSocket.CLOSED) {
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
        ws.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.close();
      });
    },
  };
}

const gateway = await connectGateway();

function randomBitmapTextToken(length = 6) {
  const alphabet = "24567ACEF";
  return [...randomBytes(length)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

try {
  const expectedToken = randomBitmapTextToken();
  const imageBase64 = renderBitmapTextPngBase64(expectedToken);
  const expectedHash = sha256Base64(imageBase64);
  const runId = `codex-media-path-${randomUUID()}`;
  const started = Date.now();

  const response = await gateway.request(
    "chat.send",
    {
      sessionKey: "agent:main:codex-media-path-e2e",
      idempotencyKey: runId,
      message: "Read the code printed in the attached image. Reply only the code.",
      attachments: [
        {
          mimeType: "image/png",
          fileName: "codex-media-path-probe.png",
          content: imageBase64,
        },
      ],
      originatingChannel: "codex-media-path-e2e",
      originatingTo: "codex-media-path-e2e",
      originatingAccountId: "codex-media-path-e2e",
    },
    { timeoutMs: timeoutSeconds * 1000 },
  );
  assert(response?.status === "started", `chat.send did not start: ${JSON.stringify(response)}`);

  const turnRequest = await waitFor(
    "Codex turn/start image input",
    () =>
      loggedRequests.read().find((request) => {
        if (request.method !== "turn/start") {
          return undefined;
        }
        const imageInput = request.params?.input?.find?.(
          (entry) => entry?.type === "image" && typeof entry.url === "string",
        );
        return imageInput ? request : undefined;
      }),
    timeoutSeconds * 1000,
  );

  const imageInput = turnRequest.params.input.find((entry) => entry?.type === "image");
  const imageUrl = imageInput.url;
  assert(
    imageUrl.startsWith("data:image/png;base64,"),
    `turn/start image input is not an inline PNG: ${JSON.stringify(imageInput)}`,
  );
  const actualBase64 = imageUrl.slice("data:image/png;base64,".length);
  const actualHash = sha256Base64(actualBase64);
  assert(
    actualHash === expectedHash,
    `forwarded PNG hash mismatch: expected ${expectedHash}, got ${actualHash}`,
  );

  await delay(50);
  console.log(
    JSON.stringify({
      ok: true,
      elapsedMs: Date.now() - started,
      expectedToken,
      imageSha256: actualHash,
    }),
  );
} finally {
  await gateway.close();
}
