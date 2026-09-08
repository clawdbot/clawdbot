import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

type ClipboardFaultState = {
  asyncWrites: string[];
  execSucceeds: boolean;
  legacyWrites: string[];
  mode: "defer" | "missing" | "reject";
  pendingRejects: Array<(reason?: unknown) => void>;
};

const suite = createControlUiE2eSuite({
  name: "Control UI Lobsterdex clipboard E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

suite.define(() => {
  it("falls back, announces failure, and keeps feedback with the newest copy", async () => {
    await suite.withPage(
      {
        hasTouch: true,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      },
      async ({ page }) => {
        await page.addInitScript(() => {
          const state: ClipboardFaultState = {
            asyncWrites: [],
            execSucceeds: true,
            legacyWrites: [],
            mode: "reject",
            pendingRejects: [],
          };
          Object.defineProperty(window, "lobsterdexClipboardFault", { value: state });
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            get: () =>
              state.mode === "missing"
                ? undefined
                : {
                    writeText(text: string) {
                      state.asyncWrites.push(text);
                      if (state.mode === "reject") {
                        return Promise.reject(
                          new DOMException("Clipboard access denied", "NotAllowedError"),
                        );
                      }
                      return new Promise<void>((_resolve, reject) => {
                        state.pendingRejects.push(reject);
                      });
                    },
                  },
          });
          document.execCommand = (command: string) => {
            if (command !== "copy") {
              return false;
            }
            state.legacyWrites.push(
              document.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "",
            );
            return state.execSucceeds;
          };
        });
        await installMockGateway(page);
        const response = await page.goto(`${suite.server.baseUrl}settings/lobsterdex`);
        expect(response?.status()).toBe(200);

        const pageRoot = page.locator("openclaw-lobsterdex-page");
        const copyButtons = pageRoot.getByRole("button", { name: "Copy link" });
        await expect.poll(() => copyButtons.count()).toBeGreaterThan(1);
        const crimson = copyButtons.nth(0);
        const blue = copyButtons.nth(1);
        const crimsonUrl = `${new URL(suite.server.baseUrl).origin}/settings/lobsterdex#lobsterdex-crimson`;
        const blueUrl = `${new URL(suite.server.baseUrl).origin}/settings/lobsterdex#lobsterdex-blue`;
        await crimson.focus();
        await page.keyboard.press("Enter");
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as typeof window & { lobsterdexClipboardFault: ClipboardFaultState })
                  .lobsterdexClipboardFault,
            ),
          )
          .toMatchObject({ asyncWrites: [crimsonUrl], legacyWrites: [crimsonUrl] });

        await page.evaluate(() => {
          (
            window as typeof window & { lobsterdexClipboardFault: ClipboardFaultState }
          ).lobsterdexClipboardFault.mode = "missing";
        });
        await blue.tap();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as typeof window & { lobsterdexClipboardFault: ClipboardFaultState })
                  .lobsterdexClipboardFault,
            ),
          )
          .toMatchObject({ asyncWrites: [crimsonUrl], legacyWrites: [crimsonUrl, blueUrl] });

        await page.evaluate(() => {
          const state = (
            window as typeof window & { lobsterdexClipboardFault: ClipboardFaultState }
          ).lobsterdexClipboardFault;
          state.mode = "reject";
          state.execSucceeds = false;
        });
        await crimson.tap();
        await expect.poll(() => pageRoot.getByRole("alert").textContent()).toBe("Copy failed");
        await pageRoot.evaluate((element) => {
          const parent = element.parentElement;
          if (!parent) {
            throw new Error("Lobsterdex page has no route host");
          }
          element.remove();
          parent.append(element);
        });
        await expect.poll(() => pageRoot.getByRole("alert").count()).toBe(0);

        await page.evaluate(() => {
          const state = (
            window as typeof window & { lobsterdexClipboardFault: ClipboardFaultState }
          ).lobsterdexClipboardFault;
          state.mode = "defer";
          state.execSucceeds = true;
          state.asyncWrites = [];
          state.legacyWrites = [];
          state.pendingRejects = [];
        });
        await crimson.focus();
        await page.keyboard.press("Enter");
        await blue.tap();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as typeof window & { lobsterdexClipboardFault: ClipboardFaultState })
                  .lobsterdexClipboardFault.pendingRejects.length,
            ),
          )
          .toBe(2);
        expect(await pageRoot.getByRole("alert").count()).toBe(0);

        await page.evaluate(() => {
          const state = (
            window as typeof window & { lobsterdexClipboardFault: ClipboardFaultState }
          ).lobsterdexClipboardFault;
          state.pendingRejects[1]?.(new DOMException("Newer write rejected", "NotAllowedError"));
        });
        await blue.locator('path[d="M20 6 9 17l-5-5"]').waitFor();
        expect(await crimson.locator('path[d="M20 6 9 17l-5-5"]').count()).toBe(0);
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as typeof window & { lobsterdexClipboardFault: ClipboardFaultState })
                  .lobsterdexClipboardFault.legacyWrites,
            ),
          )
          .toEqual([blueUrl]);

        await page.evaluate(() => {
          const state = (
            window as typeof window & { lobsterdexClipboardFault: ClipboardFaultState }
          ).lobsterdexClipboardFault;
          state.pendingRejects[0]?.(new DOMException("Older write rejected", "NotAllowedError"));
        });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              window.setTimeout(resolve, 0);
            }),
        );
        expect(await crimson.locator('path[d="M20 6 9 17l-5-5"]').count()).toBe(0);
        expect(await blue.locator('path[d="M20 6 9 17l-5-5"]').count()).toBe(1);
        expect(
          await page.evaluate(
            () =>
              (window as typeof window & { lobsterdexClipboardFault: ClipboardFaultState })
                .lobsterdexClipboardFault.legacyWrites,
          ),
        ).toEqual([blueUrl]);
        await expect.poll(() => blue.locator('path[d="M20 6 9 17l-5-5"]').count()).toBe(0);
      },
    );
  });
});
