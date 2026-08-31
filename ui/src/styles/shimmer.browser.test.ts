import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeShimmer = canRunPlaywrightChromium(chromiumExecutablePath) ? describe : describe.skip;

let browser: Browser;

beforeAll(async () => {
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    return;
  }
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
});

afterAll(async () => {
  await browser?.close().catch(() => {});
});

describeShimmer("Control UI shimmer", () => {
  it("moves loading highlights on compositor-safe pseudo-elements", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><head><style>
        ${readStyleSheet("ui/src/styles/base.css")}
        ${readStyleSheet("ui/src/styles/chat/layout.css")}
        ${readStyleSheet("ui/src/styles/memory-import.css")}
        ${readStyleSheet("ui/src/styles/usage.css")}
      </style></head><body>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton usage-skeleton-block"></div>
        <div class="skeleton memory-import__skeleton"></div>
        <div class="skeleton chat-controls__model-trigger-skeleton"></div>
      </body></html>`);

      for (const [selector, duration] of [
        [".skeleton-line", "1.5s"],
        [".usage-skeleton-block", "1.35s"],
        [".memory-import__skeleton", "1.4s"],
        [".chat-controls__model-trigger-skeleton", "1.45s"],
      ] as const) {
        const styles = await page.locator(selector).evaluate((element) => {
          const host = getComputedStyle(element);
          const highlight = getComputedStyle(element, "::after");
          const animation = element.getAnimations({ subtree: true })[0];
          const keyframes =
            animation?.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [];
          const animatedProperties = new Set(
            keyframes.flatMap((frame) =>
              Object.keys(frame).filter(
                (key) => !["composite", "computedOffset", "easing", "offset"].includes(key),
              ),
            ),
          );
          return {
            hostAnimation: host.animationName,
            hostBackground: host.backgroundImage,
            hostOverflow: host.overflow,
            highlightAnimation: highlight.animationName,
            highlightBackground: highlight.backgroundImage,
            highlightDuration: highlight.animationDuration,
            highlightIterations: highlight.animationIterationCount,
            highlightWillChange: highlight.willChange,
            animatedProperties: [...animatedProperties],
          };
        });

        expect(styles).toMatchObject({
          hostAnimation: "none",
          hostBackground: "none",
          hostOverflow: "hidden",
          highlightAnimation: "shimmer",
          highlightDuration: duration,
          highlightIterations: "infinite",
          highlightWillChange: "transform",
          animatedProperties: ["transform"],
        });
        expect(styles.highlightBackground).toContain("linear-gradient");
      }
    } finally {
      await page.close().catch(() => {});
    }
  });

  it("keeps the global reduced-motion gate", async () => {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    try {
      await page.setContent(`<!doctype html><html><head><style>
        ${readStyleSheet("ui/src/styles/base.css")}
        ${readStyleSheet("ui/src/styles/chat/layout.css")}
        ${readStyleSheet("ui/src/styles/memory-import.css")}
        ${readStyleSheet("ui/src/styles/usage.css")}
      </style></head><body>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton usage-skeleton-block"></div>
        <div class="skeleton memory-import__skeleton"></div>
        <div class="skeleton chat-controls__model-trigger-skeleton"></div>
      </body></html>`);

      for (const selector of [
        ".skeleton-line",
        ".usage-skeleton-block",
        ".memory-import__skeleton",
        ".chat-controls__model-trigger-skeleton",
      ]) {
        const animation = await page.locator(selector).evaluate(async (element) => {
          const highlight = getComputedStyle(element, "::after");
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          return {
            duration: highlight.animationDuration,
            iterations: highlight.animationIterationCount,
            running: element
              .getAnimations({ subtree: true })
              .some((item) => item.playState === "running"),
          };
        });

        expect(animation.iterations).toBe("1");
        expect(Number.parseFloat(animation.duration)).toBeLessThanOrEqual(0.00001);
        expect(animation.running).toBe(false);
      }
    } finally {
      await page.close().catch(() => {});
    }
  });
});
