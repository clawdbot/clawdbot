import { EventEmitter } from "node:events";
import fsSync from "node:fs";
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

async function flushCredsUpdate() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function emitCredsUpdateAndReadSaveCreds() {
  const sock = getLastSocket();
  const saveCreds = (await useMultiFileAuthStateMock.mock.results[0]?.value)?.saveCreds;
  sock.ev.emit("creds.update", {});
  await flushCredsUpdate();
  return saveCreds;
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
    ({ createWaSocket, formatError, logWebSelfId, waitForWaConnection, waitForCredsSaveQueue } =
      await import("./session.js"));
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
    await createWaSocket(true, false);
    const makeWASocket = baileys.makeWASocket as ReturnType<typeof vi.fn>;
    expect(makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ printQRInTerminal: false }),
    );
    const passed = makeWASocket.mock.calls[0][0];
    const passedLogger = (passed as { logger?: { level?: string; trace?: unknown } }).logger;
    expect(passedLogger?.level).toBe("silent");
    expect(typeof passedLogger?.trace).toBe("function");
    const sock = getLastSocket();
    const saveCreds = (await useMultiFileAuthStateMock.mock.results[0]?.value)?.saveCreds;
    // trigger creds.update listener
    sock.ev.emit("creds.update", {});
    await flushCredsUpdate();
    expect(saveCreds).toHaveBeenCalled();
  });

  it("uses ambient env proxy agent when HTTPS_PROXY is configured", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");

    await createWaSocket(false, false);

    const passed = (baileys.makeWASocket as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      agent?: unknown;
      fetchAgent?: unknown;
    };
    expect(passed.agent).toBeDefined();
    expect(passed.fetchAgent).toBe(passed.agent);
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

    await createWaSocket(false, false);
    const saveCreds = await emitCredsUpdateAndReadSaveCreds();

    expect(creds.copySpy).not.toHaveBeenCalled();
    expect(saveCreds).toHaveBeenCalled();

    creds.restore();
  });

  it("serializes creds.update saves to avoid overlapping writes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const saveCreds = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
    });
    useMultiFileAuthStateMock.mockResolvedValueOnce({
      state: { creds: {} as never, keys: {} as never },
      saveCreds,
    });

    await createWaSocket(false, false);
    const sock = getLastSocket();

    sock.ev.emit("creds.update", {});
    sock.ev.emit("creds.update", {});

    await flushCredsUpdate();
    expect(inFlight).toBe(1);

    (release as (() => void) | null)?.();

    // let both queued saves complete
    await flushCredsUpdate();
    await flushCredsUpdate();

    expect(saveCreds).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
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

    const saveCredsA = vi.fn(async () => {
      inFlightA += 1;
      await gateA;
      inFlightA -= 1;
    });
    const saveCredsB = vi.fn(async () => {
      inFlightB += 1;
      await gateB;
      inFlightB -= 1;
    });
    useMultiFileAuthStateMock
      .mockResolvedValueOnce({
        state: { creds: {} as never, keys: {} as never },
        saveCreds: saveCredsA,
      })
      .mockResolvedValueOnce({
        state: { creds: {} as never, keys: {} as never },
        saveCreds: saveCredsB,
      });

    await createWaSocket(false, false, { authDir: "/tmp/wa-a" });
    const sockA = getLastSocket();
    await createWaSocket(false, false, { authDir: "/tmp/wa-b" });
    const sockB = getLastSocket();

    sockA.ev.emit("creds.update", {});
    sockB.ev.emit("creds.update", {});

    await flushCredsUpdate();

    expect(saveCredsA).toHaveBeenCalledTimes(1);
    expect(saveCredsB).toHaveBeenCalledTimes(1);
    expect(inFlightA).toBe(1);
    expect(inFlightB).toBe(1);

    (releaseA as (() => void) | null)?.();
    (releaseB as (() => void) | null)?.();
    await flushCredsUpdate();
    await flushCredsUpdate();

    expect(inFlightA).toBe(0);
    expect(inFlightB).toBe(0);
  });

  it("rotates creds backup when creds.json is valid JSON", async () => {
    const creds = mockCredsJsonSpies("{}");
    const backupSuffix = path.join(
      "/tmp",
      "openclaw-oauth",
      "whatsapp",
      "default",
      "creds.json.bak",
    );

    await createWaSocket(false, false);
    const saveCreds = await emitCredsUpdateAndReadSaveCreds();

    expect(creds.copySpy).toHaveBeenCalledTimes(1);
    const args = creds.copySpy.mock.calls[0] ?? [];
    expect(String(args[0] ?? "")).toContain(creds.credsSuffix);
    expect(String(args[1] ?? "")).toContain(backupSuffix);
    expect(saveCreds).toHaveBeenCalled();

    creds.restore();
  });
});
