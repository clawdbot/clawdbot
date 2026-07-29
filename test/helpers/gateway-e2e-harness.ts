// Gateway E2E harness starts test gateway processes and HTTP probes.
import { request as httpRequest } from "node:http";
import path from "node:path";
import { GatewayClient } from "../../src/gateway/client.js";
import { connectGatewayClient } from "../../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { sleep } from "../../src/utils.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../src/utils/message-channel.js";
import { createOpenClawTestInstance, type OpenClawTestInstance } from "./openclaw-test-instance.js";

export type GatewayInstance = OpenClawTestInstance;

const GATEWAY_CONNECT_STATUS_TIMEOUT_MS = 10_000;
const GATEWAY_NODE_STATUS_TIMEOUT_MS = 15_000;
const GATEWAY_NODE_STATUS_POLL_MS = 20;
const POST_JSON_TIMEOUT_MS = 15_000;
const POST_JSON_MAX_RESPONSE_BYTES = 1024 * 1024;

type PostJsonOptions = {
  maxResponseBytes?: number;
  timeoutMs?: number;
};

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
  options: PostJsonOptions = {},
): Promise<{ status: number; json: unknown }> {
  const payload = JSON.stringify(body);
  const parsed = new URL(url);
  const timeoutMs = options.timeoutMs ?? POST_JSON_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? POST_JSON_MAX_RESPONSE_BYTES;
  return await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
    let settled = false;
    let responseBytes = 0;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (result: { status: number; json: unknown } | { error: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if ("error" in result) {
        reject(result.error);
        return;
      }
      resolve(result);
    };

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
          responseBytes += Buffer.byteLength(chunk, "utf8");
          if (responseBytes > maxResponseBytes) {
            const error = new Error(`POST ${url} response exceeded ${maxResponseBytes} bytes`);
            req.destroy(error);
            res.destroy(error);
            finish({ error });
            return;
          }
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
          finish({ status: res.statusCode ?? 0, json });
        });
        res.on("error", (error) => finish({ error }));
      },
    );
    timeout = setTimeout(() => {
      req.destroy(new Error(`POST ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
    req.on("error", (error) => finish({ error }));
    req.write(payload);
    req.end();
  });
}

export async function connectNode(
  inst: GatewayInstance,
  label: string,
): Promise<{ client: GatewayClient; nodeId: string }> {
  const identityPath = path.join(inst.homeDir, `${label}-device.sqlite`);
  const deviceIdentity = loadOrCreateDeviceIdentity({ path: identityPath });
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

export async function connectGatewayStatusClient(
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
      finish(new Error(`timeout waiting for status client hello for ${inst.name}`));
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
  let lastError: unknown;
  while (Date.now() < deadline) {
    let client: GatewayClient | undefined;
    while (Date.now() < deadline) {
      try {
        client = await connectGatewayStatusClient(
          inst,
          Math.min(2_000, GATEWAY_CONNECT_STATUS_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        );
        break;
      } catch (error) {
        lastError = error;
        await sleep(GATEWAY_NODE_STATUS_POLL_MS);
      }
    }
    if (!client) {
      break;
    }
    try {
      while (Date.now() < deadline) {
        const list = (await client.request("node.list", {})) as {
          nodes?: Array<{ nodeId: string; connected?: boolean; paired?: boolean }>;
        };
        const match = list.nodes?.find((n) => n.nodeId === nodeId);
        if (match?.connected && match?.paired) {
          return;
        }
        await sleep(GATEWAY_NODE_STATUS_POLL_MS);
      }
    } catch (error) {
      lastError = error;
      await sleep(GATEWAY_NODE_STATUS_POLL_MS);
    } finally {
      client.stop();
    }
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`timeout waiting for node status for ${nodeId}${suffix}`);
}
