// Composer native undo/redo regression: the controlled `.value` binding must
// not re-apply the textarea value after native input, which clobbers the
// browser's undo/redo bookkeeping (#131708).
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeComposerUndoRedo = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

const COMPOSER_TEXTAREA = ".agent-chat__composer-combobox > textarea";
const TYPED_TEXT = "hello world test";

let browser: Browser | null = null;
let page: Page | null = null;
let server: ControlUiE2eServer | null = null;

describeComposerUndoRedo("chat composer native undo/redo", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: chromiumExecutablePath,
      headless: true,
    });
    server = await startControlUiE2eServer();
    page = await browser.newPage();
    await installMockGateway(page);
    // Count every programmatic textarea value write so the binding contract
    // (no re-apply after native input) is asserted directly.
    await page.addInitScript(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      ) as PropertyDescriptor & { get(): string; set(next: string): void };
      Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
        get: descriptor.get,
        set(next: string) {
          if (this.isConnected) {
            (window as { composerValueWrites?: number }).composerValueWrites =
              ((window as { composerValueWrites?: number }).composerValueWrites ?? 0) + 1;
          }
          descriptor.set.call(this, next);
        },
        configurable: true,
      });
    });
    await page.goto(`${server.baseUrl}chat/main`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.locator(COMPOSER_TEXTAREA).waitFor({ timeout: 30_000 });
  });

  afterAll(async () => {
    await page?.close();
    await server?.close();
    await browser?.close();
  });

  async function valueWriteCount(): Promise<number> {
    return page!.evaluate(
      () => (window as { composerValueWrites?: number }).composerValueWrites ?? 0,
    );
  }

  it("keeps native redo working after undo in the composer textarea", async () => {
    const textarea = page!.locator(COMPOSER_TEXTAREA);
    await textarea.click();
    await textarea.type(TYPED_TEXT);
    expect(await textarea.inputValue()).toBe(TYPED_TEXT);

    await page!.keyboard.press("ControlOrMeta+a");
    await page!.keyboard.press("Backspace");
    expect(await textarea.inputValue()).toBe("");

    await page!.keyboard.press("ControlOrMeta+z");
    expect(await textarea.inputValue()).toBe(TYPED_TEXT);

    // Redo must re-apply the deletion, exactly like a native textarea.
    await page!.keyboard.press("ControlOrMeta+Shift+z");
    expect(await textarea.inputValue()).toBe("");
  });

  it("does not re-apply the textarea value after native input", async () => {
    const textarea = page!.locator(COMPOSER_TEXTAREA);
    await textarea.click();
    await page!.keyboard.press("ControlOrMeta+a");
    await page!.keyboard.press("Backspace");
    await page!.waitForTimeout(100);

    const beforeTyping = await valueWriteCount();
    await textarea.type(TYPED_TEXT);
    await page!.waitForTimeout(100);
    const afterTyping = await valueWriteCount();

    // Typing reaches the draft owner and requests renders, but none of those
    // renders may write the textarea value back: the DOM already holds it, and
    // a programmatic re-apply resets the browser's undo/redo bookkeeping.
    expect(afterTyping - beforeTyping).toBe(0);

    // Native undo/redo must likewise complete without any value write-back.
    const beforeUndo = await valueWriteCount();
    await page!.keyboard.press("ControlOrMeta+a");
    await page!.keyboard.press("Backspace");
    await page!.keyboard.press("ControlOrMeta+z");
    await page!.keyboard.press("ControlOrMeta+Shift+z");
    await page!.waitForTimeout(100);
    expect(await textarea.inputValue()).toBe("");
    expect((await valueWriteCount()) - beforeUndo).toBe(0);
  });
});
