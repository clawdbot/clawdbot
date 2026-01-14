import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging.js";
import {
  baileys,
  getLastSocket,
  resetBaileysMocks,
  resetLoadConfigMock,
} from "./test-helpers.js";

const { createWaSocket, formatError, logWebSelfId, waitForWaConnection } =
  await import("./session.js");

describe("web session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBaileysMocks();
    resetLoadConfigMock();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });

  it("creates WA socket with QR handler", async () => {
    await createWaSocket(true, false);
    const makeWASocket = baileys.makeWASocket as ReturnType<typeof vi.fn>;
    expect(makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ printQRInTerminal: false }),
    );
    const passed = makeWASocket.mock.calls[0][0];
    const passedLogger = (
      passed as { logger?: { level?: string; trace?: unknown } }
    ).logger;
    expect(passedLogger?.level).toBe("silent");
    expect(typeof passedLogger?.trace).toBe("function");
    const sock = getLastSocket();
    const saveCreds = (
      await baileys.useMultiFileAuthState.mock.results[0].value
    ).saveCreds;
    // trigger creds.update listener
    sock.ev.emit("creds.update", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(saveCreds).toHaveBeenCalled();
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
    const existsSpy = vi.spyOn(fsSync, "existsSync").mockImplementation((p) => {
      if (typeof p !== "string") return false;
      return p.endsWith("creds.json");
    });
    const readSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((p) => {
      if (typeof p === "string" && p.endsWith("creds.json")) {
        return JSON.stringify({ me: { id: "12345@s.whatsapp.net" } });
      }
      throw new Error(`unexpected readFileSync path: ${String(p)}`);
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    logWebSelfId("/tmp/wa-creds", runtime as never, true);

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Web Channel: +12345 (jid 12345@s.whatsapp.net)"),
    );
    existsSpy.mockRestore();
    readSpy.mockRestore();
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
    const credsSuffix = path.join(
      ".clawdbot",
      "credentials",
      "whatsapp",
      "default",
      "creds.json",
    );

    const copySpy = vi
      .spyOn(fsSync, "copyFileSync")
      .mockImplementation(() => {});
    const existsSpy = vi.spyOn(fsSync, "existsSync").mockImplementation((p) => {
      if (typeof p !== "string") return false;
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
        return "{" as never;
      }
      throw new Error(`unexpected readFileSync path: ${String(p)}`);
    });

    await createWaSocket(false, false);
    const sock = getLastSocket();
    const saveCreds = (
      await baileys.useMultiFileAuthState.mock.results[0].value
    ).saveCreds;

    sock.ev.emit("creds.update", {});
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(copySpy).not.toHaveBeenCalled();
    expect(saveCreds).toHaveBeenCalled();

    copySpy.mockRestore();
    existsSpy.mockRestore();
    statSpy.mockRestore();
    readSpy.mockRestore();
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
    baileys.useMultiFileAuthState.mockResolvedValueOnce({
      state: { creds: {}, keys: {} },
      saveCreds,
    });

    await createWaSocket(false, false);
    const sock = getLastSocket();

    sock.ev.emit("creds.update", {});
    sock.ev.emit("creds.update", {});

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inFlight).toBe(1);

    release?.();

    // let both queued saves complete
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(saveCreds).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  it("rotates creds backup when creds.json is valid JSON", async () => {
    const credsSuffix = path.join(
      ".clawdbot",
      "credentials",
      "whatsapp",
      "default",
      "creds.json",
    );
    const backupSuffix = path.join(
      ".clawdbot",
      "credentials",
      "whatsapp",
      "default",
      "creds.json.bak",
    );

    const copySpy = vi
      .spyOn(fsSync, "copyFileSync")
      .mockImplementation(() => {});
    const existsSpy = vi.spyOn(fsSync, "existsSync").mockImplementation((p) => {
      if (typeof p !== "string") return false;
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
        return "{}" as never;
      }
      throw new Error(`unexpected readFileSync path: ${String(p)}`);
    });

    await createWaSocket(false, false);
    const sock = getLastSocket();
    const saveCreds = (
      await baileys.useMultiFileAuthState.mock.results[0].value
    ).saveCreds;

    sock.ev.emit("creds.update", {});
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(copySpy).toHaveBeenCalledTimes(1);
    const args = copySpy.mock.calls[0] ?? [];
    expect(String(args[0] ?? "")).toContain(credsSuffix);
    expect(String(args[1] ?? "")).toContain(backupSuffix);
    expect(saveCreds).toHaveBeenCalled();

    copySpy.mockRestore();
    existsSpy.mockRestore();
    statSpy.mockRestore();
    readSpy.mockRestore();
  });
});
