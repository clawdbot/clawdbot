import { beforeEach, describe, expect, it, vi } from "vitest";
import { startWebLoginWithQr, waitForWebLogin } from "./login-qr.js";
import { renderQrPngDataUrl } from "./qr-image.js";
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
  const createWaSocket = vi.fn();
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
  renderQrPngDataUrl: vi.fn(async (input: string) => `data:image/png;base64,encoded:${input}`),
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const readWebAuthExistsForDecisionMock = vi.mocked(readWebAuthExistsForDecision);
const readWebSelfIdMock = vi.mocked(readWebSelfId);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const logoutWebMock = vi.mocked(logoutWeb);
const renderQrPngDataUrlMock = vi.mocked(renderQrPngDataUrl);

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitMs(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQrRenderCallCount(count: number) {
  const deadline = Date.now() + 1000;
  while (renderQrPngDataUrlMock.mock.calls.length < count && Date.now() < deadline) {
    await waitMs(0);
    await flushTasks();
  }
}

describe("login-qr", () => {
  const rotatingAccountId = "rotating-qr";
  const concurrentAccountId = "concurrent-qr";

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
    renderQrPngDataUrlMock
      .mockReset()
      .mockImplementation(async (input) => `data:image/png;base64,encoded:${input}`);
  });

  it("restarts login once on status 515 and completes", async () => {
    waitForWaConnectionMock
      // Baileys v7 wraps the error: { error: BoomError(515) }
      .mockRejectedValueOnce({ error: { output: { statusCode: 515 } } })
      .mockResolvedValueOnce(undefined);

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId: rotatingAccountId,
    });
    expect(start.qrDataUrl).toBe("data:image/png;base64,encoded:qr-data");

    const resultPromise = waitForWebLogin({
      timeoutMs: 5000,
      currentQrDataUrl: start.qrDataUrl,
      accountId: rotatingAccountId,
    });
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
    expect(start.qrDataUrl).toBe("data:image/png;base64,encoded:qr-data");

    const result = await waitForWebLogin({
      timeoutMs: 5000,
      currentQrDataUrl: start.qrDataUrl,
    });

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
    expect(start.qrDataUrl).toBe("data:image/png;base64,encoded:qr-data");

    const result = await waitForWebLogin({
      timeoutMs: 5000,
      currentQrDataUrl: start.qrDataUrl,
    });

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

  it("surfaces the latest QR after the socket rotates it", async () => {
    createWaSocketMock.mockImplementationOnce(
      async (
        _printQr: boolean,
        _verbose: boolean,
        opts?: { authDir?: string; onQr?: (qr: string) => void },
      ) => {
        const sock = { ws: { close: vi.fn() } };
        setImmediate(() => opts?.onQr?.("qr-data"));
        setTimeout(() => opts?.onQr?.("qr-data-2"), 100);
        return sock as never;
      },
    );
    waitForWaConnectionMock.mockImplementation(() => new Promise(() => {}));

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe("data:image/png;base64,encoded:qr-data");

    const resultPromise = waitForWebLogin({
      timeoutMs: 5000,
      currentQrDataUrl: start.qrDataUrl,
    });
    await flushTasks();
    await waitMs(140);
    await flushTasks();

    await expect(resultPromise).resolves.toEqual({
      connected: false,
      message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,encoded:qr-data-2",
    });
  });

  it("does not short-circuit on an existing QR when the waiter has no current QR image", async () => {
    const accountId = "wait-without-current-qr";
    waitForWaConnectionMock.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(undefined), 20)),
    );

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });
    expect(start.qrDataUrl).toBe("data:image/png;base64,encoded:qr-data");

    await expect(
      waitForWebLogin({
        timeoutMs: 5000,
        accountId,
      }),
    ).resolves.toEqual({
      connected: true,
      message: "✅ Linked! WhatsApp is ready.",
    });
  });

  it("returns a terminal login result before a stale QR refresh", async () => {
    const accountId = "connected-before-refresh";
    let resolveLogin: () => void = () => {
      throw new Error("Expected login wait to be pending");
    };
    createWaSocketMock.mockImplementationOnce(
      async (
        _printQr: boolean,
        _verbose: boolean,
        opts?: { authDir?: string; onQr?: (qr: string) => void },
      ) => {
        const sock = { ws: { close: vi.fn() } };
        setImmediate(() => opts?.onQr?.("qr-data"));
        setTimeout(() => opts?.onQr?.("qr-data-2"), 20);
        return sock as never;
      },
    );
    waitForWaConnectionMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLogin = resolve;
        }),
    );

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });
    expect(start.qrDataUrl).toBe("data:image/png;base64,encoded:qr-data");

    await waitMs(50);
    await flushTasks();
    resolveLogin();
    await flushTasks();

    await expect(
      waitForWebLogin({
        timeoutMs: 5000,
        currentQrDataUrl: start.qrDataUrl,
        accountId,
      }),
    ).resolves.toEqual({
      connected: true,
      message: "✅ Linked! WhatsApp is ready.",
    });
  });

  it("returns a terminal result when an older replaced waiter resolves without state", async () => {
    const accountId = "replaced-login-waiter";
    let resolveFirstConnection: () => void = () => {
      throw new Error("Expected first login wait to be pending");
    };
    waitForWaConnectionMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstConnection = resolve;
          }),
      )
      .mockImplementation(() => new Promise(() => {}));

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });
    expect(start.qrDataUrl).toBe("data:image/png;base64,encoded:qr-data");

    const waiter = waitForWebLogin({
      timeoutMs: 1000,
      currentQrDataUrl: start.qrDataUrl,
      accountId,
    });
    await flushTasks();

    const now = Date.now();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now + 3 * 60_000 + 1000);
    try {
      const replacement = await startWebLoginWithQr({
        timeoutMs: 5000,
        accountId,
      });
      expect(replacement.qrDataUrl).toBe("data:image/png;base64,encoded:qr-data");

      resolveFirstConnection();

      await expect(waiter).resolves.toEqual({
        connected: false,
        message: "Login ended without a connection.",
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("keeps an active login reusable while a rotated QR image renders", async () => {
    const accountId = "reuse-during-qr-render";
    let onQr: (qr: string) => void = () => {
      throw new Error("Expected QR callback to be registered");
    };
    createWaSocketMock.mockImplementation(
      async (
        _printQr: boolean,
        _verbose: boolean,
        opts?: { authDir?: string; onQr?: (qr: string) => void },
      ) => {
        const sock = { ws: { close: vi.fn() } };
        onQr = (qr) => opts?.onQr?.(qr);
        setImmediate(() => onQr("qr-data"));
        return sock as never;
      },
    );
    waitForWaConnectionMock.mockImplementation(() => new Promise(() => {}));
    renderQrPngDataUrlMock.mockImplementation((qr) =>
      qr === "qr-data-2"
        ? new Promise<string>(() => {})
        : Promise.resolve(`data:image/png;base64,encoded:${qr}`),
    );

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });
    expect(start.qrDataUrl).toBe("data:image/png;base64,encoded:qr-data");

    onQr("qr-data-2");
    await flushTasks();

    const reused = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });

    expect(createWaSocketMock).toHaveBeenCalledTimes(1);
    expect(reused).toEqual({
      qrDataUrl: "data:image/png;base64,encoded:qr-data",
      message: "QR already active. Scan it in WhatsApp → Linked Devices.",
    });
  });

  it("deduplicates initial QR rendering while the start path awaits the same image", async () => {
    const accountId = "single-flight-qr";
    let resolveRender: (value: string) => void = () => {
      throw new Error("Expected QR render promise to be pending");
    };
    renderQrPngDataUrlMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveRender = resolve;
        }),
    );
    waitForWaConnectionMock.mockImplementation(() => new Promise(() => {}));

    const resultPromise = startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });
    await waitForQrRenderCallCount(1);

    expect(renderQrPngDataUrlMock).toHaveBeenCalledTimes(1);

    resolveRender("data:image/png;base64,encoded:qr-data");
    await expect(resultPromise).resolves.toEqual({
      qrDataUrl: "data:image/png;base64,encoded:qr-data",
      message: "Scan this QR in WhatsApp → Linked Devices.",
    });
    expect(renderQrPngDataUrlMock).toHaveBeenCalledTimes(1);
  });

  it("returns the same rotated QR to concurrent waiters that share the same current image", async () => {
    createWaSocketMock.mockImplementationOnce(
      async (
        _printQr: boolean,
        _verbose: boolean,
        opts?: { authDir?: string; onQr?: (qr: string) => void },
      ) => {
        const sock = { ws: { close: vi.fn() } };
        setImmediate(() => opts?.onQr?.("qr-data"));
        setTimeout(() => opts?.onQr?.("qr-data-2"), 100);
        return sock as never;
      },
    );
    waitForWaConnectionMock.mockImplementation(() => new Promise(() => {}));

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId: concurrentAccountId,
    });
    expect(start.qrDataUrl).toBe("data:image/png;base64,encoded:qr-data");

    const waiterA = waitForWebLogin({
      timeoutMs: 5000,
      currentQrDataUrl: start.qrDataUrl,
      accountId: concurrentAccountId,
    });
    const waiterB = waitForWebLogin({
      timeoutMs: 5000,
      currentQrDataUrl: start.qrDataUrl,
      accountId: concurrentAccountId,
    });

    await flushTasks();
    await waitMs(140);
    await flushTasks();

    await expect(waiterA).resolves.toEqual({
      connected: false,
      message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,encoded:qr-data-2",
    });
    await expect(waiterB).resolves.toEqual({
      connected: false,
      message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,encoded:qr-data-2",
    });
  });
});
