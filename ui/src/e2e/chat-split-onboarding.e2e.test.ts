import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "split-onboarding");

suite.define(() => {
  it("shows the split-view onboarding once and persists dismissal", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ type: "text", text: "Split onboarding proof." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
      methodResponses: { "sessions.list": chatSessionListResponse() },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Split onboarding proof.").waitFor();

      const splitEntry = page.getByRole("button", { name: "Open split view" });
      await expect.poll(() => splitEntry.isVisible()).toBe(true);
      expect(await page.locator(".chat-split-onboarding").count()).toBe(0);

      await splitEntry.click();
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expect.poll(() => panes.count()).toBe(2);
      const onboarding = page.locator(".chat-split-onboarding");
      await expect.poll(() => onboarding.count()).toBe(1);
      const inactivePane = panes.first();
      const activePane = panes.last();
      await expect.poll(() => activePane.locator(".chat-split-onboarding").count()).toBe(1);
      expect(await inactivePane.locator(".chat-split-onboarding").count()).toBe(0);

      const copy = activePane.locator(".chat-split-onboarding__copy");
      await expect
        .poll(() => copy.textContent())
        .toBe("Select another session to show it in this column.");
      const dismiss = activePane.getByRole("button", { name: "Don't show again" });
      await expect.poll(() => dismiss.isVisible()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.className ?? "")).not.toContain(
        "chat-split-onboarding__dismiss",
      );

      const placement = await activePane.evaluate((pane) => {
        const header = pane.querySelector<HTMLElement>(".chat-pane__header");
        const hint = pane.querySelector<HTMLElement>(".chat-split-onboarding");
        const cell = pane.closest<HTMLElement>(".chat-split-view__cell");
        if (!header || !hint || !cell) {
          throw new Error("split onboarding placement is incomplete");
        }
        const headerBox = header.getBoundingClientRect();
        const hintBox = hint.getBoundingClientRect();
        const cellBox = cell.getBoundingClientRect();
        return {
          hintTop: hintBox.top,
          headerBottom: headerBox.bottom,
          hintRight: hintBox.right,
          cellRight: cellBox.right,
          position: getComputedStyle(hint).position,
          overflow: hint.scrollWidth > hint.clientWidth || hint.scrollHeight > hint.clientHeight,
        };
      });
      expect(placement.hintTop).toBeGreaterThanOrEqual(placement.headerBottom);
      expect(placement.hintRight).toBeLessThanOrEqual(placement.cellRight + 1);
      expect(placement.position).toBe("static");
      expect(placement.overflow).toBe(false);

      await mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "split-onboarding-light.png"),
      });

      await dismiss.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      const focusProof = await dismiss.evaluate((button) => ({
        active: document.activeElement === button,
        outlineStyle: getComputedStyle(button).outlineStyle,
        outlineWidth: getComputedStyle(button).outlineWidth,
      }));
      expect(focusProof.active).toBe(true);
      expect(focusProof.outlineStyle).toBe("solid");
      expect(focusProof.outlineWidth).toBe("2px");

      await dismiss.click();
      await expect.poll(() => onboarding.count()).toBe(0);
      const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      expect(
        await page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          return raw ? (JSON.parse(raw) as { chatSplitOnboardingDismissed?: boolean }) : null;
        }, settingsKey),
      ).toMatchObject({ chatSplitOnboardingDismissed: true });

      await page.reload();
      await page.getByText("Split onboarding proof.").first().waitFor();
      await expect.poll(() => panes.count()).toBe(2);
      expect(await page.locator(".chat-split-onboarding").count()).toBe(0);

      await panes
        .last()
        .locator(".chat-pane__header")
        .getByRole("button", { name: "Close pane" })
        .click();
      await expect.poll(() => panes.count()).toBe(0);
      await expect
        .poll(() => page.getByRole("button", { name: "Open split view" }).isVisible())
        .toBe(true);
      expect(await page.locator(".chat-split-onboarding").count()).toBe(0);

      await page.getByRole("button", { name: "Open split view" }).click();
      await expect.poll(() => panes.count()).toBe(2);
      expect(await page.locator(".chat-split-onboarding").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps the onboarding legible in dark mode at the side-by-side width", async () => {
    const context = await suite.newBrowserContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1100 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ type: "text", text: "Dark split onboarding proof." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
      methodResponses: { "sessions.list": chatSessionListResponse() },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Dark split onboarding proof.").waitFor();
      await page.getByRole("button", { name: "Open split view" }).click();
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expect.poll(() => panes.count()).toBe(2);
      const onboarding = panes.last().locator(".chat-split-onboarding");
      await expect.poll(() => onboarding.count()).toBe(1);
      const metrics = await onboarding.evaluate((hint) => ({
        clientWidth: hint.clientWidth,
        scrollWidth: hint.scrollWidth,
        clientHeight: hint.clientHeight,
        scrollHeight: hint.scrollHeight,
      }));
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
      expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);

      await mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "split-onboarding-dark.png"),
      });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
