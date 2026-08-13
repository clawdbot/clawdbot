// Whatsapp tests cover login qr plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveWebListener } from "./active-listener.js";
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
  const createWaSocketLocal = vi.fn();
  const waitForWaConnectionLocal = vi.fn();
  const formatError = vi.fn((err: unknown) => `formatted:${String(err)}`);
  const getStatusCode = vi.fn(
    (err: unknown) =>
      (err as { output?: { statusCode?: number } })?.output?.statusCode ??
      (err as { status?: number })?.status ??
      (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode,
  );
  const readWebAuthExistsForDecisionLocal = vi.fn(async () => ({
    outcome: "stable" as const,
    exists: false,
  }));
  const readWebSelfIdLocal = vi.fn(() => ({ e164: null, jid: null, lid: null }));
  const logoutWebLocal = vi.fn(async () => true);
  return {
    ...actual,
    createWaSocket: createWaSocketLocal,
    waitForWaConnection: waitForWaConnectionLocal,
    formatError,
    getStatusCode,
    readWebAuthExistsForDecision: readWebAuthExistsForDecisionLocal,
    readWebSelfId: readWebSelfIdLocal,
    logoutWeb: logoutWebLocal,
  };
});

vi.mock("./active-listener.js", () => ({
  getActiveWebListener: vi.fn(() => null),
}));

vi.mock("./qr-image.js", () => ({
  renderQrPngDataUrl: vi.fn(async (input: string) => `data:image/png;base64,encoded:${input}`),
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const getActiveWebListenerMock = vi.mocked(getActiveWebListener);
const readWebAuthExistsForDecisionMock = vi.mocked(readWebAuthExistsForDecision);
const readWebSelfIdMock = vi.mocked(readWebSelfId);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const logoutWebMock = vi.mocked(logoutWeb);
const renderQrPngDataUrlMock = vi.mocked(renderQrPngDataUrl);
const scanQrMessage = "Scan this QR in WhatsApp → Linked Devices.";
const refreshedQrMessage = "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.";
const cleanupFailureMessage =
  "WhatsApp login failed: existing auth could not be cleared. Remove or fix the configured WhatsApp auth directory, then retry login.";

function encodedQr(qr: string) {
  return `data:image/png;base64,encoded:${qr}`;
}

function queueQrSocket(qr: string) {
  createWaSocketMock.mockImplementationOnce(
    async (
      _printQr: boolean,
      _verbose: boolean,
      opts?: { authDir?: string; onQr?: (qr: string) => void },
    ) => {
      const sock = { ws: { close: vi.fn() } };
      setImmediate(() => opts?.onQr?.(qr));
      return sock as never;
    },
  );
}

function queueRotatingQrSocket(firstQr: string, secondQr: string, delayMs: number) {
  createWaSocketMock.mockImplementationOnce(
    async (
      _printQr: boolean,
      _verbose: boolean,
      opts?: { authDir?: string; onQr?: (qr: string) => void },
    ) => {
      const sock = { ws: { close: vi.fn() } };
      setImmediate(() => opts?.onQr?.(firstQr));
      setTimeout(() => opts?.onQr?.(secondQr), delayMs);
      return sock as never;
    },
  );
}

function queueSilentSocket() {
  createWaSocketMock.mockImplementationOnce(async () => ({ ws: { close: vi.fn() } }) as never);
}

function expectScanQrResult(result: unknown, qr = "qr-data") {
  expect(result).toEqual({
    qrDataUrl: encodedQr(qr),
    message: scanQrMessage,
  });
}

function expectQrRefreshResult(result: unknown, qr: string) {
  expect(result).toEqual({
    connected: false,
    message: refreshedQrMessage,
    qrDataUrl: encodedQr(qr),
  });
}

function waitForever() {
  return new Promise<never>(() => {});
}

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForNextTask() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function waitMs(ms: number) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
    getActiveWebListenerMock.mockReset().mockReturnValue(null);
    readWebSelfIdMock.mockReset().mockReturnValue({ e164: null, jid: null, lid: null });
    logoutWebMock.mockReset().mockResolvedValue(true);
    renderQrPngDataUrlMock
      .mockReset()
      .mockImplementation(async (input) => `data:image/png;base64,encoded:${input}`);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts login once on status 515 and completes", async () => {
    waitForWaConnectionMock
      // Baileys v7 wraps the error: { error: BoomError(515) }
      .mockRejectedValueOnce({ error: { output: { statusCode: 515 } } })
      .mockResolvedValueOnce(undefined);
    readWebAuthExistsForDecisionMock
      .mockResolvedValueOnce({ outcome: "stable", exists: false })
      .mockResolvedValue({ outcome: "stable", exists: true });

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId: rotatingAccountId,
    });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

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

  it("returns a replacement QR when status 408 happens before the first QR", async () => {
    const accountId = "timeout-before-first-qr";
    queueSilentSocket();
    queueQrSocket("qr-after-timeout");
    waitForWaConnectionMock
      .mockRejectedValueOnce({ output: { statusCode: 408 } })
      .mockImplementation(waitForever);

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });

    expectScanQrResult(start, "qr-after-timeout");
    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
  });

  it("clears auth and returns a replacement QR when WhatsApp is logged out", async () => {
    const accountId = "logged-out-replacement-qr";
    queueQrSocket("qr-data");
    queueQrSocket("qr-after-logout");
    waitForWaConnectionMock
      .mockRejectedValueOnce({
        output: { statusCode: 401 },
      })
      .mockImplementation(waitForever);

    const start = await startWebLoginWithQr({ timeoutMs: 5000, accountId });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

    const result = await waitForWebLogin({
      timeoutMs: 5000,
      currentQrDataUrl: start.qrDataUrl,
      accountId,
    });

    expect(result).toEqual({
      connected: false,
      message: refreshedQrMessage,
      qrDataUrl: encodedQr("qr-after-logout"),
    });
    expect(logoutWebMock).toHaveBeenCalledOnce();
  });

  it("keeps the linked shortcut when existing auth has an active listener", async () => {
    getActiveWebListenerMock.mockReturnValue({} as never);
    readWebSelfIdMock.mockReturnValueOnce({ e164: "+15551234567", jid: null, lid: null });
    readWebAuthExistsForDecisionMock.mockResolvedValueOnce({
      outcome: "stable",
      exists: true,
    });

    await expect(startWebLoginWithQr({ timeoutMs: 5000 })).resolves.toEqual({
      message: "WhatsApp is already linked (+15551234567). Say “relink” if you want a fresh QR.",
    });
    expect(createWaSocketMock).not.toHaveBeenCalled();
    expect(logoutWebMock).not.toHaveBeenCalled();
  });

  it("clears saved auth for an explicit fresh QR relink", async () => {
    const accountId = "force-fresh-qr";
    getActiveWebListenerMock.mockReturnValue({} as never);
    waitForWaConnectionMock.mockImplementation(waitForever);
    readWebAuthExistsForDecisionMock.mockResolvedValueOnce({
      outcome: "stable",
      exists: true,
    });

    const result = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
      force: true,
    });

    expectScanQrResult(result);
    expect(logoutWebMock).toHaveBeenCalledWith({
      authDir: expect.stringContaining(accountId),
      isLegacyAuthDir: false,
      runtime: expect.anything(),
    });
  });

  it("rederives logged-out auth after restart when preserved creds have no active listener", async () => {
    const accountId = "restart-preserved-logged-out";
    queueSilentSocket();
    queueQrSocket("qr-after-restart-logout");
    waitForWaConnectionMock
      .mockRejectedValueOnce({ output: { statusCode: 401 } })
      .mockImplementation(waitForever);
    readWebAuthExistsForDecisionMock.mockResolvedValueOnce({
      outcome: "stable",
      exists: true,
    });

    const result = await startWebLoginWithQr({ timeoutMs: 5000, accountId });

    expectScanQrResult(result, "qr-after-restart-logout");
    expect(logoutWebMock).toHaveBeenCalledWith({
      authDir: expect.stringContaining(accountId),
      isLegacyAuthDir: false,
      runtime: expect.anything(),
    });
    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
  });

  it("does not start a fresh QR when existing auth cleanup is skipped", async () => {
    const accountId = "skipped-cleanup-qr";
    queueSilentSocket();
    waitForWaConnectionMock.mockRejectedValueOnce({
      output: { statusCode: 401 },
    });
    logoutWebMock.mockResolvedValueOnce(false);
    readWebAuthExistsForDecisionMock
      .mockResolvedValueOnce({ outcome: "stable", exists: true })
      .mockResolvedValueOnce({ outcome: "stable", exists: true });

    const result = await startWebLoginWithQr({ timeoutMs: 5000, accountId });

    expect(result).toEqual({ message: cleanupFailureMessage });
    expect(createWaSocketMock).toHaveBeenCalledOnce();
  });

  it("reports skipped cleanup during QR login as an auth cleanup failure", async () => {
    const accountId = "skipped-cleanup-after-qr";
    waitForWaConnectionMock.mockRejectedValueOnce({
      output: { statusCode: 401 },
    });
    readWebAuthExistsForDecisionMock
      .mockResolvedValueOnce({ outcome: "stable", exists: false })
      .mockResolvedValueOnce({ outcome: "stable", exists: true });
    logoutWebMock.mockResolvedValueOnce(false);

    const start = await startWebLoginWithQr({ timeoutMs: 5000, accountId });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

    await expect(
      waitForWebLogin({
        timeoutMs: 5000,
        currentQrDataUrl: start.qrDataUrl,
        accountId,
      }),
    ).resolves.toEqual({
      connected: false,
      message: cleanupFailureMessage,
    });
  });

  it("uses the linked shortcut after successful QR relink starts a listener", async () => {
    const accountId = "qr-success-clears-terminal-state";
    let finishLogin!: () => void;
    waitForWaConnectionMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLogin = resolve;
        }),
    );
    readWebAuthExistsForDecisionMock
      .mockResolvedValueOnce({ outcome: "stable", exists: false })
      .mockResolvedValueOnce({ outcome: "stable", exists: true })
      .mockResolvedValueOnce({ outcome: "stable", exists: true });
    readWebSelfIdMock.mockReturnValue({ e164: "+15551234567", jid: null, lid: null });

    const start = await startWebLoginWithQr({ timeoutMs: 5000, accountId });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

    finishLogin();
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

    logoutWebMock.mockClear();
    getActiveWebListenerMock.mockReturnValue({} as never);
    await expect(startWebLoginWithQr({ timeoutMs: 5000, accountId })).resolves.toEqual({
      message: "WhatsApp is already linked (+15551234567). Say “relink” if you want a fresh QR.",
    });
    expect(logoutWebMock).not.toHaveBeenCalled();
  });

  it("caps oversized wait timeouts to a timer-safe delay", async () => {
    const accountId = "oversized-wait-timeout";
    waitForWaConnectionMock.mockImplementation(waitForever);

    const start = await startWebLoginWithQr({ timeoutMs: 5000, accountId });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

    vi.useFakeTimers();
    const resultPromise = waitForWebLogin({
      timeoutMs: Number.MAX_SAFE_INTEGER,
      currentQrDataUrl: start.qrDataUrl,
      accountId,
    });

    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    await expect(resultPromise).resolves.toEqual({
      connected: false,
      message: "Still waiting for the QR scan. Let me know when you’ve scanned it.",
    });
  });

  it("turns unexpected login cleanup failures into a normal login error", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce({
      output: { statusCode: 401 },
    });
    logoutWebMock.mockRejectedValueOnce(new Error("cleanup failed"));

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

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

  it("does not report linked success when the socket opens before creds persistence stabilizes", async () => {
    const accountId = "socket-open-before-persistence";
    waitForWaConnectionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(undefined), 20);
        }),
    );
    readWebAuthExistsForDecisionMock
      .mockResolvedValueOnce({ outcome: "stable", exists: false })
      .mockResolvedValue({ outcome: "unstable" });

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });
    expect(start.qrDataUrl).toBe("data:image/png;base64,encoded:qr-data");

    const result = await waitForWebLogin({
      timeoutMs: 5000,
      currentQrDataUrl: start.qrDataUrl,
      accountId,
    });

    expect(result.connected).toBe(false);
    expect(result.message).toMatch(/retry/i);
  });

  it("reports a recovered linked session when saved auth has no active listener", async () => {
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
    readWebAuthExistsForDecisionMock.mockResolvedValue({ outcome: "stable", exists: true });

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
    queueRotatingQrSocket("qr-data", "qr-data-2", 100);
    waitForWaConnectionMock.mockImplementation(waitForever);

    const start = await startWebLoginWithQr({ timeoutMs: 5000 });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

    const resultPromise = waitForWebLogin({
      timeoutMs: 5000,
      currentQrDataUrl: start.qrDataUrl,
    });
    await flushTasks();
    await waitMs(140);
    await flushTasks();

    expectQrRefreshResult(await resultPromise, "qr-data-2");
  });

  it("does not short-circuit on an existing QR when the waiter has no current QR image", async () => {
    const accountId = "wait-without-current-qr";
    waitForWaConnectionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(undefined), 20);
        }),
    );
    readWebAuthExistsForDecisionMock
      .mockResolvedValueOnce({ outcome: "stable", exists: false })
      .mockResolvedValue({ outcome: "stable", exists: true });

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

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
    queueRotatingQrSocket("qr-data", "qr-data-2", 20);
    waitForWaConnectionMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    readWebAuthExistsForDecisionMock
      .mockResolvedValueOnce({ outcome: "stable", exists: false })
      .mockResolvedValue({ outcome: "stable", exists: true });

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

    await waitForQrRenderCallCount(2);
    resolveLogin();
    await vi.waitFor(() => expect(readWebAuthExistsForDecisionMock).toHaveBeenCalledTimes(2));
    await waitForNextTask();

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
      .mockImplementation(waitForever);

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

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
      expect(replacement.qrDataUrl).toBe(encodedQr("qr-data"));

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
    waitForWaConnectionMock.mockImplementation(waitForever);
    renderQrPngDataUrlMock.mockImplementation((qr) =>
      qr === "qr-data-2"
        ? new Promise<string>(() => {})
        : Promise.resolve(`data:image/png;base64,encoded:${qr}`),
    );

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

    onQr("qr-data-2");
    await flushTasks();

    const reused = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });

    expect(createWaSocketMock).toHaveBeenCalledTimes(1);
    expect(reused).toEqual({
      qrDataUrl: encodedQr("qr-data"),
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
    waitForWaConnectionMock.mockImplementation(waitForever);

    const resultPromise = startWebLoginWithQr({
      timeoutMs: 5000,
      accountId,
    });
    await waitForQrRenderCallCount(1);

    expect(renderQrPngDataUrlMock).toHaveBeenCalledTimes(1);

    resolveRender(encodedQr("qr-data"));
    expectScanQrResult(await resultPromise);
    expect(renderQrPngDataUrlMock).toHaveBeenCalledTimes(1);
  });

  it("returns the same rotated QR to concurrent waiters that share the same current image", async () => {
    queueRotatingQrSocket("qr-data", "qr-data-2", 100);
    waitForWaConnectionMock.mockImplementation(waitForever);

    const start = await startWebLoginWithQr({
      timeoutMs: 5000,
      accountId: concurrentAccountId,
    });
    expect(start.qrDataUrl).toBe(encodedQr("qr-data"));

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

    expectQrRefreshResult(await waiterA, "qr-data-2");
    expectQrRefreshResult(await waiterB, "qr-data-2");
  });
});
