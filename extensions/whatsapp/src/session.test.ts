// Whatsapp tests cover session plugin behavior.
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueCredsSave } from "./creds-persistence.js";
import { baileys, getLastSocket, resetBaileysMocks, resetLoadConfigMock } from "./test-helpers.js";

const { envHttpProxyAgentCtor, proxyAgentCtor } = vi.hoisted(() => ({
  envHttpProxyAgentCtor: vi.fn(function MockEnvHttpProxyAgent(
    this: { options: unknown; dispatch: () => void },
    options: unknown,
  ) {
    this.options = options;
    this.dispatch = () => {};
  }),
  proxyAgentCtor: vi.fn(function MockProxyAgent(
    this: { options: unknown; dispatch: () => void },
    options: unknown,
  ) {
    this.options = options;
    this.dispatch = () => {};
  }),
}));

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    EnvHttpProxyAgent: envHttpProxyAgentCtor,
    ProxyAgent: proxyAgentCtor,
  };
});

const useMultiFileAuthStateMock = vi.mocked(baileys.useMultiFileAuthState);

let createWaSocket: typeof import("./session.js").createWaSocket;
let formatError: typeof import("./session.js").formatError;
let logWebSelfId: typeof import("./session.js").logWebSelfId;
let OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV: typeof import("./session.js").OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV;
let renderQrTerminalMock: ReturnType<typeof vi.fn>;
let waitForWaConnection: typeof import("./session.js").waitForWaConnection;
let waitForCredsSaveQueue: typeof import("./session.js").waitForCredsSaveQueue;
let writeCredsJsonAtomically: typeof import("./session.js").writeCredsJsonAtomically;
let DEFAULT_WHATSAPP_SOCKET_TIMING: typeof import("./socket-timing.js").DEFAULT_WHATSAPP_SOCKET_TIMING;

async function flushCredsUpdate() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function emitCredsUpdate(authDir?: string) {
  const sock = getLastSocket();
  sock.ev.emit("creds.update", {});
  await flushCredsUpdate();
  if (authDir) {
    await waitForCredsSaveQueue(authDir);
  }
}

function createTempAuthDir(prefix: string) {
  return path.resolve(
    fsSync.mkdtempSync(path.join((process.env.TMPDIR ?? "/tmp").replace(/\/+$/, ""), `${prefix}-`)),
  );
}

function createTempCaFile(contents: string): string {
  const dir = createTempAuthDir("openclaw-wa-proxy-ca");
  const caFile = path.join(dir, "proxy-ca.pem");
  fsSync.writeFileSync(caFile, contents, "utf8");
  return caFile;
}

function mockFsOpenForCredsWrites(params?: {
  onTempWrite?: (filePath: string) => Promise<void> | void;
}) {
  const writeFile = fs.writeFile.bind(fs);
  const tempHandles: Array<{
    filePath: string;
    sync: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const dirHandles: Array<{
    filePath: string;
    sync: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const tempWrites: string[] = [];
  const writeFileSpy = vi
    .spyOn(fs, "writeFile")
    .mockImplementation(async (filePath, data, opts) => {
      if (typeof filePath === "string" && filePath.includes(".creds.")) {
        tempWrites.push(filePath);
        await params?.onTempWrite?.(filePath);
      }
      return await writeFile(filePath as never, data as never, opts as never);
    });
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
    if (typeof filePath === "string" && flags === "r+" && filePath.includes(".creds.")) {
      const handle = {
        filePath,
        sync: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };
      tempHandles.push(handle);
      return handle as never;
    }
    if (typeof filePath === "string" && flags === "r") {
      const handle = {
        filePath,
        sync: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      };
      dirHandles.push(handle);
      return handle as never;
    }
    throw new Error(
      `unexpected fs.open call: ${String(filePath)} ${String(flags)} ${String(mode)}`,
    );
  });
  return {
    openSpy,
    writeFileSpy,
    tempWrites,
    tempHandles,
    dirHandles,
    restore() {
      writeFileSpy.mockRestore();
      openSpy.mockRestore();
    },
  };
}

function firstMockCall(
  mock: { mock: { calls: Array<readonly unknown[]> } },
  label: string,
): readonly unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function readLastSocketOptions(): {
  agent?: unknown;
  connectTimeoutMs?: number;
  defaultQueryTimeoutMs?: number;
  fetchAgent?: unknown;
  keepAliveIntervalMs?: number;
  printQRInTerminal?: boolean;
  waWebSocketUrl?: string | URL;
  logger?: { level?: string; trace?: unknown };
} {
  const [options] = firstMockCall(
    baileys.makeWASocket as ReturnType<typeof vi.fn>,
    "Baileys socket creation",
  );
  if (typeof options !== "object" || options === null) {
    throw new Error("expected Baileys socket options");
  }
  return options as {
    agent?: unknown;
    connectTimeoutMs?: number;
    defaultQueryTimeoutMs?: number;
    fetchAgent?: unknown;
    keepAliveIntervalMs?: number;
    printQRInTerminal?: boolean;
    waWebSocketUrl?: string | URL;
    logger?: { level?: string; trace?: unknown };
  };
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function firstWriteFileCall(writeFileSpy: ReturnType<typeof vi.fn>): {
  data: unknown;
  options: { flag?: string; mode?: number };
  path: string;
} {
  const [filePath, data, options] = firstMockCall(writeFileSpy, "fs.writeFile");
  expect(typeof filePath).toBe("string");
  return {
    data,
    options: (options ?? {}) as { flag?: string; mode?: number },
    path: filePath as string,
  };
}

function expectRuntimeLogContaining(
  runtime: { log: ReturnType<typeof vi.fn> },
  text: string,
): void {
  expect(runtime.log.mock.calls.map(([message]) => String(message)).join("\n")).toContain(text);
}

function installUndiciRuntimeDeps(): void {
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: vi.fn(),
    EnvHttpProxyAgent: envHttpProxyAgentCtor,
    Pool: vi.fn(),
    ProxyAgent: proxyAgentCtor,
    fetch: vi.fn(),
  };
}

describe("web session", () => {
  beforeAll(async () => {
    ({
      createWaSocket,
      formatError,
      logWebSelfId,
      OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV,
      waitForWaConnection,
      waitForCredsSaveQueue,
      writeCredsJsonAtomically,
    } = await import("./session.js"));
    renderQrTerminalMock = vi.mocked((await import("./qr-terminal.js")).renderQrTerminal);
    ({ DEFAULT_WHATSAPP_SOCKET_TIMING } = await import("./socket-timing.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    envHttpProxyAgentCtor.mockClear();
    proxyAgentCtor.mockClear();
    installUndiciRuntimeDeps();
    resetBaileysMocks();
    resetLoadConfigMock();
  });

  afterEach(async () => {
    Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
    await waitForCredsSaveQueue();
    resetLogger();
    setLoggerOverride(null);
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("creates WA socket with QR handler", async () => {
    const authDir = createTempAuthDir("openclaw-wa-creds-test");
    const openMock = mockFsOpenForCredsWrites();

    await createWaSocket(true, false, { authDir });
    const passed = readLastSocketOptions();
    expect(passed.printQRInTerminal).toBe(false);
    expect(passed.keepAliveIntervalMs).toBe(DEFAULT_WHATSAPP_SOCKET_TIMING.keepAliveIntervalMs);
    expect(passed.connectTimeoutMs).toBe(DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs);
    expect(passed.defaultQueryTimeoutMs).toBe(DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);
    const passedLogger = (passed as { logger?: { level?: string; trace?: unknown } }).logger;
    expect(passedLogger?.level).toBe("silent");
    if (typeof passedLogger?.trace !== "function") {
      throw new Error("expected WhatsApp socket logger trace no-op");
    }
    passedLogger.trace("ignored");
    await emitCredsUpdate(authDir);

    const write = firstWriteFileCall(openMock.writeFileSpy);
    expect(write.path).toContain(path.join(authDir, ".creds."));
    expect(typeof write.data).toBe("string");
    expect(write.options.mode).toBe(0o600);
    expect(write.options.flag).toBe("wx");
    openMock.restore();
  });

  it("prints compact terminal QR output when requested", async () => {
    const authDir = createTempAuthDir("openclaw-wa-terminal-qr");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await createWaSocket(true, false, { authDir });
      getLastSocket().ev.emit("connection.update", { qr: "qr-data" });
      await flushCredsUpdate();

      expect(logSpy).toHaveBeenCalledWith(
        "Open the WhatsApp app, go to Linked Devices, then scan this QR:",
      );
      expect(renderQrTerminalMock).toHaveBeenCalledWith("qr-data", { small: true });
      expect(stdoutSpy).toHaveBeenCalledWith("ASCII-QR\n");
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked creds before Baileys auth state reads",
    async () => {
      const authDir = createTempAuthDir("openclaw-wa-creds-symlink-runtime");
      const targetPath = path.join(authDir, "target-creds.json");
      const credsPath = path.join(authDir, "creds.json");
      fsSync.writeFileSync(
        targetPath,
        JSON.stringify({ me: { id: "15551234567@s.whatsapp.net" } }),
        "utf-8",
      );
      fsSync.symlinkSync(targetPath, credsPath);

      await expect(createWaSocket(false, false, { authDir })).rejects.toThrow(
        "creds.json must be a regular file or missing",
      );

      expect(useMultiFileAuthStateMock).not.toHaveBeenCalled();
      expect(fsSync.lstatSync(credsPath).isSymbolicLink()).toBe(true);
      expect(fsSync.readFileSync(targetPath, "utf-8")).toContain("15551234567");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked auth directories before Baileys auth state reads",
    async () => {
      const rootDir = createTempAuthDir("openclaw-wa-authdir-symlink-runtime");
      const targetAuthDir = path.join(rootDir, "target-auth");
      const authDir = path.join(rootDir, "linked-auth");
      fsSync.mkdirSync(targetAuthDir);
      fsSync.writeFileSync(
        path.join(targetAuthDir, "creds.json"),
        JSON.stringify({ me: { id: "15551234567@s.whatsapp.net" } }),
        "utf-8",
      );
      fsSync.symlinkSync(targetAuthDir, authDir, "dir");

      await expect(createWaSocket(false, false, { authDir })).rejects.toThrow(
        "creds.json must be a regular file or missing",
      );

      expect(useMultiFileAuthStateMock).not.toHaveBeenCalled();
      expect(fsSync.lstatSync(authDir).isSymbolicLink()).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked auth directory parents before creating the auth directory",
    async () => {
      const rootDir = createTempAuthDir("openclaw-wa-auth-parent-symlink-runtime");
      const targetBaseDir = path.join(rootDir, "target-base");
      const linkedBaseDir = path.join(rootDir, "linked-base");
      const authDir = path.join(linkedBaseDir, "default");
      fsSync.mkdirSync(targetBaseDir);
      fsSync.symlinkSync(targetBaseDir, linkedBaseDir, "dir");

      await expect(createWaSocket(false, false, { authDir })).rejects.toThrow(
        "creds.json must be a regular file or missing",
      );

      expect(useMultiFileAuthStateMock).not.toHaveBeenCalled();
      expect(fsSync.existsSync(path.join(targetBaseDir, "default"))).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked creds before atomic credential saves",
    async () => {
      const authDir = createTempAuthDir("openclaw-wa-creds-symlink-save");
      const targetPath = path.join(authDir, "target-creds.json");
      const credsPath = path.join(authDir, "creds.json");
      fsSync.writeFileSync(targetPath, "keep", "utf-8");
      fsSync.symlinkSync(targetPath, credsPath);

      await expect(
        writeCredsJsonAtomically(authDir, { me: { id: "15551234567@s.whatsapp.net" } }),
      ).rejects.toThrow("creds.json must be a regular file or missing");

      expect(fsSync.lstatSync(credsPath).isSymbolicLink()).toBe(true);
      expect(fsSync.readFileSync(targetPath, "utf-8")).toBe("keep");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked credential parents before atomic credential saves",
    async () => {
      const rootDir = createTempAuthDir("openclaw-wa-creds-parent-symlink-save");
      const targetBaseDir = path.join(rootDir, "target-base");
      const linkedBaseDir = path.join(rootDir, "linked-base");
      const authDir = path.join(linkedBaseDir, "default");
      fsSync.mkdirSync(targetBaseDir);
      fsSync.symlinkSync(targetBaseDir, linkedBaseDir, "dir");

      await expect(
        writeCredsJsonAtomically(authDir, { me: { id: "15551234567@s.whatsapp.net" } }),
      ).rejects.toThrow("creds.json must be a regular file or missing");

      expect(fsSync.existsSync(path.join(targetBaseDir, "default"))).toBe(false);
    },
  );

  it("passes explicit Baileys socket timing overrides", async () => {
    await createWaSocket(false, false, {
      keepAliveIntervalMs: 10_000,
      connectTimeoutMs: 90_000,
      defaultQueryTimeoutMs: 120_000,
    });

    const passed = readLastSocketOptions();
    expect(passed.keepAliveIntervalMs).toBe(10_000);
    expect(passed.connectTimeoutMs).toBe(90_000);
    expect(passed.defaultQueryTimeoutMs).toBe(120_000);
  });

  it("passes explicit Baileys WebSocket URL overrides", async () => {
    await createWaSocket(false, false, {
      waWebSocketUrl: " ws://127.0.0.1:49152/ws/chat ",
    });

    expect(readLastSocketOptions().waWebSocketUrl).toBe("ws://127.0.0.1:49152/ws/chat");
  });

  it("uses OPENCLAW_WHATSAPP_WEB_SOCKET_URL as the default Baileys WebSocket URL", async () => {
    vi.stubEnv(OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV, " ws://127.0.0.1:49153/ws/chat ");

    await createWaSocket(false, false);

    expect(readLastSocketOptions().waWebSocketUrl).toBe("ws://127.0.0.1:49153/ws/chat");
  });

  it("preserves explicit Baileys WebSocket URL options over environment", async () => {
    vi.stubEnv(OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV, "ws://127.0.0.1:49153/ws/chat");

    await createWaSocket(false, false, {
      waWebSocketUrl: "ws://127.0.0.1:49154/ws/chat",
    });

    expect(readLastSocketOptions().waWebSocketUrl).toBe("ws://127.0.0.1:49154/ws/chat");
  });

  it("ignores blank Baileys WebSocket URL environment overrides", async () => {
    vi.stubEnv(OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV, " ");

    await createWaSocket(false, false);

    expect(readLastSocketOptions().waWebSocketUrl).toBeUndefined();
  });

  it("rejects invalid OPENCLAW_WHATSAPP_WEB_SOCKET_URL values", async () => {
    vi.stubEnv(OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV, "http://127.0.0.1:14567/ws");

    await expect(createWaSocket(false, false)).rejects.toThrow(
      "OPENCLAW_WHATSAPP_WEB_SOCKET_URL must use ws:// or wss://.",
    );
    expect(baileys.makeWASocket).not.toHaveBeenCalled();
  });

  it("preserves explicit Baileys WebSocket URL options over invalid environment", async () => {
    vi.stubEnv(OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV, "http://127.0.0.1:49153/ws/chat");

    await createWaSocket(false, false, {
      waWebSocketUrl: "ws://127.0.0.1:49154/ws/chat",
    });

    expect(readLastSocketOptions().waWebSocketUrl).toBe("ws://127.0.0.1:49154/ws/chat");
  });

  it("uses ambient env proxy agent when HTTPS_PROXY is configured", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");

    await createWaSocket(false, false);

    const passed = readLastSocketOptions();
    const agent = requireValue(
      passed.agent as { constructor: { name: string } } | undefined,
      "WebSocket proxy agent",
    );
    const fetchAgent = requireValue(passed.fetchAgent, "fetch proxy agent");
    expect(fetchAgent).not.toBe(agent);
    expect(typeof (fetchAgent as { dispatch?: unknown }).dispatch).toBe("function");
  });

  it("adds managed proxy CA trust to WhatsApp env proxy agents", async () => {
    const caFile = createTempCaFile("whatsapp-managed-proxy-ca");
    vi.stubEnv("HTTPS_PROXY", "https://proxy.test:8443");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);

    await createWaSocket(false, false);

    const passed = readLastSocketOptions();
    const agent = requireValue(
      passed.agent as { constructor: { name: string } } | undefined,
      "WebSocket proxy agent",
    );
    expect(agent.constructor.name).toBe("ProxylineNodeProxyAgent");
    expect(proxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyTls: expect.objectContaining({ ca: "whatsapp-managed-proxy-ca" }),
      }),
    );
  });

  it("adds managed proxy CA trust to WhatsApp env fetch dispatchers", async () => {
    const caFile = createTempCaFile("whatsapp-managed-env-proxy-ca");
    vi.stubEnv("HTTPS_PROXY", "https://proxy.test:8443");
    vi.stubEnv("NO_PROXY", "mmg.whatsapp.net");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);

    await createWaSocket(false, false);

    const passed = readLastSocketOptions();
    expect(passed.agent).toBeUndefined();
    expect(envHttpProxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyTls: expect.objectContaining({ ca: "whatsapp-managed-env-proxy-ca" }),
      }),
    );
  });

  it("uses lowercase HTTPS proxy before uppercase for WA WebSocket connection", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://upper-proxy.test:8080");
    vi.stubEnv("https_proxy", "http://lower-proxy.test:8080");

    await createWaSocket(false, false);

    const agent = requireValue(
      readLastSocketOptions().agent as { getProxyForUrl?: (url: string) => string } | undefined,
      "WebSocket proxy agent",
    );
    expect(agent.getProxyForUrl?.("https://mmg.whatsapp.net/")).toContain("lower-proxy.test");
  });

  it("skips WA WebSocket env proxy agent when NO_PROXY covers WhatsApp Web", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    vi.stubEnv("NO_PROXY", "mmg.whatsapp.net");

    await createWaSocket(false, false);

    const passed = readLastSocketOptions();
    expect(passed.agent).toBeUndefined();
    requireValue(passed.fetchAgent, "fetch proxy agent");
  });

  it("does not create a proxy agent when no env proxy is configured", async () => {
    for (const key of [
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
    ]) {
      vi.stubEnv(key, "");
    }

    await createWaSocket(false, false);

    const passed = readLastSocketOptions();
    expect(passed.agent).toBeUndefined();
    expect(passed.fetchAgent).toBeUndefined();
  });

  it("waits for connection open", async () => {
    const ev = new EventEmitter();
    const promise = waitForWaConnection(
      { ev } as unknown as ReturnType<typeof baileys.makeWASocket>,
      { timeout: "none" },
    );
    ev.emit("connection.update", { connection: "open" });
    await expect(promise).resolves.toBeUndefined();
  });

  it("keeps one-argument callers on the old no-timeout wait policy", async () => {
    const ev = new EventEmitter();
    const promise = waitForWaConnection({ ev } as unknown as ReturnType<
      typeof baileys.makeWASocket
    >);
    ev.emit("connection.update", { connection: "open" });
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects when connection closes", async () => {
    const ev = new EventEmitter();
    const promise = waitForWaConnection(
      { ev } as unknown as ReturnType<typeof baileys.makeWASocket>,
      { timeout: "none" },
    );
    ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: new Error("bye"),
    });
    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it("rejects after timeout with no connection event", async () => {
    vi.useFakeTimers();
    const ev = new EventEmitter();
    const promise = waitForWaConnection(
      { ev } as unknown as ReturnType<typeof baileys.makeWASocket>,
      { timeoutMs: 100 },
    );
    vi.advanceTimersByTime(100);
    const error = await promise.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("timed out after 100ms");
    expect(error).toMatchObject({ output: { statusCode: 408 } });
    expect(ev.listenerCount("connection.update")).toBe(0);
    vi.useRealTimers();
  });

  it("clears timeout when connection opens before timeout", async () => {
    vi.useFakeTimers();
    const ev = new EventEmitter();
    const promise = waitForWaConnection(
      { ev } as unknown as ReturnType<typeof baileys.makeWASocket>,
      { timeoutMs: 5000 },
    );
    ev.emit("connection.update", { connection: "open" });
    await expect(promise).resolves.toBeUndefined();
    expect(ev.listenerCount("connection.update")).toBe(0);
    vi.useRealTimers();
  });

  it("logWebSelfId prints cached E.164 when creds exist", () => {
    const authDir = createTempAuthDir("openclaw-wa-log-self");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json"),
      JSON.stringify({ me: { id: "12345@s.whatsapp.net" } }),
      "utf-8",
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    logWebSelfId(authDir, runtime as never, true);

    expectRuntimeLogContaining(runtime, "Web Channel: +12345 (jid 12345@s.whatsapp.net)");
  });

  it("logWebSelfId prints cached lid details when creds include a lid", () => {
    const authDir = createTempAuthDir("openclaw-wa-log-self-lid");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json"),
      JSON.stringify({
        me: {
          id: "12345@s.whatsapp.net",
          lid: "777@lid",
        },
      }),
      "utf-8",
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    logWebSelfId(authDir, runtime as never, true);

    expectRuntimeLogContaining(
      runtime,
      "Web Channel: +12345 (jid 12345@s.whatsapp.net, lid 777@lid)",
    );
  });

  it("formatError prints Boom-like payload message", () => {
    const err = {
      error: {
        isBoom: true,
        output: {
          statusCode: 408,
          payload: {
            statusCode: 408,
            error: "Request Time-out",
            message: "QR refs attempts ended",
          },
        },
      },
    };
    expect(formatError(err)).toContain("status=408");
    expect(formatError(err)).toContain("Request Time-out");
    expect(formatError(err)).toContain("QR refs attempts ended");
  });

  it("formatError keeps truncated object details free of lone surrogates", () => {
    const emptyEnvelope = JSON.stringify({ detail: "" }, null, 2);
    const insertionIndex = emptyEnvelope.indexOf('""') + 1;
    const detail = `${"a".repeat(799 - insertionIndex)}😀tail`;
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

    const result = formatError({ detail });

    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toMatch(loneSurrogate);
  });

  it("does not clobber creds backup when creds.json is corrupted", async () => {
    const authDir = createTempAuthDir("openclaw-wa-corrupt-backup");
    const backupPath = path.join(authDir, "creds.json.bak");
    fsSync.writeFileSync(path.join(authDir, "creds.json"), "{", "utf-8");
    const openMock = mockFsOpenForCredsWrites();

    try {
      await createWaSocket(false, false, { authDir });
      await emitCredsUpdate(authDir);

      expect(fsSync.existsSync(backupPath)).toBe(false);
      expect(openMock.tempHandles).toHaveLength(1);
    } finally {
      openMock.restore();
    }
  });

  it("serializes creds.update saves to avoid overlapping writes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const authDir = createTempAuthDir("openclaw-wa-queue");
    const openMock = mockFsOpenForCredsWrites({
      onTempWrite: async (filePath) => {
        if (filePath.startsWith(authDir)) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await gate;
          inFlight -= 1;
        }
      },
    });

    await createWaSocket(false, false, { authDir });
    const sock = getLastSocket();

    sock.ev.emit("creds.update", {});
    sock.ev.emit("creds.update", {});

    try {
      await vi.waitFor(() => {
        expect(inFlight).toBe(1);
      });
    } finally {
      (release as (() => void) | null)?.();
    }

    await waitForCredsSaveQueue(authDir);

    expect(openMock.tempHandles).toHaveLength(3);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
    openMock.restore();
  });

  it("lets different authDir queues flush independently", async () => {
    let inFlightA = 0;
    let inFlightB = 0;
    let releaseA: (() => void) | null = null;
    let releaseB: (() => void) | null = null;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const authDirA = createTempAuthDir("openclaw-wa-a");
    const authDirB = createTempAuthDir("openclaw-wa-b");
    const onError = vi.fn();

    enqueueCredsSave(
      authDirA,
      async () => {
        inFlightA += 1;
        await gateA;
        inFlightA -= 1;
      },
      onError,
    );
    enqueueCredsSave(
      authDirB,
      async () => {
        inFlightB += 1;
        await gateB;
        inFlightB -= 1;
      },
      onError,
    );

    try {
      await vi.waitFor(() => {
        expect(inFlightA).toBe(1);
        expect(inFlightB).toBe(1);
      });
    } finally {
      (releaseA as (() => void) | null)?.();
      (releaseB as (() => void) | null)?.();
    }

    await Promise.all([waitForCredsSaveQueue(authDirA), waitForCredsSaveQueue(authDirB)]);

    expect(inFlightA).toBe(0);
    expect(inFlightB).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("rotates creds backup when creds.json is valid JSON", async () => {
    const authDir = createTempAuthDir("openclaw-wa-rotate-backup");
    const credsPath = path.join(authDir, "creds.json");
    const backupPath = path.join(authDir, "creds.json.bak");
    fsSync.writeFileSync(credsPath, "{}", "utf-8");
    const openMock = mockFsOpenForCredsWrites();

    try {
      await createWaSocket(false, false, { authDir });
      await emitCredsUpdate(authDir);

      expect(fsSync.readFileSync(backupPath, "utf-8")).toBe("{}");
      expect(openMock.tempHandles).toHaveLength(2);
    } finally {
      openMock.restore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not rotate creds backup through a symlinked backup path",
    async () => {
      const authDir = createTempAuthDir("openclaw-wa-rotate-backup-symlink");
      const credsPath = path.join(authDir, "creds.json");
      const backupPath = path.join(authDir, "creds.json.bak");
      const targetPath = path.join(authDir, "backup-target.json");
      fsSync.writeFileSync(credsPath, "{}", "utf-8");
      fsSync.writeFileSync(targetPath, "keep", "utf-8");
      fsSync.symlinkSync(targetPath, backupPath);

      await createWaSocket(false, false, { authDir });
      await emitCredsUpdate(authDir);

      expect(fsSync.lstatSync(backupPath).isSymbolicLink()).toBe(true);
      expect(fsSync.readFileSync(targetPath, "utf-8")).toBe("keep");
    },
  );

  it("writes creds.json atomically via temp file and rename", async () => {
    const openMock = mockFsOpenForCredsWrites();
    const renameSpy = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
    const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);
    const chmodSpy = vi.spyOn(fs, "chmod").mockResolvedValue(undefined);

    try {
      await writeCredsJsonAtomically("/tmp/openclaw-oauth/whatsapp/default", {
        me: { id: "123@s.whatsapp.net" },
      });

      const write = firstWriteFileCall(openMock.writeFileSpy);
      expect(write.path).toContain(
        path.join("/tmp", "openclaw-oauth", "whatsapp", "default", ".creds."),
      );
      expect(typeof write.data).toBe("string");
      expect(write.options.mode).toBe(0o600);
      expect(write.options.flag).toBe("wx");
      expect(openMock.tempHandles).toHaveLength(1);
      expect(openMock.tempHandles[0]?.sync).toHaveBeenCalledTimes(1);
      expect(openMock.tempHandles[0]?.close).toHaveBeenCalledTimes(1);
      expect(renameSpy).toHaveBeenCalledTimes(1);
      expect(rmSpy).not.toHaveBeenCalled();
      expect(chmodSpy).toHaveBeenCalledWith(
        path.join("/tmp", "openclaw-oauth", "whatsapp", "default", "creds.json"),
        0o600,
      );
      expect(openMock.dirHandles).toHaveLength(1);
      expect(openMock.dirHandles[0]?.sync).toHaveBeenCalledTimes(1);
      const writePath = openMock.tempHandles[0]?.filePath;
      const [, renameTarget] = firstMockCall(renameSpy, "creds atomic rename");
      expect(typeof writePath).toBe("string");
      expect(writePath).toContain(".creds.");
      expect(requireString(renameTarget, "creds rename target path")).toContain(
        path.join("/tmp", "openclaw-oauth", "whatsapp", "default", "creds.json"),
      );
    } finally {
      openMock.restore();
      renameSpy.mockRestore();
      rmSpy.mockRestore();
      chmodSpy.mockRestore();
    }
  });

  it("keeps the previous creds.json valid if the atomic rename fails", async () => {
    const authDir = createTempAuthDir("openclaw-wa-creds-atomic");
    const credsPath = path.join(authDir, "creds.json");
    const originalCreds = { me: { id: "old@s.whatsapp.net" } };
    const nextCreds = { me: { id: "new@s.whatsapp.net" } };
    fsSync.writeFileSync(credsPath, JSON.stringify(originalCreds), "utf-8");
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (
        typeof from === "string" &&
        typeof to === "string" &&
        from.startsWith(path.join(authDir, ".creds.")) &&
        to === credsPath
      ) {
        throw new Error("simulated atomic rename failure");
      }
      return rename(from, to);
    });

    useMultiFileAuthStateMock.mockResolvedValueOnce({
      state: {
        creds: nextCreds as never,
        keys: {} as never,
      },
      saveCreds: vi.fn(),
    });

    await createWaSocket(false, false, { authDir });
    await emitCredsUpdate(authDir);

    const raw = fsSync.readFileSync(credsPath, "utf-8");
    const tempEntries = fsSync
      .readdirSync(authDir)
      .filter((entry) => entry.startsWith(".creds.") && entry.endsWith(".tmp"));

    const primaryRenameCalls = renameSpy.mock.calls.filter(
      ([from, to]) =>
        typeof from === "string" &&
        typeof to === "string" &&
        from.startsWith(path.join(authDir, ".creds.")) &&
        to === credsPath,
    );
    expect(primaryRenameCalls).toHaveLength(1);
    const parsedCreds = JSON.parse(raw) as unknown;
    expect(parsedCreds).toEqual(originalCreds);
    expect(tempEntries).toHaveLength(0);

    renameSpy.mockRestore();
  });
});
