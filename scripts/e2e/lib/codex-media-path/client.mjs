// Client helpers for Codex media-path E2E fixtures.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PROTOCOL_VERSION } from "../../../../dist/gateway/protocol/index.js";
import { renderBitmapTextPngBase64 } from "../../../../test/helpers/live-image-probe.ts";
import { createGatewayWsClient } from "../../../lib/gateway-ws-client.ts";
import { resolveGatewaySuccessPayload } from "../gateway-frame-payload.mjs";
import { createJsonlRequestTailer } from "./jsonl-request-tail.mjs";
import { readPositiveIntEnv } from "./limits.mjs";

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

async function connectGateway() {
  const gatewayClient = createGatewayWsClient({
    handshakeTimeoutMs: 45_000,
    openTimeoutMs: 45_000,
    openTimeoutMessage: "gateway ws open timeout",
    url: `ws://127.0.0.1:${port}`,
  });
  await gatewayClient.waitOpen();

  async function request(method, params, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const response = await gatewayClient.request(method, params ?? {}, timeoutMs);
    if (response.ok) {
      return resolveGatewaySuccessPayload(response);
    }
    throw new Error(
      response.error && typeof response.error === "object" && "message" in response.error
        ? String(response.error.message)
        : "gateway request failed",
    );
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
      gatewayClient.close();
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
