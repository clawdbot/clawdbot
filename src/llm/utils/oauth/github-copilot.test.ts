// GitHub Copilot OAuth tests cover device flow polling and timeout behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshGitHubCopilotToken, testing } from "./github-copilot.js";

function stubHangingFetch(timeoutMs: number): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
    expect(actualTimeoutMs).toBe(timeoutMs);
    const controller = new AbortController();
    queueMicrotask(() => {
      controller.abort(new DOMException("timed out", "TimeoutError"));
    });
    return controller.signal;
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }

          const abort = () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("aborted", "AbortError"),
            );
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
        }),
    ),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GitHub Copilot OAuth model policy", () => {
  it("lists model ids from Copilot instead of the generated OpenClaw catalog", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "claude-sonnet-4.6" },
              { id: "  gpt-5.5  " },
              { id: "embedding-model", capabilities: { type: "embeddings" } },
              { id: "accounts/example/router" },
              { id: "not-a-model", object: "assistant" },
              { id: "" },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(testing.listGitHubCopilotModelIds("copilot-token")).resolves.toEqual([
      "claude-sonnet-4.6",
      "gpt-5.5",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.individual.githubcopilot.com/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer copilot-token",
        }),
      }),
    );
  });

  it("treats model listing failures as optional policy setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );

    await expect(testing.listGitHubCopilotModelIds("copilot-token")).resolves.toEqual([]);
  });

  it("times out device code requests", async () => {
    stubHangingFetch(5);

    await expect(testing.startDeviceFlow("github.com", { timeoutMs: 5 })).rejects.toThrow(
      "GitHub Copilot device code request timed out after 5ms",
    );
  });

  it("caps oversized request timeouts before creating abort signals", async () => {
    stubHangingFetch(MAX_TIMER_TIMEOUT_MS);

    await expect(
      testing.startDeviceFlow("github.com", { timeoutMs: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow(
      `GitHub Copilot device code request timed out after ${MAX_TIMER_TIMEOUT_MS}ms`,
    );
  });

  it("rejects unsafe device code lifetimes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '{"device_code":"device-code","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","interval":0,"expires_in":1e309}',
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    await expect(testing.startDeviceFlow("github.com")).rejects.toThrow(
      "Invalid device code response fields",
    );
  });

  it("times out token refresh requests", async () => {
    stubHangingFetch(5);

    await expect(
      refreshGitHubCopilotToken("refresh-token", undefined, { timeoutMs: 5 }),
    ).rejects.toThrow("GitHub Copilot token refresh request timed out after 5ms");
  });

  it("rejects unsafe Copilot token expiry values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"token":"copilot-token","expires_at":1e309}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(refreshGitHubCopilotToken("refresh-token")).rejects.toThrow(
      "Invalid Copilot token response fields",
    );
  });

  it("treats timed out model listing as optional policy setup", async () => {
    stubHangingFetch(5);

    await expect(
      testing.listGitHubCopilotModelIds("copilot-token", undefined, { timeoutMs: 5 }),
    ).resolves.toEqual([]);
  });

  it("treats timed out model enablement as optional policy setup", async () => {
    stubHangingFetch(5);

    await expect(
      testing.enableGitHubCopilotModel("copilot-token", "claude-sonnet-4.6", undefined, {
        timeoutMs: 5,
      }),
    ).resolves.toBe(false);
  });

  it("cancels model enablement response bodies", async () => {
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, body: { cancel } }) as unknown as Response),
    );

    await expect(
      testing.enableGitHubCopilotModel("copilot-token", "claude-sonnet-4.6"),
    ).resolves.toBe(true);

    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub Copilot OAuth bounded reads", () => {
  it("caps oversized OAuth JSON responses instead of buffering the full body", async () => {
    // 18 MiB body in 1 MiB chunks exceeds the 16 MiB default cap on
    // the shared readProviderJsonResponse reader.
    const CHUNK = 1024 * 1024;
    const CHUNK_COUNT = 18;
    let pulls = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls >= CHUNK_COUNT) {
          controller.close();
          return;
        }
        pulls += 1;
        controller.enqueue(encoder.encode("a".repeat(CHUNK)));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(refreshGitHubCopilotToken("refresh-token")).rejects.toThrow(
      "GitHub Copilot token refresh request: JSON response exceeds 16777216 bytes",
    );
  });

  it("parses normal-size OAuth JSON responses under the byte cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              token: "copilot-token",
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const result = await refreshGitHubCopilotToken("refresh-token");
    expect(result.access).toBe("copilot-token");
    expect(typeof result.expires).toBe("number");
  });

  it("cancels the upstream body when the bounded reader overflows", async () => {
    const cancel = vi.fn(async () => undefined);
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("a".repeat(1024 * 1024)));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(source, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(refreshGitHubCopilotToken("refresh-token")).rejects.toThrow(
      "GitHub Copilot token refresh request",
    );

    expect(cancel).toHaveBeenCalled();
  });
});

describe("GitHub Copilot OAuth error responses", () => {
  const githubToken = `ghr_${"s".repeat(40)}`;

  function createOversizedOAuthErrorResponse(): {
    response: Response;
    cancel: ReturnType<typeof vi.fn>;
  } {
    const cancel = vi.fn();
    const payload =
      JSON.stringify({
        error: "invalid_grant",
        error_description: `refresh_token=${githubToken} was rejected`,
        refresh_token: githubToken,
      }) + " ".repeat(32 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
      },
      cancel,
    });
    return {
      response: new Response(body, {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "copilot-request-id",
        },
      }),
      cancel,
    };
  }

  async function captureError(promise: Promise<unknown>): Promise<Error> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof Error) {
        return error;
      }
      throw error;
    }
    throw new Error("Expected request to fail");
  }

  function expectBoundedRedactedError(error: Error, label: string): void {
    expect(error).toMatchObject({
      name: "ProviderHttpError",
      status: 400,
      code: "invalid_grant",
      requestId: "copilot-request-id",
    });
    expect(error.message).toContain(`${label} (400):`);
    expect(error.message).toContain("[code=invalid_grant]");
    expect(error.message).toContain("[request_id=copilot-request-id]");
    expect(error.message).not.toContain("error_description");
    expect(error.message).not.toContain(githubToken);
    const errorBody = (error as Error & { errorBody?: string }).errorBody;
    expect(errorBody).toBeDefined();
    expect(errorBody).not.toContain(githubToken);
    expect(errorBody?.length).toBeLessThanOrEqual(500);
  }

  it("bounds and redacts device-code HTTP failures", async () => {
    const { response, cancel } = createOversizedOAuthErrorResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const error = await captureError(testing.startDeviceFlow("github.com"));

    expectBoundedRedactedError(error, "GitHub Copilot device code request");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds and redacts device-token HTTP failures", async () => {
    vi.useFakeTimers();
    const { response, cancel } = createOversizedOAuthErrorResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const pending = captureError(
      testing.pollForGitHubAccessToken("github.com", "device-code", 0, Date.now() + 5_000),
    );
    await vi.advanceTimersByTimeAsync(1_200);
    const error = await pending;

    expectBoundedRedactedError(error, "GitHub Copilot device token request");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds and redacts Copilot-token HTTP failures", async () => {
    const { response, cancel } = createOversizedOAuthErrorResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const error = await captureError(refreshGitHubCopilotToken("refresh-token"));

    expectBoundedRedactedError(error, "GitHub Copilot token refresh request");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds model-list HTTP failures before treating discovery as optional", async () => {
    const { response, cancel } = createOversizedOAuthErrorResponse();
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(testing.listGitHubCopilotModelIds("copilot-token")).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
