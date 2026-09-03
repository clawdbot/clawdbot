import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const QUEUED = ["review the migration", "then update the docs", "finally run the smoke"] as const;

suite.define(() => {
  it("reorders offline queued messages from the keyboard-focused handle", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 15_000 });

      // Offline is the honest way to hold a queue still: nothing drains while
      // the Gateway is gone, so the rows stay observable.
      await gateway.setOnline(false);
      await gateway.closeLatest();
      for (const message of QUEUED) {
        await composer.fill(message);
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
      }

      const queueText = () => page.locator(".chat-queue__item .chat-queue__text").allTextContents();
      expect(await queueText()).toEqual([...QUEUED]);

      // One handle per movable row, and it is the whole reorder surface.
      expect(await page.locator(".chat-queue__grip").count()).toBe(QUEUED.length);

      // Keyboard path: focus the last row's handle and walk it up the queue.
      await page.locator(".chat-queue__item").nth(2).locator(".chat-queue__grip").focus();
      await page.keyboard.press("ArrowUp");

      await expect.poll(queueText, { timeout: 10_000 }).toEqual([QUEUED[0], QUEUED[2], QUEUED[1]]);

      // Focus follows the moved row, so a second press keeps moving the same one.
      await page.keyboard.press("ArrowUp");

      await expect.poll(queueText, { timeout: 10_000 }).toEqual([QUEUED[2], QUEUED[0], QUEUED[1]]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps the queue order consistent through a reload after a mid-reorder storage failure", async () => {
    if (captureUiProofEnabled) {
      await mkdir(path.join(suite.artifactDir, "queue-reorder-failure-reload"), {
        recursive: true,
      });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      // A real active turn holds the restored queue while we inspect its order.
      sessions: [
        {
          key: "agent:main:main",
          kind: "direct",
          hasActiveRun: true,
          activeRunIds: ["queue-order-holder"],
          status: "running",
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 15_000 });

      await gateway.setOnline(false);
      await gateway.closeLatest();
      for (const message of QUEUED) {
        await composer.fill(message);
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
      }

      const queueText = () => page.locator(".chat-queue__item .chat-queue__text").allTextContents();
      expect(await queueText()).toEqual([...QUEUED]);
      if (captureUiProofEnabled) {
        await page.screenshot({
          path: `${path.join(suite.artifactDir, "queue-reorder-failure-reload")}/01-queued-before-failure.png`,
        });
      }

      // Break durable storage for the rest of this page's lifetime, then attempt
      // a reorder. A real `sessionStorage.setItem` failure (quota, private mode,
      // disabled storage) landing mid-batch must reject the whole permutation
      // instead of applying it partway, so the order has to stay exactly what
      // it was — never a mix of the attempted and original arrangements.
      await page.evaluate(() => {
        window.sessionStorage.setItem = () => {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        };
      });

      await page.locator(".chat-queue__item").nth(2).locator(".chat-queue__grip").focus();
      await page.keyboard.press("ArrowUp");

      await page
        .getByRole("alert")
        .filter({ hasText: "Could not store this message for reconnect." })
        .waitFor();
      expect(await queueText()).toEqual([...QUEUED]);
      if (captureUiProofEnabled) {
        await page.screenshot({
          path: `${path.join(suite.artifactDir, "queue-reorder-failure-reload")}/02-order-unchanged-after-failure.png`,
        });
      }

      // A fresh load reads back only what actually made it to storage. Seeing the
      // same order here (not a mix of the attempted and original permutations)
      // is the proof: the failed batch never left a half-applied reorder behind.
      // The app only mounts its session UI once the Gateway connects, so the
      // storage-level readback below runs first, while this reload is still
      // offline, exactly as the cold-reload offline-queue proof elsewhere does.
      await page.reload();
      const storedQueueOrder = () =>
        page.evaluate(() =>
          Object.entries(sessionStorage)
            .filter(([key]) => key.startsWith("openclaw.control.chatComposer.v4:"))
            .flatMap(([, value]) => {
              try {
                const parsed = JSON.parse(value) as {
                  sessions?: Record<
                    string,
                    { queue?: { text?: unknown; orderKey?: unknown; createdAt?: unknown }[] }
                  >;
                };
                return Object.values(parsed.sessions ?? {}).flatMap(
                  (session) => session.queue ?? [],
                );
              } catch {
                return [];
              }
            })
            .toSorted(
              (left, right) =>
                (typeof left.orderKey === "number" ? left.orderKey : Number(left.createdAt)) -
                (typeof right.orderKey === "number" ? right.orderKey : Number(right.createdAt)),
            )
            .map((item) => item.text),
        );
      expect(await storedQueueOrder()).toEqual([...QUEUED]);

      // Bringing the Gateway back lets the app mount its session UI so the same
      // order can be confirmed rendered, not just stored.
      await gateway.setOnline(true);
      await page.locator("openclaw-chat-pane").waitFor({ state: "attached", timeout: 15_000 });
      await page.locator(".chat-queue__item", { hasText: QUEUED[0] }).waitFor({ timeout: 10_000 });
      expect(await queueText()).toEqual([...QUEUED]);
      if (captureUiProofEnabled) {
        await page.screenshot({
          path: `${path.join(suite.artifactDir, "queue-reorder-failure-reload")}/03-consistent-order-after-reload.png`,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
