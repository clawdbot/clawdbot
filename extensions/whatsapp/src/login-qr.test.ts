import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWebLoginWithQr, waitForWebLogin } from "./login-qr.js";
import {
  createWaSocket,
  logoutWeb,
  readWebAuthExistsForDecision,
  readWebSelfId,
  WHATSAPP_AUTH_UNSTABLE_CODE,
  waitForWaConnection,
} from "./session.js";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  const createWaSocket = vi.fn(
    async (
      _printQr: boolean,
      _verbose: boolean,
      opts?: { authDir?: string; onQr?: (qr: string) => void },
    ) => {
      const sock = { ws: { close: vi.fn() } };
      if (opts?.onQr) {
        setImmediate(() => opts.onQr?.("qr-data"));
      }
      return sock as never;
    },
  );
  const waitForWaConnection = vi.fn();
  const formatError = vi.fn((err: unknown) => `formatted:${String(err)}`);
  const getStatusCode = vi.fn(
    (err: unknown) =>
      (err as { output?: { statusCode?: number } })?.output?.statusCode ??
      (err as { status?: number })?.status ??
      (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode,
  );
  const readWebAuthExistsForDecision = vi.fn(async () => ({
    outcome: "stable" as const,
    exists: false,
  }));
  const readWebSelfId = vi.fn(() => ({ e164: null, jid: null, lid: null }));
  const logoutWeb = vi.fn(async () => true);
  return {
    ...actual,
    createWaSocket,
    waitForWaConnection,
    formatError,
    getStatusCode,
    readWebAuthExistsForDecision,
    readWebSelfId,
    logoutWeb,
  };
});

vi.mock("./qr-image.js", () => ({
  renderQrPngBase64: vi.fn(async () => "base64"),
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const readWebAuthExistsForDecisionMock = vi.mocked(readWebAuthExistsForDecision);
const readWebSelfIdMock = vi.mocked(readWebSelfId);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const logoutWebMock = vi.mocked(logoutWeb);

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("login-qr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createWaSocketMock
      .mockReset()
      .mockImplementation(
        async (
          _printQr: boolean,
          _verbose: boolean,
          opts?: { authDir?: string; onQr?: (qr: string) => void },
        ) => {
          const sock = { ws: { close: vi.fn() } };
          if (opts?.onQr) {
            setImmediate(() => opts.onQr?.("qr-data"));
          }
          return sock as never;
        },
      );
    waitForWaConnectionMock.mockReset();
    readWebAuthExistsForDecisionMock.mockReset().mockResolvedValue({
      outcome: "stable",
      exists: false,
    });
    readWebSelfIdMock.mockReset().mockReturnValue({ e164: null, jid: null, lid: null });
    logoutWebMock.mockReset().mockResolvedValue(true);
  });

  it("restarts login once on status 515 and completes", async () => {
    waitForWaConnectionMock
      // Baileys v7 wraps the error: { error: BoomError(515) }
      .mockRejectedValueOnce({ error: { output: { statusCode: 515 } } })
      .mockResolvedValueOnce(undefined);

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,base64");

    const resultPromise = waitForWebLogin({ timeoutMs: 5000 });
    await flushTasks();
    await flushTasks();

    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    const result = await resultPromise;

    expect(result.connected).toBe(true);
    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    expect(logoutWebMock).not.toHaveBeenCalled();
  });

  it("clears auth and reports a relink message when WhatsApp is logged out", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce({
      output: { statusCode: 401 },
    });

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,base64");

    const result = await waitForWebLogin({ timeoutMs: 5000 });

    expect(result).toEqual({
      connected: false,
      message:
        "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR.",
    });
    expect(logoutWebMock).toHaveBeenCalledOnce();
  });

  it("turns unexpected login cleanup failures into a normal login error", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce({
      output: { statusCode: 401 },
    });
    logoutWebMock.mockRejectedValueOnce(new Error("cleanup failed"));

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,base64");

    const result = await waitForWebLogin({ timeoutMs: 5000 });

    expect(result).toEqual({
      connected: false,
      message: "WhatsApp login failed: cleanup failed",
    });
  });

  it("returns an unstable-auth result when creds flush does not settle", async () => {
    readWebAuthExistsForDecisionMock.mockResolvedValueOnce({ outcome: "unstable" });

    const result = await startWebLoginWithQr({ timeoutMs: 5000 });

    expect(result).toEqual({
      code: WHATSAPP_AUTH_UNSTABLE_CODE,
      message: "WhatsApp auth state is still stabilizing. Retry login in a moment.",
    });
    expect(createWaSocketMock).not.toHaveBeenCalled();
  });

  it("reports a recovered linked session when socket bootstrap restores auth without a QR", async () => {
    createWaSocketMock.mockImplementationOnce(
      async (
        _printQr: boolean,
        _verbose: boolean,
        _opts?: { authDir?: string; onQr?: (qr: string) => void },
      ) =>
        ({
          ws: { close: vi.fn() },
        }) as never,
    );
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    readWebSelfIdMock.mockReturnValueOnce({ e164: "+5511977000000", jid: null, lid: null });

    const result = await startWebLoginWithQr({ timeoutMs: 5000 });

    expect(result).toEqual({
      connected: true,
      message: "WhatsApp recovered the existing linked session (+5511977000000).",
    });
    expect(createWaSocketMock).toHaveBeenCalledOnce();
    await expect(waitForWebLogin({ timeoutMs: 1000 })).resolves.toEqual({
      connected: false,
      message: "No active WhatsApp login in progress.",
    });
  });
});
