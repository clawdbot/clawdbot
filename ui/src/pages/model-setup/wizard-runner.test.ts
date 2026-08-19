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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(runner.state).toMatchObject({
      phase: "step",
      authChoice: "llama-cpp",
      step: { type: "progress" },
    });
  });

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
