import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { baileys, getLastSocket, resetBaileysMocks, resetLoadConfigMock } from "./test-helpers.js";

const useMultiFileAuthStateMock = vi.mocked(baileys.useMultiFileAuthState);

let createWaSocket: typeof import("./session.js").createWaSocket;
let formatError: typeof import("./session.js").formatError;
let logWebSelfId: typeof import("./session.js").logWebSelfId;
let waitForWaConnection: typeof import("./session.js").waitForWaConnection;
let waitForCredsSaveQueue: typeof import("./session.js").waitForCredsSaveQueue;
let writeCredsJsonAtomically: typeof import("./session.js").writeCredsJsonAtomically;

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
  return fsSync.mkdtempSync(
    path.join((process.env.TMPDIR ?? "/tmp").replace(/\/+$/, ""), `${prefix}-`),
  );
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
    const writeFileSpy = vi.spyOn(fs, "writeFile");

    await createWaSocket(true, false, { authDir });
    const makeWASocket = baileys.makeWASocket as ReturnType<typeof vi.fn>;
    expect(makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ printQRInTerminal: false }),
    );
    const passed = makeWASocket.mock.calls[0][0];
    const passedLogger = (passed as { logger?: { level?: string; trace?: unknown } }).logger;
    expect(passedLogger?.level).toBe("silent");
    expect(typeof passedLogger?.trace).toBe("function");
    await emitCredsUpdate(authDir);

    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining(path.join(authDir, ".creds.")),
      expect.any(String),
      expect.objectContaining({ mode: 0o600 }),
    );
    writeFileSpy.mockRestore();
  });

  it("uses ambient env proxy agent when HTTPS_PROXY is configured", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");

    await createWaSocket(false, false);

    const passed = (baileys.makeWASocket as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      agent?: unknown;
      fetchAgent?: unknown;
    };
    expect(passed.agent).toBeDefined();
    expect(passed.fetchAgent).toBeDefined();
    expect(passed.fetchAgent).not.toBe(passed.agent);
    expect(typeof (passed.fetchAgent as { dispatch?: unknown } | undefined)?.dispatch).toBe(
      "function",
    );
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

    const passed = (baileys.makeWASocket as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      agent?: unknown;
      fetchAgent?: unknown;
    };
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

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Web Channel: +12345 (jid 12345@s.whatsapp.net)"),
    );
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

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Web Channel: +12345 (jid 12345@s.whatsapp.net, lid 777@lid)"),
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
    const writeFileSpy = vi.spyOn(fs, "writeFile");

    await createWaSocket(false, false);
    await emitCredsUpdate();

    expect(creds.copySpy).not.toHaveBeenCalled();
    expect(writeFileSpy).toHaveBeenCalled();

    creds.restore();
    writeFileSpy.mockRestore();
  });

  it("serializes creds.update saves to avoid overlapping writes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const authDir = createTempAuthDir("openclaw-wa-queue");
    const writeFile = fs.writeFile.bind(fs);
    const writeFileSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (file, data, options) => {
        if (typeof file === "string" && file.startsWith(authDir) && file.includes(".creds.")) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await gate;
          inFlight -= 1;
          return;
        }
        return writeFile(file, data, options as never);
      });

    await createWaSocket(false, false, { authDir });
    const sock = getLastSocket();

    sock.ev.emit("creds.update", {});
    sock.ev.emit("creds.update", {});

    await flushCredsUpdate();
    expect(inFlight).toBe(1);

    (release as (() => void) | null)?.();

    await waitForCredsSaveQueue(authDir);

    expect(writeFileSpy).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
    writeFileSpy.mockRestore();
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
    const writeFile = fs.writeFile.bind(fs);
    const writeFileSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (file, data, options) => {
        if (typeof file === "string" && file.startsWith(authDirA) && file.includes(".creds.")) {
          inFlightA += 1;
          await gateA;
          inFlightA -= 1;
          return;
        }
        if (typeof file === "string" && file.startsWith(authDirB) && file.includes(".creds.")) {
          inFlightB += 1;
          await gateB;
          inFlightB -= 1;
          return;
        }
        return writeFile(file, data, options as never);
      });

    await createWaSocket(false, false, { authDir: authDirA });
    const sockA = getLastSocket();
    await createWaSocket(false, false, { authDir: authDirB });
    const sockB = getLastSocket();

    sockA.ev.emit("creds.update", {});
    sockB.ev.emit("creds.update", {});

    await flushCredsUpdate();

    expect(writeFileSpy).toHaveBeenCalledTimes(2);
    expect(inFlightA).toBe(1);
    expect(inFlightB).toBe(1);

    (releaseA as (() => void) | null)?.();
    (releaseB as (() => void) | null)?.();
    await Promise.all([waitForCredsSaveQueue(authDirA), waitForCredsSaveQueue(authDirB)]);

    expect(inFlightA).toBe(0);
    expect(inFlightB).toBe(0);
    writeFileSpy.mockRestore();
  });

  it("rotates creds backup when creds.json is valid JSON", async () => {
    const creds = mockCredsJsonSpies("{}");
    const writeFileSpy = vi.spyOn(fs, "writeFile");
    const backupSuffix = path.join(
      "/tmp",
      "openclaw-oauth",
      "whatsapp",
      "default",
      "creds.json.bak",
    );

    await createWaSocket(false, false);
    await emitCredsUpdate();

    expect(creds.copySpy).toHaveBeenCalledTimes(1);
    const args = creds.copySpy.mock.calls[0] ?? [];
    expect(String(args[0] ?? "")).toContain(creds.credsSuffix);
    expect(String(args[1] ?? "")).toContain(backupSuffix);
    expect(writeFileSpy).toHaveBeenCalled();

    creds.restore();
    writeFileSpy.mockRestore();
  });

  it("writes creds.json atomically via temp file and rename", async () => {
    const writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    const renameSpy = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
    const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);
    const chmodSpy = vi.spyOn(fsSync, "chmodSync").mockImplementation(() => {});

    await writeCredsJsonAtomically("/tmp/openclaw-oauth/whatsapp/default", {
      me: { id: "123@s.whatsapp.net" },
    });

    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(rmSpy).not.toHaveBeenCalled();
    expect(chmodSpy).not.toHaveBeenCalled();
    const writePath = writeFileSpy.mock.calls[0]?.[0];
    const renameArgs = renameSpy.mock.calls[0] ?? [];
    expect(typeof writePath).toBe("string");
    expect(writePath).toContain(".creds.");
    expect(String(renameArgs[1] ?? "")).toContain(
      path.join("/tmp", "openclaw-oauth", "whatsapp", "default", "creds.json"),
    );

    writeFileSpy.mockRestore();
    renameSpy.mockRestore();
    rmSpy.mockRestore();
    chmodSpy.mockRestore();
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
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toMatchObject(originalCreds);
    expect(tempEntries).toHaveLength(0);

    renameSpy.mockRestore();
  });
});
