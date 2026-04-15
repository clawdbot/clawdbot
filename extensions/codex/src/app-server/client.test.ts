import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  CodexAppServerClient,
  CodexAppServerRpcError,
  MIN_CODEX_APP_SERVER_VERSION,
  readCodexVersionFromUserAgent,
} from "./client.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.js";

function createClientHarness() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(() => {
      process.killed = true;
    }),
  });
  // fromTransportForTests speaks the same newline-delimited JSON-RPC as the
  // spawned app-server, but keeps the process lifecycle fully observable.
  const client = CodexAppServerClient.fromTransportForTests(process);
  return {
    client,
    process,
    writes,
    send(message: unknown) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}

describe("CodexAppServerClient", () => {
  const clients: CodexAppServerClient[] = [];

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.useRealTimers();
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
    const harness = createClientHarness();
    clients.push(harness.client);

    const initializing = harness.client.initialize();
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as {
      id?: number;
      method?: string;
      params?: { clientInfo?: { name?: string; title?: string; version?: string } };
    };
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.118.0 (macOS; test)" },
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
    const harness = createClientHarness();
    clients.push(harness.client);

    const initializing = harness.client.initialize();
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
    harness.send({
      id: outbound.id,
      result: { userAgent: "openclaw/0.117.9 (macOS; test)" },
    });

    await expect(initializing).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected 0.117.9`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  it("blocks app-server initialize responses without a version", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);

    const initializing = harness.client.initialize();
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
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
  it("reads the Codex version from the app-server user agent", () => {
    expect(readCodexVersionFromUserAgent("openclaw/0.118.0 (macOS; test)")).toBe("0.118.0");
    expect(readCodexVersionFromUserAgent("codex_cli_rs/0.118.1-dev (linux; test)")).toBe(
      "0.118.1-dev",
    );
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
});
