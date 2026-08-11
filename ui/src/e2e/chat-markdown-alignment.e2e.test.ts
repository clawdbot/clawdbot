import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "chat Markdown alignment",
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("aligns Markdown markers and text while containing expanded disclosures", async () => {
    const longJson = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`field-${index + 1}`, index + 1]),
      ),
      null,
      2,
    );
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 800, width: 1180 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            {
              content: [
                {
                  type: "text",
                  text: [
                    "## Alignment check",
                    "",
                    "- Bullet item",
                    "",
                    "1. Numbered item",
                    "",
                    "- [ ] Unchecked task",
                    "",
                    "<details open>",
                    "<summary>More details</summary>",
                    "",
                    "Disclosure body",
                    "</details>",
                    "",
                    "<details>",
                    "<summary>Collapsed details</summary>",
                    "Hidden body",
                    "</details>",
                    "",
                    "```json",
                    longJson,
                    "```",
                  ].join("\n"),
                },
              ],
              role: "assistant",
              timestamp: Date.now(),
            },
          ],
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        const markdown = page.locator(".chat-group.assistant .chat-text", {
          hasText: "Alignment check",
        });
        await markdown.waitFor();

        const geometry = await markdown.evaluate((root) => {
          const textRect = (selector: string) => {
            const element = root.querySelector(selector);
            if (!element) {
              throw new Error(`Missing element for ${selector}`);
            }
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let text = walker.nextNode();
            while (text && !text.textContent?.trim()) {
              text = walker.nextNode();
            }
            if (!text) {
              throw new Error(`Missing text for ${selector}`);
            }
            const range = document.createRange();
            range.selectNodeContents(text);
            return range.getBoundingClientRect();
          };
          const checkbox = root.querySelector(".task-list-item-checkbox");
          const details = root.querySelector("details:not(.json-collapse)[open]");
          const summary = root.querySelector("details:not(.json-collapse)[open] > summary");
          if (!checkbox || !details || !summary) {
            throw new Error("Missing task-list or disclosure markup");
          }
          const detailsStyle = getComputedStyle(details);
          const summaryStyle = getComputedStyle(summary);
          const checkboxRect = checkbox.getBoundingClientRect();
          const taskTextRect = textRect(".task-list-item");
          const collapsedSummary = root.querySelector(
            "details:not(.json-collapse):not([open]) > summary",
          );
          const jsonCollapse = root.querySelector("details.json-collapse");
          const jsonSummary = root.querySelector("details.json-collapse > summary");
          const jsonCopy = root.querySelector("details.json-collapse .code-block-copy");
          if (!collapsedSummary || !jsonCollapse || !jsonSummary || !jsonCopy) {
            throw new Error("Missing authored or JSON disclosure markup");
          }
          const closedChevronStyle = getComputedStyle(collapsedSummary, "::after");
          const collapsedSummaryRect = collapsedSummary.getBoundingClientRect();
          const collapsedSummaryTextRect = textRect(
            "details:not(.json-collapse):not([open]) > summary",
          );
          const jsonCollapseStyle = getComputedStyle(jsonCollapse);
          const jsonSummaryStyle = getComputedStyle(jsonSummary);
          return {
            bodyTextX: textRect("details:not(.json-collapse) > p").x,
            borderInlineStartWidth: detailsStyle.borderInlineStartWidth,
            bulletTextX: textRect("ul:not(.contains-task-list) > li").x,
            checkboxGap: taskTextRect.x - checkboxRect.right,
            checkboxLineCenterDelta:
              checkboxRect.y + checkboxRect.height / 2 - (taskTextRect.y + taskTextRect.height / 2),
            checkboxSize: checkboxRect.width,
            chevronClosedTransform: closedChevronStyle.transform,
            chevronInlineEnd: closedChevronStyle.insetInlineEnd,
            chevronTransitionDuration: closedChevronStyle.transitionDuration,
            chevronWidth: closedChevronStyle.width,
            collapsedSummaryPaddingInlineEnd: getComputedStyle(collapsedSummary).paddingInlineEnd,
            collapsedSummaryTextRight: collapsedSummaryTextRect.right,
            collapsedSummaryTextX: collapsedSummaryTextRect.x,
            collapsedSummaryRight: collapsedSummaryRect.right,
            detailsX: details.getBoundingClientRect().x,
            jsonBorderInlineStartWidth: jsonCollapseStyle.borderInlineStartWidth,
            jsonCopyFloat: getComputedStyle(jsonCopy).float,
            jsonDetailsX: jsonCollapse.getBoundingClientRect().x,
            jsonSummaryDisplay: jsonSummaryStyle.display,
            jsonSummaryPaddingInlineStart: jsonSummaryStyle.paddingInlineStart,
            numberedTextX: textRect("ol > li").x,
            rootX: root.getBoundingClientRect().x,
            summaryMarginBottom: summaryStyle.marginBottom,
            summaryTextX: textRect("details[open] > summary").x,
            taskTextX: taskTextRect.x,
          };
        });

        const textStarts = [
          geometry.bulletTextX,
          geometry.numberedTextX,
          geometry.taskTextX,
          geometry.summaryTextX,
          geometry.collapsedSummaryTextX,
        ];
        expect(Math.max(...textStarts) - Math.min(...textStarts)).toBeLessThanOrEqual(1);
        expect(geometry.checkboxGap).toBeGreaterThanOrEqual(7);
        expect(geometry.checkboxGap).toBeLessThanOrEqual(9);
        expect(Math.abs(geometry.checkboxLineCenterDelta)).toBeLessThanOrEqual(1);
        expect(geometry.checkboxSize).toBe(16);
        expect(geometry.bodyTextX - geometry.rootX).toBeGreaterThanOrEqual(28);
        expect(geometry.detailsX).toBeGreaterThan(geometry.rootX);
        expect(geometry.detailsX).toBeLessThan(geometry.bodyTextX);
        expect(Number.parseFloat(geometry.borderInlineStartWidth)).toBeGreaterThan(0);
        expect(Number.parseFloat(geometry.summaryMarginBottom)).toBeGreaterThan(0);
        expect(Number.parseFloat(geometry.chevronWidth)).toBe(16);
        expect(Number.parseFloat(geometry.chevronInlineEnd)).toBe(0);
        expect(Number.parseFloat(geometry.collapsedSummaryPaddingInlineEnd)).toBeGreaterThanOrEqual(
          24,
        );
        expect(geometry.collapsedSummaryRight - geometry.collapsedSummaryTextRight).toBeGreaterThan(
          24,
        );
        expect(geometry.chevronTransitionDuration).not.toBe("0s");
        expect(Math.abs(geometry.jsonDetailsX - geometry.rootX)).toBeLessThanOrEqual(1);
        expect(Number.parseFloat(geometry.jsonBorderInlineStartWidth)).toBe(0);
        expect(geometry.jsonSummaryDisplay).toBe("list-item");
        expect(Number.parseFloat(geometry.jsonSummaryPaddingInlineStart)).toBe(8);
        expect(geometry.jsonCopyFloat).toBe("right");

        const collapsedSummary = markdown.locator("summary", { hasText: "Collapsed details" });
        await collapsedSummary.click();
        await expect
          .poll(() =>
            collapsedSummary.evaluate((summary) => getComputedStyle(summary, "::after").transform),
          )
          .not.toBe(geometry.chevronClosedTransform);
      },
    );
  });

  it("preserves the shared Markdown gutter in RTL transcripts", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "ar",
        serviceWorkers: "block",
        viewport: { height: 800, width: 1180 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            {
              content: [
                {
                  type: "text",
                  text: [
                    "## فحص المحاذاة",
                    "",
                    "- عنصر نقطي",
                    "",
                    "1. عنصر مرقم",
                    "",
                    "- [ ] مهمة غير مكتملة",
                    "",
                    "<details open>",
                    "<summary>تفاصيل إضافية</summary>",
                    "",
                    "محتوى التفاصيل",
                    "</details>",
                  ].join("\n"),
                },
              ],
              role: "assistant",
              timestamp: Date.now(),
            },
          ],
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        const markdown = page.locator(".chat-group.assistant .chat-text[dir='rtl']", {
          hasText: "فحص المحاذاة",
        });
        await markdown.waitFor();

        const geometry = await markdown.evaluate((root) => {
          const textRight = (selector: string) => {
            const element = root.querySelector(selector);
            if (!element) {
              throw new Error(`Missing element for ${selector}`);
            }
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let text = walker.nextNode();
            while (text && !text.textContent?.trim()) {
              text = walker.nextNode();
            }
            if (!text) {
              throw new Error(`Missing text for ${selector}`);
            }
            const range = document.createRange();
            range.selectNodeContents(text);
            return range.getBoundingClientRect().right;
          };
          const checkbox = root.querySelector(".task-list-item-checkbox");
          const task = root.querySelector(".task-list-item");
          const unorderedList = root.querySelector("ul:not(.contains-task-list)");
          const orderedList = root.querySelector("ol");
          const summary = root.querySelector("details:not(.json-collapse) > summary");
          if (!checkbox || !task || !unorderedList || !orderedList || !summary) {
            throw new Error("Missing RTL Markdown geometry");
          }
          const checkboxRect = checkbox.getBoundingClientRect();
          return {
            checkboxGap: checkboxRect.left - textRight(".task-list-item"),
            chevronInlineEnd: getComputedStyle(summary, "::after").insetInlineEnd,
            orderedPaddingInlineStart: getComputedStyle(orderedList).paddingInlineStart,
            textStarts: [
              textRight("ul:not(.contains-task-list) > li"),
              textRight("ol > li"),
              textRight(".task-list-item"),
              textRight("details:not(.json-collapse) > summary"),
            ],
            unorderedPaddingInlineStart: getComputedStyle(unorderedList).paddingInlineStart,
          };
        });

        expect(
          Math.max(...geometry.textStarts) - Math.min(...geometry.textStarts),
        ).toBeLessThanOrEqual(1);
        expect(Number.parseFloat(geometry.unorderedPaddingInlineStart)).toBe(32);
        expect(Number.parseFloat(geometry.orderedPaddingInlineStart)).toBe(32);
        expect(geometry.checkboxGap).toBeGreaterThanOrEqual(7);
        expect(geometry.checkboxGap).toBeLessThanOrEqual(9);
        expect(Number.parseFloat(geometry.chevronInlineEnd)).toBe(0);
      },
    );
  });
});
