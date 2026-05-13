import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueCredsSave } from "./creds-persistence.js";
import { baileys, getLastSocket, resetBaileysMocks, resetLoadConfigMock } from "./test-helpers.js";

const useMultiFileAuthStateMock = vi.mocked(baileys.useMultiFileAuthState);

let createWaSocket: typeof import("./session.js").createWaSocket;
let formatError: typeof import("./session.js").formatError;
let logWebSelfId: typeof import("./session.js").logWebSelfId;
let waitForWaConnection: typeof import("./session.js").waitForWaConnection;
let waitForCredsSaveQueue: typeof import("./session.js").waitForCredsSaveQueue;
let writeCredsJsonAtomically: typeof import("./session.js").writeCredsJsonAtomically;
let DEFAULT_WHATSAPP_SOCKET_TIMING: typeof import("./socket-timing.js").DEFAULT_WHATSAPP_SOCKET_TIMING;

async function flushCredsUpdate() {
  await new Promise<void>((resolve) => setImmediate(resolve));
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

function mockCredsJsonSpies(readContents: string) {
  const credsSuffix = path.join("/tmp", "openclaw-oauth", "whatsapp", "default", "creds.json");
  const copySpy = vi.spyOn(fsSync, "copyFileSync").mockImplementation(() => {});
  const existsSpy = vi.spyOn(fsSync, "existsSync").mockImplementation((p) => {
    if (typeof p !== "string") {
      return false;
    }
    return p.endsWith(credsSuffix);
  });
  const statSpy = vi.spyOn(fsSync, "statSync").mockImplementation((p) => {
    if (typeof p === "string" && p.endsWith(credsSuffix)) {
      return { isFile: () => true, size: 12 } as never;
    }
    throw new Error(`unexpected statSync path: ${String(p)}`);
  });
  const readSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((p) => {
    if (typeof p === "string" && p.endsWith(credsSuffix)) {
      return readContents as never;
    }
    throw new Error(`unexpected readFileSync path: ${String(p)}`);
  });
  return {
    copySpy,
    credsSuffix,
    restore: () => {
      copySpy.mockRestore();
      existsSpy.mockRestore();
      statSpy.mockRestore();
      readSpy.mockRestore();
    },
  };
}

function mockLogWebSelfIdCreds(me: Record<string, string>) {
  const existsSpy = vi.spyOn(fsSync, "existsSync").mockImplementation((p) => {
    if (typeof p !== "string") {
      return false;
    }
    return p.endsWith("creds.json");
  });
  const readSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((p) => {
    if (typeof p === "string" && p.endsWith("creds.json")) {
      return JSON.stringify({ me });
    }
    throw new Error(`unexpected readFileSync path: ${String(p)}`);
  });
  return {
    restore() {
      existsSpy.mockRestore();
      readSpy.mockRestore();
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

describe("web session", () => {
  beforeAll(async () => {
    ({
      createWaSocket,
      formatError,
      logWebSelfId,
      waitForWaConnection,
      waitForCredsSaveQueue,
      writeCredsJsonAtomically,
    } = await import("./session.js"));
    ({ DEFAULT_WHATSAPP_SOCKET_TIMING } = await import("./socket-timing.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetBaileysMocks();
    resetLoadConfigMock();
  });

  afterEach(async () => {
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

  it("uses ambient env proxy agent when HTTPS_PROXY is configured", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");

    await createWaSocket(false, false);

    const passed = readLastSocketOptions();
    const agent = requireValue(passed.agent, "WebSocket proxy agent");
    const fetchAgent = requireValue(passed.fetchAgent, "fetch proxy agent");
    expect(fetchAgent).not.toBe(agent);
    expect(typeof (fetchAgent as { dispatch?: unknown }).dispatch).toBe("function");
  });

  it("uses lowercase HTTPS proxy before uppercase for WA WebSocket connection", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://upper-proxy.test:8080");
    vi.stubEnv("https_proxy", "http://lower-proxy.test:8080");

    await createWaSocket(false, false);

    const agent = requireValue(
      readLastSocketOptions().agent as { proxy?: URL } | undefined,
      "WebSocket proxy agent",
    );
    expect(agent.proxy?.href).toContain("lower-proxy.test");
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
    const promise = waitForWaConnection({ ev } as unknown as ReturnType<
      typeof baileys.makeWASocket
    >);
    ev.emit("connection.update", { connection: "open" });
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects when connection closes", async () => {
    const ev = new EventEmitter();
    const promise = waitForWaConnection({ ev } as unknown as ReturnType<
      typeof baileys.makeWASocket
    >);
    ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: new Error("bye"),
    });
    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it("logWebSelfId prints cached E.164 when creds exist", () => {
    const creds = mockLogWebSelfIdCreds({ id: "12345@s.whatsapp.net" });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    logWebSelfId("/tmp/wa-creds", runtime as never, true);

    expectRuntimeLogContaining(runtime, "Web Channel: +12345 (jid 12345@s.whatsapp.net)");
    creds.restore();
  });

  it("logWebSelfId prints cached lid details when creds include a lid", () => {
    const creds = mockLogWebSelfIdCreds({
      id: "12345@s.whatsapp.net",
      lid: "777@lid",
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    logWebSelfId("/tmp/wa-creds", runtime as never, true);

    expectRuntimeLogContaining(
      runtime,
      "Web Channel: +12345 (jid 12345@s.whatsapp.net, lid 777@lid)",
    );
    creds.restore();
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

  it("does not clobber creds backup when creds.json is corrupted", async () => {
    const creds = mockCredsJsonSpies("{");
    const openMock = mockFsOpenForCredsWrites();

    await createWaSocket(false, false);
    await emitCredsUpdate();
    await waitForCredsSaveQueue();

    expect(creds.copySpy).not.toHaveBeenCalled();
    expect(openMock.tempHandles).toHaveLength(1);

    creds.restore();
    openMock.restore();
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

    expect(openMock.tempHandles).toHaveLength(2);
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
    const creds = mockCredsJsonSpies("{}");
    const openMock = mockFsOpenForCredsWrites();
    const backupSuffix = path.join(
      "/tmp",
      "openclaw-oauth",
      "whatsapp",
      "default",
      "creds.json.bak",
    );

    await createWaSocket(false, false);
    await emitCredsUpdate();
    await waitForCredsSaveQueue();

    expect(creds.copySpy).toHaveBeenCalledTimes(1);
    const [sourcePath, backupPath] = firstMockCall(creds.copySpy, "creds backup copy");
    expect(requireString(sourcePath, "creds backup source path")).toContain(creds.credsSuffix);
    expect(requireString(backupPath, "creds backup target path")).toContain(backupSuffix);
    expect(openMock.tempHandles).toHaveLength(1);

    creds.restore();
    openMock.restore();
  });

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

    expect(renameSpy).toHaveBeenCalledOnce();
    const parsedCreds = JSON.parse(raw) as unknown;
    expect(parsedCreds).toEqual(originalCreds);
    expect(tempEntries).toHaveLength(0);

    renameSpy.mockRestore();
  });
});
