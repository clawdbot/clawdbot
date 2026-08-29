// Control UI E2E tests protect transcript disclosure geometry across animation frames.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatThreadDistanceFromBottom, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureTopVisibleVirtualRow } from "./virtual-row-anchor.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI transcript disclosure anchoring",
  startServerBeforeBrowser: true,
});

type DisclosureFrame = {
  expanded: boolean;
  mountedBodies: number;
  rowHeight: number;
  rowTop: number;
  scrollHeight: number;
  scrollTop: number;
};

async function toggleDisclosureWithFrameTrace(
  page: import("playwright").Page,
  summary: import("playwright").Locator,
  actionSelector?: string,
): Promise<DisclosureFrame[]> {
  return await summary.evaluate((button, selector) => {
    const row = button.closest<HTMLElement>(".chat-virtual-row");
    const thread = button.closest<HTMLElement>(".chat-thread");
    if (!row || !thread) {
      throw new Error("Expected disclosure inside a virtual transcript row");
    }
    const frames: DisclosureFrame[] = [];
    const sample = () => {
      frames.push({
        expanded: button.matches("summary")
          ? button.closest("details")?.hasAttribute("open") === true
          : button.getAttribute("aria-expanded") === "true" ||
            button.getAttribute("aria-pressed") === "true",
        mountedBodies: row.querySelectorAll(".chat-tool-msg-body, .chat-activity-group__body")
          .length,
        rowHeight: row.getBoundingClientRect().height,
        rowTop: row.getBoundingClientRect().top - thread.getBoundingClientRect().top,
        scrollHeight: thread.scrollHeight,
        scrollTop: thread.scrollTop,
      });
    };
    sample();
    const action = selector ? row.querySelector<HTMLElement>(selector) : (button as HTMLElement);
    if (!action) {
      throw new Error(`Expected disclosure action ${selector}`);
    }
    action.click();
    return new Promise<DisclosureFrame[]>((resolve) => {
      let remaining = 8;
      const next = () => {
        sample();
        remaining -= 1;
        if (remaining === 0) {
          resolve(frames);
        } else {
          requestAnimationFrame(next);
        }
      };
      requestAnimationFrame(next);
    });
  }, actionSelector);
}

function expectStableDisclosureFrames(frames: DisclosureFrame[], label = "disclosure") {
  const initial = frames[0];
  expect(initial).toBeDefined();
  expect(frames.at(-1)?.expanded, `${label} state`).toBe(!initial!.expanded);
  expect(
    frames.some(
      (frame) =>
        Math.abs(frame.rowHeight - initial!.rowHeight) > 0.5 ||
        frame.scrollHeight !== initial!.scrollHeight,
    ),
    `${label} resize`,
  ).toBe(true);
  expect(
    Math.max(...frames.map((frame) => Math.abs(frame.rowTop - initial!.rowTop))),
    `${label} geometry: ${JSON.stringify(frames)}`,
  ).toBeLessThanOrEqual(2);
  expect(
    Math.max(...frames.map((frame) => Math.abs(frame.scrollTop - initial!.scrollTop))),
    `${label} scroll offset`,
  ).toBeLessThanOrEqual(2);
}

async function showSplitDashboard(page: import("playwright").Page, sessionKey: string) {
  const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, settingsKey }) => {
      const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Record<
        string,
        unknown
      >;
      settings.boardSessionViews = { [key]: { activeTabId: "main" } };
      localStorage.setItem(settingsKey, JSON.stringify(settings));
    },
    { key: sessionKey, settingsKey: storageKey },
  );
  await page.goto(`${suite.server.baseUrl}dashboard`);
  await page.locator('.side-panel [data-panel-slot="chat"] .chat-thread').waitFor();
}

suite.define(() => {
  it.each([
    { reducedMotion: "no-preference", interruption: "wheel", recoveryPosition: "within-viewport" },
    { reducedMotion: "reduce", interruption: "wheel", recoveryPosition: "within-viewport" },
    {
      reducedMotion: "no-preference",
      interruption: "synthetic-pointer",
      recoveryPosition: "within-viewport",
    },
    {
      reducedMotion: "no-preference",
      interruption: "native-pointer",
      recoveryPosition: "above-viewport",
    },
  ] as const)(
    "remeasures recovered assistant text after interrupted scrolling ($reducedMotion, $interruption, $recoveryPosition)",
    async ({ reducedMotion, interruption, recoveryPosition }) => {
      const artifactDir = path.resolve(
        process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR ??
          ".artifacts/control-ui-e2e/virtual-sizing/after",
        `${reducedMotion}-${interruption}-${recoveryPosition}`,
      );
      await fs.mkdir(artifactDir, { recursive: true });
      await suite.withPage(
        {
          reducedMotion,
          viewport: { width: 1440, height: 900 },
          recordVideo: { dir: artifactDir },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            heldMethods: ["chat.message.get"],
            historyMessages: Array.from({ length: 60 }, (_, index) => ({
              role: index % 2 === 0 ? "user" : "assistant",
              content:
                index === 1
                  ? "Assistant preview awaiting full text."
                  : `Transcript message ${index}. ${"Keep this conversation scrollable. ".repeat(6)}`,
              timestamp: 1000 + index,
              __openclaw: {
                id: `sizing-message-${index}`,
                seq: index + 1,
                ...(index === 1 || (interruption === "native-pointer" && index % 2 === 1)
                  ? { truncated: true, reason: "display-cap" }
                  : {}),
              },
            })),
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("Transcript message 59.", { exact: false }).waitFor();
          await waitForChatScrollIdle(page);
          const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
          await thread.hover();
          await page.mouse.wheel(0, -100_000);
          await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
          await gateway.waitForRequest("chat.message.get");
          await waitForChatScrollIdle(page);
          await page
            .locator('.chat-bubble[data-entry-id="sizing-message-1"]')
            .waitFor({ state: "visible" });
          await page.screenshot({ path: path.join(artifactDir, "01-before-scroll.png") });
          let during: { top: number; max: number };
          if (interruption === "synthetic-pointer") {
            // Check native gutter hit testing separately from animation timing.
            const pointer = await thread.evaluateHandle((element) => {
              const observed = { trusted: false, scroller: false };
              document.addEventListener(
                "pointerdown",
                (event) => {
                  observed.trusted = event.isTrusted;
                  observed.scroller = event.target === element;
                },
                { capture: true, once: true },
              );
              return observed;
            });
            const track = await thread.boundingBox();
            expect(track).not.toBeNull();
            await page.mouse.click(track!.x + track!.width - 3, track!.y + 20);
            expect(await pointer.jsonValue()).toEqual({ trusted: true, scroller: true });
            await pointer.dispose();
            // Synthetic intent runs in the first positive native scroll callback;
            // a Node round trip can outlive the fixed row's visible range.
            // Smooth animation and production cancellation remain real.
            during = await page
              .locator(".chat-scroll-to-bottom")
              .evaluate((button, waitTimeout) => {
                const scroller = document.querySelector<HTMLElement>(
                  ".chat-pane-cache__pane--active .chat-thread",
                )!;
                return new Promise<{ top: number; max: number }>((resolve, reject) => {
                  const interrupt = (event: Event) => {
                    if (!event.isTrusted || scroller.scrollTop <= 0) {
                      return;
                    }
                    clearTimeout(timer);
                    scroller.removeEventListener("scroll", interrupt);
                    const position = {
                      top: scroller.scrollTop,
                      max: scroller.scrollHeight - scroller.clientHeight,
                    };
                    scroller.dispatchEvent(
                      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
                    );
                    resolve(position);
                  };
                  const timer = setTimeout(() => {
                    scroller.removeEventListener("scroll", interrupt);
                    reject(new Error("Native scrolling did not reach the interruption geometry"));
                  }, waitTimeout);
                  scroller.addEventListener("scroll", interrupt);
                  (button as HTMLElement).click();
                });
              }, controlUiE2eWaitTimeoutMs);
          } else if (interruption === "native-pointer") {
            const track = await thread.boundingBox();
            expect(track).not.toBeNull();
            const pointer = await thread.evaluateHandle((scroller, waitTimeout) => {
              const pendingAboveReader = () => {
                const viewportTop = scroller.getBoundingClientRect().top;
                const bubble = Array.from(
                  scroller.querySelectorAll<HTMLElement>(
                    '.chat-bubble[data-entry-id^="sizing-message-"]',
                  ),
                ).findLast(
                  (candidate) =>
                    Number(candidate.dataset.entryId!.slice("sizing-message-".length)) % 2 === 1 &&
                    candidate.closest(".chat-virtual-row")!.getBoundingClientRect().bottom <=
                      viewportTop,
                );
                return bubble
                  ? {
                      messageId: bubble.dataset.entryId!,
                      bottom: bubble.closest(".chat-virtual-row")!.getBoundingClientRect().bottom,
                      viewportTop,
                    }
                  : null;
              };
              let eligible = false;
              let arrival: {
                top: number;
                max: number;
                trusted: boolean;
                scroller: boolean;
                pending: ReturnType<typeof pendingAboveReader>;
              } | null = null;
              let resolveReady!: () => void;
              let rejectReady!: (error: Error) => void;
              const ready = new Promise<void>((resolve, reject) => {
                resolveReady = resolve;
                rejectReady = reject;
              });
              const onScroll = (event: Event) => {
                if (!event.isTrusted || scroller.scrollTop <= 0 || !pendingAboveReader()) {
                  return;
                }
                eligible = true;
                clearTimeout(timer);
                scroller.removeEventListener("scroll", onScroll);
                resolveReady();
              };
              const onPointer = (event: PointerEvent) => {
                if (!eligible) {
                  return;
                }
                // Sample the real input before the scroller's takeover handler cancels motion.
                arrival = {
                  top: scroller.scrollTop,
                  max: scroller.scrollHeight - scroller.clientHeight,
                  trusted: event.isTrusted,
                  scroller: event.target === scroller,
                  pending: pendingAboveReader(),
                };
                document.removeEventListener("pointerdown", onPointer, true);
              };
              const dispose = () => {
                clearTimeout(timer);
                scroller.removeEventListener("scroll", onScroll);
                document.removeEventListener("pointerdown", onPointer, true);
                rejectReady(new Error("Native pointer observation ended before scrolling"));
              };
              const timer = setTimeout(dispose, waitTimeout);
              scroller.addEventListener("scroll", onScroll);
              document.addEventListener("pointerdown", onPointer, true);
              return { ready, read: () => arrival, dispose };
            }, controlUiE2eWaitTimeoutMs);
            try {
              // Arm before START; its post-click bookkeeping must not delay native input.
              const interrupt = pointer
                .evaluate((observation) => observation.ready)
                .then(() => page.mouse.click(track!.x + track!.width - 3, track!.y + 20));
              await Promise.all([interrupt, page.locator(".chat-scroll-to-bottom").click()]);
              const arrival = await pointer.evaluate((observation) => observation.read());
              expect(arrival).not.toBeNull();
              expect(arrival).toMatchObject({ trusted: true, scroller: true });
              expect(arrival!.top).toBeGreaterThan(0);
              expect(arrival!.pending).not.toBeNull();
              expect(arrival!.pending!.bottom).toBeLessThanOrEqual(arrival!.pending!.viewportTop);
              during = arrival!;
            } finally {
              await pointer.evaluate((observation) => observation.dispose());
              await pointer.dispose();
            }
          } else {
            await page.locator(".chat-scroll-to-bottom").click();
            await page.waitForFunction(() => {
              const scroller = document.querySelector<HTMLElement>(
                ".chat-pane-cache__pane--active .chat-thread",
              );
              return scroller && scroller.scrollTop > 0;
            });
            during = await thread.evaluate((element) => ({
              top: element.scrollTop,
              max: element.scrollHeight - element.clientHeight,
            }));
          }
          if (reducedMotion === "no-preference") {
            expect(during.top).toBeLessThan(during.max);
          }
          if (interruption === "wheel") {
            await thread.hover();
            await page.mouse.wheel(0, -100_000);
          } else {
            await page.locator(".chat-scroll-to-bottom").waitFor({ state: "visible" });
            // Chromium can commit its last canceled animation offset after the
            // pointer action returns. Capture the reader before releasing text.
            await waitForChatScrollIdle(page);
          }
          const interruptedOffset = await thread.evaluate((element) => element.scrollTop);
          if (interruption === "wheel") {
            await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
          } else {
            expect(interruptedOffset).toBeGreaterThan(0);
            expect(interruptedOffset).toBeLessThan(during.max);
          }
          const interruptedAnchor = await captureTopVisibleVirtualRow(thread);
          // Native smooth scrolling can pass the first message before the pointer
          // arrives. Recover a still-mounted pending row above the settled reader.
          const messageId =
            interruption === "native-pointer"
              ? await thread.evaluate((element) => {
                  const top = element.getBoundingClientRect().top;
                  const bubbles = Array.from(
                    element.querySelectorAll<HTMLElement>(
                      '.chat-bubble[data-entry-id^="sizing-message-"]',
                    ),
                  );
                  const bubble = bubbles.findLast(
                    (candidate) =>
                      Number(candidate.dataset.entryId!.slice("sizing-message-".length)) % 2 ===
                        1 &&
                      candidate.closest(".chat-virtual-row")!.getBoundingClientRect().bottom <= top,
                  );
                  return bubble?.dataset.entryId ?? null;
                })
              : "sizing-message-1";
          expect(messageId).not.toBeNull();
          const recoveredIndex = Number(messageId!.slice("sizing-message-".length));
          const nextMessageId = `sizing-message-${recoveredIndex + 1}`;
          const bubble = page.locator(`.chat-bubble[data-entry-id="${messageId}"]`);
          const requestMatcher = expect.objectContaining({
            params: expect.objectContaining({ messageId }),
          });
          const pendingRequest = (await gateway.getRequests("chat.message.get")).findLast(
            (request) => requestMatcher.asymmetricMatch(request),
          );
          expect(pendingRequest).toBeDefined();
          const initial = await bubble.evaluate((element) => {
            const row = element.closest<HTMLElement>(".chat-virtual-row")!;
            return {
              key: row.dataset.virtualRowKey,
              height: row.offsetHeight,
              bottom: row.getBoundingClientRect().bottom,
              viewportTop: row.closest(".chat-thread")!.getBoundingClientRect().top,
            };
          });
          if (interruption !== "wheel") {
            expect(
              initial.bottom <= initial.viewportTop,
              `recovered row must remain mounted ${recoveryPosition}`,
            ).toBe(recoveryPosition === "above-viewport");
          }
          const fullText = Array.from(
            { length: 5 },
            (_, index) =>
              `Recovered paragraph ${index + 1}. ${"All wrapped lines must reserve space before the next user message. ".repeat(5)}`,
          ).join("\n\n");
          await gateway.deliverLatest({
            type: "res",
            id: pendingRequest!.id,
            ok: true,
            payload: { ok: true, message: { role: "assistant", content: fullText } },
          });
          await bubble.getByText("Recovered paragraph 1.", { exact: false }).waitFor();
          await waitForChatScrollIdle(page);
          // Outlast virtual-core's five-second scroll reconciliation deadline:
          // the assertion protects durable geometry, not a transient resize frame.
          const final = await bubble.evaluate(async (element, nextId) => {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 5_500);
            });
            const row = element.closest<HTMLElement>(".chat-virtual-row")!;
            const scroller = row.closest<HTMLElement>(".chat-thread")!;
            const next = scroller
              .querySelector(`.chat-bubble[data-entry-id="${nextId}"]`)!
              .closest<HTMLElement>(".chat-virtual-row")!;
            const rect = row.getBoundingClientRect();
            return {
              key: row.dataset.virtualRowKey,
              height: row.offsetHeight,
              top: rect.top,
              bottom: rect.bottom,
              nextTop: next.getBoundingClientRect().top,
              gap: next.getBoundingClientRect().top - rect.bottom,
              returnOffset: scroller.scrollTop + rect.top - scroller.getBoundingClientRect().top,
            };
          }, nextMessageId);
          const finalAnchor = await captureTopVisibleVirtualRow(thread);
          await page.screenshot({ path: path.join(artifactDir, "02-after-interruption.png") });
          await fs.writeFile(
            path.join(artifactDir, "interrupted-scroll.json"),
            JSON.stringify(
              { initial, during, interruptedOffset, interruptedAnchor, final, finalAnchor },
              null,
              2,
            ),
          );
          if (interruption !== "wheel") {
            // Growth above the reader legitimately adjusts scrollTop; the visible
            // row must stay anchored regardless of where the pointer stopped scrolling.
            expect(finalAnchor.key).toBe(interruptedAnchor.key);
            expect(
              Math.abs(finalAnchor.viewportTop - interruptedAnchor.viewportTop),
            ).toBeLessThanOrEqual(1);
            if (interruption === "synthetic-pointer") {
              expect(
                Math.abs(
                  (await thread.evaluate((element) => element.scrollTop)) - interruptedOffset,
                ),
              ).toBeLessThanOrEqual(1);
            }
          }
          expect(final.key).toBe(initial.key);
          expect(final.height).toBeGreaterThan(initial.height);
          expect(
            Math.abs(final.gap),
            JSON.stringify({ initial, during, final }),
          ).toBeLessThanOrEqual(1);
          // Leaving and returning must use the recovered size in the virtual
          // range too, not merely conceal stale cached geometry with DOM flow.
          if (recoveredIndex < 30) {
            await page.locator(".chat-scroll-to-bottom").click();
            await expect
              .poll(() =>
                thread.evaluate((element) =>
                  Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
                ),
              )
              .toBeLessThanOrEqual(2);
            await page
              .locator('.chat-bubble[data-entry-id="sizing-message-59"]')
              .waitFor({ state: "visible" });
          } else {
            await thread.hover();
            await page.mouse.wheel(0, -100_000);
            await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
          }
          await expect.poll(() => bubble.count()).toBe(0);
          await thread.evaluate((element, offset) => {
            element.scrollTop = offset;
          }, final.returnOffset);
          await bubble
            .getByText("Recovered paragraph 1.", { exact: false })
            .waitFor({ state: "visible" });
          await waitForChatScrollIdle(page);
          const returned = await bubble.evaluate((element, nextId) => {
            const row = element.closest<HTMLElement>(".chat-virtual-row")!;
            const next = row
              .closest(".chat-thread")!
              .querySelector(`.chat-bubble[data-entry-id="${nextId}"]`)!
              .closest<HTMLElement>(".chat-virtual-row")!;
            return {
              height: row.offsetHeight,
              gap: next.getBoundingClientRect().top - row.getBoundingClientRect().bottom,
            };
          }, nextMessageId);
          expect(returned.height).toBe(final.height);
          expect(Math.abs(returned.gap)).toBeLessThanOrEqual(1);
          await page.screenshot({ path: path.join(artifactDir, "03-after-return.png") });
          await thread.evaluate(
            (element, offset) => {
              element.scrollTop = offset;
            },
            final.returnOffset + Math.min(300, final.height / 2),
          );
          await waitForChatScrollIdle(page);
          await page.screenshot({ path: path.join(artifactDir, "04-visible-adjacency.png") });
        },
      );
    },
  );

  it("tracks late intrinsic image growth through a transcript remount", async () => {
    await suite.withPage(
      { reducedMotion: "reduce", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const imageUrl = `${suite.server.baseUrl}sizing-image.png`;
        const imageData = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 480;
          canvas.height = 240;
          canvas.getContext("2d")!.fillRect(0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/png").split(",")[1]!;
        });
        let releaseImage!: () => void;
        const imageReady = new Promise<void>((resolve) => {
          releaseImage = resolve;
        });
        await page.route(imageUrl, async (route) => {
          await imageReady;
          await route.fulfill({ contentType: "image/png", body: Buffer.from(imageData, "base64") });
        });
        await installMockGateway(page, {
          historyMessages: Array.from({ length: 60 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content:
              index === 1
                ? [
                    { type: "text", text: "Delayed image." },
                    { type: "image", url: imageUrl, alt: "Intrinsic size proof" },
                  ]
                : `Image fixture message ${index}.`,
            timestamp: index + 1,
            __openclaw: { id: `image-message-${index}`, seq: index + 1 },
          })),
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await page.getByText("Image fixture message 59.", { exact: false }).waitFor();
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        const image = thread.getByRole("img", { name: "Intrinsic size proof" });
        await image.waitFor({ state: "attached" });
        const rowHeight = () =>
          image.evaluate(
            (element) => element.closest<HTMLElement>(".chat-virtual-row")!.offsetHeight,
          );
        const initialHeight = await rowHeight();
        releaseImage();
        await expect
          .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalHeight))
          .toBe(240);
        await expect.poll(rowHeight).toBeGreaterThan(initialHeight + 100);
        const height = await rowHeight();
        const gap = () =>
          image.evaluate((element) => {
            const row = element.closest<HTMLElement>(".chat-virtual-row")!;
            const next = row
              .closest(".chat-thread")!
              .querySelector('.chat-bubble[data-entry-id="image-message-2"]')!
              .closest<HTMLElement>(".chat-virtual-row")!;
            return next.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
          });
        expect(Math.abs(await gap())).toBeLessThanOrEqual(1);
        await page.locator(".chat-scroll-to-bottom").click();
        await expect.poll(() => image.count()).toBe(0);
        await expect
          .poll(() =>
            thread.evaluate((element) =>
              Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
            ),
          )
          .toBeLessThanOrEqual(2);
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        await image.waitFor({ state: "visible" });
        await expect.poll(rowHeight).toBe(height);
        expect(Math.abs(await gap())).toBeLessThanOrEqual(1);
      },
    );
  });

  it("keeps completed-work and tool disclosures anchored on every expand and collapse frame", async () => {
    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.browser.newContext({
      reducedMotion: "reduce",
      viewport: { height: 800, width: 1400 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 800, width: 1400 } } }
        : {}),
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:dashboard:disclosure-geometry";
    const transcriptPrefix = Array.from({ length: 12 }, (_, index) => [
      {
        role: "user",
        content: `Earlier prompt ${index + 1}: keep enough transcript above the active row to make the pane scroll.`,
        timestamp: index * 2 + 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `Earlier response ${index + 1}.` }],
        timestamp: index * 2 + 2,
      },
    ]).flat();
    await installMockGateway(page, {
      sessionKey,
      featureMethods: ["board.get", "chat.history", "chat.metadata", "chat.startup"],
      methodResponses: {
        "board.get": {
          sessionKey,
          revision: 1,
          tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
          widgets: [],
        },
      },
      historyMessages: [
        ...transcriptPrefix,
        {
          role: "user",
          content: "Inspect the transcript implementation and run its focused tests.",
          timestamp: 99,
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-anchor",
              name: "bash",
              arguments: { command: "pnpm test ui/src/pages/chat" },
            },
            {
              type: "toolCall",
              id: "call-anchor-read",
              name: "read",
              arguments: { path: "ui/src/pages/chat/components/chat-tool-cards.ts" },
            },
          ],
          timestamp: 100,
        },
        {
          role: "toolResult",
          toolCallId: "call-anchor",
          toolName: "bash",
          content: [
            {
              type: "text",
              text: Array.from(
                { length: 24 },
                (_, index) => `Focused test ${index + 1}: passed with stable transcript geometry.`,
              ).join("\n"),
            },
          ],
          timestamp: 101,
        },
        {
          role: "toolResult",
          toolCallId: "call-anchor-read",
          toolName: "read",
          content: [{ type: "text", text: "export function renderToolCard() {}" }],
          timestamp: 102,
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The transcript implementation is sound and all focused tests pass.",
            },
          ],
          timestamp: 103,
        },
        ...Array.from({ length: 3 }, (_, index) => [
          {
            role: "user",
            content: `Follow-up ${index + 1}: record the next transcript observation.`,
            timestamp: 104 + index * 2,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: `Observation ${index + 1} recorded.` }],
            timestamp: 105 + index * 2,
          },
        ]).flat(),
        {
          role: "user",
          content: "Run one short sibling tool check.",
          timestamp: 110,
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-sibling",
              name: "bash",
              arguments: {
                command: "pnpm test ui/src/pages/chat/components/chat-tool-cards.test.ts",
              },
            },
          ],
          timestamp: 111,
        },
        {
          role: "toolResult",
          toolCallId: "call-sibling",
          toolName: "bash",
          content: [{ type: "text", text: "Focused sibling passed." }],
          timestamp: 112,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "The sibling tool check passed." }],
          timestamp: 113,
        },
      ],
    });

    await showSplitDashboard(page, sessionKey);
    const workSummaries = page.locator(".chat-work-group > .chat-activity-group__summary");
    await expect.poll(() => workSummaries.count()).toBe(2);
    const middleWorkSummary = workSummaries.first();
    const endWorkSummary = workSummaries.last();
    await waitForChatScrollIdle(page);
    expect(Math.abs(await chatThreadDistanceFromBottom(page))).toBeLessThanOrEqual(2);
    const traces: Record<string, DisclosureFrame[]> = {};
    traces.workEndExpand = await toggleDisclosureWithFrameTrace(page, endWorkSummary);
    traces.workEndCollapse = await toggleDisclosureWithFrameTrace(page, endWorkSummary);

    await middleWorkSummary.evaluate((button) => {
      const row = button.closest<HTMLElement>(".chat-virtual-row");
      const thread = button.closest<HTMLElement>(".chat-thread");
      if (!row || !thread) {
        throw new Error("Expected disclosure inside a virtual transcript row");
      }
      const rowTop = row.getBoundingClientRect().top - thread.getBoundingClientRect().top;
      thread.scrollTop += Math.round(rowTop - thread.clientHeight / 2);
    });
    await waitForChatScrollIdle(page);
    traces.workMiddleExpand = await toggleDisclosureWithFrameTrace(page, middleWorkSummary);
    const activitySummary = page
      .locator(
        ".chat-group--activity > .chat-group-messages > .chat-activity-group > .chat-activity-group__summary",
      )
      .first();
    traces.activityMiddleExpand = await toggleDisclosureWithFrameTrace(page, activitySummary);
    const activityGroup = activitySummary.locator("..");
    const toolSummary = activityGroup
      .locator(".chat-tool-msg-summary")
      .filter({ hasText: "pnpm test ui/src/pages/chat" });
    traces.toolMiddleExpand = await toggleDisclosureWithFrameTrace(page, toolSummary);
    traces.toolMiddleCollapse = await toggleDisclosureWithFrameTrace(page, toolSummary);
    const fileToolToggle = activityGroup.locator(".chat-tool-row__toggle").first();
    traces.fileToolMiddleExpand = await toggleDisclosureWithFrameTrace(page, fileToolToggle);
    traces.fileToolMiddleCollapse = await toggleDisclosureWithFrameTrace(page, fileToolToggle);
    traces.activityMiddleCollapse = await toggleDisclosureWithFrameTrace(page, activitySummary);
    traces.workMiddleCollapse = await toggleDisclosureWithFrameTrace(page, middleWorkSummary);

    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(
        path.join(artifactDir, "disclosure-geometry.json"),
        `${JSON.stringify(traces, null, 2)}\n`,
      );
      await page.locator(".chat-main").screenshot({
        path: path.join(artifactDir, "disclosure-geometry-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
        .toBe("dark");
      await page.locator(".chat-main").screenshot({
        path: path.join(artifactDir, "disclosure-geometry-dark.png"),
      });
    }
    await context.close();
    for (const frames of Object.values(traces)) {
      expectStableDisclosureFrames(frames);
    }
  });

  it("keeps raw tool details anchored at the end and middle of a long transcript", async () => {
    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.browser.newContext({
      reducedMotion: "reduce",
      viewport: { height: 600, width: 900 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 600, width: 900 } } }
        : {}),
    });
    const page = await context.newPage();
    const transcriptPrefix = Array.from({ length: 14 }, (_, index) => [
      {
        role: "user",
        content: `Earlier raw-details prompt ${index + 1}.`,
        timestamp: index * 2 + 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `Earlier raw-details response ${index + 1}.` }],
        timestamp: index * 2 + 2,
      },
    ]).flat();
    await installMockGateway(page, {
      historyMessages: [
        ...transcriptPrefix,
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "raw-details-widget",
              name: "canvas_render",
              arguments: { title: "Disclosure geometry proof" },
            },
            {
              type: "tool_result",
              id: "raw-details-widget",
              name: "canvas_render",
              text: JSON.stringify(
                {
                  kind: "canvas",
                  proof: Array.from(
                    { length: 24 },
                    (_, index) => `Focused test ${index + 1}: passed with stable geometry.`,
                  ),
                  view: {
                    backend: "canvas",
                    id: "disclosure-geometry-proof",
                    url: "/__openclaw__/canvas/documents/disclosure-geometry-proof/index.html",
                    title: "Disclosure geometry proof",
                    preferred_height: 160,
                  },
                  presentation: { target: "assistant_message" },
                },
                null,
                2,
              ),
            },
          ],
          timestamp: 100,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Disclosure geometry proof rendered." }],
          timestamp: 101,
        },
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const toolSummary = page.locator(".chat-tool-msg-summary");
    await toolSummary.waitFor();
    await waitForChatScrollIdle(page);
    expectStableDisclosureFrames(await toggleDisclosureWithFrameTrace(page, toolSummary));
    const widgetHost = page.locator(".chat-tool-card__widget-host");
    const rawDetailsToggle = widgetHost.locator(".chat-tool-card__raw-toggle");
    await rawDetailsToggle.waitFor({ state: "attached" });
    await page.locator(".chat-thread").evaluate((thread) => {
      thread.scrollTop = thread.scrollHeight;
    });
    await waitForChatScrollIdle(page);
    expect(Math.abs(await chatThreadDistanceFromBottom(page))).toBeLessThanOrEqual(2);
    const traces: Record<string, DisclosureFrame[]> = {};
    // Menu selection already proves it clicks this toggle; exclude the popup's
    // own close/reposition geometry from the transcript-anchor measurement.
    traces.rawDetailsEndExpand = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);
    traces.rawDetailsEndCollapse = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);

    await rawDetailsToggle.evaluate((button) => {
      const row = button.closest<HTMLElement>(".chat-virtual-row");
      const thread = button.closest<HTMLElement>(".chat-thread");
      if (!row || !thread) {
        throw new Error("Expected raw-details disclosure inside a virtual transcript row");
      }
      const rowTop = row.getBoundingClientRect().top - thread.getBoundingClientRect().top;
      thread.scrollTop += Math.round(rowTop - thread.clientHeight / 2);
    });
    await waitForChatScrollIdle(page);
    traces.rawDetailsMiddleExpand = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);

    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.writeFile(
        path.join(artifactDir, "raw-details-geometry.json"),
        `${JSON.stringify(traces, null, 2)}\n`,
      );
      await page.locator(".chat-main").screenshot({
        path: path.join(artifactDir, "raw-details-geometry-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
        .toBe("dark");
      await page.locator(".chat-main").screenshot({
        path: path.join(artifactDir, "raw-details-geometry-dark.png"),
      });
    }
    traces.rawDetailsMiddleCollapse = await toggleDisclosureWithFrameTrace(page, rawDetailsToggle);
    const video = page.video();
    await context.close();
    if (artifactDir) {
      await video?.saveAs(path.join(artifactDir, "raw-details-geometry.webm"));
    }
    for (const [label, frames] of Object.entries(traces)) {
      expectStableDisclosureFrames(frames, label);
    }
  });

  it("keeps message and JSON disclosures anchored in a long transcript", async () => {
    const context = await suite.browser.newContext({
      reducedMotion: "reduce",
      viewport: { height: 600, width: 900 },
    });
    const page = await context.newPage();
    const transcriptPrefix = Array.from({ length: 12 }, (_, index) => [
      {
        role: "user",
        content: `Earlier sibling-disclosure prompt ${index + 1}.`,
        timestamp: index * 2 + 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `Earlier sibling-disclosure response ${index + 1}.` }],
        timestamp: index * 2 + 2,
      },
    ]).flat();
    await installMockGateway(page, {
      historyMessages: [
        ...transcriptPrefix,
        {
          role: "user",
          content: `User disclosure anchor marker. ${"A wrapped prompt line that must remain visually anchored. ".repeat(24)}`,
          timestamp: 100,
        },
        {
          role: "assistant",
          content: JSON.stringify({
            marker: "json-disclosure-anchor-marker",
            rows: Array.from(
              { length: 30 },
              (_, index) => `JSON disclosure proof row ${index + 1}`,
            ),
          }),
          timestamp: 101,
        },
        {
          role: "assistant",
          content: `\`\`\`text\n${"A wide transcript code line that must wrap without moving its virtual row. ".repeat(24)}\n\`\`\``,
          timestamp: 102,
        },
        {
          role: "user",
          content: "Keep both sibling disclosures above this final exchange.",
          timestamp: 103,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Both sibling disclosures are ready." }],
          timestamp: 104,
        },
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await waitForChatScrollIdle(page);
    const userToggle = page
      .locator(".chat-message-disclosure")
      .filter({ hasText: "User disclosure anchor marker" })
      .locator(".chat-message-disclosure__toggle");
    const jsonSummary = page
      .locator(".chat-json-collapse")
      .filter({ hasText: "json-disclosure-anchor-marker" })
      .locator("summary");
    await userToggle.waitFor();
    await jsonSummary.waitFor();
    const wrapToggle = page.locator(".code-block-wrap");
    await wrapToggle.waitFor({ state: "visible" });
    const traces: Record<string, DisclosureFrame[]> = {};
    traces.userMessageExpand = await toggleDisclosureWithFrameTrace(page, userToggle);
    traces.userMessageCollapse = await toggleDisclosureWithFrameTrace(page, userToggle);
    traces.jsonExpand = await toggleDisclosureWithFrameTrace(page, jsonSummary);
    traces.jsonCollapse = await toggleDisclosureWithFrameTrace(page, jsonSummary);
    traces.codeWrap = await toggleDisclosureWithFrameTrace(page, wrapToggle);
    traces.codeUnwrap = await toggleDisclosureWithFrameTrace(page, wrapToggle);
    await context.close();
    for (const [label, frames] of Object.entries(traces)) {
      expectStableDisclosureFrames(frames, label);
    }
  });
});
