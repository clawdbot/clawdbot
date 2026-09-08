/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as uuid from "../../lib/uuid.ts";
import { QUICK_ACTIONS_QUESTION } from "../../test-helpers/custodian-quick-actions.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

  it("continues to the welcome and retries when the bounded history request times out", async () => {
    let historyCalls = 0;
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
        if (method === "openclaw.chat.history") {
          expect(options).toEqual({ timeoutMs: 15_000 });
          historyCalls += 1;
          if (historyCalls === 1) {
            throw new Error("history request timed out");
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
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    const { page } = await mountPage(context);

    await waitForFast(() => expect(page.textContent).toContain("Welcome without history."));
    const historyAlert = Array.from(page.querySelectorAll<HTMLElement>('[role="alert"]')).find(
      (alert) => alert.textContent?.includes("history request timed out"),
    );
    expect(historyAlert).toBeDefined();
    historyAlert?.querySelector<HTMLButtonElement>("button")?.click();
    await waitForFast(() => expect(page.textContent).toContain("Recovered history."));
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
  });

  it("disables retry until the welcome and active wizard settle", async () => {
    const welcome = deferred<{
      sessionId: string;
      reply: string;
      action: "none";
      wizardInputPending: true;
      step: { id: string; type: "text"; message: string };
    }>();
    const request = vi.fn((method: string) => {
      if (method === "openclaw.chat.history") {
        return Promise.reject(new Error("history unavailable"));
      }
      return welcome.promise;
    });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    const { page } = await mountPage(context);

    const retry = await waitForFast(() => {
      const button = page.querySelector<HTMLButtonElement>(".custodian__transcript-status button");
      expect(button).not.toBeNull();
      return button!;
    });
    expect(retry.disabled).toBe(true);

    welcome.resolve({
      sessionId: "wizard-session",
      reply: "Choose one.",
      action: "none",
      wizardInputPending: true,
      step: { id: "choice", type: "text", message: "Continue?" },
    });
    await waitForFast(() => expect(page.querySelector(".custodian__wizard-step")).not.toBeNull());

    expect(
      page.querySelector<HTMLButtonElement>(".custodian__transcript-status button")?.disabled,
    ).toBe(true);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
  });
});
