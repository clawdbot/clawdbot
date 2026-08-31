import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer focus",
});

suite.define(() => {
  it("routes agent-menu letters and selection keys to their owners", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        defaultAgentId: "main",
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", workspace: "/tmp/main" },
              { id: "research", workspace: "/tmp/research" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new?agent=main`);

      const picker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      const trigger = picker.locator(".agent-select__trigger");
      await trigger.waitFor({ state: "visible" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      const option = picker.getByRole("menuitemradio", { name: "research", exact: true });
      await expect
        .poll(() => option.evaluate((element) => document.activeElement === element))
        .toBe(true);

      await page.keyboard.press("Space");

      await expect
        .poll(() => picker.locator(".agent-select__label").textContent())
        .toBe("research");
      await expect.poll(() => page.locator(".new-session-page__message").inputValue()).toBe("");
      await expect
        .poll(() =>
          picker
            .locator("wa-dropdown")
            .evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);

      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => option.evaluate((element) => document.activeElement === element))
        .toBe(true);

      await page.keyboard.type("r");

      await expect.poll(() => page.locator(".new-session-page__message").inputValue()).toBe("r");
    });
  });

  it("protects an open agent dropdown before an item receives focus", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page, {
        defaultAgentId: "main",
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", workspace: "/tmp/main" },
              { id: "research", workspace: "/tmp/research" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new?agent=main`);
      const composer = page.locator(".new-session-page__message");
      await composer.waitFor({ state: "visible" });

      const result = await page.evaluate(() => {
        const dropdown = document.querySelector<HTMLElement & { open: boolean }>(
          ".new-session-page__select--agent wa-dropdown",
        );
        const main = document.querySelector<HTMLElement>("main");
        if (!dropdown || !main) {
          throw new Error("missing real agent dropdown fixture");
        }
        dropdown.open = true;
        main.focus();
        main.dispatchEvent(
          new KeyboardEvent("keydown", { key: " ", bubbles: true, composed: true }),
        );
        return {
          activeTag: document.activeElement?.localName,
          dropdownOpen: dropdown.open,
        };
      });

      expect(result).toEqual({ activeTag: "main", dropdownOpen: true });
      await expect.poll(() => composer.inputValue()).toBe("");
    });
  });

  it("routes printable input from the real Chat context menu to the composer", async () => {
    await suite.withPage({}, async ({ page }) => {
      const messageText = "Context menu typing route";
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: messageText }],
            timestamp: 1_000,
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const bubble = page.locator(".chat-bubble").filter({ hasText: messageText });
      await bubble.waitFor();
      await bubble.click({ button: "right" });
      const menuItem = page
        .locator(".chat-reply-context-menu")
        .getByRole("menuitem", { name: "Reply to message", exact: true });
      await menuItem.focus();

      await page.keyboard.type("x");

      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      await expect.poll(() => composer.inputValue()).toBe("x");
      await expect
        .poll(() => composer.evaluate((element) => document.activeElement === element))
        .toBe(true);
    });
  });

  it("preserves the first character typed outside the new-session composer", async () => {
    await suite.withPage({}, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new?agent=main`);

      const composer = page.locator(".new-session-page__message");
      await composer.waitFor({ state: "visible" });
      await page.locator("main").click({ position: { x: 5, y: 5 } });
      await page.keyboard.type("x");

      await expect.poll(() => composer.inputValue()).toBe("x");
      await expect
        .poll(() => composer.evaluate((element) => document.activeElement === element))
        .toBe(true);
    });
  });

  it("keeps remote-control typing out of the chat composer", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["browser.request", "chat.startup", "desktop.observe", "environments.list"],
        methodResponses: {
          "browser.request": {
            cases: [
              {
                match: { method: "GET", path: "/tabs" },
                response: { running: true, tabs: [] },
              },
            ],
          },
          "environments.list": { environments: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      await composer.waitFor({ state: "visible" });

      for (const [label, selector] of [
        ["Browser", "openclaw-browser-panel"],
        ["Desktop", "openclaw-desktop-panel"],
      ] as const) {
        await openChatSidePanelType(page, label);
        const panel = page.locator(selector);
        await panel.waitFor({ state: "visible" });
        await composer.blur();
        await panel.evaluate((element) => {
          element.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "a",
              bubbles: true,
              cancelable: true,
              composed: true,
            }),
          );
        });
        await expect
          .poll(() => composer.evaluate((element) => document.activeElement === element))
          .toBe(false);
      }
    });
  });

  it("uses a visible neutral focus treatment in dark and light themes", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      const textarea = composer.locator("textarea");
      await composer.waitFor({ state: "visible" });

      for (const theme of ["dark", "light"] as const) {
        await page.evaluate((nextTheme) => {
          document.documentElement.dataset.theme = "claw";
          document.documentElement.dataset.themeMode = nextTheme;
        }, theme);
        await textarea.evaluate((element) => element.blur());
        await page.waitForTimeout(150);
        const unfocused = await composer.evaluate((element) => {
          const style = getComputedStyle(element);
          return { borderColor: style.borderColor, boxShadow: style.boxShadow };
        });

        await textarea.focus();
        await page.waitForTimeout(150);
        const focused = await composer.evaluate((element) => {
          const style = getComputedStyle(element);
          const parseRgb = (color: string): [number, number, number] => {
            const values = color
              .match(/[\d.]+/g)
              ?.slice(0, 3)
              .map(Number);
            if (!values || values.length !== 3) {
              throw new Error(`expected an RGB color, received ${color}`);
            }
            return (
              color.startsWith("color(srgb") ? values.map((value) => value * 255) : values
            ) as [number, number, number];
          };
          const luminance = (color: string): number => {
            const linearize = (channel: number) => {
              const normalized = channel / 255;
              return normalized <= 0.04045
                ? normalized / 12.92
                : ((normalized + 0.055) / 1.055) ** 2.4;
            };
            const channels = parseRgb(color);
            return (
              0.2126 * linearize(channels[0]) +
              0.7152 * linearize(channels[1]) +
              0.0722 * linearize(channels[2])
            );
          };
          const borderLuminance = luminance(style.borderColor);
          const surfaceLuminance = luminance(style.backgroundColor);
          const borderChannels = parseRgb(style.borderColor);
          const contrast =
            (Math.max(borderLuminance, surfaceLuminance) + 0.05) /
            (Math.min(borderLuminance, surfaceLuminance) + 0.05);

          return {
            borderColor: style.borderColor,
            boxShadow: style.boxShadow,
            contrast,
            neutralChannelSpread: Math.max(...borderChannels) - Math.min(...borderChannels),
          };
        });

        expect([focused.borderColor, focused.boxShadow]).not.toEqual([
          unfocused.borderColor,
          unfocused.boxShadow,
        ]);
        expect(focused.neutralChannelSpread).toBeLessThanOrEqual(24);
        expect(focused.contrast).toBeGreaterThanOrEqual(3);
      }
    });
  });
});
