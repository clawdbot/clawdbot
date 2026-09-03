import { HTTPFetchError } from "@line/bot-sdk";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  lineFetchMock,
  requireRuntimeConfigMock,
  resolveLineAccountMock,
  resolveLineChannelAccessTokenMock,
  recordChannelActivityMock,
} = vi.hoisted(() => ({
  lineFetchMock: vi.fn<typeof fetch>(),
  requireRuntimeConfigMock: vi.fn((cfg: unknown) => cfg ?? {}),
  resolveLineAccountMock: vi.fn(() => ({ accountId: "default" })),
  resolveLineChannelAccessTokenMock: vi.fn(() => "line-token"),
  recordChannelActivityMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: requireRuntimeConfigMock,
}));
vi.mock("./accounts.js", () => ({ resolveLineAccount: resolveLineAccountMock }));
vi.mock("./channel-access-token.js", () => ({
  resolveLineChannelAccessToken: resolveLineChannelAccessTokenMock,
}));
vi.mock("openclaw/plugin-sdk/channel-activity-runtime", () => ({
  recordChannelActivity: recordChannelActivityMock,
}));

let sendModule: typeof import("./send.js");
const LINE_TEST_CFG = { channels: { line: { accounts: { default: {} } } } };

function createTrackedResponse(body: string, init: ResponseInit) {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
    },
    cancel() {
      canceled = true;
    },
  });
  return { response: new Response(stream, init), wasCanceled: () => canceled };
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected LINE send to fail");
}

describe("LINE bounded provider responses", () => {
  beforeAll(async () => {
    sendModule = await import("./send.js");
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/plugin-config-runtime");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./channel-access-token.js");
    vi.doUnmock("openclaw/plugin-sdk/channel-activity-runtime");
    vi.resetModules();
  });

  beforeEach(() => {
    lineFetchMock.mockReset();
    requireRuntimeConfigMock.mockClear().mockImplementation((cfg: unknown) => cfg ?? LINE_TEST_CFG);
    resolveLineAccountMock.mockReset().mockReturnValue({ accountId: "default" });
    resolveLineChannelAccessTokenMock.mockReset().mockReturnValue("line-token");
    recordChannelActivityMock.mockReset();
    vi.stubGlobal("fetch", lineFetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves partial delivery when an accepted LINE response is oversized", async () => {
    const tracked = createTrackedResponse("x".repeat(16 * 1024 + 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    lineFetchMock.mockResolvedValueOnce(tracked.response);

    const caught = await captureError(() =>
      sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG }),
    );

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected an accepted LINE delivery without a readable receipt");
    }
    expect(caught.deliveryResult).toEqual({ messageIds: [], visibleReplySent: true });
    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("bounds an accepted retry-key conflict without reclassifying it as rejected", async () => {
    const tracked = createTrackedResponse("x".repeat(16 * 1024 + 1), {
      status: 409,
      statusText: "Conflict",
      headers: { "content-type": "application/json" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    lineFetchMock.mockResolvedValueOnce(tracked.response);

    const caught = await captureError(() =>
      sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG }),
    );

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    expect(caught).not.toBeInstanceOf(HTTPFetchError);
    expect(lineFetchMock).toHaveBeenCalledOnce();
    const requestInit = lineFetchMock.mock.calls[0]?.[1];
    expect(new Headers(requestInit?.headers).get("X-Line-Retry-Key")).toBeTruthy();
    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("bounds oversized rejected LINE response bodies", async () => {
    const tracked = createTrackedResponse(`${"line upstream unavailable ".repeat(1024)}tail`, {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    lineFetchMock.mockResolvedValueOnce(tracked.response);

    const caught = await captureError(() =>
      sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG }),
    );

    expect(caught).toBeInstanceOf(HTTPFetchError);
    expect(isChannelPartialDeliveryError(caught)).toBe(false);
    expect(caught).toMatchObject({ status: 400, statusText: "Bad Request" });
    expect((caught as HTTPFetchError).body).toContain("line upstream unavailable");
    expect((caught as HTTPFetchError).body).not.toContain("tail");
    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("preserves reply rejection status when the LINE error body cannot be read", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("provider response body failed"));
        },
      }),
      { status: 503, statusText: "Service Unavailable", headers: { "content-type": "text/plain" } },
    );
    const textSpy = vi.spyOn(response, "text").mockRejectedValue(new Error("unbounded"));
    lineFetchMock.mockResolvedValueOnce(response);

    const caught = await captureError(() =>
      sendModule.sendMessageLine("U123", "Hello", {
        cfg: LINE_TEST_CFG,
        replyToken: "reply-token",
      }),
    );

    expect(caught).toBeInstanceOf(HTTPFetchError);
    expect(isChannelPartialDeliveryError(caught)).toBe(false);
    expect(caught).toMatchObject({
      status: 503,
      statusText: "Service Unavailable",
      body: "",
    });
    expect(lineFetchMock).toHaveBeenCalledOnce();
    expect(textSpy).not.toHaveBeenCalled();
  });
});
