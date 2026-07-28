// WebSocket client helpers for gateway network E2E scenarios.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { sleep as delay } from "../../../lib/sleep.mjs";
import { waitForWebSocketOpen } from "../websocket-open.mjs";
import { readGatewayNetworkClientConnectTimeoutMs } from "./limits.mjs";
import { onceFrame } from "./ws-frames.mjs";

function remainingDeadlineMs(deadline) {
  return Math.max(1, deadline - Date.now());
}

function deadlineSignal(deadline) {
  // Keep headers and response-body reads inside the same phase-wide client deadline.
  return AbortSignal.timeout(remainingDeadlineMs(deadline));
}

async function openSocket(url, timeoutMs = 10_000) {
  const ws = new WebSocket(url);
  await waitForWebSocketOpen(ws, timeoutMs, "ws open timeout");
  return ws;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasGatewayHealthSummaryPayload(response) {
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

function httpUrl(url, pathname = "/") {
  const target = new URL(url);
  target.protocol = target.protocol === "wss:" ? "https:" : "http:";
  target.pathname = pathname;
  target.search = "";
  target.hash = "";
  return target.toString();
}

async function readJson(response, label, signal) {
  let body;
  try {
    body = await response.json();
  } catch {
    signal.throwIfAborted();
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
  return { status: response.status, body };
}

async function adminRpc({ deadline, fetchImpl, token, url }, method, params = {}) {
  const signal = deadlineSignal(deadline);
  const response = await fetchImpl(httpUrl(url, "/api/v1/admin/rpc"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: `e2e-${method}`, method, params }),
    signal,
  });
  return await readJson(response, `Admin RPC ${method}`, signal);
}

async function readProbe({ deadline, fetchImpl, url }, pathname) {
  const signal = deadlineSignal(deadline);
  const response = await fetchImpl(httpUrl(url, pathname), { signal });
  return await readJson(response, pathname, signal);
}

async function requestUpgradeRejection(url, timeoutMs) {
  const target = new URL(httpUrl(url));
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": Buffer.from("gateway-net-e2e!").toString("base64"),
          "Sec-WebSocket-Version": "13",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      reject(new Error(`expected rejected websocket upgrade, received ${response.statusCode}`));
    });
    request.on("error", reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("websocket upgrade rejection timeout"));
    });
    request.end();
  });
}

function emitPhase(phase, startedAt) {
  console.log(
    JSON.stringify({
      event: "gateway-network-phase",
      phase,
      durationMs: Date.now() - startedAt,
      ok: true,
    }),
  );
}

export function assertReadySuspensionResponse(response, now = Date.now()) {
  assert.equal(response?.status, 200, "suspension prepare must return HTTP 200");
  assert.equal(response.body?.ok, true, "suspension prepare must succeed");
  const payload = response.body.payload;
  assert.equal(payload?.status, "ready", "suspension prepare must report ready");
  assert.equal(typeof payload.suspensionId, "string", "suspension prepare must return an id");
  assert(payload.suspensionId.length > 0, "suspension prepare must return an id");
  assert(payload.expiresAtMs > now, "suspension lease must expire in the future");
  assert.equal(payload.activeCount, 0, "suspension prepare must report no active work");
  assert.deepEqual(payload.blockers, [], "suspension prepare must report no blockers");
  return payload;
}

export async function prepareReadySuspension(
  { deadline, requestId, rpc },
  { delayImpl = delay, now = Date.now } = {},
) {
  while (true) {
    if (now() >= deadline) {
      throw new DOMException("gateway suspension preparation timeout", "TimeoutError");
    }
    const response = await rpc("gateway.suspend.prepare", { requestId });
    if (response?.status !== 200 || response.body?.ok !== true) {
      return assertReadySuspensionResponse(response, now());
    }
    const payload = response.body.payload;
    if (payload?.status !== "busy") {
      return assertReadySuspensionResponse(response, now());
    }
    const retryAfterMs =
      typeof payload.retryAfterMs === "number" && Number.isFinite(payload.retryAfterMs)
        ? Math.max(1, Math.floor(payload.retryAfterMs))
        : 100;
    await delayImpl(Math.min(retryAfterMs, Math.max(1, deadline - now())));
  }
}

export function assertGatewaySuspendingError(response) {
  assert.equal(response?.ok, false, "normal RPC must fail during suspension");
  assert.equal(response.error?.code, "UNAVAILABLE", "normal RPC must be unavailable");
  assert.equal(response.error?.retryable, true, "suspension error must be retryable");
  assert.equal(
    response.error?.details?.reason,
    "gateway-suspending",
    "normal RPC must identify gateway suspension",
  );
  assert.equal(
    response.error?.details?.phase,
    "prepared",
    "normal RPC must identify the prepared phase",
  );
}

export function assertSuspendedProbes(health, readiness) {
  assert.equal(health.status, 200, "/healthz must remain live during suspension");
  assert.equal(health.body?.status, "live", "/healthz must report live");
  assert.equal(health.body?.ok, true, "/healthz must report live");
  assert.equal(readiness.status, 503, "/readyz must fail during suspension");
  assert.equal(readiness.body?.ready, false, "/readyz must report not ready");
  assert.equal(
    readiness.body?.failing?.includes("gateway-draining"),
    true,
    "/readyz must identify gateway-draining",
  );
}

function assertHealthyProbes(health, readiness) {
  assert.equal(health.status, 200, "/healthz must be live");
  assert.equal(health.body?.status, "live", "/healthz must be live");
  assert.equal(readiness.status, 200, "/readyz must recover");
  assert.equal(readiness.body?.ready, true, "/readyz must recover");
}

function assertRpcSuccess(response, message) {
  assert(response?.ok === true, message);
  return response.payload;
}

function assertAdminSuccess(response, message) {
  assert.equal(response?.status, 200, `${message}: expected HTTP 200`);
  return assertRpcSuccess(response.body, message);
}

export async function runGatewaySuspensionPreRestartClient(
  { statePath, token, url, timeoutMs = readGatewayNetworkClientConnectTimeoutMs() },
  deps = {},
) {
  const startedAt = Date.now();
  const requestContext = {
    deadline: startedAt + timeoutMs,
    fetchImpl: deps.fetchImpl ?? fetch,
    token,
    url,
  };
  const rpc = (method, params) => adminRpc(requestContext, method, params);
  const firstLease = await prepareReadySuspension({
    deadline: requestContext.deadline,
    requestId: "gateway-network-live-contract",
    rpc,
  });

  assertSuspendedProbes(
    await readProbe(requestContext, "/healthz"),
    await readProbe(requestContext, "/readyz"),
  );

  const blockedAdminHealth = await rpc("health");
  assert.equal(blockedAdminHealth.status, 503, "Admin health must return HTTP 503");
  assertGatewaySuspendingError(blockedAdminHealth.body);

  const upgrade = await requestUpgradeRejection(url, remainingDeadlineMs(requestContext.deadline));
  assert.equal(upgrade.status, 503, "new websocket upgrade must return HTTP 503");
  assert.equal(
    upgrade.body,
    "Gateway websocket admission closed",
    "new websocket upgrade must return the canonical admission body",
  );

  const wrongResume = await rpc("gateway.suspend.resume", {
    suspensionId: `${firstLease.suspensionId}-wrong`,
  });
  assert.equal(wrongResume.status, 400, "wrong suspension id must return HTTP 400");
  assert.equal(
    wrongResume.body?.error?.code,
    "INVALID_REQUEST",
    "wrong suspension id must return INVALID_REQUEST",
  );
  const statusAfterMismatch = assertAdminSuccess(
    await rpc("gateway.suspend.status", { suspensionId: firstLease.suspensionId }),
    "status after wrong resume",
  );
  assert.equal(statusAfterMismatch?.status, "ready", "wrong resume must preserve the lease");

  const resumed = assertAdminSuccess(
    await rpc("gateway.suspend.resume", { suspensionId: firstLease.suspensionId }),
    "resume first lease",
  );
  assert.deepEqual(
    { status: resumed?.status, resumed: resumed?.resumed },
    { status: "running", resumed: true },
    "first resume must release the lease",
  );
  const repeatedResume = assertAdminSuccess(
    await rpc("gateway.suspend.resume", { suspensionId: firstLease.suspensionId }),
    "repeat first resume",
  );
  assert.equal(repeatedResume?.resumed, false, "repeat resume must be idempotent");

  assertHealthyProbes(
    await readProbe(requestContext, "/healthz"),
    await readProbe(requestContext, "/readyz"),
  );

  const requestId = "gateway-network-restart-contract";
  const secondLease = await prepareReadySuspension({
    deadline: requestContext.deadline,
    requestId,
    rpc,
  });
  await writeFile(
    statePath,
    JSON.stringify({
      requestId,
      suspensionId: secondLease.suspensionId,
      expiresAtMs: secondLease.expiresAtMs,
    }),
  );
  emitPhase("pre-restart", startedAt);
}

export async function runGatewaySuspensionPostRestartClient(
  { statePath, token, url, timeoutMs = readGatewayNetworkClientConnectTimeoutMs() },
  deps = {},
) {
  const startedAt = Date.now();
  const requestContext = {
    deadline: startedAt + timeoutMs,
    fetchImpl: deps.fetchImpl ?? fetch,
    token,
    url,
  };
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert(Date.now() < state.expiresAtMs, "restart proof exceeded the original lease");
  const rpc = (method, params) => adminRpc(requestContext, method, params);

  const oldStatus = assertAdminSuccess(
    await rpc("gateway.suspend.status", { suspensionId: state.suspensionId }),
    "old lease status after restart",
  );
  assert(oldStatus?.status === "running", "old lease must not survive process restart");
  const oldResume = assertAdminSuccess(
    await rpc("gateway.suspend.resume", { suspensionId: state.suspensionId }),
    "old lease resume after restart",
  );
  assert(oldResume?.resumed === false, "old lease resume must be idempotently inactive");

  assertHealthyProbes(
    await readProbe(requestContext, "/healthz"),
    await readProbe(requestContext, "/readyz"),
  );
  assertAdminSuccess(await rpc("health"), "Admin health after restart");

  const replacement = await prepareReadySuspension({
    deadline: requestContext.deadline,
    requestId: state.requestId,
    rpc,
  });
  assert(
    replacement.suspensionId !== state.suspensionId,
    "reused request id must create a fresh suspension lease after restart",
  );
  const replacementResume = assertAdminSuccess(
    await rpc("gateway.suspend.resume", { suspensionId: replacement.suspensionId }),
    "replacement lease resume",
  );
  assert(replacementResume?.resumed === true, "replacement lease must resume");
  emitPhase("post-restart", startedAt);
}

function responseError(method, response) {
  const message = response.error?.message ?? "unknown";
  return new Error(`${method} failed: ${message}`);
}

function isRetryableStartupError(message) {
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
  const openSocketImpl = deps.openSocket ?? openSocket;
  const protocolVersion = deps.protocolVersion ?? (await readProtocolVersion());
  const stdout = deps.stdout ?? console.log;

  let lastError;
  while (Date.now() < deadline) {
    let ws;
    try {
      ws = await openSocketImpl(url, remainingDeadlineMs(deadline));
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
        remainingDeadlineMs(deadline),
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
          remainingDeadlineMs(deadline),
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

    const retryDelayMs = Math.min(500, deadline - Date.now());
    if (retryDelayMs > 0) {
      await delayImpl(retryDelayMs);
    }
  }

  throw lastError ?? new Error("connect failed: timeout");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.GW_URL;
  const token = process.env.GW_TOKEN;
  if (!url || !token) {
    throw new Error("missing GW_URL/GW_TOKEN");
  }
  const mode = process.env.GW_MODE ?? "network";
  if (mode === "network") {
    await runGatewayNetworkClient({ token, url });
  } else {
    const statePath = process.env.GW_STATE_PATH;
    if (!statePath) {
      throw new Error("missing GW_STATE_PATH");
    }
    if (mode === "suspension-pre-restart") {
      await runGatewaySuspensionPreRestartClient({ statePath, token, url });
    } else if (mode === "suspension-post-restart") {
      await runGatewaySuspensionPostRestartClient({ statePath, token, url });
    } else {
      throw new Error(`unknown GW_MODE: ${mode}`);
    }
  }
}
