/** Tests embedded LSP runtime JSON-RPC, tool behavior, and cleanup. */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnedStdioCleanupError, type OwnedStdioProcess } from "../process/owned-stdio.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createBundleLspToolRuntime as createProductionBundleLspToolRuntime,
  disposeAllBundleLspRuntimes,
} from "./agent-bundle-lsp-runtime.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

const spawnMock = vi.fn();
const loadEmbeddedAgentLspConfigMock = vi.fn();

function createBundleLspToolRuntime(
  params: Parameters<typeof createProductionBundleLspToolRuntime>[0],
) {
  return createProductionBundleLspToolRuntime({
    ...params,
    dependencies: {
      loadLspConfig: loadEmbeddedAgentLspConfigMock,
      spawnServerProcess: spawnMock,
    },
  });
}

function encodeLspMessage(body: unknown): string {
  const json = JSON.stringify(body);
  return `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
}

function parseWrittenLspBody(text: string): Record<string, unknown> | null {
  const bodyStart = text.indexOf("\r\n\r\n");
  if (bodyStart === -1) {
    return null;
  }
  return JSON.parse(text.slice(bodyStart + 4)) as Record<string, unknown>;
}

class MockChildProcess extends EventEmitter implements OwnedStdioProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  pid = 4321;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly receivedMessages: Record<string, unknown>[] = [];
  readonly supportsRawOutput = true;
  readonly closed = createDeferredCore<{ code: number | null; signal: NodeJS.Signals | null }>();
  readonly extinction = createDeferredCore();
  holdExtinction = false;
  private firstError?: { error: Error; source: "process" | "stdin" | "stdout" | "stderr" };
  private readonly errorListeners = new Set<Parameters<OwnedStdioProcess["onError"]>[0]>();

  constructor(
    private readonly initializeResponsePrefix = "",
    private readonly respondMethods?: ReadonlySet<string>,
    private readonly frameResponse: (
      body: Record<string, unknown>,
      method: string,
    ) => string | readonly string[] = encodeLspMessage,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.respondToRequest(chunk.toString("utf8"));
        callback();
      },
    });
    const observeError = (source: "process" | "stdin" | "stdout" | "stderr") => (error: Error) => {
      this.firstError ??= { error, source };
      for (const listener of this.errorListeners) {
        listener(error, source);
      }
    };
    this.on("error", observeError("process"));
    this.stdin.on("error", observeError("stdin"));
    this.stdout.on("error", observeError("stdout"));
    this.stderr.on("error", observeError("stderr"));
    this.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.closed.resolve({ code, signal });
      if (!this.holdExtinction) {
        this.extinction.resolve();
      }
    });
    void this.extinction.promise.catch(() => {});
  }

  onExit: OwnedStdioProcess["onExit"] = (listener) => {
    this.on("exit", listener);
    if (this.exitCode !== null || this.signalCode !== null) {
      listener(this.exitCode, this.signalCode);
    }
  };
  onError: OwnedStdioProcess["onError"] = (listener) => {
    this.errorListeners.add(listener);
    if (this.firstError) {
      listener(this.firstError.error, this.firstError.source);
    }
  };
  onStdout: OwnedStdioProcess["onStdout"] = (listener, onRaw) => {
    this.stdout.on("data", (chunk: Buffer) => {
      onRaw?.(chunk);
      listener(chunk.toString("utf8"));
    });
  };
  onStderr: OwnedStdioProcess["onStderr"] = (listener) => {
    this.stderr.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
  };
  wait = () => this.closed.promise;
  waitForExtinction = () => this.extinction.promise;
  dispose = vi.fn();

  kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.killed = true;
    this.signalCode = signal;
    this.emit("exit", null, signal);
    this.emit("close", null, signal);
    return true;
  });

  private respondToRequest(text: string): void {
    const body = parseWrittenLspBody(text);
    if (!body) {
      return;
    }
    this.receivedMessages.push(body);
    if (body.method === "exit") {
      queueMicrotask(() => {
        this.exitCode = 0;
        this.emit("exit", 0, null);
        this.emit("close", 0, null);
      });
    }
    if (typeof body.id !== "number" || typeof body.method !== "string") {
      return;
    }
    const method = body.method;
    if (this.respondMethods && !this.respondMethods.has(method)) {
      return;
    }
    const result =
      method === "initialize"
        ? {
            capabilities: {
              hoverProvider: true,
              definitionProvider: true,
              referencesProvider: true,
            },
          }
        : null;
    queueMicrotask(() => {
      const response = { jsonrpc: "2.0", id: body.id, result };
      const frame = this.frameResponse(response, method);
      const chunks = typeof frame === "string" ? [frame] : frame;
      for (const [index, chunk] of chunks.entries()) {
        this.stdout.write(`${index === 0 ? this.initializeResponsePrefix : ""}${chunk}`);
      }
    });
  }
}

function configureSingleLspServer(): void {
  loadEmbeddedAgentLspConfigMock.mockReturnValue({
    lspServers: {
      typescript: {
        command: "typescript-language-server",
        args: ["--stdio"],
      },
    },
    diagnostics: [],
  });
}

describe("bundle LSP runtime", () => {
  afterEach(async () => {
    await disposeAllBundleLspRuntimes();
    spawnMock.mockReset();
    loadEmbeddedAgentLspConfigMock.mockReset();
  });

  it("reuses the prepared plugin manifest registry for bundle discovery", async () => {
    loadEmbeddedAgentLspConfigMock.mockReturnValue({ lspServers: {}, diagnostics: [] });
    const manifestRegistry = { plugins: [] };

    await createBundleLspToolRuntime({
      workspaceDir: "/tmp/workspace",
      manifestRegistry,
    });

    expect(loadEmbeddedAgentLspConfigMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      cfg: undefined,
      manifestRegistry,
    });
  });

  it("starts configured LSP servers and exposes their tools", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith({
      command: "typescript-language-server",
      args: ["--stdio"],
      cwd: undefined,
      env: undefined,
    });
    expect(runtime.tools.map((tool) => tool.name)).toContain("lsp_hover_typescript");

    await runtime.dispose();

    expect(child.dispose).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("fails LSP startup immediately when the child process cannot spawn", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    expect(runtime.sessions).toEqual([]);
    expect(runtime.tools).toEqual([]);
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "stdout fails",
      fail: (child: MockChildProcess) => child.stdout.emit("error", new Error("stdout failed")),
      message: "stdout failed",
    },
    {
      name: "stdin fails",
      fail: (child: MockChildProcess) => child.stdin.emit("error", new Error("stdin failed")),
      message: "stdin failed",
    },
  ])("rejects pending and future LSP requests when $name", async ({ fail, message }) => {
    configureSingleLspServer();
    const child = new MockChildProcess("", new Set(["initialize"]));
    spawnMock.mockReturnValue(child);

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const hoverTool = runtime.tools.find((tool) => tool.name === "lsp_hover_typescript");
    if (!hoverTool) {
      throw new Error("expected hover tool");
    }

    const hoverParams = {
      uri: "file:///tmp/workspace/index.ts",
      line: 0,
      character: 0,
    };
    const request = hoverTool.execute("call-1", hoverParams);
    fail(child);

    await expect(request).rejects.toThrow(message);
    await expect(hoverTool.execute("call-2", hoverParams)).rejects.toThrow(message);

    await runtime.dispose();
  });

  it("blocks new LSP requests on exit while allowing a final stdout response to drain", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess("", new Set(["initialize"]));
    spawnMock.mockReturnValue(child);

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const hoverTool = runtime.tools.find((tool) => tool.name === "lsp_hover_typescript");
    if (!hoverTool) {
      throw new Error("expected hover tool");
    }
    const hoverParams = {
      uri: "file:///tmp/workspace/index.ts",
      line: 0,
      character: 0,
    };
    const pendingRequest = hoverTool.execute("call-1", hoverParams);

    child.exitCode = 1;
    child.emit("exit", 1, null);
    await expect(hoverTool.execute("call-2", hoverParams)).rejects.toThrow(
      'LSP server "typescript" exited (1)',
    );
    child.stdout.write(
      encodeLspMessage({ jsonrpc: "2.0", id: 2, result: { contents: "final hover" } }),
    );

    await expect(pendingRequest).resolves.toMatchObject({
      details: { lspServer: "typescript", lspMethod: "hover" },
    });
    child.emit("close", 1, null);
    await runtime.dispose();
  });

  it("rejects undrained LSP requests when the exited process closes", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess("", new Set(["initialize"]));
    spawnMock.mockReturnValue(child);

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const hoverTool = runtime.tools.find((tool) => tool.name === "lsp_hover_typescript");
    if (!hoverTool) {
      throw new Error("expected hover tool");
    }
    const request = hoverTool.execute("call-1", {
      uri: "file:///tmp/workspace/index.ts",
      line: 0,
      character: 0,
    });

    child.exitCode = 1;
    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    await expect(request).rejects.toThrow('LSP server "typescript" exited (1)');
    await runtime.dispose();
  });

  it.each([
    ["lsp_hover_typescript", "textDocument/hover"],
    ["lsp_definition_typescript", "textDocument/definition"],
    ["lsp_references_typescript", "textDocument/references"],
  ])("cancels pending %s requests when the tool signal aborts", async (toolName, method) => {
    configureSingleLspServer();
    const child = new MockChildProcess("", new Set(["initialize", "shutdown"]));
    spawnMock.mockReturnValue(child);

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const tool = runtime.tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`expected ${toolName} tool`);
    }
    const controller = new AbortController();
    const request = tool.execute(
      "call-1",
      {
        uri: "file:///tmp/workspace/index.ts",
        line: 0,
        character: 0,
      },
      controller.signal,
    );
    const settled = request.then(
      () => "resolved",
      () => "rejected",
    );
    const lspRequest = child.receivedMessages.find((message) => message.method === method);

    controller.abort(new Error("agent stopped"));

    await expect(
      Promise.race([
        settled,
        new Promise((resolve) => {
          setTimeout(() => resolve("still pending"), 100);
        }),
      ]),
    ).resolves.toBe("rejected");
    expect(child.receivedMessages).toContainEqual({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: lspRequest?.id },
    });

    await runtime.dispose();
  });

  it("keeps LSP framing aligned after multibyte messages in the same chunk", async () => {
    configureSingleLspServer();
    const prefix = encodeLspMessage({
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: { message: "ready té" },
    });
    const child = new MockChildProcess(prefix);
    spawnMock.mockReturnValue(child);

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    expect(runtime.tools.map((tool) => tool.name)).toContain("lsp_hover_typescript");
    await runtime.dispose();
  });

  it("accepts a Content-Type header alongside Content-Length", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess("", undefined, (body) => {
      const json = JSON.stringify(body);
      return `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
    });
    spawnMock.mockReturnValue(child);

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    expect(runtime.tools.map((tool) => tool.name)).toContain("lsp_hover_typescript");
    await runtime.dispose();
  });

  it("accepts a maximum-size header when its separator is split across chunks", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess("", undefined, (body) => {
      const json = JSON.stringify(body);
      const headerPrefix = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\nX-Padding: `;
      const header = `${headerPrefix}${"x".repeat(8 * 1024 - headerPrefix.length)}`;
      const frame = `${header}\r\n\r\n${json}`;
      return [frame.slice(0, header.length + 1), frame.slice(header.length + 1)];
    });
    spawnMock.mockReturnValue(child);

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    expect(runtime.tools.map((tool) => tool.name)).toContain("lsp_hover_typescript");
    await runtime.dispose();
  });

  it("rejects invalid UTF-8 in LSP JSON bodies", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess("", new Set(["initialize"]));
    spawnMock.mockReturnValue(child);

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const hoverTool = runtime.tools.find((tool) => tool.name === "lsp_hover_typescript");
    if (!hoverTool) {
      throw new Error("expected hover tool");
    }
    const request = hoverTool.execute("call-1", {
      uri: "file:///tmp/workspace/index.ts",
      line: 0,
      character: 0,
    });
    const hoverRequest = child.receivedMessages.find(
      (message) => message.method === "textDocument/hover",
    );
    if (typeof hoverRequest?.id !== "number") {
      throw new Error("expected numeric hover request id");
    }
    const body = Buffer.concat([
      Buffer.from(`{"jsonrpc":"2.0","id":${hoverRequest.id},"result":{"contents":"`),
      Buffer.from([0xff]),
      Buffer.from('"}}'),
    ]);
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    child.stdout.write(Buffer.concat([header, body]));

    await expect(request).rejects.toThrow(/LSP framing error: body is not valid UTF-8/i);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    await runtime.dispose();
  });

  it.each([
    {
      name: "a suffixed Content-Length value",
      frame: (body: Record<string, unknown>) => {
        const json = JSON.stringify(body);
        return `Content-Length: ${Buffer.byteLength(json, "utf-8")}junk\r\n\r\n${json}`;
      },
    },
    {
      name: "duplicate Content-Length fields",
      frame: (body: Record<string, unknown>) => {
        const json = JSON.stringify(body);
        const length = Buffer.byteLength(json, "utf-8");
        return `Content-Length: ${length}\r\nContent-Length: ${length}\r\n\r\n${json}`;
      },
    },
    {
      name: "a colonless header line",
      frame: (body: Record<string, unknown>) => {
        const json = JSON.stringify(body);
        const length = Buffer.byteLength(json, "utf-8");
        return `Content-Length: ${length}\r\nbroken\r\n\r\n${json}`;
      },
    },
    {
      name: "an oversized declared body",
      frame: () => `Content-Length: ${64 * 1024 * 1024 + 1}\r\n\r\n`,
    },
    {
      name: "an oversized unterminated header",
      frame: () => `X-Header: ${"x".repeat(8 * 1024)}`,
    },
  ])("fails the LSP session immediately for $name", async ({ frame }) => {
    configureSingleLspServer();
    const child = new MockChildProcess(
      "",
      new Set(["initialize", "textDocument/hover"]),
      (body, method) => (method === "initialize" ? encodeLspMessage(body) : frame(body)),
    );
    spawnMock.mockReturnValue(child);

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const hoverTool = runtime.tools.find((tool) => tool.name === "lsp_hover_typescript");
    if (!hoverTool) {
      throw new Error("expected hover tool");
    }

    const request = hoverTool.execute("call-1", {
      uri: "file:///tmp/workspace/index.ts",
      line: 0,
      character: 0,
    });
    const outcome = await Promise.race([
      request.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("still pending"), 100);
      }),
    ]);

    expect(outcome).toMatch(/LSP framing error/i);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    await runtime.dispose();
  });

  it("disposes active LSP sessions from the global shutdown sweep", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    await disposeAllBundleLspRuntimes();

    expect(child.dispose).toHaveBeenCalledOnce();

    await runtime.dispose();
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it("joins repeated disposal until the exited LSP server's descendants settle", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess();
    child.holdExtinction = true;
    spawnMock.mockReturnValue(child);
    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const cleanupScope = createAgentCleanupScope();
    let settled = false;
    const cleanup = cleanupScope
      .run(async () => {
        await Promise.all([runtime.dispose(), runtime.dispose()]);
      })
      .then(() => {
        settled = true;
      });
    try {
      await vi.waitFor(() => expect(child.exitCode).toBe(0));
      expect(settled).toBe(false);
      expect(child.dispose).not.toHaveBeenCalled();
    } finally {
      child.extinction.resolve();
      await cleanup;
    }
    expect(cleanupScope.outcome).toBe("closed");
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.receivedMessages.filter((message) => message.method === "shutdown")).toHaveLength(
      1,
    );
  });

  it.each(["rejected", "unsupported"] as const)(
    "records uncertain cleanup when LSP descendant settlement is %s",
    async (extinction) => {
      configureSingleLspServer();
      const child = new MockChildProcess();
      if (extinction === "rejected") {
        child.extinction.reject(new Error("descendant settlement failed"));
      } else {
        Object.defineProperty(child, "waitForExtinction", { value: undefined });
      }
      spawnMock.mockReturnValue(child);
      const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
      expect(runtime.tools.map((tool) => tool.name)).toContain("lsp_hover_typescript");
      const cleanupScope = createAgentCleanupScope();

      // Global/manual cleanup can precede an automatic owner joining the same resources.
      await runtime.dispose();
      await cleanupScope.run(() => runtime.dispose());

      expect(cleanupScope.outcome).toBe("uncertain");
      expect(child.dispose).toHaveBeenCalledOnce();
    },
  );

  it("records uncertain cleanup when process construction cannot confirm reclamation", async () => {
    configureSingleLspServer();
    spawnMock.mockRejectedValue(new OwnedStdioCleanupError("startup cleanup was not confirmed"));
    const cleanupScope = createAgentCleanupScope();

    const runtime = await cleanupScope.run(() =>
      createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" }),
    );

    expect(runtime.tools).toEqual([]);
    expect(cleanupScope.outcome).toBe("uncertain");
  });

  it.each([
    ["lsp_hover_typescript", "textDocument/hover"],
    ["lsp_definition_typescript", "textDocument/definition"],
    ["lsp_references_typescript", "textDocument/references"],
  ])("rejects retained %s requests throughout disposal", async (toolName, method) => {
    configureSingleLspServer();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const tool = runtime.tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`expected ${toolName} tool`);
    }
    const input = { uri: "file:///tmp/workspace/index.ts", line: 0, character: 0 };
    await tool.execute("before-dispose", input);

    const disposal = runtime.dispose();
    const during = await tool.execute("during-dispose", input).then(
      () => "accepted",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await disposal;
    const after = await tool.execute("after-dispose", input).then(
      () => "accepted",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect({ during, after }).toEqual({
      during: "LSP session disposed",
      after: "LSP session disposed",
    });
    expect(child.receivedMessages.filter((message) => message.method === method)).toHaveLength(1);
    expect(child.receivedMessages.filter((message) => message.method === "shutdown")).toHaveLength(
      1,
    );
    expect(child.receivedMessages.filter((message) => message.method === "exit")).toHaveLength(1);
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it("rejects outstanding requests before shutdown and detaches their abort listeners", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess("", new Set(["initialize"]));
    spawnMock.mockReturnValue(child);
    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });
    const hover = runtime.tools.find((tool) => tool.name === "lsp_hover_typescript");
    if (!hover) {
      throw new Error("expected hover tool");
    }
    const controller = new AbortController();
    const pending = hover
      .execute(
        "pending",
        {
          uri: "file:///tmp/workspace/index.ts",
          line: 0,
          character: 0,
        },
        controller.signal,
      )
      .then(
        () => "accepted",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

    const disposal = runtime.dispose();
    const shutdown = child.receivedMessages.find((message) => message.method === "shutdown");
    controller.abort(new Error("caller aborted during shutdown"));
    const outcome = await pending;
    child.stdout.write(encodeLspMessage({ jsonrpc: "2.0", id: shutdown?.id, result: null }));
    await disposal;

    expect(outcome).toBe("LSP session disposed");
    expect(child.receivedMessages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/hover",
      "shutdown",
      "exit",
    ]);
    expect(child.dispose).toHaveBeenCalledOnce();
  });
});
