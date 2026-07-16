import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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
    const onDone = vi.fn();
    const runner = new ModelSetupWizardRunner({
      getClient: () => client,
      onChange: () => undefined,
      onDone,
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
    });

    await runner.start("openai-oauth");
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
    await answer;
    expect(onDone).toHaveBeenCalledOnce();
    expect(runner.state).toEqual({ phase: "done", authChoice: "openai-oauth" });
  });

  it("cancels the gateway wizard when advancing fails", async () => {
    const request = vi.fn((method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return Promise.resolve({ sessionId: "session-1", done: false, status: "running" });
      }
      if (method === "wizard.next") {
        return Promise.reject(new Error("wizard unavailable"));
      }
      return Promise.resolve({ ok: true });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const runner = new ModelSetupWizardRunner({
      getClient: () => client,
      onChange: () => undefined,
      onDone: () => undefined,
      requestFailedMessage: () => "failed",
      cancelledMessage: () => "cancelled",
    });

    await runner.start("openai-oauth");
    expect(runner.state).toEqual({ phase: "error", message: "wizard unavailable" });
    expect(request).toHaveBeenCalledWith(
      "wizard.cancel",
      { sessionId: expect.any(String) },
      { timeoutMs: 30_000 },
    );
  });
});
