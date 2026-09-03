/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { renderTelegramMiniAppPage, TELEGRAM_MINIAPP_EXPIRED_MESSAGE } from "./page.js";

describe("telegram miniapp page bootstrap", () => {
  it("executes the generated page and expires a hung auth request", async () => {
    let scheduledTimeout: { callback: () => void; delayMs: number; id: number } | undefined;
    const clearTimeoutSpy = vi.fn();
    const ready = vi.fn();
    const fetchMock = vi.fn();
    const location = { hash: "#launchTicket=launch-ticket", replace: vi.fn() };

    const rendered = new DOMParser().parseFromString(
      renderTelegramMiniAppPage({ accountId: "ops", scriptNonce: "test-nonce" }),
      "text/html",
    );
    const bootstrap = rendered.querySelector("script:not([src])")?.textContent;
    if (!bootstrap) {
      throw new Error("generated Mini App page is missing its bootstrap script");
    }
    document.body.innerHTML = rendered.body.innerHTML;
    Object.defineProperty(window, "Telegram", {
      configurable: true,
      value: { WebApp: { initData: "signed-init-data", ready } },
    });
    const scheduleTimeout = (callback: () => void, delayMs: number) => {
      scheduledTimeout = { callback, delayMs, id: 1 };
      return 1;
    };
    fetchMock.mockImplementation(
      (_input: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    try {
      // oxlint-disable-next-line typescript/no-implied-eval -- Execute the generated bootstrap itself so the test cannot drift into a reimplementation.
      new Function(
        "window",
        "document",
        "AbortController",
        "setTimeout",
        "clearTimeout",
        "fetch",
        "location",
        bootstrap,
      )(window, document, AbortController, scheduleTimeout, clearTimeoutSpy, fetchMock, location);

      expect(ready).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "auth",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            initData: "signed-init-data",
            accountId: "ops",
            launchTicket: "launch-ticket",
          }),
          credentials: "same-origin",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(scheduledTimeout?.delayMs).toBe(15_000);

      scheduledTimeout?.callback();

      await vi.waitFor(() => {
        expect(document.getElementById("status")?.textContent).toBe(
          TELEGRAM_MINIAPP_EXPIRED_MESSAGE,
        );
      });
      expect(clearTimeoutSpy).toHaveBeenCalledWith(scheduledTimeout?.id);
    } finally {
      Reflect.deleteProperty(window, "Telegram");
      document.body.replaceChildren();
    }
  });

  it("redirects with the authenticated handoff", async () => {
    const ready = vi.fn();
    const location = { hash: "#launchTicket=launch-ticket", replace: vi.fn() };
    const rendered = new DOMParser().parseFromString(
      renderTelegramMiniAppPage({ accountId: "ops", scriptNonce: "test-nonce" }),
      "text/html",
    );
    const bootstrap = rendered.querySelector("script:not([src])")?.textContent;
    if (!bootstrap) {
      throw new Error("generated Mini App page is missing its bootstrap script");
    }
    document.body.innerHTML = rendered.body.innerHTML;
    Object.defineProperty(window, "Telegram", {
      configurable: true,
      value: { WebApp: { initData: "signed-init-data", ready } },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        bootstrapToken: "bootstrap-token",
        controlUiUrl: "https://host.tailnet.ts.net/openclaw",
        gatewayUrl: "wss://host.tailnet.ts.net",
      }),
    }));

    try {
      // oxlint-disable-next-line typescript/no-implied-eval -- Execute the generated bootstrap itself so the test cannot drift into a reimplementation.
      new Function(
        "window",
        "document",
        "AbortController",
        "setTimeout",
        "clearTimeout",
        "fetch",
        "location",
        bootstrap,
      )(window, document, AbortController, setTimeout, clearTimeout, fetchMock, location);

      await vi.waitFor(() => {
        expect(location.replace).toHaveBeenCalledWith(
          "https://host.tailnet.ts.net/openclaw#gatewayUrl=wss%3A%2F%2Fhost.tailnet.ts.net&bootstrapToken=bootstrap-token",
        );
      });
      expect(ready).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(window, "Telegram");
      document.body.replaceChildren();
    }
  });
});
