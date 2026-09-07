import { expect, it } from "vitest";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../pages/chat/sidebar-layout.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
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
          const track = rail.locator(".chat-position-rail__track");
          const trackOpacity = () => track.evaluate((element) => getComputedStyle(element).opacity);
          await markers.first().waitFor();
          await expect.poll(() => markers.count()).toBe(10);
          expect(await preview.count()).toBe(0);
          expect(await rail.locator('[role="status"]').count()).toBe(0);
          await captureUiProof(suite, page, "chat-position-rail", "idle.png");
          await expect.poll(trackOpacity).toBe("0");
          // Enter the continuous gutter, between markers, without hitting a dot.
          await track.hover({ position: { x: 20, y: 3 } });
          await expect.poll(trackOpacity).toBe("1");
          expect(await preview.count()).toBe(0);
          await track.hover({ position: { x: 20, y: (await track.boundingBox())!.height - 3 } });
          await expect.poll(trackOpacity).toBe("1");
          expect(await preview.count()).toBe(0);
          await captureUiProof(suite, page, "chat-position-rail", "edge-hover.png");
          await page.mouse.move(600, 100);
          await expect.poll(trackOpacity).toBe("0");

          const currentMarkerIndex = () =>
            markers.evaluateAll((items) =>
              items.findIndex((item) => item.getAttribute("aria-current") === "true"),
            );
          await transcript.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await expect.poll(currentMarkerIndex).toBe(9);
          await transcript.hover();
          await page.mouse.wheel(
            0,
            -Math.round(
              await transcript.evaluate(
                (element) => (element.scrollHeight - element.clientHeight) / 2,
              ),
            ),
          );
          await expect.poll(currentMarkerIndex).toBeGreaterThan(0);
          await expect.poll(currentMarkerIndex).toBeLessThan(9);
          await page.mouse.wheel(
            0,
            -(await transcript.evaluate((element) => element.scrollHeight)),
          );
          await expect.poll(currentMarkerIndex).toBe(0);

          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.focus();
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
          await expect.poll(trackOpacity).toBe("1");
          const hoveredMarker = await markers.nth(4).boundingBox();
          const hoveredTick = await markers
            .nth(4)
            .locator(".chat-position-rail__tick")
            .boundingBox();
          expect(hoveredTick!.x + hoveredTick!.width).toBeLessThan(
            hoveredMarker!.x + hoveredMarker!.width / 2,
          );
          expect(hoveredAppearance.opacity).toBe("1");
          expect(hoveredAppearance.background).not.toBe("rgba(0, 0, 0, 0)");
          expect(hoveredAppearance.ring).not.toBe("none");
          expect(hoveredAppearance.tickWidth).toBeGreaterThan(8);
          expect(hoveredAppearance.targetWidth).toBeGreaterThanOrEqual(24);
          expect(hoveredAppearance.targetHeight).toBeGreaterThanOrEqual(24);
          await captureUiProof(suite, page, "chat-position-rail", "scroll-follow-hover.png");

          const previewBounds = await preview.boundingBox();
          expect(previewBounds).not.toBeNull();
          expect(previewBounds!.x + previewBounds!.width).toBeLessThan(hoveredMarker!.x);
          await page.mouse.move(
            previewBounds!.x + previewBounds!.width / 2,
            previewBounds!.y + previewBounds!.height / 2,
            { steps: 20 },
          );
          expect(await preview.textContent()).toContain("Transcript checkpoint 32");
          await captureUiProof(suite, page, "chat-position-rail", "hover-reading.png");
          await page.keyboard.press("Escape");
          await expect.poll(() => preview.count()).toBe(0);
          expect(await composer.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );

          await page.mouse.move(600, 100);
          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 32");
          await page.mouse.move(600, 100);
          await expect.poll(() => preview.count()).toBe(0);
          await expect.poll(trackOpacity).toBe("0");
          await markers.nth(5).focus();
          await expect.poll(trackOpacity).toBe("1");
          await page.keyboard.press("Shift+Tab");
          await expect.poll(trackOpacity).toBe("0");
          await page.keyboard.press("Tab");
          await expect.poll(trackOpacity).toBe("1");
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

          // Mouse activation must not latch the rail open after leaving the edge.
          await markers.last().click();
          await page.mouse.move(600, 100);
          await expect.poll(trackOpacity).toBe("0");
          await preview.waitFor({ state: "hidden" });
          await captureUiProof(suite, page, "chat-position-rail", "pointer-exit.png");
          await track.hover({ position: { x: 20, y: 3 } });
          await expect.poll(trackOpacity).toBe("1");
          await preview.waitFor({ state: "hidden" });
          await page.mouse.move(600, 100);
          await page.keyboard.press("ArrowDown");
          await expect.poll(trackOpacity).toBe("1");

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

          // Saved widths can consume the gutter even in a wide desktop pane.
          for (const width of ["100%", "none", "95%", "48rem"]) {
            await page.goto(`${suite.server.baseUrl}settings/appearance#settings-appearance-chat`);
            const widthInput = page.locator("[data-settings-chat-message-width]");
            await widthInput.fill(width);
            await widthInput.press("Tab");
            await expect
              .poll(() =>
                page.evaluate(
                  (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatMessageMaxWidth,
                  controlUiBundledSettingsStorageKey(suite.server.baseUrl),
                ),
              )
              .toBe(width);
            await page.goto(`${suite.server.baseUrl}chat`);
            await transcript.locator(".chat-virtual-row").first().waitFor();
            await expect
              .poll(() =>
                transcript.evaluate((element) =>
                  getComputedStyle(element).getPropertyValue("--chat-thread-max-width").trim(),
                ),
              )
              .toBe(width);
            await markers.first().waitFor({ state: width === "48rem" ? "visible" : "hidden" });
            if (width === "48rem") {
              const inner = await transcript.locator(".chat-thread-inner").boundingBox();
              const marker = await markers.first().boundingBox();
              expect(marker!.x - (inner!.x + inner!.width)).toBeGreaterThanOrEqual(8);
            }
            await captureUiProof(
              suite,
              page,
              "chat-position-rail",
              `saved-width-${width.replace("%", "percent")}.png`,
            );
          }
          // A foreign-host commit can change the inner column while the pane's
          // own dimensions stay fixed. Exercise that existing event boundary.
          for (const width of ["95%", "48rem"]) {
            await transcript.evaluate(
              (element, { columnWidth, eventName }) => {
                element.style.setProperty("--chat-thread-max-width", columnWidth);
                element.dispatchEvent(
                  new CustomEvent(eventName, {
                    bubbles: true,
                    detail: { widthChanged: false },
                  }),
                );
              },
              { columnWidth: width, eventName: SIDEBAR_GEOMETRY_COMMIT_EVENT },
            );
            await markers.first().waitFor({ state: width === "48rem" ? "visible" : "hidden" });
          }
          await transcript.evaluate((element) =>
            element.style.removeProperty("--chat-thread-max-width"),
          );
          // A shifted reading column must reserve the rail's actual (right) gutter,
          // not a spacious left gutter that would allow markers over the text.
          for (const columnAtLeft of [false, true]) {
            await transcript.evaluate(
              (element, { alignLeft, eventName }) => {
                const inner = element.querySelector<HTMLElement>(".chat-thread-inner")!;
                inner.style.marginLeft = alignLeft ? "32px" : "auto";
                inner.style.marginRight = alignLeft ? "auto" : "32px";
                element.dispatchEvent(
                  new CustomEvent(eventName, {
                    bubbles: true,
                    detail: { widthChanged: false },
                  }),
                );
              },
              { alignLeft: columnAtLeft, eventName: SIDEBAR_GEOMETRY_COMMIT_EVENT },
            );
            await markers.first().waitFor({ state: columnAtLeft ? "visible" : "hidden" });
          }
          await page.evaluate(() => {
            document.documentElement.dir = "rtl";
          });
          await markers.first().waitFor({ state: "visible" });
          await expect
            .poll(() =>
              markers.first().evaluate((marker) => {
                const inner = marker.closest(".chat-thread")!.querySelector(".chat-thread-inner")!;
                return marker.getBoundingClientRect().left - inner.getBoundingClientRect().right;
              }),
            )
            .toBeGreaterThanOrEqual(8);
          expect(
            await rail.locator(".chat-position-rail__track").evaluate((element) => ({
              right: getComputedStyle(element).borderRightWidth,
              left: getComputedStyle(element).borderLeftWidth,
            })),
          ).toEqual({ right: "0px", left: "1px" });
          expect(pageErrors).toEqual([]);
        },
      );
    },
  );
  it("keeps the rail usable on a wide screen without mouse hover", async () => {
    await suite.withPage(
      { hasTouch: true, viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [0, 1].map((index) => ({
            role: index === 0 ? "user" : "assistant",
            content: "Touch checkpoint " + index,
            timestamp: Date.UTC(2026, 8, 7, 12, index),
            __openclaw: { id: "touch-rail-" + index, seq: index + 1 },
          })),
        });
        await page.goto(suite.server.baseUrl + "chat");
        const rail = page.locator(".chat-position-rail");
        await rail.locator(".chat-position-rail__marker").first().waitFor();
        expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);
        expect(
          await rail
            .locator(".chat-position-rail__track")
            .evaluate((element) => getComputedStyle(element).opacity),
        ).toBe("1");
        await rail.locator(".chat-position-rail__marker").first().tap();
        await rail.locator(".chat-position-rail__preview").waitFor({ state: "hidden" });
        await page.locator('.chat-bubble[data-entry-id="touch-rail-0"]').waitFor();
      },
    );
  });
});
