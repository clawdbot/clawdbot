import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardNextResult } from "../../api/types.ts";
import { ModelSetupWizardRunner } from "./wizard-runner.ts";

describe("ModelSetupWizardRunner", () => {
  it.each(["cancelled", "failed"] as const)(
    "shares an in-flight explicit cancellation with teardown when it is %s",
    async (outcome) => {
      const pending = createDeferred<unknown>();
      const request = vi.fn(async (method: string) => {
        if (method === "openclaw.setup.auth.start") {
          return { done: false, status: "running" };
        }
        if (method === "wizard.cancel") {
          return await pending.promise;
        }
        return { done: false, status: "running", step: { id: "key", type: "text" } };
      });
      const terminal = vi.fn();
      const runner = new ModelSetupWizardRunner({
        getClient: () => ({ request }) as unknown as GatewayBrowserClient,
        getAgentId: () => "main",
        onChange: () => undefined,
        onStart: () => terminal,
        requestFailedMessage: () => "failed",
        cancelledMessage: () => "cancelled",
        sessionExpiredMessage: () => "expired",
      });
      await runner.start("provider-auth");
      const explicit = runner.requestCancellation();
      const teardown = runner.cancel();
      const callsBeforeAcknowledgment = request.mock.calls.filter(
        ([method]) => method === "wizard.cancel",
      );
      if (outcome === "failed") {
        pending.reject(new Error("Cancellation transport disconnected"));
      } else {
        pending.resolve({ status: "cancelled" });
      }
      await expect(Promise.all([explicit, teardown])).resolves.toEqual([undefined, undefined]);
      expect(callsBeforeAcknowledgment).toHaveLength(1);
      expect(runner.state).toEqual({ phase: "idle" });
      expect(terminal).toHaveBeenCalledTimes(outcome === "cancelled" ? 1 : 0);
    },
  );

  it("cancels independently after transport rebind and retries settled cancellation attempts", async () => {
    const oldCancellation = createDeferred<unknown>();
    const originalRequest = vi.fn(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { done: false, status: "running" };
      }
      if (method === "wizard.cancel") {
        return await oldCancellation.promise;
      }
      return { done: false, status: "running", step: { id: "key", type: "text" } };
    });
    let cancellations = 0;
    const replacementRequest = vi.fn(async (method: string) => {
      if (method === "wizard.next") {
        return { done: false, status: "running", step: { id: "key", type: "text" } };
      }
      if (method === "wizard.cancel") {
        cancellations += 1;
        if (cancellations === 1) {
          return { status: "running" };
        }
        if (cancellations === 2) {
          throw new Error("Cancellation transport disconnected");
        }
        return { status: "cancelled" };
      }
      throw new Error(`Unexpected wizard request: ${method}`);
    });
    let client = { request: originalRequest } as unknown as GatewayBrowserClient;
    const terminal = vi.fn();
    const runner = new ModelSetupWizardRunner({
      getClient: () => client,
      getAgentId: () => "main",
      onChange: () => undefined,
      onStart: () => terminal,
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
      sessionExpiredMessage: () => "expired",
    });
    await runner.start("provider-auth");
    const pending = runner.requestCancellation();
    runner.suspend();
    client = { request: replacementRequest } as unknown as GatewayBrowserClient;
    await runner.resume();
    await expect(runner.requestCancellation()).resolves.toBe("running");
    await expect(runner.requestCancellation()).rejects.toThrow(
      "Cancellation transport disconnected",
    );
    expect(runner.state).toMatchObject({ phase: "step", authChoice: "provider-auth" });
    await expect(runner.requestCancellation()).resolves.toBe("cancelled");
    expect(cancellations).toBe(3);
    expect(terminal).toHaveBeenCalledExactlyOnceWith({ done: true, status: "cancelled" });
    oldCancellation.resolve({ status: "cancelled" });
    await expect(pending).resolves.toBeUndefined();
    expect(terminal).toHaveBeenCalledOnce();
    expect(runner.state).toEqual({ phase: "idle" });
    expect(
      originalRequest.mock.calls.filter(([method]) => method === "wizard.cancel"),
    ).toHaveLength(1);
    expect(replacementRequest.mock.calls.map(([method]) => method)).toEqual([
      "wizard.next",
      "wizard.cancel",
      "wizard.cancel",
      "wizard.cancel",
    ]);
  });

  it("ignores a retired owner's cancellation failure and keeps teardown best effort", async () => {
    const failedCancel = createDeferred<unknown>();
    let cancellations = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { done: false, status: "running" };
      }
      if (method === "wizard.cancel") {
        if (++cancellations === 1) {
          return await failedCancel.promise;
        }
        throw new Error("Cleanup transport failed");
      }
      return { done: false, status: "running", step: { id: "key", type: "text" } };
    });
    const terminal = vi.fn();
    const runner = new ModelSetupWizardRunner({
      getClient: () => ({ request }) as unknown as GatewayBrowserClient,
      getAgentId: () => "main",
      onChange: () => undefined,
      onStart: () => terminal,
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
      sessionExpiredMessage: () => "expired",
    });
    await runner.start("original");
    const cancellation = runner.requestCancellation();
    runner.close({ retireOwner: true });
    await runner.start("replacement");
    failedCancel.reject(new Error("Original transport failed"));
    await expect(cancellation).resolves.toBeUndefined();
    expect(runner.state).toMatchObject({ phase: "step", authChoice: "replacement" });
    expect(terminal).not.toHaveBeenCalled();
    await expect(runner.cancel()).resolves.toBeUndefined();
    expect(runner.state).toEqual({ phase: "idle" });
    expect(cancellations).toBe(2);
  });

  it.each(["late admission", "late terminal", "late cancellation"] as const)(
    "retires detached %s authority before a client can represent another owner",
    async (caseName) => {
      const lateReply = createDeferred<WizardNextResult>();
      const request = vi.fn(async (method: string) => {
        if (method === "openclaw.setup.auth.start") {
          return caseName === "late admission"
            ? await lateReply.promise
            : { done: false, status: "running" };
        }
        if (method === "wizard.next") {
          return caseName === "late terminal"
            ? await lateReply.promise
            : { done: false, status: "running", step: { id: "key", type: "text" } };
        }
        if (method === "wizard.cancel") {
          return await lateReply.promise;
        }
        throw new Error(`Unexpected wizard request: ${method}`);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const onTerminal = vi.fn();
      const runner = new ModelSetupWizardRunner({
        getClient: () => client,
        getAgentId: () => "main",
        onChange: () => undefined,
        onStart: () => onTerminal,
        requestFailedMessage: () => "failed",
        cancelledMessage: () => "cancelled",
        sessionExpiredMessage: () => "expired",
      });
      let pending: Promise<unknown> = runner.start("original-provider");
      if (caseName === "late terminal") {
        await vi.waitFor(() =>
          expect(request.mock.calls.some(([method]) => method === "wizard.next")).toBe(true),
        );
      }
      if (caseName === "late cancellation") {
        await pending;
        pending = runner.cancel();
        await vi.waitFor(() =>
          expect(request.mock.calls.some(([method]) => method === "wizard.cancel")).toBe(true),
        );
      }
      runner.close({ retireOwner: true });
      const requestsAtRetirement = request.mock.calls.length;
      lateReply.resolve(
        caseName === "late admission"
          ? { done: false, status: "running" }
          : { done: true, status: "cancelled" },
      );
      await pending;
      expect(request).toHaveBeenCalledTimes(requestsAtRetirement);
      expect(onTerminal).not.toHaveBeenCalled();
      expect(runner.state).toEqual({ phase: "idle" });
    },
  );

  it.each(["cancelled", "error", "done"])(
    "binds cancellation to the original client and fences late %s after repeated resets",
    async (terminal) => {
      const cancellation = createDeferred<unknown>();
      const lateNext = createDeferred<unknown>();
      let firstNext = true;
      const originalRequest = vi.fn(async (method: string) => {
        if (method === "openclaw.setup.auth.start") {
          return { done: false, status: "running" };
        }
        if (method === "wizard.cancel") {
          return await cancellation.promise;
        }
        if (firstNext) {
          firstNext = false;
          return { done: false, status: "running", step: { id: "login", type: "text" } };
        }
        return await lateNext.promise;
      });
      const replacementRequest = vi.fn(async (method: string) => {
        if (method === "openclaw.setup.auth.start") {
          return { done: false, status: "running" };
        }
        return { done: false, status: "running", step: { id: "replacement", type: "text" } };
      });
      let client = { request: originalRequest } as unknown as GatewayBrowserClient;
      const originalTerminal = vi.fn();
      const replacementTerminal = vi.fn();
      const runner = new ModelSetupWizardRunner({
        getClient: () => client,
        getAgentId: () => null,
        onChange: () => undefined,
        onStart: vi.fn().mockReturnValueOnce(originalTerminal).mockReturnValue(replacementTerminal),
        requestFailedMessage: () => "failed",
        cancelledMessage: () => "cancelled",
        sessionExpiredMessage: () => "expired",
      });
      await runner.start("original");
      const next = runner.answer("answer");
      client = { request: replacementRequest } as unknown as GatewayBrowserClient;
      const cancelled = runner.cancel({ settleActiveRequest: true });
      await runner.cancel();
      runner.close();
      await runner.start("replacement");
      expect(
        originalRequest.mock.calls.filter(([method]) => method === "wizard.cancel"),
      ).toHaveLength(1);
      expect(
        replacementRequest.mock.calls.filter(([method]) => method === "wizard.cancel"),
      ).toHaveLength(0);
      cancellation.resolve({ status: "running" });
      await cancelled;
      expect(originalTerminal).not.toHaveBeenCalled();
      lateNext.resolve({
        done: true,
        status: terminal,
        modelActivation: { modelRef: "provider/original" },
      });
      await expect(next).resolves.toBeNull();
      if (terminal !== "done") {
        expect(originalTerminal).toHaveBeenCalledOnce();
        expect(originalTerminal).toHaveBeenCalledWith(
          expect.objectContaining({ status: terminal }),
        );
      } else {
        expect(originalTerminal).not.toHaveBeenCalled();
      }
      expect(replacementTerminal).not.toHaveBeenCalled();
      expect(runner.state).toMatchObject({
        phase: "step",
        authChoice: "replacement",
        step: { id: "replacement" },
      });
    },
  );

  it("reconciles an interrupted answer without replaying it or cancelling the resumed wizard", async () => {
    const interrupted = createDeferred<unknown>();
    let nextCalls = 0;
    const originalRequest = vi.fn(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { done: false, status: "running" };
      }
      nextCalls += 1;
      if (nextCalls === 1) {
        return { done: false, status: "running", step: { id: "key", type: "text" } };
      }
      return interrupted.promise;
    });
    const replacementRequest = vi.fn(
      async (_method: string, _params?: unknown, _options?: unknown) => ({
        done: false,
        status: "running",
        step: { id: "model-review", type: "note" },
      }),
    );
    let client = { request: originalRequest } as unknown as GatewayBrowserClient;
    const terminal = vi.fn();
    const runner = new ModelSetupWizardRunner({
      getClient: () => client,
      getAgentId: () => "research",
      onChange: () => undefined,
      onStart: () => terminal,
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
      sessionExpiredMessage: () => "expired",
    });
    await runner.start("meta-api-key");
    const answer = runner.answer("synthetic-key");
    runner.suspend();
    client = { request: replacementRequest } as unknown as GatewayBrowserClient;
    await runner.resume();
    expect(replacementRequest).toHaveBeenCalledExactlyOnceWith(
      "wizard.next",
      { sessionId: expect.any(String) },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    interrupted.resolve({ done: true, status: "cancelled" });
    await answer;
    expect(terminal).not.toHaveBeenCalled();
    expect(runner.state).toMatchObject({
      phase: "step",
      authChoice: "meta-api-key",
      step: { id: "model-review" },
    });
    expect(
      originalRequest.mock.calls.filter(([method]) => method === "wizard.cancel"),
    ).toHaveLength(0);
  });

  it("uses a terminal reply received while disconnected without repeating a Gateway request", async () => {
    const terminalReply = createDeferred<unknown>();
    let nextCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { done: false, status: "running" };
      }
      if (++nextCalls === 1) {
        return { done: false, status: "running", step: { id: "key", type: "text" } };
      }
      return terminalReply.promise;
    });
    const afterReconnect = vi.fn();
    let client = { request } as unknown as GatewayBrowserClient;
    const onTerminal = vi.fn();
    const runner = new ModelSetupWizardRunner({
      getClient: () => client,
      getAgentId: () => "research",
      onChange: () => undefined,
      onStart: () => onTerminal,
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
      sessionExpiredMessage: () => "expired",
    });
    await runner.start("meta-api-key");
    const answer = runner.answer("synthetic-key");
    runner.suspend();
    terminalReply.resolve({
      done: true,
      status: "done",
      modelActivation: { modelRef: "meta/fixture-model" },
    });
    await answer;
    expect(onTerminal).not.toHaveBeenCalled();
    client = { request: afterReconnect } as unknown as GatewayBrowserClient;
    expect(await runner.resume()).toMatchObject({
      modelActivation: { modelRef: "meta/fixture-model" },
    });
    expect(afterReconnect).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledOnce();
  });

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
      const terminalResult = vi.fn();
      const runner = new ModelSetupWizardRunner({
        getClient: () => client,
        getAgentId: () => null,
        onChange: () => undefined,
        onStart: () => terminalResult,
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
      expect(terminalResult).toHaveBeenCalledWith({ done: true, status: "cancelled" });
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
    ["openclaw.setup.auth.start", "running"],
    ["openclaw.setup.prepare.start", "running"],
    ["openclaw.setup.auth.start", "done"],
    ["openclaw.setup.prepare.start", "done"],
    ["openclaw.setup.auth.start", "error"],
    ["openclaw.setup.prepare.start", "error"],
    ["openclaw.setup.auth.start", "cancelled"],
    ["openclaw.setup.prepare.start", "cancelled"],
    ["openclaw.setup.auth.start", "busy"],
    ["openclaw.setup.prepare.start", "busy"],
  ] as const)(
    "retains late %s responses after the local deadline (status: %s)",
    async (method, status) => {
      const terminal = status !== "running";
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
                    if (status === "busy") {
                      reject(
                        new GatewayRequestError({
                          code: "UNAVAILABLE",
                          message: "Setup busy",
                          details: { code: "SETUP_ADMISSION_BUSY" },
                        }),
                      );
                      return;
                    }
                    if (!terminal) {
                      runningSession = sessionId;
                    }
                    resolve({ sessionId, done: terminal, status });
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
        const terminalResult = vi.fn();
        const runner = new ModelSetupWizardRunner({
          getClient: () => client,
          getAgentId: () => null,
          onChange: () => undefined,
          onStart: () => terminalResult,
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
        expect(terminalResult).toHaveBeenCalledTimes(status === "done" ? 0 : 1);
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

  it.each(
    (["openclaw.setup.auth.start", "openclaw.setup.prepare.start"] as const).flatMap((method) =>
      ["done", "busy"].flatMap((status) =>
        ["open", "closed"].map((lifecycle) => ({ method, status, lifecycle })),
      ),
    ),
  )(
    "does not cancel a terminal $method $status result ($lifecycle presentation)",
    async ({ method, status, lifecycle }) => {
      let resolveStart: () => void = () => {
        throw new Error("the setup request did not start");
      };
      const request = vi.fn(async (requestMethod: string) => {
        if (requestMethod === method) {
          return await new Promise((resolve, reject) => {
            resolveStart = () => {
              if (status === "busy") {
                reject(
                  new GatewayRequestError({
                    code: "UNAVAILABLE",
                    message: "Setup busy",
                    details: { code: "SETUP_ADMISSION_BUSY" },
                  }),
                );
              } else {
                resolve({
                  done: true,
                  status: "done",
                  modelActivation: { modelRef: "provider/late" },
                });
              }
            };
          });
        }
        throw new Error(`unexpected request ${requestMethod}`);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const terminalResult = vi.fn();
      const runner = new ModelSetupWizardRunner({
        getClient: () => client,
        getAgentId: () => null,
        onChange: () => undefined,
        onStart: () => terminalResult,
        requestFailedMessage: () => "failed",
        cancelledMessage: () => "cancelled",
        sessionExpiredMessage: () => "expired",
      });

      const start = runner.start("original", method);
      if (lifecycle === "closed") {
        runner.close();
      }
      resolveStart();
      await start;
      await runner.cancel();

      expect(request.mock.calls.map(([requestMethod]) => requestMethod)).toEqual([method]);
      expect(runner.state).toEqual({ phase: "idle" });
      if (status === "busy") {
        expect(terminalResult).toHaveBeenCalledExactlyOnceWith({
          done: true,
          status: "not-admitted",
          error: "Setup busy",
        });
      } else if (lifecycle === "open") {
        expect(terminalResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ done: true, status: "done" }),
        );
      } else {
        expect(terminalResult).not.toHaveBeenCalled();
      }
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
});
