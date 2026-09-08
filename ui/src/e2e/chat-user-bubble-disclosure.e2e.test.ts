import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps seven short lines fully visible", async () => {
    const text = [
      "please re-review these:",
      "#127818",
      "#127826",
      "#127844",
      "#127881",
      "",
      "rerun the same session we had for these",
    ].join("\n");
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const bubble = page.locator(".chat-group.user .chat-bubble");
      await bubble.waitFor({ state: "visible", timeout: 10_000 });
      if (captureUiProofEnabled) {
        await bubble.screenshot({
          path: path.join(suite.artifactDir, "user-bubble-clamp", "short-message.png"),
        });
      }

      expect(await bubble.getByRole("button", { name: "Show more" }).count()).toBe(0);
      expect(await bubble.locator(".chat-message-disclosure").count()).toBe(0);
      const bubbleText = await bubble.textContent();
      for (const line of text.split("\n").filter(Boolean)) {
        expect(bubbleText).toContain(line);
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("clamps a 1300-character prompt to five lines and toggles the complete prompt", async () => {
    const text =
      `${"This long prompt stays mounted while its preview is clamped. ".repeat(22)}Final prompt tail.`.slice(
        0,
        1_300,
      );
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const bubble = page.locator(".chat-group.user .chat-bubble");
      await bubble.waitFor({ state: "visible", timeout: 10_000 });
      const content = bubble.locator(".chat-message-disclosure__content");
      const toggle = bubble.getByRole("button", { name: "Show more" });

      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      const lineHeight = await content
        .locator(".chat-text")
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
      expect((await content.textContent())?.trim()).toBe(text);
      const collapsedHeight = await content.evaluate((element) => element.clientHeight);
      expect(collapsedHeight).toBeLessThanOrEqual(5 * lineHeight + 1);
      expect(await content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true,
      );
      if (captureUiProofEnabled) {
        await bubble.screenshot({
          path: path.join(suite.artifactDir, "user-bubble-clamp", "long-message-collapsed.png"),
        });
      }

      await toggle.click();
      const collapse = bubble.getByRole("button", { name: "Show less" });
      expect(await collapse.getAttribute("aria-expanded")).toBe("true");
      expect(await content.evaluate((element) => element.clientHeight)).toBeGreaterThan(
        collapsedHeight,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ])(
    "keeps collapsed paragraphs readable after reload and browser reveal ($name)",
    async (viewport) => {
      const paragraphs = [
        ...Array.from(
          { length: 8 },
          (_, index) =>
            `Background paragraph ${index + 1}. Please review the synthetic project notes and summarize the next steps. Keep the explanation clear enough for someone reading the conversation later.`,
        ),
        ...["First", "Second"].map((label) =>
          [
            `${label} request:`,
            "<review_request>",
            "<input>Read the sample notes and explain the next step,",
            "then describe the expected result.</input>",
            "<context>The sample is ready for review.</context>",
            "</review_request>",
          ].join("\n"),
        ),
        "Final prompt tail: the complete request remains available.",
      ];
      const context = await suite.newBrowserContext({
        locale: "en-US",
        colorScheme: "light",
        serviceWorkers: "block",
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      await installMockGateway(page, {
        historyMessages: [
          { role: "user", content: paragraphs.join("\n\n"), timestamp: 1 },
          { role: "user", content: "Short follow-up request.", timestamp: 2 },
          { role: "assistant", content: "The sample review is complete.", timestamp: 3 },
        ],
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const bubble = page.locator(".chat-group.user .chat-bubble").first();
        const toggle = bubble.getByRole("button", { name: "Show more", exact: true });
        await toggle.waitFor({ state: "visible" });
        await page.reload();
        await toggle.waitFor({ state: "visible" });
        const content = bubble.locator(".chat-message-disclosure__content");
        const markdown = content.locator(".chat-text");
        const lineHeight = await markdown.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).lineHeight),
        );
        expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
        expect(await markdown.locator("p").allTextContents()).toEqual(paragraphs);

        // Browser descendant reveal can scroll an overflow-hidden preview without expanding it.
        const revealedParagraph = markdown.locator("p").nth(9);
        await revealedParagraph.scrollIntoViewIfNeeded();
        const geometry = await revealedParagraph.evaluate((paragraph) => {
          const clip = paragraph.closest(".chat-message-disclosure__content");
          if (!clip) {
            throw new Error("Missing user message preview");
          }
          const clipRect = clip.getBoundingClientRect();
          const paragraphRect = paragraph.getBoundingClientRect();
          // Read individual text nodes so BR boxes and duplicate element fragments are excluded.
          const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
          const lines: Array<{ top: number; bottom: number }> = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) {
              continue;
            }
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              if (rect.width > 0 && rect.height > 0) {
                lines.push({ top: rect.top, bottom: rect.bottom });
              }
            }
          }
          return {
            scrollTop: clip.scrollTop,
            clip: { top: clipRect.top, bottom: clipRect.bottom },
            paragraph: { top: paragraphRect.top, bottom: paragraphRect.bottom },
            lines,
          };
        });
        if (captureUiProofEnabled) {
          const artifactDir = path.join(suite.artifactDir, "user-bubble-clamp");
          await page.screenshot({ path: path.join(artifactDir, `${viewport.name}-revealed.png`) });
          await writeFile(
            path.join(artifactDir, `${viewport.name}-geometry.json`),
            `${JSON.stringify(geometry, null, 2)}\n`,
          );
        }
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(geometry.scrollTop).toBeGreaterThan(0);
        expect(
          geometry.lines.filter(
            (line) => line.top >= geometry.clip.top && line.bottom <= geometry.clip.bottom,
          ).length,
        ).toBeGreaterThan(0);
        expect(geometry.lines.length).toBeGreaterThanOrEqual(6);
        for (const line of geometry.lines) {
          expect(line.top, "text starts within its own paragraph").toBeGreaterThanOrEqual(
            geometry.paragraph.top - 1,
          );
          expect(
            line.bottom,
            "text ends within its own paragraph without overlapping the next",
          ).toBeLessThanOrEqual(geometry.paragraph.bottom + 1);
        }
        const collapsedHeight = await content.evaluate((element) => element.clientHeight);
        expect(collapsedHeight).toBeLessThanOrEqual(5 * lineHeight + 1);

        await toggle.click();
        const collapse = bubble.getByRole("button", { name: "Show less", exact: true });
        expect(await collapse.getAttribute("aria-expanded")).toBe("true");
        expect(await content.evaluate((element) => element.clientHeight)).toBeGreaterThan(
          collapsedHeight,
        );
        expect(
          await content.evaluate((element) => element.scrollHeight - element.clientHeight),
        ).toBeLessThanOrEqual(1);
        const tail = markdown.locator("p").last();
        await tail.scrollIntoViewIfNeeded();
        expect(await tail.textContent()).toBe(paragraphs.at(-1));
        if (captureUiProofEnabled) {
          await page.screenshot({
            path: path.join(
              suite.artifactDir,
              "user-bubble-clamp",
              `${viewport.name}-expanded-tail.png`,
            ),
          });
        }
        await collapse.click();
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(await content.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(
          5 * lineHeight + 1,
        );
        const siblings = page.locator(".chat-group .chat-bubble");
        expect(await siblings.nth(1).textContent()).toContain("Short follow-up request.");
        expect(await siblings.nth(2).textContent()).toContain("The sample review is complete.");
        const boxes = await siblings.evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          }),
        );
        expect(boxes).toHaveLength(3);
        for (const [index, box] of boxes.entries()) {
          const previous = boxes[index - 1];
          if (previous) {
            expect(previous.bottom).toBeLessThanOrEqual(box.top + 1);
          }
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
