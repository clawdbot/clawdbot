import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const killProcessTreeMock = vi.hoisted(() => vi.fn());
const loadEmbeddedPiLspConfigMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: spawnMock,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

vi.mock("./embedded-pi-lsp.js", () => ({
  loadEmbeddedPiLspConfig: loadEmbeddedPiLspConfigMock,
}));

vi.mock("../logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

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

class MockChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  pid = 4321;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.respondToRequest(chunk.toString("utf8"));
        callback();
      },
    });
  }

  kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.killed = true;
    this.signalCode = signal;
    this.emit("exit", null, signal);
    this.emit("close", null, signal);
    return true;
  });

  private respondToRequest(text: string): void {
    const body = parseWrittenLspBody(text);
    if (!body || typeof body.id !== "number" || typeof body.method !== "string") {
      return;
    }
    const result = body.method === "initialize" ? { capabilities: { hoverProvider: true } } : null;
    queueMicrotask(() => {
      this.stdout.write(encodeLspMessage({ jsonrpc: "2.0", id: body.id, result }));
    });
  }
}

function configureSingleLspServer(): void {
  loadEmbeddedPiLspConfigMock.mockReturnValue({
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
    const { disposeAllBundleLspRuntimes } = await import("./pi-bundle-lsp-runtime.js");
    await disposeAllBundleLspRuntimes();
    spawnMock.mockReset();
    killProcessTreeMock.mockReset();
    loadEmbeddedPiLspConfigMock.mockReset();
  });

  it("starts LSP servers in a disposable process group", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { createBundleLspToolRuntime } = await import("./pi-bundle-lsp-runtime.js");

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls.at(0) ?? [];
    expect(command).toBe("typescript-language-server");
    expect(args).toEqual(["--stdio"]);
    expect(options?.detached).toBe(process.platform !== "win32");
    expect(options?.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options?.windowsHide).toBe(process.platform === "win32");
    expect(runtime.tools.map((tool) => tool.name)).toContain("lsp_hover_typescript");

    await runtime.dispose();

    expect(killProcessTreeMock).toHaveBeenCalledWith(4321, { graceMs: 1000 });
  });

  it("disposes active LSP sessions from the global shutdown sweep", async () => {
    configureSingleLspServer();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { createBundleLspToolRuntime, disposeAllBundleLspRuntimes } =
      await import("./pi-bundle-lsp-runtime.js");

    const runtime = await createBundleLspToolRuntime({ workspaceDir: "/tmp/workspace" });

    await disposeAllBundleLspRuntimes();

    expect(killProcessTreeMock).toHaveBeenCalledWith(4321, { graceMs: 1000 });

    killProcessTreeMock.mockClear();
    await runtime.dispose();
    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });
});
