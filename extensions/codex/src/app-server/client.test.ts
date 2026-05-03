import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  CodexAppServerClient,
  CodexAppServerRpcError,
  MIN_CODEX_APP_SERVER_VERSION,
  isCodexAppServerApprovalRequest,
  readCodexVersionFromUserAgent,
} from "./client.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

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
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("logs a redacted preview for malformed app-server messages", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createClientHarness();
    clients.push(harness.client);

    harness.process.stdout.write('{"token":"secret-value"} trailing\n');

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "failed to parse codex app-server message",
        expect.objectContaining({
          consoleMessage: expect.stringContaining("<redacted>"),
          linePreview: '{"token":"<redacted>"} trailing',
        }),
      ),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-value");
  });

  it("redacts prefixed env credential names from app-server previews", () => {
    expect(
      __testing.redactCodexAppServerLinePreview(
        "fatal OPENAI_API_KEY=sk-live ANTHROPIC_API_KEY='anthropic-secret' OTHER=value",
      ),
    ).toBe("fatal OPENAI_API_KEY=<redacted> ANTHROPIC_API_KEY='<redacted>' OTHER=value");
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

  it("preserves JSON-RPC error codes", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const request = harness.client.request("future/method", {});
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({ id: outbound.id, error: { code: -32601, message: "Method not found" } });

    await expect(request).rejects.toMatchObject({
      name: "CodexAppServerRpcError",
      code: -32601,
      message: "Method not found",
    } satisfies Partial<CodexAppServerRpcError>);
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
      result: { userAgent: "openclaw/0.125.0 (macOS; test)" },
    });

    await expect(initializing).resolves.toBeUndefined();
    expect(outbound).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: {
          name: "openclaw",
          title: "OpenClaw",
          version: expect.any(String),
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
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected 0.124.9`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("blocks same-version Codex app-server prereleases below the stable floor", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.125.0-alpha.2 (macOS; test)" },
    });

    await expect(initializing).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected 0.125.0-alpha.2`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("blocks same-version Codex app-server build metadata below the stable floor", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.125.0+alpha.2 (macOS; test)" },
    });

    await expect(initializing).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected 0.125.0+alpha.2`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("accepts newer Codex app-server prereleases", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.126.0-alpha.1 (macOS; test)" },
    });

    await expect(initializing).resolves.toBeUndefined();
    expect(JSON.parse(harness.writes[1] ?? "{}")).toEqual({ method: "initialized" });
  });

  it("accepts newer Codex app-server builds", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.126.0+custom (macOS; test)" },
    });

    await expect(initializing).resolves.toBeUndefined();
    expect(JSON.parse(harness.writes[1] ?? "{}")).toEqual({ method: "initialized" });
  });

  it("blocks app-server initialize responses without a version", async () => {
    const { harness, initializing, outbound } = startInitialize();
    harness.send({ id: outbound.id, result: {} });

    await expect(initializing).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("force-stops app-server transports that ignore the graceful signal", async () => {
    vi.useFakeTimers();
    const process = Object.assign(new EventEmitter(), {
      stdin: {
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
        unref: vi.fn(),
      },
      stdout: Object.assign(new PassThrough(), { unref: vi.fn() }),
      stderr: Object.assign(new PassThrough(), { unref: vi.fn() }),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      unref: vi.fn(),
    });

    __testing.closeCodexAppServerTransport(process, { forceKillDelayMs: 25 });

    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(25);
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    expect(process.unref).toHaveBeenCalledTimes(1);
  });

  it("waits for app-server transport exit during async shutdown", async () => {
    vi.useFakeTimers();
    const process = Object.assign(new EventEmitter(), {
      stdin: {
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
        unref: vi.fn(),
      },
      stdout: Object.assign(new PassThrough(), { unref: vi.fn() }),
      stderr: Object.assign(new PassThrough(), { unref: vi.fn() }),
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(),
      unref: vi.fn(),
    });

    const closed = __testing.closeCodexAppServerTransportAndWait(process, {
      exitTimeoutMs: 100,
      forceKillDelayMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    process.signalCode = "SIGKILL";
    process.emit("exit");

    await expect(closed).resolves.toBe(true);
  });

  it("handles stdin write errors without crashing the process", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    // Start a pending request so we can verify it gets properly rejected.
    const pending = harness.client.request("test/method");

    // Simulate the child process closing its pipe — a write to the now-dead
    // stdin emits an asynchronous EPIPE error on the stream.
    harness.process.stdin.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    // The pending request must be rejected with the pipe error rather than
    // an unhandled exception tearing down the gateway.
    await expect(pending).rejects.toThrow("write EPIPE");

    // Subsequent requests keep the original close reason so startup logs stay actionable.
    await expect(harness.client.request("another/method")).rejects.toThrow("write EPIPE");
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

  it("does not write to stdin after the child process exits", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    // Simulate the child process exiting.
    harness.process.emit("exit", 1, null);

    // A notification after exit must not attempt a write.
    harness.client.notify("late/event", { data: "ignored" });
    expect(harness.writes).toHaveLength(0);
  });

  it("reads the Codex version from the app-server user agent", () => {
    expect(readCodexVersionFromUserAgent("Codex Desktop/0.125.0")).toBe("0.125.0");
    expect(readCodexVersionFromUserAgent("openclaw/0.125.0 (macOS; test)")).toBe("0.125.0");
    expect(readCodexVersionFromUserAgent("codex_cli_rs/0.125.0-dev (linux; test)")).toBe(
      "0.125.0-dev",
    );
    expect(readCodexVersionFromUserAgent("Codex Desktop/not-a-version")).toBeUndefined();
    expect(readCodexVersionFromUserAgent("Codex Desktop/0.124")).toBeUndefined();
    expect(readCodexVersionFromUserAgent("openclaw/0.125.0abc")).toBeUndefined();
    expect(readCodexVersionFromUserAgent("missing-version")).toBeUndefined();
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

  it("fails closed when a dynamic tool server request handler hangs", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createClientHarness();
    clients.push(harness.client);
    harness.client.addRequestHandler((request) => {
      if (request.method === "item/tool/call") {
        return new Promise<never>(() => undefined);
      }
      return undefined;
    });

    harness.send({ id: "srv-timeout", method: "item/tool/call", params: { tool: "message" } });
    await vi.advanceTimersByTimeAsync(__testing.CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS);
    await vi.waitFor(() => expect(harness.writes.length).toBe(1));

    expect(JSON.parse(harness.writes[0] ?? "{}")).toEqual({
      id: "srv-timeout",
      result: {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: `OpenClaw dynamic tool call timed out after ${__testing.CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS}ms before sending a response to Codex.`,
          },
        ],
      },
    });
    expect(warn).toHaveBeenCalledWith(
      "codex app-server server request timed out",
      expect.objectContaining({
        id: "srv-timeout",
        method: "item/tool/call",
        timeoutMs: __testing.CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS,
      }),
    );
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
