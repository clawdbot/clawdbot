import { EventEmitter } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { VERSION } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createMockIncomingRequest,
  createMockServerResponse,
  postRawWebhook,
} from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createA2aHttpHandler } from "./http.js";
import { A2aTaskStore } from "./task-store.js";
import type { A2aChannelConfig } from "./types.js";

vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers")>();
  return {
    ...actual,
    setTimeout: ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      globalThis.setTimeout(callback, delay, ...args)) as typeof actual.setTimeout,
    clearTimeout: ((timer: ReturnType<typeof globalThis.setTimeout> | undefined) =>
      globalThis.clearTimeout(timer)) as typeof actual.clearTimeout,
  };
});

const activeStores = new Set<A2aTaskStore>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of activeStores) {
    store.stop();
  }
  activeStores.clear();
});

async function startHttpHarness(options?: {
  config?: OpenClawConfig;
  a2aConfig?: Partial<A2aChannelConfig>;
  onDispatch?: (message: {
    taskId: string;
    contextId: string;
    messageId: string;
    peerName: string;
    text: string;
  }) => Promise<void>;
}) {
  const taskStore = new A2aTaskStore();
  activeStores.add(taskStore);
  const config = options?.config ?? {};
  const a2aConfig: A2aChannelConfig = {
    peers: {
      alpha: { token: "alpha-secret" },
      beta: { token: "beta-secret" },
    },
    ...options?.a2aConfig,
  };
  const dispatchInbound =
    options?.onDispatch ??
    (async (message) => {
      taskStore.completeNext(message.contextId, `echo: ${message.text}`, message.peerName);
    });
  const handler = createA2aHttpHandler({
    config,
    a2aConfig,
    version: VERSION,
    taskStore,
    dispatchInbound,
  });
  const baseUrl = "http://gateway.example.test";

  async function dispatchRequest(dispatch: {
    method: "GET" | "POST";
    endpoint: string;
    body?: string;
    token?: string | null;
  }) {
    const request = createMockIncomingRequest(dispatch.body === undefined ? [] : [dispatch.body]);
    request.method = dispatch.method;
    request.url = dispatch.endpoint;
    request.headers = {
      host: "gateway.example.test",
      ...(dispatch.body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(dispatch.body)),
          }),
      ...(dispatch.token ? { authorization: `Bearer ${dispatch.token}` } : {}),
    };
    Object.defineProperty(request.socket, "remoteAddress", {
      value: "127.0.0.1",
    });

    const response = createMockServerResponse();
    const events = new EventEmitter();
    response.once = events.once.bind(events) as ServerResponse["once"];
    const originalEnd = response.end.bind(response);
    response.end = ((body?: string) => {
      originalEnd(body);
      events.emit("finish");
      return response;
    }) as ServerResponse["end"];
    await handler(request, response);

    return {
      status: response.statusCode,
      async json(): Promise<unknown> {
        return JSON.parse(response.body ?? "");
      },
      async text(): Promise<string> {
        return response.body ?? "";
      },
    };
  }

  return {
    baseUrl,
    taskStore,
    handler,
    async get(endpoint: string) {
      return await dispatchRequest({ method: "GET", endpoint });
    },
    async post(body: unknown, token: string | null = "alpha-secret") {
      return await dispatchRequest({
        method: "POST",
        endpoint: "/a2a/v1",
        body: typeof body === "string" ? body : JSON.stringify(body),
        token,
      });
    },
  };
}

function sendRequest(options?: {
  id?: string | number;
  contextId?: string;
  messageId?: string;
  text?: string;
  returnImmediately?: boolean;
  method?: string;
}) {
  return {
    jsonrpc: "2.0",
    ...(options?.id !== undefined ? { id: options.id } : { id: "send-1" }),
    method: options?.method ?? "SendMessage",
    params: {
      message: {
        ...(options?.messageId ? { messageId: options.messageId } : {}),
        ...(options?.contextId ? { contextId: options.contextId } : {}),
        role: "ROLE_USER",
        parts: [{ text: options?.text ?? "hello" }],
      },
      ...(options?.returnImmediately ? { configuration: { returnImmediately: true } } : {}),
    },
  };
}

describe("A2A HTTP agent discovery", () => {
  it("serves both public discovery paths with the canonical bounded v1.0 card", async () => {
    const hiddenDescription = "hidden-secret-description";
    const harness = await startHttpHarness({
      config: {
        agents: {
          list: [
            { id: "hidden", description: hiddenDescription },
            { id: "writer", name: "Writing assistant", description: "x".repeat(500) },
            { id: "reviewer" },
          ],
        },
      },
      a2aConfig: {
        advertisedUrl: "https://agents.example.test/",
        exposeAgents: ["writer", "reviewer"],
      },
    });

    for (const endpoint of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      const response = await harness.get(endpoint);
      const card = (await response.json()) as {
        capabilities: Record<string, unknown>;
        skills: Array<{ id: string; description: string }>;
      };
      expect(response.status).toBe(200);
      expect(card).toMatchObject({
        name: "Writing assistant",
        description: expect.any(String),
        supportedInterfaces: [
          {
            url: "https://agents.example.test/a2a/v1",
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
          },
        ],
        version: VERSION,
        capabilities: {
          streaming: false,
          pushNotifications: false,
        },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: [
          { id: "writer", name: "writer", tags: ["openclaw"] },
          { id: "reviewer", name: "reviewer", tags: ["openclaw"] },
        ],
      });
      // A2A v1.0 AgentCapabilities has no stateTransitionHistory member; a
      // partial match would let the retired 0.3 field reappear unnoticed.
      expect(Object.keys(card.capabilities).toSorted()).toEqual(["pushNotifications", "streaming"]);
      // The card is served unauthenticated, so operator-authored descriptions
      // must never reach it - not the unexposed agent's, not the exposed one's.
      expect(card.skills[0]?.description).toBe("OpenClaw agent writer.");
      expect(card.skills[1]?.description).toBe("OpenClaw agent reviewer.");
      expect(JSON.stringify(card)).not.toContain(hiddenDescription);
      expect(JSON.stringify(card)).not.toContain("x".repeat(50));
      expect(card).not.toHaveProperty("protocolVersion");
      expect(card).not.toHaveProperty("url");
      expect(card).not.toHaveProperty("preferredTransport");
    }
  });

  it("advertises skills for the canonical agents.entries roster", async () => {
    const harness = await startHttpHarness({
      config: {
        agents: {
          entries: {
            main: { description: "Primary assistant" },
            research: { name: "Research", description: "Deep research" },
          },
        },
      },
    });

    const card = (await (await harness.get("/.well-known/agent-card.json")).json()) as {
      skills: Array<{ id: string; description: string }>;
    };

    // Operators configure agents.entries, not the legacy agents.list projection;
    // reading only the list shape published a skill-less card to every peer.
    expect(card.skills.map((skill) => skill.id).toSorted()).toEqual(["main", "research"]);
    expect(card.skills.find((skill) => skill.id === "research")?.description).toBe(
      "OpenClaw agent research.",
    );
  });

  it("derives the advertised interface origin from the request Host", async () => {
    const harness = await startHttpHarness({
      config: { agents: { list: [{ id: "main" }] } },
    });
    const response = await harness.get("/.well-known/agent-card.json");
    const card = (await response.json()) as { supportedInterfaces: Array<{ url: string }> };

    expect(card.supportedInterfaces[0]?.url).toBe(`${harness.baseUrl}/a2a/v1`);
  });
});

describe("A2A HTTP authentication and request limits", () => {
  it.each([
    ["missing bearer", null],
    ["empty token", ""],
    ["short invalid token", "x"],
    ["long invalid token", "x".repeat(200)],
  ])("rejects %s while accepting configured peer credentials", async (_label, token) => {
    const harness = await startHttpHarness();
    const denied = await harness.post(sendRequest(), token);

    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toMatchObject({
      error: expect.stringContaining("channels.a2a.peers"),
    });

    const accepted = await harness.post(sendRequest());
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      result: { task: { status: { state: "TASK_STATE_COMPLETED" } } },
    });
  });

  it("limits each peer independently and admits requests when the sliding window expires", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const harness = await startHttpHarness({ a2aConfig: { rateLimitPerMinute: 2 } });
    const request = { jsonrpc: "2.0", id: "task", method: "GetTask", params: { id: "missing" } };

    await harness.post(request);
    await harness.post(request);
    const limited = await harness.post(request);
    expect(limited.status).toBe(200);
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: -32000, message: expect.stringContaining("rate limited") },
    });

    const otherPeer = await harness.post(request, "beta-secret");
    await expect(otherPeer.json()).resolves.toMatchObject({ error: { code: -32001 } });

    now += 60_001;
    const admittedAgain = await harness.post(request);
    await expect(admittedAgain.json()).resolves.toMatchObject({ error: { code: -32001 } });
  });

  it("allows unlimited requests when the per-peer rate limit is zero", async () => {
    const harness = await startHttpHarness({ a2aConfig: { rateLimitPerMinute: 0 } });
    const request = { jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "missing" } };

    const responses = await Promise.all(Array.from({ length: 35 }, () => harness.post(request)));
    for (const response of responses) {
      await expect(response.json()).resolves.toMatchObject({ error: { code: -32001 } });
    }
  });

  it("delivers HTTP 413 over the wire and closes for request bodies above 1 MiB", async () => {
    const harness = await startHttpHarness();
    const server = createServer((req, res) => {
      void harness.handler(req, res);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected the A2A test server to have a TCP address");
      }

      // Declared and sent in one write: the shape whose rejection used to race the flush.
      const result = await postRawWebhook({
        url: `http://127.0.0.1:${address.port}/a2a/v1`,
        body: "x".repeat(1024 * 1024 + 1),
        headers: {
          "content-type": "application/json",
          authorization: "Bearer alpha-secret",
        },
      });

      expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(result.headers.connection).toBe("close");
      expect(JSON.parse(result.body)).toEqual({
        error: "Request body exceeds the 1 MiB limit",
      });
      expect(result.closedByServer).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("delivers the JSON-RPC timeout response before closing a partial upload", async () => {
    vi.useFakeTimers();
    const harness = await startHttpHarness();
    const server = createServer((req, res) => {
      void harness.handler(req, res);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected the A2A test server to have a TCP address");
      }
      const requestReceived = new Promise<void>((resolve) => {
        server.once("connection", (socket) => socket.once("data", () => resolve()));
      });
      const resultPromise = postRawWebhook({
        url: `http://127.0.0.1:${address.port}/a2a/v1`,
        body: "{",
        contentLength: 2,
        idleTimeoutMs: 60_000,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer alpha-secret",
        },
      });

      await requestReceived;
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await resultPromise;

      expect(result.statusLine).toBe("HTTP/1.1 200 OK");
      expect(result.headers.connection).toBe("close");
      expect(JSON.parse(result.body)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Request body could not be read" },
      });
      expect(result.closedByServer).toBe(true);
    } finally {
      vi.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("A2A JSON-RPC protocol boundary", () => {
  it.each([
    ["malformed JSON", "{", -32700],
    ["invalid request", "null", -32600],
    ["empty batch", "[]", -32600],
  ])("maps %s to its JSON-RPC error with HTTP 200", async (_label, body, errorCode) => {
    const harness = await startHttpHarness();
    const response = await harness.post(body);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: errorCode },
    });
  });

  it.each([
    ["missing method", { jsonrpc: "2.0", id: "bad" }, -32600],
    ["wrong protocol version", { jsonrpc: "1.0", id: "bad", method: "GetTask" }, -32600],
    ["unknown method", { jsonrpc: "2.0", id: "bad", method: "tasks/send" }, -32601],
    ["unsupported method", { jsonrpc: "2.0", id: "bad", method: "ListTasks" }, -32004],
    [
      "missing message parts",
      { jsonrpc: "2.0", id: "bad", method: "SendMessage", params: { message: { role: "user" } } },
      -32602,
    ],
    [
      "invalid context id",
      {
        jsonrpc: "2.0",
        id: "bad",
        method: "SendMessage",
        params: { message: { role: "user", contextId: "../../secret", parts: [{ text: "hi" }] } },
      },
      -32602,
    ],
    [
      "file-only message",
      {
        jsonrpc: "2.0",
        id: "bad",
        method: "SendMessage",
        params: { message: { role: "user", parts: [{ url: "https://example.test/file" }] } },
      },
      -32602,
    ],
    ["missing task id", { jsonrpc: "2.0", id: "bad", method: "GetTask", params: {} }, -32602],
  ])("rejects %s", async (_label, request, errorCode) => {
    const harness = await startHttpHarness();
    const response = await harness.post(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "bad", error: { code: errorCode } });
  });

  it("executes batch notifications without returning notification response entries", async () => {
    const harness = await startHttpHarness();
    const notification = sendRequest({ text: "notify", returnImmediately: true });
    const { id: _notificationId, ...withoutId } = notification;
    const response = await harness.post([
      withoutId,
      sendRequest({ id: "visible", text: "visible" }),
      42,
    ]);

    expect(response.status).toBe(200);
    const results = (await response.json()) as Array<{ id: string | null }>;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "visible",
      result: { task: { artifacts: [{ parts: [{ text: "echo: visible" }] }] } },
    });
    expect(results[1]).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it("responds to notification-only requests with HTTP 200 and an empty body", async () => {
    const harness = await startHttpHarness();
    const { id: _notificationId, ...notification } = sendRequest({ returnImmediately: true });
    const response = await harness.post(notification);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
  });

  it.each(["SendMessage", "message/send"])(
    "dispatches %s through the inbound channel boundary and returns its task artifact",
    async (method) => {
      const harness = await startHttpHarness();
      const response = await harness.post(
        sendRequest({ method, contextId: "conversation-1", text: "hello world" }),
      );

      await expect(response.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: "send-1",
        result: {
          task: {
            contextId: "conversation-1",
            status: { state: "TASK_STATE_COMPLETED" },
            artifacts: [{ parts: [{ text: "echo: hello world" }] }],
            history: [],
          },
        },
      });
    },
  );

  it("returns immediately with a working task when requested and supports legacy task polling", async () => {
    const harness = await startHttpHarness({ onDispatch: async () => {} });
    const createdResponse = await harness.post(sendRequest({ returnImmediately: true }));
    const created = (await createdResponse.json()) as { result: { task: { id: string } } };

    expect(created).toMatchObject({
      result: { task: { status: { state: "TASK_STATE_WORKING" } } },
    });

    const polled = await harness.post({
      jsonrpc: "2.0",
      id: "poll",
      method: "tasks/get",
      params: { id: created.result.task.id },
    });
    await expect(polled.json()).resolves.toMatchObject({
      id: "poll",
      result: { id: created.result.task.id, status: { state: "TASK_STATE_WORKING" } },
    });
  });

  it("rejects task inspection from a different configured peer", async () => {
    const harness = await startHttpHarness({ onDispatch: async () => {} });
    const createdResponse = await harness.post(sendRequest({ returnImmediately: true }));
    const created = (await createdResponse.json()) as { result: { task: { id: string } } };

    const response = await harness.post(
      { jsonrpc: "2.0", id: "GetTask", method: "GetTask", params: { id: created.result.task.id } },
      "beta-secret",
    );
    await expect(response.json()).resolves.toMatchObject({
      id: "GetTask",
      error: { code: -32001, message: "Task not found" },
    });
  });

  it.each(["CancelTask", "tasks/cancel"])(
    "refuses %s instead of reporting a terminal state it cannot enforce",
    async (method) => {
      const harness = await startHttpHarness({ onDispatch: async () => {} });
      const createdResponse = await harness.post(sendRequest({ returnImmediately: true }));
      const created = (await createdResponse.json()) as { result: { task: { id: string } } };

      const response = await harness.post({
        jsonrpc: "2.0",
        id: "cancel",
        method,
        params: { id: created.result.task.id },
      });

      // A dispatched agent run has no plugin-facing abort seam, so acknowledging
      // cancellation would report a terminal state while the run kept going.
      await expect(response.json()).resolves.toMatchObject({ error: { code: -32004 } });
      const after = await harness.post({
        jsonrpc: "2.0",
        id: "after",
        method: "GetTask",
        params: { id: created.result.task.id },
      });
      await expect(after.json()).resolves.toMatchObject({
        result: { status: { state: "TASK_STATE_WORKING" } },
      });
    },
  );

  it("transitions the task to FAILED when inbound dispatch throws", async () => {
    const harness = await startHttpHarness({
      onDispatch: async () => {
        throw new Error("dispatch unavailable");
      },
    });
    const response = await harness.post(sendRequest());

    await expect(response.json()).resolves.toMatchObject({
      result: {
        task: {
          status: {
            state: "TASK_STATE_FAILED",
            message: { parts: [{ text: "dispatch unavailable" }] },
          },
        },
      },
    });
  });
});
