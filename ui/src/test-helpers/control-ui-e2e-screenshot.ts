import photon from "@silvia-odwyer/photon-node";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";

export async function waitForControlUiProofSurface(
  surface: Locator,
  content: readonly Locator[],
): Promise<void> {
  // Lazy hosts can have boxes before their meaningful children have loaded.
  await Promise.all(content.map((locator) => locator.waitFor()));
  // Preserve Playwright screenshot preparation: late fonts change glyphs and boxes.
  await surface.evaluate(async (element) => {
    await element.ownerDocument.fonts.ready;
  });
  // Ancestor transforms affect captured pixels even when the surface has no animation.
  // Settle that presentation chain, including shadow hosts, without waiting on descendants.
  await expect
    .poll(() =>
      surface.evaluate((element) => {
        if (
          !element.checkVisibility({ checkOpacity: true }) ||
          getComputedStyle(element).opacity !== "1"
        ) {
          return false;
        }
        for (let owner: Element | null = element; owner;) {
          if (
            owner
              .getAnimations()
              .some(
                (animation) =>
                  Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
                  animation.playState !== "finished",
              )
          ) {
            return false;
          }
          const root = owner.getRootNode();
          owner = owner.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }
        return true;
      }),
    )
    .toBe(true);
}

export async function takeControlUiViewportScreenshot(
  page: Page,
  surface: Locator,
  content: readonly Locator[],
): Promise<Buffer> {
  await waitForControlUiProofSurface(surface, content);
  return captureControlUiViewport(page);
}

async function captureControlUiViewport(page: Page): Promise<Buffer> {
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

export async function takeControlUiElementScreenshot(
  page: Page,
  surface: Locator,
  content: readonly Locator[],
): Promise<Buffer> {
  await waitForControlUiProofSurface(surface, content);
  // Playwright's scroll waits for stable geometry without changing the hover target.
  await surface.scrollIntoViewIfNeeded();
  const bounds = await surface.boundingBox();
  const viewport = page.viewportSize();
  if (
    !bounds ||
    !viewport ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.x + bounds.width > viewport.width ||
    bounds.y + bounds.height > viewport.height
  ) {
    throw new Error(
      `Proof surface is not contained by the viewport: ${JSON.stringify({ bounds, viewport })}`,
    );
  }
  const png = await captureControlUiViewport(page);
  expect(await surface.boundingBox(), "Proof surface moved during viewport capture").toEqual(
    bounds,
  );
  // Browser-side clips can replace recording frames with the clipped surface.
  // Crop only the completed PNG, enclosing fractional CSS bounds in device pixels.
  const image = photon.PhotonImage.new_from_byteslice(png);
  let crop: ReturnType<typeof photon.crop> | undefined;
  try {
    const scaleX = image.get_width() / viewport.width;
    const scaleY = image.get_height() / viewport.height;
    crop = photon.crop(
      image,
      Math.floor(bounds.x * scaleX),
      Math.floor(bounds.y * scaleY),
      Math.ceil((bounds.x + bounds.width) * scaleX),
      Math.ceil((bounds.y + bounds.height) * scaleY),
    );
    return Buffer.from(crop.get_bytes());
  } finally {
    crop?.free();
    image.free();
  }
}
