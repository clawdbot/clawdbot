// Control UI tests cover the canonical scrollbar profile and native-style text selection.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI app chrome interaction mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "app-chrome-interaction",
);

async function dragAcross(page: Page, locator: Locator): Promise<string> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected a visible text-selection target");
  }
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.max(3, box.width - 2), y, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => globalThis.getSelection()?.toString() ?? "");
}

async function readFocusOutline(locator: Locator) {
  return locator.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: styles.outlineStyle,
    };
  });
}

async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: path.join(uiProofArtifactDir, fileName),
  });
}

suite.define(() => {
  it("keeps canonical scrollbars without horizontal model-picker overflow and preserves selection", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: captureUiProofEnabled
          ? { dir: path.join(uiProofArtifactDir, "video"), size: { height: 900, width: 1440 } }
          : undefined,
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Selectable transcript content" }],
            },
          ],
          models: [
            {
              contextWindow: 1_000_000,
              id: "gpt-5.6-sol-openclaw",
              name: "openai/gpt-5.6-sol-openclaw",
              provider: "openai",
            },
            ...Array.from({ length: 24 }, (_value, index) => ({
              id: `scroll-model-${index + 1}`,
              name: `Scroll Model ${index + 1}`,
              provider: "openai",
            })),
          ],
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        const transcript = page.getByText("Selectable transcript content", { exact: true });
        await transcript.waitFor();
        await page.locator('[data-chat-model-select="true"]').click();
        const modelOptions = page.locator(".chat-controls__model-options");
        await expect.poll(() => modelOptions.isVisible()).toBe(true);
        const chatStyles = await page.evaluate(() => {
          const sidebar = document.querySelector<HTMLElement>(".sidebar");
          const sessions = document.querySelector<HTMLElement>(".sidebar-shell__body");
          const thread = document.querySelector<HTMLElement>(".chat-thread");
          const modelPicker = document.querySelector<HTMLElement>(".chat-controls__model-options");
          if (!sidebar || !sessions || !thread || !modelPicker) {
            throw new Error("Missing chat interaction surface");
          }
          return {
            chatSelection: getComputedStyle(thread).userSelect,
            chatScrollbar: getComputedStyle(thread, "::-webkit-scrollbar").width,
            sidebarSelection: getComputedStyle(sidebar).userSelect,
            sidebarScrollbar: getComputedStyle(sessions, "::-webkit-scrollbar").width,
            modelPickerScrollbar: getComputedStyle(modelPicker, "::-webkit-scrollbar").width,
            modelPickerOverflowX: getComputedStyle(modelPicker).overflowX,
            modelPickerHorizontalOverflow: modelPicker.scrollWidth - modelPicker.clientWidth,
          };
        });
        // One canonical width everywhere: the sidebar no longer overrides
        // --scrollbar-size down to 6px, and the model picker (which used to
        // inherit the raw document default with no width of its own) now
        // reports the same value as every other sampled surface.
        expect(chatStyles).toEqual({
          chatSelection: "text",
          chatScrollbar: "12px",
          sidebarSelection: "none",
          sidebarScrollbar: "12px",
          modelPickerScrollbar: "12px",
          modelPickerOverflowX: "hidden",
          modelPickerHorizontalOverflow: 0,
        });
        await page.keyboard.press("Escape");
        expect(await dragAcross(page, transcript)).toContain("Selectable transcript");
        const thread = page.locator(".chat-thread");
        expect(await readFocusOutline(thread)).toMatchObject({
          focusVisible: false,
          outlineStyle: "none",
        });
        await captureUiProof(page, "01-chat-selectable-transcript.png");

        await thread.focus();
        await page.keyboard.press("Tab");
        await expect
          .poll(() => thread.evaluate((element) => element !== document.activeElement))
          .toBe(true);
        await page.keyboard.press("Shift+Tab");
        await expect
          .poll(() =>
            thread.evaluate(
              (element) => element === document.activeElement && element.matches(":focus-visible"),
            ),
          )
          .toBe(true);
        const focusedOutline = await readFocusOutline(thread);
        expect(focusedOutline).toMatchObject({
          focusVisible: true,
          outlineStyle: "none",
        });
        await captureUiProof(page, "02-chat-thread-keyboard-focus.png");

        await page.setViewportSize({ height: 650, width: 1440 });
        // Appearance renders schema-independent theme/UI sections that overflow
        // 650px even against the mock gateway's tiny config fixture; General
        // became short enough to fit once the host panel moved to Gateway.
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        const { search: settingsSearch, sidebar: settingsSidebar } =
          await waitForControlUiSettingsTakeover(page);
        const settingsTitle = settingsSidebar.locator(".settings-sidebar__title");
        const content = page.locator(".content");
        await expect
          .poll(() => content.evaluate((element) => element.scrollHeight))
          .toBeGreaterThan(await content.evaluate((element) => element.clientHeight));

        const settingsStyles = await page.evaluate(() => {
          const contentNode = document.querySelector<HTMLElement>(".content");
          const nav = document.querySelector<HTMLElement>(".settings-sidebar__nav");
          const search = document.querySelector<HTMLElement>(".settings-sidebar__search-input");
          const sidebar = document.querySelector<HTMLElement>(".settings-sidebar");
          if (!contentNode || !nav || !search || !sidebar) {
            throw new Error("Missing settings interaction surface");
          }
          return {
            contentScrollbar: getComputedStyle(contentNode, "::-webkit-scrollbar").width,
            contentSelection: getComputedStyle(contentNode).userSelect,
            inputSelection: getComputedStyle(search).userSelect,
            sidebarScrollbar: getComputedStyle(nav, "::-webkit-scrollbar").width,
            sidebarSelection: getComputedStyle(sidebar).userSelect,
          };
        });
        expect(settingsStyles).toEqual({
          contentScrollbar: "12px",
          contentSelection: "none",
          inputSelection: "text",
          sidebarScrollbar: "12px",
          sidebarSelection: "none",
        });

        await page.evaluate(() => globalThis.getSelection()?.removeAllRanges());
        expect(await dragAcross(page, settingsTitle)).toBe("");
        await settingsSearch.selectText();
        expect(
          await settingsSearch.evaluate(
            (element) =>
              element instanceof HTMLInputElement &&
              element.selectionStart === 0 &&
              element.selectionEnd === element.value.length,
          ),
        ).toBe(true);
        await content.evaluate((element) => {
          element.scrollTop = Math.min(160, element.scrollHeight - element.clientHeight);
        });
        await captureUiProof(page, "03-settings-contextual-scrollbars.png");
      },
    );
  });

  it("resolves the scrollbar thumb from theme tokens and captures dark/light proof", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    const thumbColorByScheme: Record<"dark" | "light", string> = { dark: "", light: "" };
    for (const colorScheme of ["dark", "light"] as const) {
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
        },
        async ({ page }) => {
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Selectable transcript content" }],
              },
            ],
            models: [
              { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
              ...Array.from({ length: 24 }, (_value, index) => ({
                id: `scroll-model-${index + 1}`,
                name: `Scroll Model ${index + 1}`,
                provider: "openai",
              })),
            ],
          });

          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("Selectable transcript content", { exact: true }).waitFor();
          thumbColorByScheme[colorScheme] = await page.evaluate(
            () => getComputedStyle(document.body, "::-webkit-scrollbar-thumb").backgroundColor,
          );
          // Chat transcript + session sidebar together, before opening anything.
          await captureUiProof(page, `chat-transcript-sidebar-${colorScheme}.png`);

          // The headline complaint surface: the light-DOM chat model picker.
          await page.locator('[data-chat-model-select="true"]').click();
          const modelOptions = page.locator(".chat-controls__model-options");
          await expect.poll(() => modelOptions.isVisible()).toBe(true);
          await captureUiProof(page, `model-picker-${colorScheme}.png`);
          await page.keyboard.press("Escape");

          // The shadow-DOM lane: a Web Awesome ::part() menu picks up the same
          // profile through the grouped rule in base.css.
          const composer = page.locator(".agent-chat__input");
          await composer.getByRole("button", { name: "Add attachment" }).click();
          const capabilityMenu = composer.locator("wa-dropdown.agent-chat__capability-menu");
          await expect
            .poll(() =>
              capabilityMenu.evaluate((node) => (node as HTMLElement & { open: boolean }).open),
            )
            .toBe(true);
          // Regression guard: base.css's ::-webkit-scrollbar* rules do not cross
          // a shadow boundary on their own. Only the grouped ::part() rule gives
          // this menu's shadow-root scrollbar the canonical width and a real
          // thumb color instead of silently falling back to the UA default.
          const shadowScrollbar = await capabilityMenu.evaluate((node) => {
            const part = (node as HTMLElement).shadowRoot?.querySelector('[part~="menu"]');
            if (!part) {
              return null;
            }
            return {
              width: getComputedStyle(part, "::-webkit-scrollbar").width,
              thumbBackground: getComputedStyle(part, "::-webkit-scrollbar-thumb").backgroundColor,
            };
          });
          expect(shadowScrollbar).toEqual({ width: "12px", thumbBackground: expect.any(String) });
          expect(shadowScrollbar?.thumbBackground).not.toBe("rgba(0, 0, 0, 0)");
          await captureUiProof(page, `capability-menu-shadow-dom-${colorScheme}.png`);

          // Genericity guard, not a second sample of the menu above: base.css
          // reaches these parts through bare wa-dropdown/wa-select/wa-popover
          // selectors, so every Web Awesome scroll part rendered on this page
          // must report the canonical width -- including the ones no stylesheet
          // names. A class allowlist would leave some at the platform default.
          const shadowScrollbarWidths = await page.evaluate(() => {
            // One part per host tag, matching the base.css rule exactly: sampling
            // whichever part came first would read a part that rule never targets.
            const partSelectorByTag: Record<string, string> = {
              "WA-DROPDOWN": '[part~="menu"]',
              "WA-POPOVER": '[part~="body"]',
              "WA-SELECT": '[part~="listbox"]',
            };
            const hosts = document.querySelectorAll("wa-dropdown, wa-select, wa-popover");
            return Array.from(hosts, (host) => {
              const partSelector = partSelectorByTag[host.tagName];
              const part = partSelector ? host.shadowRoot?.querySelector(partSelector) : null;
              return part ? getComputedStyle(part, "::-webkit-scrollbar").width : null;
            }).filter((width): width is string => width !== null);
          });
          expect(shadowScrollbarWidths.length).toBeGreaterThan(1);
          expect([...new Set(shadowScrollbarWidths)]).toEqual(["12px"]);
        },
      );
    }
    // Same source (--muted), different value per mode: the token derivation
    // covers dark and light without a hand-written color pair.
    expect(thumbColorByScheme.dark).not.toBe(thumbColorByScheme.light);
    expect(thumbColorByScheme.dark).not.toBe("");
    expect(thumbColorByScheme.light).not.toBe("");
  });
});
