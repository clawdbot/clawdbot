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
});
