/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLazyElementSpec,
  resetAppHostTestGlobals,
  type TestOptionalCustomElement,
} from "./app-host.test-support.ts";
import "./app-host.ts";
import type { LazyCustomElementRequestController } from "./lazy-custom-element.ts";

type ShellOnboardingMemoryImportState = {
  onboardingMemoryImportElement: TestOptionalCustomElement;
  lazyCustomElements: LazyCustomElementRequestController;
};

afterEach(() => resetAppHostTestGlobals());

describe("OpenClaw shell onboarding memory import", () => {
  it("surfaces a rejected load and retries it", async () => {
    const element = createLazyElementSpec("onboarding memory import", {
      firstError: new Error("memory import chunk unavailable"),
    });
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellOnboardingMemoryImportState;
    shell.onboardingMemoryImportElement = element;
    Object.defineProperty(shell, "updateComplete", { get: () => Promise.resolve(true) });

    shell.lazyCustomElements.requestWhileActive(element, true);

    await vi.waitFor(() => expect(shell.lazyCustomElements.visibleState?.status).toBe("error"));
    expect(shell.lazyCustomElements.visibleState?.element).toBe(element);
    shell.lazyCustomElements.retry();
    await vi.waitFor(() => expect(customElements.get(element.tagName)).toBeDefined());
    expect(shell.lazyCustomElements.visibleState).toBeUndefined();
  });

  it("abandons a pending load when onboarding ends", async () => {
    let rejectLoad: ((error: Error) => void) | undefined;
    let loadSettled: Promise<void> | undefined;
    const element = createLazyElementSpec("onboarding memory import");
    element.loadModule = vi.fn(() => {
      const load = new Promise<void>((_resolve, reject) => {
        rejectLoad = reject;
      });
      loadSettled = load.catch(() => undefined);
      return load;
    });
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellOnboardingMemoryImportState;
    shell.onboardingMemoryImportElement = element;

    shell.lazyCustomElements.requestWhileActive(element, true);
    await vi.waitFor(() => expect(element.loadModule).toHaveBeenCalledOnce());
    expect(shell.lazyCustomElements.visibleState?.status).toBe("loading");
    shell.lazyCustomElements.requestWhileActive(element, false);
    const error = new Error("late memory import chunk failure");
    rejectLoad?.(error);
    await loadSettled;
    await Promise.resolve();

    expect(shell.lazyCustomElements.visibleState).toBeUndefined();
  });
});
