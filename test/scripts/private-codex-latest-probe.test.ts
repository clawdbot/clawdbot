import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPrivateCodexProbe } from "../../scripts/private-codex-latest-probe.ts";

const harness = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; params: Record<string, unknown> }>,
  messages: [] as Array<Record<string, unknown>>,
  toolResult: true,
  denyNonowner: true,
  rejectAtGateway: false,
  toolError: false,
  oversizedDenial: false,
  denialChunks: [] as Uint8Array[],
  nonce: "",
  connections: 0,
  native: false,
  wrongRuntime: false,
}));
vi.mock("ws", () => ({
  default: class extends EventEmitter {
    denied: boolean;
    constructor(_url: string, options: { headers: Record<string, string> }) {
      super();
      harness.connections++;
      this.denied = options.headers.authorization === "nonowner" && harness.denyNonowner;
      queueMicrotask(() => {
        if (this.denied && !harness.rejectAtGateway) {
          const response = Object.assign(new EventEmitter(), {
            statusCode: 403,
            headers: {},
            destroy() {},
          });
          this.emit("unexpected-response", {}, response);
          const chunks = harness.denialChunks.length
            ? harness.denialChunks
            : [Buffer.from(harness.oversizedDenial ? "x".repeat(1_048_577) : "Forbidden")];
          for (const chunk of chunks) {
            response.emit("data", Buffer.from(chunk));
          }
          response.emit("end");
        } else {
          this.emit(
            "message",
            Buffer.from(JSON.stringify({ type: "event", event: "connect.challenge" })),
          );
        }
      });
    }
    send(raw: string, callback: () => void) {
      const request = JSON.parse(raw) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      harness.requests.push(request);
      const { method, params } = request;
      let payload: unknown = {};
      if (method === "models.list") {
        payload = { models: [{ id: "codex-latest", name: "Codex (Latest)" }] };
      }
      if (method === "sessions.create") {
        payload = { key: "probe-session" };
        harness.native = String(params.model).startsWith("openai/");
        harness.messages = [];
      }
      if (method === "sessions.send") {
        const message = String(params.message);
        const nonce = /probe-tool-[a-f0-9-]+/u.exec(message)?.[0];
        if (nonce) {
          harness.nonce = nonce;
          harness.messages.push({
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1" }],
          });
          if (harness.toolResult) {
            harness.messages.push({
              role: "toolResult",
              toolCallId: "call-1",
              isError: harness.toolError,
              content: [{ type: "text", text: nonce }],
            });
          }
        }
        harness.messages.push({
          role: "assistant",
          content: [{ type: "text", text: harness.nonce }],
        });
        payload = { runId: "probe-run" };
      }
      if (method === "agent.wait") {
        payload = { status: "ok" };
      }
      if (method === "chat.history") {
        payload = {
          messages: harness.messages,
          sessionInfo: {
            model: "codex-latest",
            modelProvider: harness.native ? "openai" : "clawrouter",
            agentRuntime: {
              id: harness.wrongRuntime ? "unexpected" : harness.native ? "codex" : "openclaw",
            },
          },
        };
      }
      const denied = method === "connect" && this.denied;
      queueMicrotask(() =>
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "res",
              id: request.id,
              ok: !denied,
              payload,
              ...(denied ? { error: { details: { code: "AUTH_UNAUTHORIZED" } } } : {}),
            }),
          ),
        ),
      );
      callback();
    }
    terminate() {}
  },
}));

const input = {
  isolatedCellReady: true,
  verifiedExternalProxyReady: true,
  allowInference: true,
  gatewayUrl: "wss://cell.example",
  facadeBase: "https://broker.example/private",
  ownerHeaders: { authorization: "owner" },
  nonownerHeaders: { authorization: "nonowner" },
  workloadToken: "synthetic-workload",
  openclawAgent: "private-pi",
  codexAgent: "private-codex",
};
const catalog = {
  providers: [
    { models: [{ id: "codex-latest", upstream: "codex-latest", displayName: "Codex (Latest)" }] },
  ],
};
const complete = 'data: {"type":"response.completed","response":{"model":"codex-latest"}}\n\n';
function mockFacade(leak?: { surface: string; value: string }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (typeof url !== "string" || (init?.body !== undefined && typeof init.body !== "string")) {
      throw new Error("unexpected probe request representation");
    }
    const body = init?.body ?? "";
    if (url.endsWith("catalog")) {
      return new Response(JSON.stringify(catalog));
    }
    if (body === "{") {
      return new Response('{"error":{"code":"invalid_request"}}', { status: 400 });
    }
    const request = JSON.parse(body);
    // The private broker requires no storage; its subscription upstream consumes
    // explicit instructions and Responses input items, not the string shorthand.
    if (
      request.store !== false ||
      typeof request.instructions !== "string" ||
      !Array.isArray(request.input)
    ) {
      return new Response('{"error":{"code":"invalid_request"}}', { status: 400 });
    }
    if (body.includes("synthetic-private-probe-selector")) {
      return new Response(
        leak?.surface === "error" ? leak.value : '{"error":{"code":"model_not_allowed"}}',
        { status: 403 },
      );
    }
    return new Response(
      leak?.surface === "sse"
        ? `data: ${JSON.stringify({ type: "response.completed", response: { detail: leak.value } })}\n\n`
        : complete,
      {
        headers: { "openai-model": leak?.surface === "header" ? leak.value : "codex-latest" },
      },
    );
  });
}

beforeEach(() => {
  harness.requests = [];
  harness.messages = [];
  harness.toolResult = true;
  harness.denyNonowner = true;
  harness.rejectAtGateway = false;
  harness.toolError = false;
  harness.oversizedDenial = false;
  harness.denialChunks = [];
  harness.connections = 0;
  harness.wrongRuntime = false;
});
afterEach(() => vi.restoreAllMocks());

describe("private alias acceptance client", () => {
  it("uses only new sessions, proves tool results and reconnect continuation, and keeps native blocked", async () => {
    const fetch = mockFacade();
    const report = await runPrivateCodexProbe(input);
    expect(report).toMatchObject({
      owner_admitted: 1,
      nonowner_denied: 1,
      facade_catalog_pass: 1,
      raw_model_rejected: 1,
      malformed_request_rejected: 1,
      alias_sse_pass: 1,
      openclaw_picker_pass: 1,
      openclaw_tool_pass: 1,
      openclaw_second_turn_pass: 1,
      native_blocked: 1,
      protocol_pass: 0,
      errors: 0,
      leak_hits: 0,
      report_scanned: 1,
      persisted_state_scanned: 0,
      native_restart_resume_tested: 0,
    });
    expect(harness.connections).toBe(4);
    expect(harness.requests.filter((row) => row.method === "sessions.create")).toHaveLength(1);
    expect(harness.requests.find((row) => row.method === "sessions.create")?.params.model).toBe(
      "clawrouter/codex-latest",
    );
    expect(
      harness.requests.filter((row) => row.method === "models.list").map((row) => row.params),
    ).toEqual([{ agentId: "private-pi", preparedOnly: true, view: "configured" }]);
    expect(fetch).toHaveBeenCalledTimes(4);
    const rejected = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    const accepted = JSON.parse(String(fetch.mock.calls[3]?.[1]?.body));
    expect(rejected).toEqual({ ...accepted, model: "synthetic-private-probe-selector" });
    expect(accepted).toMatchObject({
      model: "codex-latest",
      store: false,
      stream: true,
      instructions: expect.any(String),
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply OK" }] }],
    });
    expect(Object.values(report).every((value) => typeof value === "number")).toBe(true);
  });

  it("covers the future two-harness protocol success branch only with synthetic transports", async () => {
    mockFacade();
    const report = await runPrivateCodexProbe({ ...input, nativeSafetyContractApproved: true });
    expect(report).toMatchObject({
      native_blocked: 0,
      openclaw_runtime_pass: 1,
      codex_runtime_pass: 1,
      openclaw_tool_pass: 1,
      codex_tool_pass: 1,
      openclaw_second_turn_pass: 1,
      codex_second_turn_pass: 1,
      protocol_pass: 1,
      errors: 0,
      leak_hits: 0,
      explicit_model_failures: 0,
      persisted_state_scanned: 0,
      native_restart_resume_tested: 0,
    });
    expect(
      harness.requests
        .filter((row) => row.method === "sessions.create")
        .map((row) => row.params.model),
    ).toEqual(["clawrouter/codex-latest", "openai/codex-latest"]);
  });

  it("detects a Unicode sentinel split across any proxy denial byte boundary", async () => {
    const fetch = mockFacade();
    const privateTarget = "SYNTHETIC_π_🦞_SENTINEL";
    const body = Buffer.from(privateTarget);
    for (let split = 1; split < body.length; split++) {
      harness.denialChunks = [body.subarray(0, split), body.subarray(split)];
      const report = await runPrivateCodexProbe({ ...input, privateTarget });
      expect(report.leak_hits).toBeGreaterThan(0);
      expect(report.protocol_pass).toBe(0);
      expect(JSON.stringify(report)).not.toContain(privateTarget);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when a proxy denial body exceeds the scan budget", async () => {
    const fetch = mockFacade();
    harness.oversizedDenial = true;
    const report = await runPrivateCodexProbe(input);
    expect(report).toMatchObject({ nonowner_denied: 0, errors: 1, protocol_pass: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not accept assistant claims as actual tool use", async () => {
    mockFacade();
    harness.toolResult = false;
    const report = await runPrivateCodexProbe(input);
    expect(report.openclaw_tool_pass).toBe(0);
    expect(report.openclaw_second_turn_pass).toBe(0);
    expect(report.protocol_pass).toBe(0);
  });

  it("fails runtime proof when a correct picker row executes under another harness", async () => {
    mockFacade();
    harness.wrongRuntime = true;
    const report = await runPrivateCodexProbe(input);
    expect(report.openclaw_picker_pass).toBe(1);
    expect(report.openclaw_runtime_pass).toBe(0);
    expect(report.openclaw_tool_pass).toBe(0);
    expect(report.protocol_pass).toBe(0);
  });

  it("does not treat a Gateway rejection after WebSocket upgrade as a proxy fence", async () => {
    const fetch = mockFacade();
    harness.rejectAtGateway = true;
    const report = await runPrivateCodexProbe(input);
    expect(report.nonowner_denied).toBe(0);
    expect(report.protocol_pass).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not accept failed tool output even when it contains the nonce", async () => {
    mockFacade();
    harness.toolError = true;
    const report = await runPrivateCodexProbe(input);
    expect(report.openclaw_tool_pass).toBe(0);
    expect(report.openclaw_second_turn_pass).toBe(0);
  });

  it("stops before facade access when nonowner admission succeeds", async () => {
    const fetch = mockFacade();
    harness.denyNonowner = false;
    const report = await runPrivateCodexProbe(input);
    expect(report).toMatchObject({ nonowner_denied: 0, errors: 1, protocol_pass: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.requests.every((row) => row.method === "connect")).toBe(true);
  });

  it.each(["header", "sse", "error"])(
    "detects a supplied sentinel in %s without exposing matched data",
    async (surface) => {
      const privateTarget = "SYNTHETIC_FORBIDDEN_TARGET";
      mockFacade({ surface, value: privateTarget });
      const report = await runPrivateCodexProbe({ ...input, privateTarget });
      expect(report.leak_hits).toBeGreaterThan(0);
      expect(report.protocol_pass).toBe(0);
      expect(JSON.stringify(report)).not.toContain(privateTarget);
      expect(harness.requests.some((row) => row.method === "sessions.create")).toBe(false);
    },
  );

  it.each(["header", "model"])(
    "rejects unexpected explicit %s identity without a supplied target",
    async (surface) => {
      mockFacade();
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response(JSON.stringify(catalog)))
        .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }))
        .mockResolvedValueOnce(new Response("Invalid", { status: 400 }))
        .mockResolvedValueOnce(
          new Response(
            surface === "model"
              ? 'data: {"type":"response.completed","response":{"model":"synthetic-wrong-model"}}\n\n'
              : complete,
            {
              headers: {
                "OpenAI-Model": surface === "header" ? "synthetic-wrong-model" : "codex-latest",
              },
            },
          ),
        );
      const report = await runPrivateCodexProbe(input);
      expect(report.explicit_model_failures).toBeGreaterThan(0);
      expect(report.openclaw_tool_pass).toBe(0);
      expect(report.protocol_pass).toBe(0);
    },
  );

  it("scans escaped JSON sentinel data across stream chunks", async () => {
    const privateTarget = "SYNTHETIC_CHUNK_SENTINEL";
    mockFacade();
    // JSON Unicode escapes encode UTF-16 code units, not grapheme clusters.
    const escaped = privateTarget
      .split("")
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    const body = `data: {"type":"response.completed","response":{"detail":"${escaped}"}}\n\n`;
    const encoder = new TextEncoder();
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(catalog)))
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }))
      .mockResolvedValueOnce(new Response("Invalid", { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              for (let index = 0; index < body.length; index += 7) {
                controller.enqueue(encoder.encode(body.slice(index, index + 7)));
              }
              controller.close();
            },
          }),
        ),
      );
    const report = await runPrivateCodexProbe({ ...input, privateTarget });
    expect(report.leak_hits).toBeGreaterThan(0);
    expect(report.protocol_pass).toBe(0);
    expect(JSON.stringify(report)).not.toContain(privateTarget);
  });

  it("requires independent preflight declarations and secure remote URLs before connecting", async () => {
    const fetch = mockFacade();
    for (const change of [
      { isolatedCellReady: false },
      { verifiedExternalProxyReady: false },
      { gatewayUrl: "ws://cell.example" },
    ]) {
      expect((await runPrivateCodexProbe({ ...input, ...change })).preflight_pass).toBe(0);
    }
    expect(harness.connections).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
