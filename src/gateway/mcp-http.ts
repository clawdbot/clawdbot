// MCP loopback HTTP server.
// Exposes Gateway-scoped tools to local MCP clients over bearer-auth loopback.
import crypto from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveToolLoopDetectionConfig } from "../agents/tool-loop-detection-config.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionEntryAccessTarget } from "../config/sessions/session-accessor.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logDebug, logWarn } from "../logger.js";
import {
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  isAgentHarnessSessionStoreEntryProtected,
} from "../sessions/agent-harness-session-key.js";
import {
  resolveMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrantsForRuntime,
} from "./mcp-grant-store.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import {
  clearActiveMcpLoopbackRuntimeByOwnerToken,
  markMcpLoopbackRequestClassified,
  markMcpLoopbackRequestFinished,
  markMcpLoopbackRequestStarted,
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
  resolveMcpLoopbackYieldContext,
  setActiveMcpLoopbackRuntime,
  updateMcpLoopbackToolCallCapture,
} from "./mcp-http.loopback-runtime.js";
import { jsonRpcError, type JsonRpcRequest } from "./mcp-http.protocol.js";
import {
  isMcpHttpBodyTooLargeError,
  isMcpHttpBodyTimeoutError,
  readMcpHttpBody,
  resolveMcpCliCaptureKey,
  resolveMcpHttpBodyTimeoutMs,
  resolveMcpRequestContext,
  validateMcpLoopbackRequest,
} from "./mcp-http.request.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";

// Loopback MCP server exposes gateway-scoped tools to local MCP clients over a
// bearer-token HTTP endpoint bound to 127.0.0.1. Only one active server/runtime
// is registered per process.

type McpLoopbackServer = {
  port: number;
  close: () => Promise<void>;
};

let activeMcpLoopbackServer: McpLoopbackServer | undefined;
let activeMcpLoopbackServerPromise: Promise<McpLoopbackServer> | null = null;

function createMcpJsonParseError(error: unknown): Error & { code: "mcp_json_parse_error" } {
  return Object.assign(new Error("MCP JSON parse error"), {
    cause: error,
    code: "mcp_json_parse_error" as const,
  });
}

function isMcpJsonParseError(error: unknown): error is Error & { code: "mcp_json_parse_error" } {
  return isRecord(error) && error.code === "mcp_json_parse_error";
}

function parseMcpJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw createMcpJsonParseError(error);
  }
}

function readJsonRpcRequestId(message: unknown) {
  if (!isRecord(message)) {
    return null;
  }
  const id = message.id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : undefined;
}

function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  return isRecord(message) && message.jsonrpc === "2.0" && typeof message.method === "string";
}

function shouldSendJsonRpcResponse(message: unknown): boolean {
  return !isJsonRpcRequest(message) || Object.hasOwn(message, "id");
}

function collectJsonRpcResponses<T>(
  messages: unknown[],
  createResponse: (message: unknown) => T,
): T[] {
  return messages.filter(shouldSendJsonRpcResponse).map(createResponse);
}

function jsonRpcInternalError(parsed: unknown) {
  const isBatch = Array.isArray(parsed);
  const messages = isBatch ? parsed : [parsed];
  const responses = collectJsonRpcResponses(messages, (message) =>
    jsonRpcError(readJsonRpcRequestId(message), -32603, "Internal error"),
  );
  if (responses.length === 0) {
    return null;
  }
  return isBatch ? responses : responses[0];
}

function shouldLogMcpLoopbackTraffic(): boolean {
  return (
    isTruthyEnvValue(process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT) ||
    isTruthyEnvValue(process.env.OPENCLAW_LIVE_CLI_BACKEND_DEBUG)
  );
}

function logMcpLoopbackTraffic(step: string, details: Record<string, unknown>): void {
  if (!shouldLogMcpLoopbackTraffic()) {
    return;
  }
  console.error(`[mcp-loopback] ${step} ${JSON.stringify(details)}`);
}

// Abort tool calls when the request disconnects before completion, but keep
// completed responses alive through normal response close notifications.
function createRequestAbortSignal(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const abortIfRequestIncomplete = () => {
    if (!req.complete) {
      abort();
    }
  };
  const abortIfResponseStillOpen = () => {
    if (!res.writableEnded) {
      abort();
    }
  };
  req.once("close", abortIfRequestIncomplete);
  res.once("close", abortIfResponseStillOpen);
  if (req.destroyed && !req.complete) {
    abort();
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off("close", abortIfRequestIncomplete);
      res.off("close", abortIfResponseStillOpen);
    },
  };
}

/** Starts a new MCP loopback HTTP server and registers its bearer tokens. */
async function startMcpLoopbackServer(port = 0): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const nonOwnerToken = crypto.randomBytes(32).toString("hex");
  const toolCache = new McpLoopbackToolCache();
  // GET notification streams are intentionally long-lived; shutdown must end
  // them itself before waiting for httpServer.close() to drain active responses.
  const activeSseResponses = new Set<ServerResponse>();

  const trackSseResponse = (res: ServerResponse): void => {
    activeSseResponses.add(res);
    const cleanup = () => {
      activeSseResponses.delete(res);
      res.off("close", cleanup);
      res.off("finish", cleanup);
    };
    res.once("close", cleanup);
    res.once("finish", cleanup);
  };

  const closeActiveSseResponses = (): void => {
    for (const res of activeSseResponses) {
      if (!res.destroyed && !res.writableEnded) {
        const socket = res.socket;
        res.end();
        socket?.end();
      }
    }
  };

  const httpServer = createHttpServer((req, res) => {
    const auth = validateMcpLoopbackRequest({
      req,
      res,
      ownerToken,
      nonOwnerToken,
      onSseResponse: trackSseResponse,
    });
    if (!auth) {
      return;
    }

    // Bind the request before body parsing/tool resolution. A CLI may exit while
    // an accepted request is still uploading, and retries must not outrun it.
    const cliCaptureKey = resolveMcpCliCaptureKey(req, auth);
    const cliRequestCaptureHandle = markMcpLoopbackRequestStarted(cliCaptureKey);
    const requestAbort = createRequestAbortSignal(req, res);
    void (async () => {
      let parsed: unknown;
      let cliCaptureHandles: Array<ReturnType<typeof markMcpLoopbackToolCallStarted>> = [];
      try {
        const body = await readMcpHttpBody(req, { timeoutMs: resolveMcpHttpBodyTimeoutMs() });
        parsed = parseMcpJsonBody(body);
        if (Array.isArray(parsed) && parsed.length === 0) {
          markMcpLoopbackRequestClassified(cliRequestCaptureHandle);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(jsonRpcError(null, -32600, "Invalid Request")));
          return;
        }
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        cliCaptureHandles = messages.map((message) => {
          if (
            !cliRequestCaptureHandle ||
            !isJsonRpcRequest(message) ||
            message.method !== "tools/call"
          ) {
            return undefined;
          }
          const admittedToolName =
            isRecord(message.params) && typeof message.params.name === "string"
              ? message.params.name
              : "";
          const toolArgs =
            isRecord(message.params) && isRecord(message.params.arguments)
              ? message.params.arguments
              : {};
          return markMcpLoopbackToolCallStarted({
            requestCaptureHandle: cliRequestCaptureHandle,
            toolName: admittedToolName,
            args: toolArgs,
          });
        });
        markMcpLoopbackRequestClassified(cliRequestCaptureHandle);
        const cfg = getRuntimeConfig();
        const requestContext = resolveMcpRequestContext(req, cfg, auth);
        const { boundGrantToken, boundCaptureKey } = auth;
        const authorizeToolCall =
          boundGrantToken && boundCaptureKey
            ? () =>
                Boolean(
                  resolveMcpLoopbackClientGrant({
                    token: boundGrantToken,
                    runtimeOwnerToken: ownerToken,
                    captureKey: boundCaptureKey,
                  }),
                )
            : undefined;
        const harnessEntry = isAgentHarnessSessionKey(requestContext.sessionKey)
          ? resolveSessionEntryAccessTarget({ cfg, sessionKey: requestContext.sessionKey }).entry
          : undefined;
        if (
          isAgentHarnessSessionKey(requestContext.sessionKey) &&
          (!harnessEntry ||
            isAgentHarnessSessionStoreEntryProtected(requestContext.sessionKey, harnessEntry))
        ) {
          const errors = collectJsonRpcResponses(messages, (message) =>
            jsonRpcError(
              readJsonRpcRequestId(message),
              -32600,
              AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
            ),
          );
          if (errors.length === 0) {
            res.writeHead(202);
            res.end();
            return;
          }
          const payload = Array.isArray(parsed)
            ? JSON.stringify(errors)
            : JSON.stringify(errors[0]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(payload);
          return;
        }
        const yieldContext = resolveMcpLoopbackYieldContext(cliRequestCaptureHandle);
        const scopedTools = toolCache.resolve({
          cfg,
          sessionKey: requestContext.sessionKey,
          runtimePolicySessionKey: requestContext.runtimePolicySessionKey,
          agentId: requestContext.agentId,
          sessionId: requestContext.sessionId,
          runId: requestContext.runId,
          workspaceDir: requestContext.workspaceDir,
          cwd: requestContext.cwd,
          modelProvider: requestContext.modelProvider,
          modelId: requestContext.modelId,
          yieldContextCacheKey: yieldContext?.cacheKey,
          onYield: yieldContext?.onYield,
          messageProvider: requestContext.messageProvider,
          clientCaps: requestContext.clientCaps,
          currentChannelId: requestContext.currentChannelId,
          currentThreadTs: requestContext.currentThreadTs,
          currentMessageId: requestContext.currentMessageId,
          currentInboundAudio: requestContext.currentInboundAudio,
          accountId: requestContext.accountId,
          inboundEventKind: requestContext.inboundEventKind,
          sourceReplyDeliveryMode: requestContext.sourceReplyDeliveryMode,
          taskSuggestionDeliveryMode: requestContext.taskSuggestionDeliveryMode,
          requireExplicitMessageTarget: requestContext.requireExplicitMessageTarget,
          toolsAllow: requestContext.toolsAllow,
          scheduledToolPolicy: requestContext.scheduledToolPolicy,
          senderIsOwner: requestContext.senderIsOwner,
          nodeExecAllowed: requestContext.nodeExecAllowed,
          execSession: requestContext.execSession,
          execOverrides: requestContext.execOverrides,
          bashElevated: requestContext.bashElevated,
          trigger: requestContext.trigger,
          approvalReviewerDeviceId: requestContext.approvalReviewerDeviceId,
          channelContext: requestContext.channelContext,
          senderName: requestContext.senderName,
          senderUsername: requestContext.senderUsername,
          senderE164: requestContext.senderE164,
          groupId: requestContext.groupId,
          groupChannel: requestContext.groupChannel,
          groupSpace: requestContext.groupSpace,
          spawnedBy: requestContext.spawnedBy,
        });

        logMcpLoopbackTraffic("request", {
          batchSize: messages.length,
          methods: messages.map((message) =>
            isJsonRpcRequest(message) ? message.method : undefined,
          ),
          sessionKey: requestContext.sessionKey,
          inboundEventKind: requestContext.inboundEventKind,
          senderIsOwner: requestContext.senderIsOwner,
          toolCount: scopedTools.toolSchema.length,
          cronVisible: scopedTools.toolSchema.some((tool) => tool.name === "cron"),
        });
        const responses: object[] = [];
        for (const [messageIndex, message] of messages.entries()) {
          if (!isJsonRpcRequest(message)) {
            responses.push(jsonRpcError(readJsonRpcRequestId(message), -32600, "Invalid Request"));
            continue;
          }
          const cliCaptureHandle = cliCaptureHandles[messageIndex];
          let response: object | null;
          try {
            response = await handleMcpJsonRpc({
              message,
              tools: scopedTools.tools,
              toolSchema: scopedTools.toolSchema,
              hookContext: {
                agentId: scopedTools.agentId,
                config: cfg,
                sessionKey: requestContext.sessionKey,
                sessionId: requestContext.sessionId,
                runId: requestContext.runId,
                approvalReviewerDeviceId: requestContext.approvalReviewerDeviceId,
                channelId: requestContext.currentChannelId,
                turnSourceChannel: requestContext.messageProvider,
                turnSourceTo: requestContext.currentChannelId,
                turnSourceAccountId: requestContext.accountId,
                turnSourceThreadId: requestContext.currentThreadTs,
                loopDetection: resolveToolLoopDetectionConfig({
                  cfg,
                  agentId: scopedTools.agentId,
                }),
              },
              signal: requestAbort.signal,
              authorizeToolCall,
              onToolCallPrepared: cliCaptureHandle
                ? ({ toolName: preparedToolName, args }) => {
                    updateMcpLoopbackToolCallCapture(cliCaptureHandle, {
                      toolName: preparedToolName,
                      args,
                    });
                  }
                : undefined,
              onToolCallResult: cliCaptureHandle
                ? (result) => {
                    recordMcpLoopbackToolCallResult({
                      captureHandle: cliCaptureHandle,
                      ...result,
                    });
                  }
                : undefined,
            });
          } finally {
            markMcpLoopbackToolCallFinished(cliCaptureHandle);
          }
          if (response !== null && shouldSendJsonRpcResponse(message)) {
            const responseToolName =
              message.method === "tools/call" && isRecord(message.params)
                ? message.params.name
                : undefined;
            const isError =
              isRecord(response) && isRecord(response.result) && response.result.isError === true;
            logMcpLoopbackTraffic("response", {
              method: message.method,
              toolName: typeof responseToolName === "string" ? responseToolName : undefined,
              isError,
            });
            responses.push(response);
          }
        }

        if (responses.length === 0) {
          res.writeHead(202);
          res.end();
          return;
        }

        const payload = Array.isArray(parsed)
          ? JSON.stringify(responses)
          : JSON.stringify(responses[0]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(payload);
      } catch (error) {
        logWarn(`mcp-loopback: request handling failed: ${formatErrorMessage(error)}`);
        logMcpLoopbackTraffic("request-failed", {
          message: formatErrorMessage(error),
        });
        if (!res.headersSent) {
          if (isMcpHttpBodyTooLargeError(error)) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "payload_too_large" }), () => {
              req.destroy();
            });
          } else if (isMcpHttpBodyTimeoutError(error)) {
            res.writeHead(408, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "request_body_timeout" }), () => {
              req.destroy();
            });
          } else if (isMcpJsonParseError(error)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
          } else {
            const internalError = jsonRpcInternalError(parsed);
            if (internalError === null) {
              res.writeHead(202);
              res.end();
            } else {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify(internalError));
            }
          }
        }
      } finally {
        requestAbort.cleanup();
        for (const captureHandle of cliCaptureHandles) {
          markMcpLoopbackToolCallFinished(captureHandle);
        }
        markMcpLoopbackRequestFinished(cliRequestCaptureHandle);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("mcp loopback did not bind to a TCP port");
  }
  // Register tokens only after the TCP listener is live so clients never learn
  // a bearer token for a server that failed to bind.
  setActiveMcpLoopbackRuntime({ port: address.port, ownerToken, nonOwnerToken });
  logDebug(`mcp loopback listening on 127.0.0.1:${address.port}`);

  const server: McpLoopbackServer = {
    port: address.port,
    close: () => {
      // Stop admitting this runtime's child grants before draining accepted
      // requests. A delayed old-server close cannot revoke a successor runtime.
      clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken);
      revokeMcpLoopbackClientGrantsForRuntime(ownerToken);
      return new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (!error) {
            if (activeMcpLoopbackServer === server) {
              activeMcpLoopbackServer = undefined;
            }
          }
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        closeActiveSseResponses();
      });
    },
  };
  return server;
}

/** Returns the active MCP loopback server or starts one if none exists. */
export async function ensureMcpLoopbackServer(port = 0): Promise<McpLoopbackServer> {
  if (activeMcpLoopbackServer) {
    return activeMcpLoopbackServer;
  }
  if (!activeMcpLoopbackServerPromise) {
    activeMcpLoopbackServerPromise = startMcpLoopbackServer(port)
      .then((server) => {
        activeMcpLoopbackServer = server;
        return server;
      })
      .finally(() => {
        activeMcpLoopbackServerPromise = null;
      });
  }
  return activeMcpLoopbackServerPromise;
}

/** Closes the active MCP loopback server if one has been started. */
export async function closeMcpLoopbackServer(): Promise<void> {
  const server =
    activeMcpLoopbackServer ??
    (activeMcpLoopbackServerPromise ? await activeMcpLoopbackServerPromise : undefined);
  if (!server) {
    return;
  }
  activeMcpLoopbackServer = undefined;
  await server.close();
}
