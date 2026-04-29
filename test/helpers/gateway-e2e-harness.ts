import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { GatewayClient } from "../../src/gateway/client.js";
import { connectGatewayClient } from "../../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { extractFirstTextBlock } from "../../src/shared/chat-message-content.js";
import { sleep } from "../../src/utils.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../src/utils/message-channel.js";
import { createOpenClawTestInstance, type OpenClawTestInstance } from "./openclaw-test-instance.js";

export { extractFirstTextBlock };

export type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: string;
  message?: unknown;
};

export type GatewayInstance = OpenClawTestInstance;

const GATEWAY_CONNECT_STATUS_TIMEOUT_MS = 2_000;
const GATEWAY_NODE_STATUS_TIMEOUT_MS = 4_000;
const GATEWAY_NODE_STATUS_POLL_MS = 20;

export async function spawnGatewayInstance(name: string): Promise<GatewayInstance> {
  const inst = await createOpenClawTestInstance({ name });
  try {
    await inst.startGateway();
    return inst;
  } catch (err) {
    await inst.cleanup();
    throw err;
  }
}

export async function stopGatewayInstance(inst: GatewayInstance) {
  await inst.cleanup();
}

export async function postJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const payload = JSON.stringify(body);
  const parsed = new URL(url);
  return await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
    const req = httpRequest(
      {
        method: "POST",
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let json: unknown = null;
          if (data.trim()) {
            try {
              json = JSON.parse(data);
            } catch {
              json = data;
            }
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export async function connectNode(
  inst: GatewayInstance,
  label: string,
): Promise<{ client: GatewayClient; nodeId: string }> {
  const identityPath = path.join(inst.homeDir, `${label}-device.json`);
  const deviceIdentity = loadOrCreateDeviceIdentity(identityPath);
  const nodeId = deviceIdentity.deviceId;
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${inst.port}`,
    token: inst.gatewayToken,
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: label,
    clientVersion: "1.0.0",
    platform: "ios",
    mode: GATEWAY_CLIENT_MODES.NODE,
    role: "node",
    scopes: [],
    caps: ["system"],
    commands: ["system.run"],
    deviceIdentity,
    timeoutMessage: `timeout waiting for ${label} to connect`,
  });
  return { client, nodeId };
}

async function connectStatusClient(
  inst: GatewayInstance,
  timeoutMs = GATEWAY_CONNECT_STATUS_TIMEOUT_MS,
): Promise<GatewayClient> {
  let settled = false;
  let timer: NodeJS.Timeout | null = null;

  return await new Promise<GatewayClient>((resolve, reject) => {
    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (err) {
        reject(err);
        return;
      }
      resolve(client);
    };

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${inst.port}`,
      connectChallengeTimeoutMs: 0,
      token: inst.gatewayToken,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientDisplayName: `status-${inst.name}`,
      clientVersion: "1.0.0",
      platform: "test",
      mode: GATEWAY_CLIENT_MODES.CLI,
      onHelloOk: () => {
        finish();
      },
      onConnectError: (err) => finish(err),
      onClose: (code, reason) => {
        finish(new Error(`gateway closed (${code}): ${reason}`));
      },
    });

    timer = setTimeout(() => {
      finish(new Error("timeout waiting for node.list"));
    }, timeoutMs);

    client.start();
  });
}

export async function waitForNodeStatus(
  inst: GatewayInstance,
  nodeId: string,
  timeoutMs = GATEWAY_NODE_STATUS_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  const client = await connectStatusClient(
    inst,
    Math.min(GATEWAY_CONNECT_STATUS_TIMEOUT_MS, timeoutMs),
  );
  try {
    while (Date.now() < deadline) {
      const list = await client.request("node.list", {});
      const match = list.nodes?.find((n) => n.nodeId === nodeId);
      if (match?.connected && match?.paired) {
        return;
      }
      await sleep(GATEWAY_NODE_STATUS_POLL_MS);
    }
  } finally {
    client.stop();
  }
  throw new Error(`timeout waiting for node status for ${nodeId}`);
}

export async function waitForChatFinalEvent(params: {
  events: ChatEventPayload[];
  runId: string;
  sessionKey: string;
  timeoutMs?: number;
}): Promise<ChatEventPayload> {
  const deadline = Date.now() + (params.timeoutMs ?? 45_000);
  while (Date.now() < deadline) {
    const match = params.events.find(
      (evt) =>
        evt.runId === params.runId && evt.sessionKey === params.sessionKey && evt.state === "final",
    );
    if (match) {
      return match;
    }
    await sleep(20);
  }
  const observed = params.events
    .filter((evt) => evt.runId === params.runId || evt.sessionKey === params.sessionKey)
    .map((evt) => `${evt.runId ?? "no-run"}:${evt.sessionKey ?? "no-session"}:${evt.state}`)
    .slice(-10)
    .join(", ");
  throw new Error(
    `timeout waiting for final chat event (runId=${params.runId}, sessionKey=${params.sessionKey}, observed=${observed || "none"})`,
  );
}
