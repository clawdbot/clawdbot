import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventType } from "@ag-ui/core";
import { vi } from "vitest";

// Shared fixtures for the AG-UI HTTP handler tests. Named `*.test-helpers.ts`
// so the dead-code scan treats it as test infrastructure.

export const GATEWAY_SECRET = "test-gateway-secret";
export const APPROVED_DEVICE_ID = "12345678-1234-1234-1234-123456789abc";

export function createReq(
  overrides: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): IncomingMessage & EventEmitter {
  const emitter = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(emitter, {
    method: overrides.method ?? "POST",
    url: "/v1/ag-ui",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      ...overrides.headers,
    },
    destroy: vi.fn(),
  });

  // Simulate body streaming
  const bodyStr = overrides.body !== undefined ? JSON.stringify(overrides.body) : undefined;
  if (bodyStr !== undefined) {
    process.nextTick(() => {
      emitter.emit("data", Buffer.from(bodyStr));
      emitter.emit("end");
    });
  }

  return emitter as IncomingMessage & EventEmitter;
}

export function createRes(): ServerResponse & {
  chunks: string[];
  headers: Record<string, string>;
  ended: boolean;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const res = {
    statusCode: 200,
    chunks: [] as string[],
    headers: {} as Record<string, string>,
    ended: false,
    // Real ServerResponse commits on flushHeaders/write and then rejects
    // setHeader. Model that so tests can catch a status written after commit.
    headersSent: false,
    setHeader(name: string, value: string) {
      if (res.headersSent) {
        throw Object.assign(new Error("Cannot set headers after they are sent to the client"), {
          code: "ERR_HTTP_HEADERS_SENT",
        });
      }
      res.headers[name.toLowerCase()] = value;
    },
    flushHeaders() {
      res.headersSent = true;
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return res;
    },
    once(event: string, cb: (...args: unknown[]) => void) {
      return res.on(event, cb);
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners.get(event) ?? []) {
        cb(...args);
      }
      return true;
    },
    write(chunk: string) {
      res.chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk) {
        res.chunks.push(chunk);
      }
      res.ended = true;
    },
  };
  return res as unknown as ServerResponse & {
    chunks: string[];
    headers: Record<string, string>;
    ended: boolean;
  };
}

export function parseEvents(chunks: string[]): Array<{ type: EventType; [key: string]: unknown }> {
  const events: Array<{ type: EventType; [key: string]: unknown }> = [];
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      const match = line.match(/^data:\s*(.+)$/);
      if (match?.[1]) {
        try {
          events.push(JSON.parse(match[1]));
        } catch {
          /* skip */
        }
      }
    }
  }
  return events;
}

// HMAC token utility (duplicated from http-handler for testing).
export function createDeviceToken(secret: string, deviceId: string): string {
  const encodedId = Buffer.from(deviceId).toString("base64url");
  const signature = createHmac("sha256", secret).update(deviceId).digest("hex").slice(0, 32);
  return `${encodedId}.${signature}`;
}

export function createFakeApi(
  approvedDevices: string[] = [],
  options: { pairingCode?: string } = {},
) {
  const { pairingCode = "TEST1234" } = options;

  const dispatchReplyFromConfig = vi.fn().mockResolvedValue({
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  });

  // The single run path for EVERY turn now goes through
  // runtime.agent.runEmbeddedAgent (see http-handler.ts `runViaEmbeddedAgent`).
  // Tests drive assistant text / reasoning by `.mockImplementation`-ing this and
  // invoking the callbacks it receives (onPartialReply / onReasoningStream /
  // onReasoningEnd), then returning a result of shape
  // `{ meta: { stopReason, pendingToolCalls }, payloads: [{ text }] }`.
  const runEmbeddedAgent = vi.fn().mockResolvedValue({
    meta: { stopReason: "stop", pendingToolCalls: [] },
    payloads: [],
  });

  const upsertPairingRequest = vi.fn().mockResolvedValue({
    code: pairingCode,
  });

  const readAllowFromStore = vi.fn().mockResolvedValue(approvedDevices);

  return {
    config: { gateway: { auth: { token: "test-gateway-secret" } } },
    runtime: {
      config: {
        current: () => ({
          session: { store: "/tmp/test-sessions" },
        }),
      },
      agent: {
        resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/ws"),
        resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent"),
        resolveAgentTimeoutMs: vi.fn().mockReturnValue(30000),
        ensureAgentWorkspace: vi.fn().mockResolvedValue(undefined),
        runEmbeddedAgent,
      },
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({
            sessionKey: "agui:test-session",
            agentId: "main",
            accountId: "default",
          }),
        },
        // Retained for the handful of passing tests that still reference these
        // mocks; the refactored handler no longer calls the reply pipeline or
        // session helpers — every turn runs through runtime.agent.runEmbeddedAgent.
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi.fn().mockImplementation(({ body }: { body: string }) => body),
          finalizeInboundContext: vi.fn().mockImplementation((ctx: Record<string, unknown>) => ctx),
          dispatchReplyFromConfig,
        },
        pairing: {
          upsertPairingRequest,
          readAllowFromStore,
        },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}
