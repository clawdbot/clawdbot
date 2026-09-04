import type { Locator, Page } from "playwright";
import { expect } from "vitest";

export async function waitForControlUiProofSurface(
  surface: Locator,
  content: readonly Locator[],
): Promise<void> {
  // Lazy hosts can have boxes before their meaningful children have loaded.
  await Promise.all(content.map((locator) => locator.waitFor()));
  // Visibility ignores opacity. Settle only the owner's finite entrance/resize
  // motion; perpetual descendant activity must not hold up retained proof.
  await expect
    .poll(() =>
      surface.evaluate(
        (element) =>
          element.checkVisibility({ checkOpacity: true }) &&
          getComputedStyle(element).opacity === "1" &&
          element
            .getAnimations()
            .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
            .every((animation) => animation.playState === "finished"),
      ),
    )
    .toBe(true);
}

export async function takeControlUiViewportScreenshot(
  page: Page,
  surface: Locator,
  content: readonly Locator[],
): Promise<Buffer> {
  await waitForControlUiProofSurface(surface, content);
  // CDP repaints the current viewport but does not settle semantic presentation.
  // Keep capture independent of unrelated dashboard RPCs and descendant motion.
  const session = await page.context().newCDPSession(page);
  try {
    const result = await session.send("Page.captureScreenshot", {
      captureBeyondViewport: false,
      format: "png",
      fromSurface: true,
    });
    return Buffer.from(result.data, "base64");
  } finally {
    await session.detach();
  }
}
