import { describe, expect, it, vi } from "vitest";
import {
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.js");

describe("pw-tools-core", () => {
  it("clamps timeoutMs for scrollIntoView", async () => {
    const scrollIntoViewIfNeeded = vi.fn(async () => {});
    setPwToolsCoreCurrentRefLocator({ scrollIntoViewIfNeeded });
    setPwToolsCoreCurrentPage({});

    await mod.scrollIntoViewViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "1",
      timeoutMs: 50,
    });

    expect(scrollIntoViewIfNeeded).toHaveBeenCalledWith({ timeout: 500 });
  });
  it.each([
    {
      name: "strict mode violations for scrollIntoView",
      errorMessage: 'Error: strict mode violation: locator("aria-ref=1") resolved to 2 elements',
      expectedMessage: /Run a new snapshot/i,
    },
    {
      name: "not-visible timeouts for scrollIntoView",
      errorMessage: 'Timeout 5000ms exceeded. waiting for locator("aria-ref=1") to be visible',
      expectedMessage: /not found or not visible/i,
    },
  ])("rewrites $name", async ({ errorMessage, expectedMessage }) => {
    const scrollIntoViewIfNeeded = vi.fn(async () => {
      throw new Error(errorMessage);
    });
    setPwToolsCoreCurrentRefLocator({ scrollIntoViewIfNeeded });
    setPwToolsCoreCurrentPage({});

    await expect(
      mod.scrollIntoViewViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(expectedMessage);
  });
  it.each([
    {
      name: "strict mode violations into snapshot hints",
      errorMessage: 'Error: strict mode violation: locator("aria-ref=1") resolved to 2 elements',
      expectedMessage: /Run a new snapshot/i,
    },
    {
      name: "not-visible timeouts into snapshot hints",
      errorMessage: 'Timeout 5000ms exceeded. waiting for locator("aria-ref=1") to be visible',
      expectedMessage: /not found or not visible/i,
    },
    {
      name: "bare locator timeouts into snapshot hints",
      errorMessage:
        "locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=ax13')",
      expectedMessage: /not found or not visible/i,
    },
  ])("rewrites $name", async ({ errorMessage, expectedMessage }) => {
    const click = vi.fn(async () => {
      throw new Error(errorMessage);
    });
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage({ url: vi.fn(() => "https://example.com") });

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(expectedMessage);
  });
  it("rewrites covered/hidden errors into interactable hints", async () => {
    const click = vi.fn(async () => {
      throw new Error(
        "Element is not receiving pointer events because another element intercepts pointer events",
      );
    });
    setPwToolsCoreCurrentRefLocator({ click });
    setPwToolsCoreCurrentPage({ url: vi.fn(() => "https://example.com") });

    await expect(
      mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
      }),
    ).rejects.toThrow(/not interactable/i);
  });
});
