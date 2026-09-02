import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { listAgentIds, resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { boundedJsonUtf8Bytes } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  runDetachedWebhookWork,
  sendHttpRequestRejection,
} from "openclaw/plugin-sdk/webhook-request-guards";
import {
  A2aProtocolError,
  A2aRpcRequestSchema,
  A2aSendMessageParamsSchema,
  A2aTaskRequestParamsSchema,
  extractA2aMessageText,
  isA2aContextId,
  resolveA2aRpcMethod,
} from "./protocol.js";
import type { A2aTaskStore } from "./task-store.js";
import type { A2aChannelConfig } from "./types.js";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
// This cap stays enforced when an operator disables the per-peer rate limit.
const MAX_BATCH_REQUESTS = 30;
const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

type A2aRpcIdentifier = string | number | null;

type A2aRpcResponse =
  | { jsonrpc: "2.0"; id: A2aRpcIdentifier; result: unknown }
  | { jsonrpc: "2.0"; id: A2aRpcIdentifier; error: { code: number; message: string } };

type A2aInboundDispatch = {
  taskId: string;
  contextId: string;
  messageId: string;
  peerName: string;
  text: string;
};

type A2aHttpHandlerParams = {
  config: OpenClawConfig;
  a2aConfig: A2aChannelConfig;
  version: string;
  taskStore: A2aTaskStore;
  dispatchInbound: (message: A2aInboundDispatch) => Promise<void>;
};

function writeJsonResponse(response: ServerResponse, statusCode: number, value: unknown): void {
  writeJsonBody(response, statusCode, JSON.stringify(value));
}

function writeJsonBody(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

function createRpcError(id: A2aRpcIdentifier, code: number, message: string): A2aRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeRpcResponse(
  response: ServerResponse,
  value: A2aRpcResponse | A2aRpcResponse[],
): void {
  const measured = boundedJsonUtf8Bytes(value, MAX_RESPONSE_BODY_BYTES);
  if (measured.complete) {
    writeJsonBody(response, 200, JSON.stringify(value));
    return;
  }
  const errorMessage = "A2A response exceeds the 1 MiB limit";
  const bounded = Array.isArray(value)
    ? value.map((entry) => createRpcError(entry.id, -32000, errorMessage))
    : createRpcError(value.id, -32000, errorMessage);
  // Request IDs can consume nearly the entire inbound budget. Drop correlation
  // only when an already-oversized response's replacement still cannot fit.
  const fallback = boundedJsonUtf8Bytes(bounded, MAX_RESPONSE_BODY_BYTES).complete
    ? bounded
    : Array.isArray(bounded)
      ? bounded.map(() => createRpcError(null, -32000, errorMessage))
      : createRpcError(null, -32000, errorMessage);
  writeJsonResponse(response, 200, fallback);
}

function resolvePeerName(request: IncomingMessage, config: A2aChannelConfig): string | undefined {
  const authorization = request.headers.authorization;
  const token = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token) {
    return undefined;
  }
  const presentedDigest = createHash("sha256").update(token).digest();
  for (const [peerName, peer] of Object.entries(config.peers ?? {})) {
    const configuredDigest = createHash("sha256").update(peer.token).digest();
    if (timingSafeEqual(presentedDigest, configuredDigest)) {
      return peerName;
    }
  }
  return undefined;
}

function resolveRequestOrigin(request: IncomingMessage): string {
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  try {
    return new URL(`${encrypted ? "https" : "http"}://${request.headers.host ?? "localhost"}`)
      .origin;
  } catch {
    return `${encrypted ? "https" : "http"}://localhost`;
  }
}

function createAgentCard(params: A2aHttpHandlerParams, request: IncomingMessage) {
  // listAgentIds reads both the canonical `agents.entries` roster and the legacy
  // `agents.list` projection; reading either shape directly publishes a
  // skill-less card to every peer whose operator configured the other one.
  const exposed = params.a2aConfig.exposeAgents;
  const agentIds = listAgentIds(params.config).filter(
    (agentId) => !exposed?.length || exposed.includes(agentId),
  );
  const instanceName =
    (agentIds[0] ? resolveAgentConfig(params.config, agentIds[0])?.name?.trim() : undefined) ||
    "OpenClaw";
  const advertisedOrigin = params.a2aConfig.advertisedUrl ?? resolveRequestOrigin(request);
  return {
    name: instanceName,
    description: "OpenClaw agent gateway using the Agent2Agent protocol.",
    supportedInterfaces: [
      {
        url: `${advertisedOrigin.replace(/\/+$/, "")}/a2a/v1`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    version: params.version,
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    // AgentSkill.description is spec-required. Operator-authored agent
    // descriptions are deliberately not published here: the card is served
    // unauthenticated, so only the agent id crosses the discovery boundary.
    skills: agentIds.map((agentId) => ({
      id: agentId,
      name: agentId,
      description: `OpenClaw agent ${agentId}.`,
      tags: ["openclaw"],
    })),
  };
}

export function createA2aHttpHandler(params: A2aHttpHandlerParams) {
  const peerRequestTimes = new Map<string, number[]>();

  function isRateLimited(peerName: string): boolean {
    const maximum = params.a2aConfig.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
    if (maximum === 0) {
      return false;
    }
    const now = Date.now();
    const requests = (peerRequestTimes.get(peerName) ?? []).filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
    );
    if (requests.length >= maximum) {
      peerRequestTimes.set(peerName, requests);
      return true;
    }
    requests.push(now);
    peerRequestTimes.set(peerName, requests);
    return false;
  }

  async function processRpcRequest(
    input: unknown,
    peerName: string,
  ): Promise<A2aRpcResponse | undefined> {
    const parsed = A2aRpcRequestSchema.safeParse(input);
    const candidateId = isRecord(input) ? input.id : undefined;
    const id =
      typeof candidateId === "string" || typeof candidateId === "number" ? candidateId : null;
    const notification = parsed.success && !Object.hasOwn(parsed.data, "id");

    if (isRateLimited(peerName)) {
      return notification ? undefined : createRpcError(id, -32000, "Peer is rate limited");
    }

    if (!parsed.success) {
      return createRpcError(id, -32600, "Invalid JSON-RPC request");
    }

    const request = parsed.data;

    let result: unknown;
    try {
      const method = resolveA2aRpcMethod(request.method);
      if (method === undefined) {
        throw new A2aProtocolError(-32601, `Method not found: ${request.method}`);
      }
      if (method === "unsupported") {
        throw new A2aProtocolError(
          -32004,
          "Unsupported operation; supported methods are SendMessage and GetTask",
        );
      }

      if (method === "SendMessage") {
        const send = A2aSendMessageParamsSchema.safeParse(request.params);
        if (!send.success) {
          throw new A2aProtocolError(
            -32602,
            "Invalid SendMessage params: message and parts required",
          );
        }
        const message = send.data.message;
        const text = extractA2aMessageText(message.parts);
        if (!text) {
          throw new A2aProtocolError(-32602, "Message must contain at least one usable text part");
        }
        const contextId = message.contextId ?? `ctx-${randomUUID()}`;
        if (!isA2aContextId(contextId)) {
          throw new A2aProtocolError(-32602, "Invalid message contextId");
        }

        const task = params.taskStore.create(contextId, peerName);
        params.taskStore.start(task.id);
        // Reserved synchronously while this request is still admitted: a
        // returnImmediately dispatch outlives the response, and an inherited
        // released root makes the agent turn fail as gateway-draining.
        void runDetachedWebhookWork(async () => {
          await params.dispatchInbound({
            taskId: task.id,
            contextId,
            messageId: message.messageId ?? randomUUID(),
            peerName,
            text,
          });
        }).catch((error: unknown) => params.taskStore.fail(task.id, error));

        if (send.data.configuration?.returnImmediately) {
          result = { task: params.taskStore.get(task.id, peerName) ?? task };
        } else {
          const timeoutMs = params.a2aConfig.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
          const settled = await params.taskStore.wait(task.id, timeoutMs);
          result = { task: settled ?? params.taskStore.get(task.id, peerName) ?? task };
        }
      } else {
        const taskParams = A2aTaskRequestParamsSchema.safeParse(request.params);
        if (!taskParams.success) {
          throw new A2aProtocolError(-32602, "Invalid task params: id is required");
        }
        const task = params.taskStore.get(taskParams.data.id, peerName);
        if (!task) {
          throw new A2aProtocolError(-32001, "Task not found");
        }
        result = task;
      }
    } catch (error) {
      if (notification) {
        return undefined;
      }
      if (error instanceof A2aProtocolError) {
        return createRpcError(id, error.code, error.message);
      }
      return createRpcError(id, -32000, "A2A request could not be processed");
    }

    return notification ? undefined : { jsonrpc: "2.0", id, result };
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (
      request.method === "GET" &&
      (pathname === "/.well-known/agent-card.json" || pathname === "/.well-known/agent.json")
    ) {
      writeJsonResponse(response, 200, createAgentCard(params, request));
      return true;
    }

    if (request.method !== "POST" || pathname !== "/a2a/v1") {
      writeJsonResponse(response, 404, { error: "Not found" });
      return true;
    }

    const peerName = resolvePeerName(request, params.a2aConfig);
    if (!peerName) {
      writeJsonResponse(response, 401, {
        error: "Unauthorized; configure channels.a2a.peers with a matching Bearer token",
      });
      return true;
    }

    let body: string;
    try {
      body = await readRequestBodyWithLimit(request, {
        maxBytes: MAX_REQUEST_BODY_BYTES,
        // Defer destruction so the rejection below reaches the peer before the close.
        destroyOnLimit: false,
      });
    } catch (error) {
      const bodyRejection = isRequestBodyLimitError(error, "PAYLOAD_TOO_LARGE")
        ? { statusCode: 413, body: { error: "Request body exceeds the 1 MiB limit" } }
        : isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")
          ? {
              statusCode: 200,
              body: createRpcError(null, -32000, "Request body could not be read"),
            }
          : undefined;
      if (bodyRejection) {
        response.setHeader("cache-control", "no-store");
        await sendHttpRequestRejection(
          request,
          response,
          bodyRejection.statusCode,
          JSON.stringify(bodyRejection.body),
          "application/json; charset=utf-8",
        );
        return true;
      }
      writeJsonResponse(
        response,
        200,
        createRpcError(null, -32000, "Request body could not be read"),
      );
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      writeJsonResponse(response, 200, createRpcError(null, -32700, "Parse error"));
      return true;
    }

    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        writeJsonResponse(response, 200, createRpcError(null, -32600, "Invalid JSON-RPC request"));
        return true;
      }
      if (payload.length > MAX_BATCH_REQUESTS) {
        const error = isRateLimited(peerName)
          ? createRpcError(null, -32000, "Peer is rate limited")
          : createRpcError(
              null,
              -32000,
              `A2A batch exceeds the ${MAX_BATCH_REQUESTS} request limit`,
            );
        writeRpcResponse(response, error);
        return true;
      }
      const responses = (
        await Promise.all(payload.map((entry) => processRpcRequest(entry, peerName)))
      ).filter((entry): entry is A2aRpcResponse => entry !== undefined);
      if (responses.length > 0) {
        writeRpcResponse(response, responses);
      } else {
        response.statusCode = 200;
        response.end();
      }
      return true;
    }

    const result = await processRpcRequest(payload, peerName);
    if (result) {
      writeRpcResponse(response, result);
    } else {
      response.statusCode = 200;
      response.end();
    }
    return true;
  };
}
