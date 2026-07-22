// Codex tests cover client plugin behavior.
import { embeddedAgentLog, OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  isCodexAppServerApprovalRequest,
  isCodexAppServerIndeterminateTransportError,
} from "./client.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { MAX_CODEX_APP_SERVER_VERSION, MIN_CODEX_APP_SERVER_VERSION } from "./version.js";

const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 660_000;

describe("CodexAppServerClient", () => {
  const clients: CodexAppServerClient[] = [];

  function startInitialize() {
    const harness = createClientHarness();
    clients.push(harness.client);
    const initializing = harness.client.initialize();
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as {
      id?: number;
      method?: string;
      params?: { clientInfo?: { name?: string; title?: string; version?: string } };
    };
    return { harness, initializing, outbound };
  }

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
  });

  it("routes request responses by id", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const request = harness.client.request("model/list", {});
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number; method?: string };
    harness.send({ id: outbound.id, result: { models: [] } });

    await expect(request).resolves.toEqual({ models: [] });
    expect(outbound.method).toBe("model/list");
  });

  it("rejects unbounded guarded thread requests before acquiring the fence", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const guard = vi.fn(async () => () => undefined);
    harness.client.setThreadSessionRequestGuard(guard);

    await expect(harness.client.request("thread/start", {})).rejects.toThrow(
      "thread/start requires a positive finite timeout or abort signal",
    );
    await expect(
      harness.client.request("thread/resume", {}, { timeoutMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("thread/resume requires a positive finite timeout or abort signal");

    expect(guard).not.toHaveBeenCalled();
    expect(harness.writes).toEqual([]);
  });

  it("removes unpaired surrogate code units from outbound JSON-RPC strings", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xdc00);

    const request = harness.client.request("thread/start", {
      prompt: `left${high}right`,
      nested: [`low${low}end`, "emoji 🙈 ok"],
    });

    expect(harness.writes[0]).not.toContain("\\ud83d");
    expect(harness.writes[0]).not.toContain("\\udc00");
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as {
      params?: { prompt?: string; nested?: string[] };
    };
    expect(outbound.params?.prompt).toBe("leftright");
    expect(outbound.params?.nested).toEqual(["lowend", "emoji 🙈 ok"]);
    harness.send({
      id: JSON.parse(harness.writes[0] ?? "{}").id,
      result: { threadId: "thread-1" },
    });
    await expect(request).resolves.toEqual({ threadId: "thread-1" });
  });

  it("logs a redacted preview for malformed app-server messages", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createClientHarness();
    clients.push(harness.client);

    harness.process.stdout.write('{"token":"secret-value"} trailing\n');

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    const [message, rawMetadata] = warn.mock.calls[0] ?? [];
    expect(message).toBe("failed to parse codex app-server message");
    const metadata = rawMetadata as
      | {
          error?: unknown;
          errorMessage?: string;
          fragmentCount?: number;
          linePreview?: string;
          consoleMessage?: string;
        }
      | undefined;
    expect(metadata?.error).toBeInstanceOf(SyntaxError);
    expect(metadata?.errorMessage).toBe(
      "Unexpected non-whitespace character after JSON at position 25 (line 1 column 26)",
    );
    expect(metadata?.fragmentCount).toBe(1);
    expect(metadata?.linePreview).toBe('{"token":"<redacted>"} trailing');
    expect(metadata?.consoleMessage).toBe(
      'failed to parse codex app-server message: preview="{\\"token\\":\\"<redacted>\\"} trailing"',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-value");
  });

  it("recovers app-server messages split by raw newlines inside JSON strings", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createClientHarness();
    clients.push(harness.client);
    const notifications: unknown[] = [];
    harness.client.addNotificationHandler((notification) => {
      notifications.push(notification);
    });

    harness.process.stdout.write(
      '{"method":"item/commandExecution/outputDelta","params":{"delta":"first' +
        "\n" +
        'second"}}\n',
    );

    await vi.waitFor(() =>
      expect(notifications).toEqual([
        {
          method: "item/commandExecution/outputDelta",
          params: { delta: "first\nsecond" },
        },
      ]),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("recovers large app-server messages split by raw newlines inside JSON strings", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createClientHarness();
    clients.push(harness.client);
    const notifications: unknown[] = [];
    harness.client.addNotificationHandler((notification) => {
      notifications.push(notification);
    });
    const largePrefix = "x".repeat(1_100_000);

    harness.process.stdout.write(
      '{"method":"item/commandExecution/outputDelta","params":{"delta":"' +
        largePrefix +
        "\n" +
        'second"}}\n',
    );

    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications).toEqual([
      {
        method: "item/commandExecution/outputDelta",
        params: { delta: largePrefix + "\nsecond" },
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves JSON-RPC error codes", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const request = harness.client.request("future/method", {});
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({ id: outbound.id, error: { code: -32601, message: "Method not found" } });

    await expect(request).rejects.toHaveProperty("name", "CodexAppServerRpcError");
    await expect(request).rejects.toHaveProperty("code", -32601);
    await expect(request).rejects.toHaveProperty("message", "Method not found");
  });

  it("retries transient app-server overload errors", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const harness = createClientHarness();
    clients.push(harness.client);

    const request = harness.client.request("model/list", {});
    const first = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: first.id,
      error: { code: -32_001, message: "Server overloaded; retry later." },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.writes).toHaveLength(2);
    const second = JSON.parse(harness.writes[1] ?? "{}") as { id?: number };
    harness.send({ id: second.id, result: { models: [] } });

    await expect(request).resolves.toEqual({ models: [] });
  });

  it("aborts while waiting to retry an overloaded request", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);
    const controller = new AbortController();

    const request = harness.client.request("model/list", {}, { signal: controller.signal });
    const first = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: first.id,
      error: { code: -32_001, message: "Server overloaded; retry later." },
    });
    controller.abort();

    await expect(request).rejects.toThrow("model/list aborted");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.writes).toHaveLength(1);
  });

  it("surfaces relogin details from Codex app-server RPC errors", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const request = harness.client.request("thread/start", {});
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: outbound.id,
      error: {
        code: -32602,
        message: "failed to load configuration",
        data: {
          reason: "cloudRequirements",
          errorCode: "Auth",
          action: "relogin",
          statusCode: 401,
          detail:
            "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
        },
      },
    });

    await expect(request).rejects.toHaveProperty(
      "message",
      "failed to load configuration: Your authentication session could not be refreshed automatically. Please log out and sign in again.",
    );
    await expect(request).rejects.toHaveProperty("data", {
      reason: "cloudRequirements",
      errorCode: "Auth",
      action: "relogin",
      statusCode: 401,
      detail:
        "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
    });
  });

  it("rejects timed-out requests and ignores late responses", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);

    const request = harness.client.request("model/list", {}, { timeoutMs: 1 });
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    const assertion = expect(request).rejects.toThrow("model/list timed out");

    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    harness.send({ id: outbound.id, result: { data: [] } });
    expect(harness.writes).toHaveLength(1);
  });

  it("rejects aborted requests and ignores late responses", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const controller = new AbortController();

    const request = harness.client.request("model/list", {}, { signal: controller.signal });
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    const assertion = expect(request).rejects.toThrow("model/list aborted");
    controller.abort();

    await assertion;
    harness.send({ id: outbound.id, result: { data: [] } });
    expect(harness.writes).toHaveLength(1);
  });

  it("initializes with the required client version", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.143.0 (macOS; test)" },
    });

    await expect(initializing).resolves.toBeUndefined();
    expect(outbound).toStrictEqual({
      id: outbound.id,
      method: "initialize",
      params: {
        clientInfo: {
          name: "openclaw",
          title: "OpenClaw",
          version: OPENCLAW_VERSION,
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    });
    expect(outbound.params?.clientInfo?.version).not.toBe("");
    expect(JSON.parse(harness.writes[1] ?? "{}")).toEqual({ method: "initialized" });
  });

  it("blocks unsupported app-server versions during initialize", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.124.9 (macOS; test)" },
    });

    await expect(initializing).rejects.toThrow(
      `A stable Codex app-server from ${MIN_CODEX_APP_SERVER_VERSION} through ${MAX_CODEX_APP_SERVER_VERSION} is required, but detected 0.124.9`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("blocks same-version Codex app-server prereleases below the stable floor", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.143.0-alpha.2 (macOS; test)" },
    });

    await expect(initializing).rejects.toThrow(
      `A stable Codex app-server from ${MIN_CODEX_APP_SERVER_VERSION} through ${MAX_CODEX_APP_SERVER_VERSION} is required, but detected 0.143.0-alpha.2`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("blocks same-version Codex app-server build metadata below the stable floor", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.143.0+alpha.2 (macOS; test)" },
    });

    await expect(initializing).rejects.toThrow(
      `A stable Codex app-server from ${MIN_CODEX_APP_SERVER_VERSION} through ${MAX_CODEX_APP_SERVER_VERSION} is required, but detected 0.143.0+alpha.2`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("blocks Codex app-server prereleases outside generated stable schemas", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.144.0-alpha.1 (macOS; test)" },
    });

    await expect(initializing).rejects.toThrow(
      `A stable Codex app-server from ${MIN_CODEX_APP_SERVER_VERSION} through ${MAX_CODEX_APP_SERVER_VERSION} is required`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("blocks Codex app-server custom builds outside generated stable schemas", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.144.0+custom (macOS; test)" },
    });

    await expect(initializing).rejects.toThrow(
      `A stable Codex app-server from ${MIN_CODEX_APP_SERVER_VERSION} through ${MAX_CODEX_APP_SERVER_VERSION} is required`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("blocks stable Codex app-server versions newer than generated schemas", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.145.1 (macOS; test)" },
    });

    await expect(initializing).rejects.toThrow(
      `A stable Codex app-server from ${MIN_CODEX_APP_SERVER_VERSION} through ${MAX_CODEX_APP_SERVER_VERSION} is required`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("blocks app-server initialize responses without a version", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({ id: outbound.id, result: {} });

    await expect(initializing).rejects.toThrow(
      `A stable Codex app-server from ${MIN_CODEX_APP_SERVER_VERSION} through ${MAX_CODEX_APP_SERVER_VERSION} is required`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("handles stdin write errors without crashing the process", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    // Start a pending request so we can verify it gets properly rejected.
    const pending = harness.client.request("test/method");

    // Simulate the child process closing its pipe: stdin emits an asynchronous
    // EPIPE error before the transport observes a process exit.
    const pipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    harness.process.stdin.emit("error", pipeError);

    // The pending request must be rejected with the pipe error rather than
    // an unhandled exception tearing down the gateway.
    const pendingError = await pending.catch((error: unknown) => error);
    expect(pendingError).toBeInstanceOf(Error);
    expect((pendingError as Error).message).toContain("write EPIPE");
    expect(isCodexAppServerIndeterminateTransportError(pendingError)).toBe(true);

    // Subsequent requests keep the original close reason so startup logs stay actionable.
    await expect(harness.client.request("another/method")).rejects.toThrow("write EPIPE");
  });

  it("handles stdout stream errors without crashing the process", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const pending = harness.client.request("test/method");
    const readError = Object.assign(new Error("stdout pipe broke"), { code: "EIO" });

    expect(() => harness.process.stdout.emit("error", readError)).not.toThrow();

    const pendingError = await pending.catch((error: unknown) => error);
    expect(pendingError).toBeInstanceOf(Error);
    expect((pendingError as Error).message).toContain("stdout pipe broke");
    expect(isCodexAppServerIndeterminateTransportError(pendingError)).toBe(true);
    await expect(harness.client.request("another/method")).rejects.toThrow("stdout pipe broke");
  });

  it("keeps RPC requests usable after stderr stream errors", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createClientHarness();
    clients.push(harness.client);

    const pending = harness.client.request("test/method");
    const firstRequest = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    const stderrError = Object.assign(new Error("stderr pipe broke"), { code: "EIO" });

    expect(() => harness.process.stderr.emit("error", stderrError)).not.toThrow();
    expect(warn).toHaveBeenCalledWith("codex app-server stderr stream failed", {
      error: stderrError,
    });

    harness.send({ id: firstRequest.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });

    const next = harness.client.request("another/method");
    const secondRequest = JSON.parse(harness.writes[1] ?? "{}") as { id?: number };
    harness.send({ id: secondRequest.id, result: { ok: "still-connected" } });
    await expect(next).resolves.toEqual({ ok: "still-connected" });
  });

  it("preserves redacted app-server stderr on exit errors", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const pending = harness.client.request("test/method");
    harness.process.stderr.write('fatal token="secret-value" while booting\n');
    harness.process.emit("exit", 1, null);

    await expect(pending).rejects.toThrow(
      'codex app-server exited: code=1 signal=null stderr="fatal token=\\"<redacted>\\" while booting"',
    );
    await expect(harness.client.request("another/method")).rejects.toThrow(
      "codex app-server exited: code=1 signal=null",
    );
  });

  it("preserves split UTF-8 in app-server stderr exit errors", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const pending = harness.client.request("test/method");
    const character = Buffer.from("猫", "utf8");

    harness.process.stderr.write(Buffer.concat([Buffer.from("fatal "), character.subarray(0, 1)]));
    harness.process.stderr.write(Buffer.concat([character.subarray(1), Buffer.from(" boot\n")]));
    harness.process.emit("exit", 1, null);

    await expect(pending).rejects.toThrow(
      'codex app-server exited: code=1 signal=null stderr="fatal 猫 boot"',
    );
  });

  it("keeps bounded stderr tails on UTF-16 boundaries", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const pending = harness.client.request("test/method");

    harness.process.stderr.write(`🎉${"x".repeat(1_999)}`);
    harness.process.emit("exit", 1, null);

    await expect(pending).rejects.toThrow(
      `codex app-server exited: code=1 signal=null stderr=${JSON.stringify(
        `${"x".repeat(500)}...`,
      )}`,
    );
  });

  it("does not write to stdin after the child process exits", () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    // Simulate the child process exiting.
    harness.process.emit("exit", 1, null);

    // A notification after exit must not attempt a write.
    harness.client.notify("late/event", { data: "ignored" });
    expect(harness.writes).toHaveLength(0);
  });

  it("answers server-initiated requests with the registered handler result", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    harness.client.addRequestHandler((request) => {
      if (request.method === "item/tool/call") {
        return { contentItems: [{ type: "inputText", text: "ok" }], success: true };
      }
      return undefined;
    });

    harness.send({ id: "srv-1", method: "item/tool/call", params: { tool: "message" } });
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));

    expect(JSON.parse(harness.writes[0] ?? "{}")).toEqual({
      id: "srv-1",
      result: { contentItems: [{ type: "inputText", text: "ok" }], success: true },
    });
  });

  it("returns JSON-RPC internal errors when server request handlers throw", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createClientHarness();
    clients.push(harness.client);
    harness.client.addRequestHandler((request) => {
      if (request.method === "account/chatgptAuthTokens/refresh") {
        throw new Error("refresh_token_invalidated: reauthentication required");
      }
      return undefined;
    });

    harness.send({
      id: "srv-refresh",
      method: "account/chatgptAuthTokens/refresh",
      params: { accountId: "acct-1" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));

    expect(JSON.parse(harness.writes[0] ?? "{}")).toEqual({
      id: "srv-refresh",
      error: {
        code: -32603,
        message: "refresh_token_invalidated: reauthentication required",
      },
    });
    expect(warn).toHaveBeenCalledWith("codex app-server server request handler failed", {
      id: "srv-refresh",
      method: "account/chatgptAuthTokens/refresh",
      error: expect.any(Error),
    });
  });

  it("fails closed when a dynamic tool server request handler hangs", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createClientHarness();
    clients.push(harness.client);
    let requestSignal: AbortSignal | undefined;
    harness.client.addRequestHandler((request, signal) => {
      if (request.method === "item/tool/call") {
        requestSignal = signal;
        return new Promise<never>(() => {});
      }
      return undefined;
    });

    harness.send({ id: "srv-timeout", method: "item/tool/call", params: { tool: "message" } });
    await vi.advanceTimersByTimeAsync(CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS);
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));

    expect(JSON.parse(harness.writes[0] ?? "{}")).toEqual({
      id: "srv-timeout",
      result: {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: `OpenClaw dynamic tool call timed out after ${CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS}ms before sending a response to Codex.`,
          },
        ],
      },
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledWith("codex app-server server request timed out", {
      id: "srv-timeout",
      method: "item/tool/call",
      timeoutMs: CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS,
    });
  });

  it("fails closed for unhandled native app-server approvals", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    harness.send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", command: "pnpm test" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));

    expect(JSON.parse(harness.writes[0] ?? "{}")).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
  });

  it("only treats known Codex app-server approval methods as approvals", () => {
    expect(isCodexAppServerApprovalRequest("item/commandExecution/requestApproval")).toBe(true);
    expect(isCodexAppServerApprovalRequest("item/fileChange/requestApproval")).toBe(true);
    expect(isCodexAppServerApprovalRequest("item/permissions/requestApproval")).toBe(true);
    expect(isCodexAppServerApprovalRequest("evil/Approval")).toBe(false);
    expect(isCodexAppServerApprovalRequest("item/tool/requestApproval")).toBe(false);
  });

  it("fails closed for unhandled request_user_input prompts", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    harness.send({
      id: "input-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [],
      },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));

    expect(JSON.parse(harness.writes[0] ?? "{}")).toEqual({
      id: "input-1",
      result: { answers: {} },
    });
  });
});
