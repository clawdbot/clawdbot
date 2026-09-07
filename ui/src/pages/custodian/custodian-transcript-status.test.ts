/* @vitest-environment jsdom */

import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import * as uuid from "../../lib/uuid.ts";
import { QUICK_ACTIONS_QUESTION } from "../../test-helpers/custodian-quick-actions.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("custodian transcript status", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "continues to the welcome and automatically recovers history (lifecycle failure: %s)",
    async (lifecycleFailure) => {
      let historyCalls = 0;
      const request = vi.fn(
        async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
          if (method === "openclaw.chat.history") {
            expect(options).toEqual({ timeoutMs: 15_000 });
            historyCalls += 1;
            if (historyCalls === 1) {
              throw lifecycleFailure
                ? new GatewayRequestError({
                    code: "UNAVAILABLE",
                    message: "Gateway is suspending",
                    retryable: true,
                    details: { reason: "gateway-suspending", phase: "draining" },
                  })
                : new Error("history request timed out");
            }
            return { turns: [{ role: "assistant", text: "Recovered history.", at: 1 }] };
          }
          return {
            sessionId: "engine-session-after-history-timeout",
            reply: "Welcome without history.",
            action: "none",
            question: QUICK_ACTIONS_QUESTION,
          };
        },
      );
      const { context, setGatewaySnapshot } = createContext(request, [
        "openclaw.chat",
        "openclaw.chat.history",
      ]);
      const { page } = await mountPage(context);

      await waitForFast(() => expect(page.textContent).toContain("Welcome without history."));
      const historyAlert = Array.from(page.querySelectorAll<HTMLElement>('[role="alert"]')).find(
        (alert) => alert.textContent?.includes("history request timed out"),
      );
      if (lifecycleFailure) {
        expect(page.querySelector(".custodian__transcript-status")).toBeNull();
      } else {
        expect(historyAlert).toBeDefined();
        expect(historyAlert?.querySelector("button")).toBeNull();
      }
      setGatewaySnapshot({ suspensionPhase: "draining" });
      setGatewaySnapshot({ suspensionPhase: "accepting" });
      setGatewaySnapshot({ suspensionPhase: "accepting" });
      await waitForFast(() => expect(page.textContent).toContain("Recovered history."));
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "openclaw.chat.history",
        "openclaw.chat",
        "openclaw.chat.history",
      ]);
    },
  );

  it("waits for a pending history failure before recovering after admission reopens", async () => {
    const pending = deferred<never>();
    let historyCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.chat.history") {
        historyCalls += 1;
        return historyCalls === 2
          ? pending.promise
          : {
              turns: [
                {
                  role: "assistant",
                  text: historyCalls === 1 ? "Earlier history" : "Recovered history",
                  at: 1,
                },
              ],
            };
      }
      return { sessionId: "custodian-session", reply: "Ready", action: "none" };
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Ready"));
    const refresh = page.store.refreshTranscriptIfIdle();
    setGatewaySnapshot({ suspensionPhase: "draining" });
    setGatewaySnapshot({ suspensionPhase: "accepting" });
    setGatewaySnapshot({ suspensionPhase: "draining" });
    setGatewaySnapshot({ suspensionPhase: "accepting" });
    expect(historyCalls).toBe(2);
    pending.reject(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Gateway was suspending",
        retryable: true,
        details: { reason: "gateway-suspending", phase: "draining" },
      }),
    );
    await refresh;
    await waitForFast(() => expect(page.textContent).toContain("Recovered history"));
    expect(page.querySelector(".custodian__transcript-status")).toBeNull();
    expect(historyCalls).toBe(3);
  });

  it("does not retry failed reconnect hydration again on the same availability edge", async () => {
    let historyCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.chat.history") {
        historyCalls += 1;
        if (historyCalls === 2) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Gateway is suspending",
            retryable: true,
            details: { reason: "gateway-suspending", phase: "draining" },
          });
        }
        return { turns: [{ role: "assistant", text: "Recovered reconnect history", at: 1 }] };
      }
      return { sessionId: "custodian-session", reply: "Ready", action: "none" };
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Ready"));
    setGatewaySnapshot({ phase: "stopped" });
    setGatewaySnapshot({ phase: "connected" });
    await waitForFast(() => {
      expect(page.store.transcript.refreshing).toBe(false);
      expect(page.store.transcript.status.awaitingGateway).toBe(true);
    });
    expect(historyCalls).toBe(2);
    setGatewaySnapshot({ suspensionPhase: "draining" });
    setGatewaySnapshot({ suspensionPhase: "accepting" });
    await waitForFast(() => expect(page.store.transcript.status.awaitingGateway).toBe(false));
    expect(historyCalls).toBe(3);
    expect(page.textContent).toContain("Recovered reconnect history");
  });

  it("recovers parked history once after an in-flight send settles", async () => {
    const reply = deferred<SystemAgentChatResult>();
    let historyCalls = 0;
    const request = vi.fn(async (method: string, params?: { message?: string }) => {
      if (method === "openclaw.chat.history") {
        historyCalls += 1;
        if (historyCalls === 1) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Gateway is suspending",
            retryable: true,
            details: { reason: "gateway-suspending", phase: "draining" },
          });
        }
        return { turns: [{ role: "assistant", text: "Recovered after send", at: 1 }] };
      }
      return params?.message
        ? reply.promise
        : { sessionId: "custodian-session", reply: "Ready", action: "none" };
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.store.canSend).toBe(true));
    expect(page.store.transcript.status.awaitingGateway).toBe(true);

    const send = page.store.send("Continue");
    setGatewaySnapshot({ suspensionPhase: "draining" });
    setGatewaySnapshot({ suspensionPhase: "accepting" });
    setGatewaySnapshot({ suspensionPhase: "draining" });
    setGatewaySnapshot({ suspensionPhase: "accepting" });
    await page.updateComplete;
    expect(page.store.sending).toBe(true);
    expect(historyCalls).toBe(1);
    expect(page.querySelector(".custodian__transcript-status")).toBeNull();
    expect(page.querySelector(".custodian__transcript-status button")).toBeNull();

    reply.resolve({ sessionId: "custodian-session", reply: "Done", action: "none" });
    await send;
    await waitForFast(() => expect(page.textContent).toContain("Recovered after send"));
    setGatewaySnapshot({ suspensionPhase: "accepting" });
    await page.updateComplete;
    expect(historyCalls).toBe(2);
    expect(page.querySelector(".custodian__transcript-status")).toBeNull();
    expect(page.querySelector(".custodian__transcript-status button")).toBeNull();
  });

  it("does not automatically refresh history while the welcome or wizard is active", async () => {
    const welcome = deferred<{
      sessionId: string;
      reply: string;
      action: "none";
      wizardInputPending: true;
      step: { id: string; type: "text"; message: string };
    }>();
    const answer = deferred<SystemAgentChatResult>();
    let historyCalls = 0;
    let chatCalls = 0;
    const request = vi.fn((method: string) => {
      if (method === "openclaw.chat.history") {
        historyCalls += 1;
        return historyCalls === 1
          ? Promise.reject(new Error("history unavailable"))
          : Promise.resolve({
              turns: [{ role: "assistant", text: "Recovered after wizard", at: 1 }],
            });
      }
      chatCalls += 1;
      return chatCalls === 1 ? welcome.promise : answer.promise;
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const { page } = await mountPage(context);

    await waitForFast(() =>
      expect(page.querySelector(".custodian__transcript-status")?.textContent).toContain(
        "history unavailable",
      ),
    );
    expect(page.querySelector(".custodian__transcript-status button")).toBeNull();
    setGatewaySnapshot({ suspensionPhase: "draining" });
    setGatewaySnapshot({ suspensionPhase: "accepting" });
    await page.updateComplete;
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);

    welcome.resolve({
      sessionId: "wizard-session",
      reply: "Choose one.",
      action: "none",
      wizardInputPending: true,
      step: { id: "choice", type: "text", message: "Continue?" },
    });
    await waitForFast(() => expect(page.querySelector(".custodian__wizard-step")).not.toBeNull());

    setGatewaySnapshot({ suspensionPhase: "draining" });
    setGatewaySnapshot({ suspensionPhase: "accepting" });
    await page.updateComplete;
    expect(page.querySelector(".custodian__transcript-status button")).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);

    const wizardMessage = page.store.messages.find((message) => message.step);
    expect(wizardMessage).toBeDefined();
    page.store.answerWizardStep(wizardMessage!, "Continue");
    await page.updateComplete;
    expect(page.store.sending).toBe(true);
    expect(historyCalls).toBe(1);

    answer.resolve({
      sessionId: "wizard-session",
      reply: "Wizard complete",
      action: "none",
      wizardInputPending: false,
    });
    await waitForFast(() => expect(page.textContent).toContain("Recovered after wizard"));
    expect(historyCalls).toBe(2);
    expect(page.querySelector(".custodian__transcript-status")).toBeNull();
    expect(page.querySelector(".custodian__transcript-status button")).toBeNull();
  });
});
