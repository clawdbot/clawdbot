import { expect, it, vi } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Transcript focused row placement",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("keeps a focused message action mounted while its row scrolls out of view", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1280, height: 800 } });
    const messages = Array.from({ length: 200 }, (_, index) => ({
      __openclaw: { seq: index + 1 },
      content: [
        {
          type: "text",
          text: `focus retention message ${index + 1}\n${"transcript detail line\n".repeat(3)}`,
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: Date.now() + index,
    }));
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: {
        "chat.startup": {
          messages,
          hasMore: false,
          totalMessages: messages.length,
          sessionId: "focus-retention",
          thinkingLevel: null,
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText(/^focus retention message 200\n/).waitFor();
    const thread = page.locator(".chat-thread");
    const action = thread.locator("button.chat-reply-btn").last();
    await action.focus();
    const focusedRowKey = await action.evaluate(
      (element) => element.closest<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey ?? "",
    );
    expect(focusedRowKey).not.toBe("");

    await thread.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => thread.evaluate((element) => Math.round(element.scrollTop))).toBe(0);
    await page.getByText(/^focus retention message 1\n/).waitFor();
    await expect
      .poll(() =>
        thread.evaluate((element, key) => {
          const row = Array.from(
            element.querySelectorAll<HTMLElement>(".chat-virtual-row[data-virtual-row-key]"),
          ).find((candidate) => candidate.dataset.virtualRowKey === key);
          return Boolean(row?.contains(document.activeElement));
        }, focusedRowKey),
      )
      .toBe(true);
    expect(await thread.locator(".chat-virtual-row").count()).toBeLessThan(30);

    const checkPlacement = async (edge: "first" | "last", sparse: boolean) => {
      // Focused outliers stay mounted, so text visibility can precede the new
      // virtual range. Wait for placement, keeping the same geometry bounds.
      await vi.waitFor(async () => {
        const placement = await thread.evaluate((element, placementEdge) => {
          const rows = [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")];
          const sizer = element.querySelector<HTMLElement>(".chat-virtual-sizer")!;
          const focused = document.activeElement?.closest<HTMLElement>(".chat-virtual-row");
          const edgeRow = placementEdge === "first" ? rows[0]! : rows.at(-1)!;
          const gaps = rows.slice(1).map((row, index) => ({
            skipped: Number(row.dataset.index) - Number(rows[index]!.dataset.index) - 1,
            pixels: row.getBoundingClientRect().top - rows[index]!.getBoundingClientRect().bottom,
          }));
          return {
            focused: focused === edgeRow,
            edgeDelta:
              placementEdge === "first"
                ? edgeRow.getBoundingClientRect().top - sizer.getBoundingClientRect().top
                : sizer.getBoundingClientRect().bottom - edgeRow.getBoundingClientRect().bottom,
            gaps,
            count: rows.length,
          };
        }, edge);
        expect(placement.focused).toBe(true);
        expect(Math.abs(placement.edgeDelta)).toBeLessThanOrEqual(2);
        expect(placement.count).toBeLessThan(30);
        expect(placement.gaps.filter((gap) => gap.skipped > 0)).toHaveLength(sparse ? 1 : 0);
        for (const gap of placement.gaps) {
          if (gap.skipped > 0) {
            expect(gap.pixels).toBeGreaterThan(1000);
          } else {
            expect(Math.abs(gap.pixels)).toBeLessThanOrEqual(1);
          }
        }
      });
    };
    await checkPlacement("last", true);
    await thread.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.getByText(/^focus retention message 200\n/).waitFor({ state: "visible" });
    await checkPlacement("last", false);

    await thread.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByText(/^focus retention message 1\n/).waitFor({ state: "visible" });
    await thread.locator("button.chat-reply-btn").first().focus();
    await thread.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.getByText(/^focus retention message 200\n/).waitFor({ state: "visible" });
    await checkPlacement("first", true);
    await thread.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByText(/^focus retention message 1\n/).waitFor({ state: "visible" });
    await checkPlacement("first", false);
    await page.close();
  });
});
