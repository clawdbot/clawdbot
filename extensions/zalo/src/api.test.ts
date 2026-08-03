// Zalo tests cover api plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolvePinnedHostnameWithPolicyMock } = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicyMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: (...args: unknown[]) =>
    resolvePinnedHostnameWithPolicyMock(...args),
}));

import {
  callZaloApi,
  deleteWebhook,
  getMe,
  getUpdates,
  getWebhookInfo,
  sendChatAction,
  sendMessage,
  sendPhoto,
  type ZaloFetch,
} from "./api.js";
import { ZALO_DEFAULT_REQUEST_TIMEOUT_MS, ZALO_SEND_PHOTO_REQUEST_TIMEOUT_MS } from "./timeouts.js";

const ZALO_JSON_CAP_BYTES = 16 * 1024 * 1024;

function oversizedZaloJsonResponse(onCancel: () => void): Response {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(ZALO_JSON_CAP_BYTES + 1));
      },
      cancel() {
        onCancel();
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
  Object.defineProperty(response, "json", {
    value: async () => {
      throw new Error("unbounded json reader was used");
    },
  });
  return response;
}

function signalAbortedZaloJsonResponse(signal: AbortSignal, onAbort: () => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const abortBody = () => {
          onAbort();
          controller.error(new Error("zalo body aborted"));
        };
        if (signal.aborted) {
          abortBody();
          return;
        }
        signal.addEventListener("abort", abortBody, { once: true });
      },
      async pull() {
        await new Promise<void>(() => {});
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

function createOkFetcher() {
  return vi.fn<ZaloFetch>(async () => new Response(JSON.stringify({ ok: true, result: {} })));
}

function requireFirstFetchCall(fetcher: ReturnType<typeof createOkFetcher>, label: string) {
  const [call] = fetcher.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

async function expectPostJsonRequest(run: (token: string, fetcher: ZaloFetch) => Promise<unknown>) {
  const fetcher = createOkFetcher();
  await run("test-token", fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [, init] = requireFirstFetchCall(fetcher, "Zalo request");
  if (!init) {
    throw new Error("expected Zalo request init");
  }
  expect(init.method).toBe("POST");
  expect(init.headers).toEqual({ "Content-Type": "application/json" });
}

describe("Zalo API request methods", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resolvePinnedHostnameWithPolicyMock.mockReset();
    resolvePinnedHostnameWithPolicyMock.mockResolvedValue({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
      lookup: vi.fn(),
    });
  });

  it("accepts the native Zalo getMe identity fields", async () => {
    const fetcher: ZaloFetch = vi.fn(async () =>
      Response.json({
        ok: true,
        result: {
          account_name: "bot.example",
          account_type: "BASIC",
          can_join_groups: false,
          id: "1459232241454765289",
        },
      }),
    );

    await expect(getMe("test-token", undefined, fetcher)).resolves.toMatchObject({
      result: {
        account_name: "bot.example",
        account_type: "BASIC",
        can_join_groups: false,
      },
    });
  });

  it("uses the production API root by default", async () => {
    const fetcher = createOkFetcher();

    await callZaloApi("getMe", "test-token", undefined, { fetch: fetcher });

    expect(fetcher).toHaveBeenCalledWith(
      "https://bot-api.zaloplatforms.com/bottest-token/getMe",
      expect.any(Object),
    );
  });

  it("uses ZALO_API_URL for provider-compatible alternate endpoints", async () => {
    vi.stubEnv("ZALO_API_URL", " http://127.0.0.1:49152/zalo/ ");
    const fetcher = createOkFetcher();

    await callZaloApi("getMe", "test-token", undefined, { fetch: fetcher });

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/zalo/bottest-token/getMe",
      expect.any(Object),
    );
  });

  it("prefers an explicit API URL over ZALO_API_URL", async () => {
    vi.stubEnv("ZALO_API_URL", "http://127.0.0.1:49152/env");
    const fetcher = createOkFetcher();

    await callZaloApi("getMe", "test-token", undefined, {
      apiUrl: "http://127.0.0.1:49153/explicit/",
      fetch: fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:49153/explicit/bottest-token/getMe",
      expect.any(Object),
    );
  });

  it("rejects an explicitly empty API URL instead of falling back to ZALO_API_URL", async () => {
    vi.stubEnv("ZALO_API_URL", "http://127.0.0.1:49152/env");

    await expect(
      callZaloApi("getMe", "test-token", undefined, {
        apiUrl: "   ",
        fetch: createOkFetcher(),
      }),
    ).rejects.toThrow("ZALO_API_URL must not be empty.");
  });

  it("rejects invalid alternate API URLs", async () => {
    vi.stubEnv("ZALO_API_URL", "file:///tmp/zalo");

    await expect(
      callZaloApi("getMe", "test-token", undefined, { fetch: createOkFetcher() }),
    ).rejects.toThrow("ZALO_API_URL must use http:// or https://.");
  });

  it.each(["https://proxy.example/zalo?tenant=1", "https://proxy.example/zalo#provider"])(
    "rejects an API root with URL suffix components: %s",
    async (apiUrl) => {
      await expect(
        callZaloApi("getMe", "test-token", undefined, {
          apiUrl,
          fetch: createOkFetcher(),
        }),
      ).rejects.toThrow("ZALO_API_URL must not include a query string or fragment.");
    },
  );

  it("uses POST for getWebhookInfo", async () => {
    await expectPostJsonRequest(getWebhookInfo);
  });

  it("keeps POST for deleteWebhook", async () => {
    await expectPostJsonRequest(deleteWebhook);
  });

  it("aborts sendChatAction when the typing timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<ZaloFetch>(
        (_, init) =>
          new Promise<Response>((_Local, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );

      const promise = sendChatAction(
        "test-token",
        {
          chat_id: "chat-123",
          action: "typing",
        },
        fetcher,
        25,
      );
      const rejected = expect(promise).rejects.toThrow("aborted");

      await vi.advanceTimersByTimeAsync(25);

      await rejected;
      const [, init] = requireFirstFetchCall(fetcher, "Zalo chat action request");
      if (!init) {
        throw new Error("expected Zalo chat action request init");
      }
      if (!init.signal) {
        throw new Error("expected Zalo chat action abort signal");
      }
      expect(init.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the default request deadline active while reading a hanging send response body", async () => {
    vi.useFakeTimers();
    try {
      let bodyAborted = false;
      const fetcher = vi.fn<ZaloFetch>(async (_input, init) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("expected Zalo request abort signal");
        }
        return signalAbortedZaloJsonResponse(signal, () => {
          bodyAborted = true;
        });
      });

      const promise = sendMessage(
        "test-token",
        {
          chat_id: "chat-123",
          text: "hello",
        },
        fetcher,
      );
      const rejected = expect(promise).rejects.toThrow("zalo body aborted");

      await vi.advanceTimersByTimeAsync(ZALO_DEFAULT_REQUEST_TIMEOUT_MS);

      await rejected;
      const [, init] = requireFirstFetchCall(fetcher, "Zalo send request");
      if (!init?.signal) {
        throw new Error("expected Zalo send request abort signal");
      }
      expect(init.signal.aborted).toBe(true);
      expect(bodyAborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps oversized sendChatAction timeouts before scheduling the timer", async () => {
    const setTimeoutMock = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutMock = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => undefined);
    try {
      const fetcher = vi.fn<ZaloFetch>(
        async () => new Response(JSON.stringify({ ok: true, result: {} })),
      );

      await sendChatAction(
        "test-token",
        {
          chat_id: "chat-123",
          action: "typing",
        },
        fetcher,
        MAX_TIMER_TIMEOUT_MS + 1_000_000,
      );

      expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutMock.mockRestore();
      clearTimeoutMock.mockRestore();
    }
  });

  it("keeps getUpdates on the long-poll request timeout", async () => {
    const setTimeoutMock = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutMock = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => undefined);
    try {
      const fetcher = createOkFetcher();

      await getUpdates("test-token", { timeout: 45 }, fetcher);

      expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 50_000);
      const [, init] = requireFirstFetchCall(fetcher, "Zalo getUpdates request");
      expect(init?.body).toBe(JSON.stringify({ timeout: "45" }));
    } finally {
      setTimeoutMock.mockRestore();
      clearTimeoutMock.mockRestore();
    }
  });

  it("validates outbound photo URLs against the SSRF guard before posting", async () => {
    const setTimeoutMock = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutMock = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => undefined);
    const fetcher = createOkFetcher();
    try {
      await sendPhoto(
        "test-token",
        {
          chat_id: "chat-123",
          photo: "https://example.com/image.png",
        },
        fetcher,
      );

      expect(resolvePinnedHostnameWithPolicyMock).toHaveBeenCalledWith("example.com", {
        policy: {},
      });
      expect(setTimeoutMock).toHaveBeenCalledWith(
        expect.any(Function),
        ZALO_SEND_PHOTO_REQUEST_TIMEOUT_MS,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [, init] = requireFirstFetchCall(fetcher, "Zalo photo request");
      expect(init?.body).toBe(
        JSON.stringify({
          chat_id: "chat-123",
          photo: "https://example.com/image.png",
        }),
      );
    } finally {
      setTimeoutMock.mockRestore();
      clearTimeoutMock.mockRestore();
    }
  });

  it("keeps URL-only photo sends past the default and bounds the media window", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const fetcher = vi.fn<ZaloFetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal ?? undefined;
            requestSignal?.addEventListener("abort", () => reject(new Error("photo aborted")), {
              once: true,
            });
          }),
      );

      const promise = sendPhoto(
        "test-token",
        {
          chat_id: "chat-123",
          photo: "https://example.com/image.png",
        },
        fetcher,
      );
      await vi.advanceTimersByTimeAsync(ZALO_DEFAULT_REQUEST_TIMEOUT_MS);
      expect(requestSignal?.aborted).toBe(false);

      const rejected = expect(promise).rejects.toThrow("photo aborted");
      await vi.advanceTimersByTimeAsync(
        ZALO_SEND_PHOTO_REQUEST_TIMEOUT_MS - ZALO_DEFAULT_REQUEST_TIMEOUT_MS,
      );
      await rejected;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks private-network photo URLs before they reach the Zalo API", async () => {
    const fetcher = createOkFetcher();
    resolvePinnedHostnameWithPolicyMock.mockRejectedValueOnce(
      new Error("Blocked hostname or private/internal/special-use IP address"),
    );

    await expect(
      sendPhoto(
        "test-token",
        {
          chat_id: "chat-123",
          photo: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        },
        fetcher,
      ),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-http photo URLs", async () => {
    const fetcher = createOkFetcher();

    await expect(
      sendPhoto(
        "test-token",
        {
          chat_id: "chat-123",
          photo: "file:///etc/passwd",
        },
        fetcher,
      ),
    ).rejects.toThrow("Zalo photo URL must use HTTP or HTTPS");

    expect(resolvePinnedHostnameWithPolicyMock).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-URL strings", async () => {
    const fetcher = createOkFetcher();

    await expect(
      sendPhoto(
        "test-token",
        {
          chat_id: "chat-123",
          photo: "not a url",
        },
        fetcher,
      ),
    ).rejects.toThrow("Zalo photo URL must be an absolute HTTP or HTTPS URL");

    expect(resolvePinnedHostnameWithPolicyMock).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds oversized getMe JSON responses and cancels the stream", async () => {
    let cancelCount = 0;
    const fetcher = vi.fn<ZaloFetch>(async () =>
      oversizedZaloJsonResponse(() => {
        cancelCount += 1;
      }),
    );

    await expect(getMe("test-token", undefined, fetcher)).rejects.toThrow(
      "zalo.getMe: JSON response exceeds 16777216 bytes",
    );
    expect(cancelCount).toBe(1);
  });
});
