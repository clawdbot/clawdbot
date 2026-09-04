import { expect, it } from "vitest";
import {
  captureUiProof,
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each(["dark", "light"] as const)(
    "tracks reader position and keyboard jumps in %s mode",
    async (colorScheme) => {
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
          ...(captureUiProofEnabled
            ? { recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1440 } } }
            : {}),
        },
        async ({ page }) => {
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          const messages = Array.from({ length: 72 }, (_, index) => ({
            __openclaw: { id: `position-rail-${index}`, seq: index + 1 },
            content: [{ text: `Transcript checkpoint ${index}`, type: "text" }],
            role: index % 2 === 0 ? "user" : "assistant",
            timestamp: Date.UTC(2026, 8, 4, 12, index),
          }));
          await installMockGateway(page, { historyMessages: messages });
          await page.goto(`${suite.server.baseUrl}chat`);
          const transcript = page.locator(".chat-thread");
          await transcript
            .locator(".chat-virtual-row")
            .getByText("Transcript checkpoint 71", { exact: true })
            .waitFor();

          const rail = page.locator(".chat-position-rail");
          const markers = rail.locator(".chat-position-rail__marker");
          const preview = rail.locator(".chat-position-rail__preview-copy");
          await markers.first().waitFor();
          await expect.poll(() => markers.count()).toBe(10);
          expect(await preview.count()).toBe(0);
          expect(await rail.locator('[role="status"]').count()).toBe(0);
          await captureUiProof(suite, page, "chat-position-rail", "idle.png");

          const currentMarkerIndex = () =>
            markers.evaluateAll((items) =>
              items.findIndex((item) => item.getAttribute("aria-current") === "true"),
            );
          await transcript.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await expect.poll(currentMarkerIndex).toBe(9);
          await transcript.evaluate((element) => {
            element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
          });
          await expect.poll(currentMarkerIndex).toBeGreaterThan(0);
          await expect.poll(currentMarkerIndex).toBeLessThan(9);
          await transcript.evaluate((element) => {
            element.scrollTop = 0;
          });
          await expect.poll(currentMarkerIndex).toBe(0);

          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 32");
          await expect
            .poll(() =>
              markers
                .nth(4)
                .evaluate((marker) =>
                  Number.parseFloat(
                    getComputedStyle(marker.querySelector(".chat-position-rail__tick")!).width,
                  ),
                ),
            )
            .toBeGreaterThan(8);
          const hoveredAppearance = await markers.nth(4).evaluate((marker) => {
            const markerStyle = getComputedStyle(marker.querySelector(".chat-position-rail__dot")!);
            const tickStyle = getComputedStyle(marker.querySelector(".chat-position-rail__tick")!);
            return {
              background: markerStyle.backgroundColor,
              opacity: markerStyle.opacity,
              ring: markerStyle.boxShadow,
              tickWidth: Number.parseFloat(tickStyle.width),
              targetWidth: marker.getBoundingClientRect().width,
              targetHeight: marker.getBoundingClientRect().height,
            };
          });
          expect(hoveredAppearance.opacity).toBe("1");
          expect(hoveredAppearance.background).not.toBe("rgba(0, 0, 0, 0)");
          expect(hoveredAppearance.ring).not.toBe("none");
          expect(hoveredAppearance.tickWidth).toBeGreaterThan(8);
          expect(hoveredAppearance.targetWidth).toBeGreaterThanOrEqual(24);
          expect(hoveredAppearance.targetHeight).toBeGreaterThanOrEqual(24);
          await captureUiProof(suite, page, "chat-position-rail", "scroll-follow-hover.png");

          await page.mouse.move(600, 100);
          await expect.poll(() => preview.count()).toBe(0);
          await markers.nth(5).focus();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 39");
          await markers.nth(5).press("ArrowDown");
          await expect
            .poll(() =>
              page.evaluate(
                () => document.activeElement?.getAttribute("data-position-marker-id") ?? null,
              ),
            )
            .toBe("position-rail-47");
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 47");
          await markers.nth(6).press("Enter");
          const revealed = transcript.locator('.chat-bubble[data-entry-id="position-rail-47"]');
          await expect
            .poll(() =>
              revealed.evaluate((element) => {
                const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
                const bubble = element.getBoundingClientRect();
                return bubble.top >= viewport.top && bubble.bottom <= viewport.bottom;
              }),
            )
            .toBe(true);
          await captureUiProof(suite, page, "chat-position-rail", "keyboard-jump.png");
          await markers.nth(6).press("Escape");
          await expect.poll(() => preview.count()).toBe(0);
          await markers.nth(6).press("Home");
          await expect
            .poll(() => markers.first().evaluate((element) => element === document.activeElement))
            .toBe(true);
          await markers.first().press(" ");
          await expect.poll(currentMarkerIndex).toBe(0);
          await markers.first().press("End");
          await markers.last().press("Enter");
          await expect.poll(currentMarkerIndex).toBe(9);

          // Pane-local width matters even inside an otherwise wide desktop.
          await transcript.evaluate((element) => {
            element.style.width = "800px";
          });
          await markers.first().waitFor({ state: "hidden" });
          await transcript.evaluate((element) => {
            element.style.removeProperty("width");
          });
          await markers.first().waitFor({ state: "visible" });

          await page.setViewportSize({ height: 900, width: 900 });
          await markers.first().waitFor({ state: "hidden" });
          await captureUiProof(suite, page, "chat-position-rail", "narrow-pane.png");
          await page.setViewportSize({ height: 900, width: 1440 });
          await markers.first().waitFor({ state: "visible" });
          await page.emulateMedia({ reducedMotion: "reduce" });
          expect(
            await markers
              .first()
              .locator(".chat-position-rail__dot")
              .evaluate((element) =>
                Number.parseFloat(getComputedStyle(element).transitionDuration),
              ),
          ).toBeLessThanOrEqual(0.00001); // Global reduced-motion policy uses 0.01ms.
          expect(pageErrors).toEqual([]);
        },
      );
    },
  );
});
