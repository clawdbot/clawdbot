import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "File editor recovery" });

declare global {
  interface Window {
    editorInitAttempts?: number;
    editorInitMaySucceed?: boolean;
    rejectEditorInitialization?: () => void;
  }
}

async function openFilePreview(page: Page) {
  await installMockGateway(page, {
    historyMessages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Review `notes.txt` and `other.txt`." }],
        timestamp: 1,
      },
    ],
    methodResponses: {
      "sessions.files.get": {
        cases: ["notes.txt", "other.txt"].map((name) => ({
          match: { path: name },
          response: {
            root: "/workspace",
            file: {
              content: `Synthetic ${name} content`,
              kind: "read",
              missing: false,
              name,
              path: name,
              workspacePath: name,
            },
          },
        })),
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
}

suite.define(() => {
  it("keeps initialization failures terminal until an explicit retry", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        await page.route(/\/assets\/file-editor-view-[^/]+\.js(?:\?.*)?$/u, async (route) => {
          const url = new URL(route.request().url());
          if (url.searchParams.has("actual")) {
            await route.continue();
            return;
          }
          url.searchParams.set("actual", "1");
          await route.fulfill({
            contentType: "text/javascript",
            body: `import { createFileEditorView as create } from ${JSON.stringify(url.href)};
              export async function createFileEditorView(options) {
                window.editorInitAttempts = (window.editorInitAttempts ?? 0) + 1;
                await new Promise(resolve => setTimeout(resolve, 25));
                if (!window.editorInitMaySucceed) throw new Error("Synthetic editor initialization failed");
                return create(options);
              }`,
          });
        });
        await openFilePreview(page);
        await page.waitForFunction(
          () => document.querySelector(".lazy-view-error") || (window.editorInitAttempts ?? 0) >= 3,
        );
        await page.locator(".side-panel").evaluate(async (panel) => {
          await Promise.all(
            panel
              .getAnimations({ subtree: true })
              .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        await page.screenshot({ path: path.join(suite.artifactDir, "initialization-result.png") });
        expect(await page.locator(".lazy-view-error").count()).toBe(1);
        expect(await page.locator(".lazy-view-error").textContent()).toContain(
          "Synthetic editor initialization failed",
        );
        await page.evaluate(() => {
          window.editorInitMaySucceed = true;
          const panel = document.querySelector("openclaw-chat-detail-panel") as HTMLElement & {
            requestUpdate(): void;
          };
          panel.requestUpdate();
        });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        expect(await page.evaluate(() => window.editorInitAttempts)).toBe(1);
        await page.locator(".lazy-view-error").getByRole("button", { name: /Retry/iu }).click();
        await page.locator(".cm-content").waitFor();
        expect(await page.locator(".cm-content").textContent()).toContain(
          "Synthetic notes.txt content",
        );
        expect(await page.evaluate(() => window.editorInitAttempts)).toBe(2);
      },
    );
  });
  it("reloads a missing editor chunk only after the gateway becomes reachable", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        let reachable = false;
        let chunkRequests = 0;
        let documentProbes = 0;
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route(
          (url) => url.pathname.startsWith("/chat"),
          async (route) => {
            if (route.request().method() === "HEAD") {
              documentProbes += 1;
              await route.fulfill({ status: reachable ? 200 : 503, body: "" });
            } else {
              await route.continue();
            }
          },
        );
        await page.route(/\/assets\/file-editor-view-[^/]+\.js$/u, async (route) => {
          chunkRequests += 1;
          if (reachable) {
            await route.continue();
          } else {
            await route.fulfill({ status: 404, contentType: "text/javascript", body: "" });
          }
        });
        await openFilePreview(page);
        const failure = page.locator(".lazy-view-error--stale");
        await failure.waitFor();
        await expect.poll(() => documentProbes).toBe(1);
        expect(chunkRequests).toBe(1);
        expect(errors).toEqual([]);
        await page.locator(".side-panel").evaluate(async (panel) => {
          await Promise.all(
            panel
              .getAnimations({ subtree: true })
              .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        await page.screenshot({ path: path.join(suite.artifactDir, "missing-chunk-error.png") });
        reachable = true;
        const navigation = page.waitForEvent(
          "framenavigated",
          (frame) => frame === page.mainFrame(),
        );
        await failure.getByRole("button", { name: "Reload", exact: true }).click();
        await navigation;
        await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
        await page.locator(".cm-content").waitFor();
        expect(await page.locator(".cm-content").textContent()).toContain(
          "Synthetic notes.txt content",
        );
        expect(chunkRequests).toBe(2);
        expect(documentProbes).toBe(2);
        expect(errors).toEqual([]);
        await page.locator(".side-panel").evaluate(async (panel) => {
          await Promise.all(
            panel
              .getAnimations({ subtree: true })
              .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        await page.screenshot({
          path: path.join(suite.artifactDir, "missing-chunk-recovered.png"),
        });
      },
    );
  });

  it.each(["raw", "file", "close"] as const)(
    "ignores a late initialization failure after selecting %s",
    async (selection) => {
      await suite.withPage(
        {
          viewport: { width: 1280, height: 900 },
          recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
        },
        async ({ page }) => {
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route(/\/assets\/file-editor-view-[^/]+\.js(?:\?.*)?$/u, async (route) => {
            const url = new URL(route.request().url());
            if (url.searchParams.has("actual")) {
              await route.continue();
              return;
            }
            url.searchParams.set("actual", "1");
            await route.fulfill({
              contentType: "text/javascript",
              body: `import { createFileEditorView as create } from ${JSON.stringify(url.href)};
          export async function createFileEditorView(options) {
            if (window.rejectEditorInitialization) return create(options);
            await new Promise((_, reject) => window.rejectEditorInitialization = () => reject(new Error("Retired editor failed")));
          }`,
            });
          });
          await openFilePreview(page);
          await page.waitForFunction(() => typeof window.rejectEditorInitialization === "function");
          if (selection === "raw") {
            await page.getByRole("button", { name: /raw text/iu, exact: true }).click();
          } else if (selection === "file") {
            await page.locator('a.markdown-file-link[data-file-path="other.txt"]').click();
            await page.locator(".cm-content").waitFor();
          } else {
            await page.getByRole("button", { name: "Close Review", exact: true }).click();
          }
          await page.evaluate(() => window.rejectEditorInitialization!());
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          expect(await page.locator(".lazy-view-error").count()).toBe(0);
          expect(errors).toEqual([]);
          if (selection === "raw") {
            expect(await page.locator(".sidebar-markdown-shell").textContent()).toContain(
              "Synthetic notes.txt content",
            );
          } else if (selection === "file") {
            expect(await page.locator(".cm-content").textContent()).toContain(
              "Synthetic other.txt content",
            );
          } else {
            expect(await page.locator("openclaw-chat-detail-panel").count()).toBe(0);
          }
        },
      );
    },
  );
});
