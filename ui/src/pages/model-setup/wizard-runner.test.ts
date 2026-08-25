import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { ModelSetupWizardRunner } from "./wizard-runner.ts";

describe("ModelSetupWizardRunner", () => {
  it("starts, advances an unbounded note step, and guards duplicate answers", async () => {
    let resolveDone: ((value: unknown) => void) | null = null;
    const request = vi.fn((method: string, _params?: unknown, _options?: unknown) => {
      if (method === "openclaw.setup.auth.start") {
        return Promise.resolve({ sessionId: "session-1", done: false, status: "running" });
      }
      if (method === "wizard.next" && !resolveDone) {
        resolveDone = () => undefined;
        return Promise.resolve({
          done: false,
          status: "running",
          step: { id: "note-1", type: "note", message: "Continue in browser" },
        });
      }
      if (method === "wizard.next") {
        return new Promise((resolve) => {
          resolveDone = resolve;
        });
      }
      return Promise.resolve({});
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const runner = new ModelSetupWizardRunner({
      getClient: () => client,
      getAgentId: () => "research",
      onChange: () => undefined,
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
      sessionExpiredMessage: () => "expired",
    });

    await runner.start("openai-oauth");
    expect(request).toHaveBeenNthCalledWith(
      1,
      "openclaw.setup.auth.start",
      { sessionId: expect.any(String), agentId: "research", authChoice: "openai-oauth" },
      { timeoutMs: null },
    );
    expect(runner.state).toMatchObject({ phase: "step" });
    const answer = runner.answer(undefined, false);
    void runner.answer(undefined, false);
    expect(request).toHaveBeenCalledTimes(3);
    const nextCalls = request.mock.calls.filter(([method]) => method === "wizard.next");
    expect(nextCalls[1]?.[1]).toEqual({
      sessionId: expect.any(String),
      answer: { stepId: "note-1" },
    });
    expect(nextCalls[1]?.[2]).toEqual(
      expect.objectContaining({ timeoutMs: null, signal: expect.any(AbortSignal) }),
    );
    resolveDone!({ done: true, status: "done" });
    await expect(answer).resolves.toEqual({ startMethod: "openclaw.setup.auth.start" });
    expect(runner.state).toEqual({ phase: "done", authChoice: "openai-oauth" });
  });

  it("cancels the gateway wizard when advancing fails", async () => {
    const request = vi.fn((method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return Promise.resolve({ sessionId: "session-1", done: false, status: "running" });
      }
      if (method === "wizard.next") {
        return Promise.reject(new Error("wizard unavailable: OPENAI_API_KEY=sk-1234567890abcdef"));
      }
      return Promise.resolve({ ok: true });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const runner = new ModelSetupWizardRunner({
      getClient: () => client,
      getAgentId: () => null,
      onChange: () => undefined,
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
      sessionExpiredMessage: () => "expired",
    });

    await runner.start("openai-oauth");
    expect(runner.state).toEqual({
      phase: "error",
      message: "wizard unavailable: OPENAI_API_KEY=sk-123...cdef",
    });
    expect(request).toHaveBeenCalledWith(
      "wizard.cancel",
      { sessionId: expect.any(String) },
      { timeoutMs: 30_000 },
    );
  });

  it("uses the prepare start method with the shared wizard transport", async () => {
    const request = vi.fn((method: string) => {
      if (method === "openclaw.setup.prepare.start") {
        return Promise.resolve({ sessionId: "prepare-session", done: false, status: "running" });
      }
      if (method === "wizard.next") {
        return Promise.resolve({
          done: false,
          status: "running",
          step: { id: "pull", type: "progress", message: "Pulling 25%" },
        });
      }
      return Promise.resolve({});
    });
    const runner = new ModelSetupWizardRunner({
      getClient: () => ({ request }) as unknown as GatewayBrowserClient,
      getAgentId: () => null,
      onChange: () => undefined,
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
      sessionExpiredMessage: () => "expired",
    });

    await runner.start("llama-cpp", "openclaw.setup.prepare.start");

    expect(request).toHaveBeenNthCalledWith(
      1,
      "openclaw.setup.prepare.start",
      { sessionId: expect.any(String), authChoice: "llama-cpp" },
      { timeoutMs: null },
    );
    expect(runner.state).toMatchObject({
      phase: "step",
      authChoice: "llama-cpp",
      step: { type: "progress" },
    });
  });

  it.each([
    ["openclaw.setup.auth.start", "cancel"],
    ["openclaw.setup.auth.start", "settled cancel"],
    ["openclaw.setup.auth.start", "close"],
    ["openclaw.setup.prepare.start", "cancel"],
    ["openclaw.setup.prepare.start", "settled cancel"],
    ["openclaw.setup.prepare.start", "close"],
  ] as const)(
    "releases a late %s session after %s so setup can restart",
    async (method, action) => {
      let runningSession: string | null = null;
      let firstSessionId = "";
      let resolveFirstStart: () => void = () => {
        throw new Error("the first setup request did not start");
      };
      let startCount = 0;
      const request = vi.fn(
        async (
          requestMethod: string,
          params?: { sessionId?: string },
          options?: { signal?: AbortSignal },
        ) => {
          if (requestMethod === method) {
            const sessionId = params?.sessionId;
            if (!sessionId) {
              throw new Error("missing setup session");
            }
            if (startCount++ === 0) {
              firstSessionId = sessionId;
              return await new Promise((resolve, reject) => {
                options?.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("Gateway retired the aborted start request")),
                  { once: true },
                );
                resolveFirstStart = () => {
                  runningSession = sessionId;
                  resolve({ sessionId, done: false, status: "running" });
                };
              });
            }
            if (runningSession) {
              throw new Error("wizard already running");
            }
            return { sessionId, done: true, status: "done" };
          }
          if (requestMethod === "wizard.cancel") {
            if (runningSession !== params?.sessionId) {
              throw new Error("wizard not found");
            }
            runningSession = null;
            return { status: "cancelled" };
          }
          throw new Error(`unexpected request ${requestMethod}`);
        },
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const runner = new ModelSetupWizardRunner({
        getClient: () => client,
        getAgentId: () => null,
        onChange: () => undefined,
        requestFailedMessage: () => "failed",
        cancelledMessage: () => "cancelled",
        sessionExpiredMessage: () => "expired",
      });

      const firstStart = runner.start("original", method);
      if (action === "cancel") {
        await runner.cancel();
      } else if (action === "settled cancel") {
        await runner.cancel({ settleActiveRequest: true });
      } else {
        runner.close();
      }
      resolveFirstStart();
      await firstStart;

      expect(runningSession).toBeNull();
      expect(request).toHaveBeenCalledWith(
        "wizard.cancel",
        { sessionId: firstSessionId },
        { timeoutMs: 30_000 },
      );
      await expect(runner.start("replacement", method)).resolves.toEqual({ startMethod: method });
      expect(runner.state).toEqual({ phase: "done", authChoice: "replacement" });
    },
  );

  it.each([
    ["openclaw.setup.auth.start", false],
    ["openclaw.setup.prepare.start", false],
    ["openclaw.setup.auth.start", true],
    ["openclaw.setup.prepare.start", true],
  ] as const)(
    "retains late %s responses after the local deadline (terminal: %s)",
    async (method, terminal) => {
      vi.useFakeTimers();
      try {
        let runningSession: string | null = null;
        let firstSessionId = "";
        let resolveFirstStart: () => void = () => {
          throw new Error("the first setup request did not start");
        };
        let startCount = 0;
        const request = vi.fn(
          async (
            requestMethod: string,
            params?: { sessionId?: string },
            options?: { signal?: AbortSignal; timeoutMs?: number | null },
          ) => {
            if (requestMethod === method) {
              const sessionId = params?.sessionId;
              if (!sessionId) {
                throw new Error("missing setup session");
              }
              if (startCount++ === 0) {
                firstSessionId = sessionId;
                return await new Promise((resolve, reject) => {
                  options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                    once: true,
                  });
                  if (typeof options?.timeoutMs === "number") {
                    setTimeout(
                      () => reject(new Error("Gateway retired the timed-out request")),
                      options.timeoutMs,
                    );
                  }
                  resolveFirstStart = () => {
                    if (!terminal) {
                      runningSession = sessionId;
                    }
                    resolve({ sessionId, done: terminal, status: terminal ? "done" : "running" });
                  };
                });
              }
              if (runningSession) {
                throw new Error("wizard already running");
              }
              return { sessionId, done: true, status: "done" };
            }
            if (requestMethod === "wizard.cancel") {
              if (runningSession !== params?.sessionId) {
                throw new Error("wizard not found");
              }
              runningSession = null;
              return { status: "cancelled" };
            }
            throw new Error(`unexpected request ${requestMethod}`);
          },
        );
        const client = { request } as unknown as GatewayBrowserClient;
        const runner = new ModelSetupWizardRunner({
          getClient: () => client,
          getAgentId: () => null,
          onChange: () => undefined,
          requestFailedMessage: () => "failed",
          cancelledMessage: () => "cancelled",
          sessionExpiredMessage: () => "expired",
        });

        const timedOutStart = runner.start("original", method);
        await vi.advanceTimersByTimeAsync(30_000);
        await timedOutStart;
        expect(runner.state).toEqual({
          phase: "error",
          message: `gateway request timed out after 30000ms: ${method}`,
        });

        resolveFirstStart();
        await vi.runAllTimersAsync();
        expect(runningSession).toBeNull();
        const cancelCalls = request.mock.calls.filter(
          ([requestMethod]) => requestMethod === "wizard.cancel",
        );
        const lateCancelCalls = cancelCalls.filter(
          ([, params]) => params?.sessionId === firstSessionId,
        );
        expect(lateCancelCalls).toHaveLength(terminal ? 1 : 2);

        await runner.cancel();
        await expect(runner.start("replacement", method)).resolves.toEqual({ startMethod: method });
        expect(runner.state).toEqual({ phase: "done", authChoice: "replacement" });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("cleans the original Gateway session without disturbing a replacement connection", async () => {
    let originalSessionId = "";
    let resolveOriginalStart: () => void = () => {
      throw new Error("the original setup request did not start");
    };
    const originalRequest = vi.fn(
      async (
        method: string,
        params?: { sessionId?: string },
        options?: { signal?: AbortSignal },
      ) => {
        if (method === "openclaw.setup.auth.start") {
          originalSessionId = params?.sessionId ?? "";
          return await new Promise((resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
            resolveOriginalStart = () =>
              resolve({ sessionId: originalSessionId, done: false, status: "running" });
          });
        }
        return { status: "cancelled" };
      },
    );
    const replacementRequest = vi.fn(async (method: string, params?: { sessionId?: string }) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: params?.sessionId, done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return {
          done: false,
          status: "running",
          step: { id: "replacement", type: "text", message: "Replacement setup" },
        };
      }
      throw new Error(`unexpected replacement request ${method}`);
    });
    const originalClient = { request: originalRequest } as unknown as GatewayBrowserClient;
    const replacementClient = { request: replacementRequest } as unknown as GatewayBrowserClient;
    let currentClient = originalClient;
    const runner = new ModelSetupWizardRunner({
      getClient: () => currentClient,
      getAgentId: () => null,
      onChange: () => undefined,
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
      sessionExpiredMessage: () => "expired",
    });

    const originalStart = runner.start("original");
    runner.close();
    currentClient = replacementClient;
    await runner.start("replacement");
    resolveOriginalStart();
    await originalStart;

    expect(originalRequest).toHaveBeenCalledWith(
      "wizard.cancel",
      { sessionId: originalSessionId },
      { timeoutMs: 30_000 },
    );
    expect(replacementRequest.mock.calls.some(([method]) => method === "wizard.cancel")).toBe(
      false,
    );
    expect(runner.state).toMatchObject({ phase: "step", authChoice: "replacement" });
  });

  it.each(["openclaw.setup.auth.start", "openclaw.setup.prepare.start"] as const)(
    "does not cancel a terminal %s result after its wizard closes",
    async (method) => {
      let resolveStart: () => void = () => {
        throw new Error("the setup request did not start");
      };
      const request = vi.fn(async (requestMethod: string) => {
        if (requestMethod === method) {
          return await new Promise((resolve) => {
            resolveStart = () => resolve({ done: true, status: "done" });
          });
        }
        throw new Error(`unexpected request ${requestMethod}`);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const runner = new ModelSetupWizardRunner({
        getClient: () => client,
        getAgentId: () => null,
        onChange: () => undefined,
        requestFailedMessage: () => "failed",
        cancelledMessage: () => "cancelled",
        sessionExpiredMessage: () => "expired",
      });

      const start = runner.start("original", method);
      runner.close();
      resolveStart();
      await start;

      expect(request.mock.calls.map(([requestMethod]) => requestMethod)).toEqual([method]);
      expect(runner.state).toEqual({ phase: "idle" });
    },
  );

  it("clears an expired session and abort without cancelling or replaying the answer", async () => {
    let nextCount = 0;
    let answerSignal: AbortSignal | undefined;
    const request = vi.fn(
      (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "openclaw.setup.auth.start") {
          return Promise.resolve({ sessionId: "session-expired", done: false, status: "running" });
        }
        if (method === "wizard.next" && nextCount++ === 0) {
          return Promise.resolve({
            done: false,
            status: "running",
            step: { id: "api-key", type: "text", message: "API key", sensitive: true },
          });
        }
        if (method === "wizard.next") {
          answerSignal = options?.signal;
          return Promise.reject(
            new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "wizard not found",
              details: { code: "WIZARD_NOT_FOUND" },
            }),
          );
        }
        return Promise.resolve({ ok: true });
      },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const runner = new ModelSetupWizardRunner({
      getClient: () => client,
      getAgentId: () => null,
      onChange: () => undefined,
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
      sessionExpiredMessage: () => "Setup expired. Close and restart setup.",
    });

    await runner.start("api-key");
    await runner.answer("secret-key");

    expect(runner.state).toEqual({
      phase: "error",
      message: "Setup expired. Close and restart setup.",
    });
    expect(answerSignal?.aborted).toBe(true);
    await runner.cancel();
    expect(
      request.mock.calls.filter(([method]) => method === "openclaw.setup.auth.start"),
    ).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toEqual([]);
  });

  it("keeps polling gateway-executed progress steps without user input", async () => {
    // Regression: download/pull progress steps carry no controls, so nothing
    // asked for the next one and the sheet froze on the first frame while the
    // gateway kept downloading (observed live: "Preparing…" stuck at 900 MB).
    const messages = ["Preparing model download…", "Downloading… 7%", "Downloading… 16%"];
    let nextIndex = 0;
    const request = vi.fn((method: string) => {
      if (method === "openclaw.setup.prepare.start") {
        return Promise.resolve({ sessionId: "session-progress", done: false, status: "running" });
      }
      if (method === "wizard.next") {
        const message = messages[nextIndex];
        nextIndex += 1;
        if (message === undefined) {
          return Promise.resolve({
            done: true,
            status: "done",
            preparedModelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
          });
        }
        return Promise.resolve({
          done: false,
          status: "running",
          step: { id: `progress-${nextIndex}`, type: "progress", message, executor: "gateway" },
        });
      }
      return Promise.resolve({});
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const seen: string[] = [];
    const runner = new ModelSetupWizardRunner({
      getClient: () => client,
      getAgentId: () => null,
      onChange: (state) => {
        if (state.phase === "step" && state.step.type === "progress") {
          seen.push(state.step.message ?? "");
        }
      },
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
      sessionExpiredMessage: () => "expired",
    });

    await expect(runner.start("llama-cpp", "openclaw.setup.prepare.start")).resolves.toEqual({
      startMethod: "openclaw.setup.prepare.start",
      preparedModelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
    });

    expect(seen).toEqual(messages);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.setup.prepare.start",
      "wizard.next",
      "wizard.next",
      "wizard.next",
      "wizard.next",
    ]);
  });

  it("retires QR data while gateway progress remains pending", async () => {
    vi.useFakeTimers();
    try {
      let nextCount = 0;
      const request = vi.fn(
        (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
          if (method === "openclaw.setup.auth.start") {
            return Promise.resolve({ sessionId: "session-qr", done: false, status: "running" });
          }
          if (method === "wizard.next" && nextCount++ === 0) {
            return Promise.resolve({
              done: false,
              status: "running",
              step: {
                id: "qr-expiry",
                type: "qr",
                executor: "gateway",
                qrDataUrl: "data:image/png;base64,aGVsbG8=",
                expiresInMs: 50,
              },
            });
          }
          if (method === "wizard.next") {
            return new Promise((_, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            });
          }
          return Promise.resolve({ status: "cancelled" });
        },
      );
      const runner = new ModelSetupWizardRunner({
        getClient: () => ({ request }) as unknown as GatewayBrowserClient,
        getAgentId: () => null,
        onChange: () => undefined,
        requestFailedMessage: () => "failed",
        cancelledMessage: () => "cancelled",
        sessionExpiredMessage: () => "expired",
      });

      const start = runner.start("signal-link");
      await vi.advanceTimersByTimeAsync(50);

      expect(runner.state).toMatchObject({
        phase: "step",
        step: { id: "qr-expiry", qrDataUrl: "", expiresInMs: 0 },
      });
      await runner.cancel();
      await expect(start).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
