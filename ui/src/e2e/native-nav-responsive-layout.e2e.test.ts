import type { BrowserContext } from "playwright";
import { afterEach, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI native-nav responsive layout E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

let context: BrowserContext | undefined;

suite.define(() => {
  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  async function openPage(options: {
    hasTouch?: boolean;
    height?: number;
    webChrome?: boolean;
    width?: number;
  }) {
    context = await suite.browser.newContext({
      hasTouch: options.hasTouch,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: options.height ?? 900, width: options.width ?? 1280 },
    });
    const page = await context.newPage();
    if (options.webChrome) {
      await installNativeWebChrome(page);
    }
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
    });
    const response = await page.goto(suite.server.baseUrl);
    expect(response?.status()).toBe(200);
    await page.locator(".sidebar-brand").waitFor({ state: "attached" });
    return page;
  }

  it("keeps only history controls in the Settings titlebar", async () => {
    const page = await openPage({ webChrome: true });
    const response = await page.goto(`${suite.server.baseUrl}settings/general`);
    expect(response?.status()).toBe(200);

    const toolbar = page.locator(".macos-titlebar-controls");
    await expect.poll(() => toolbar.isVisible()).toBe(true);
    await expect.poll(() => toolbar.getByRole("button").count()).toBe(2);
    await expect.poll(() => toolbar.getByRole("button", { name: "Back" }).isVisible()).toBe(true);
    await expect
      .poll(() => toolbar.getByRole("button", { name: "Forward" }).isVisible())
      .toBe(true);
    await expect
      .poll(() => toolbar.getByRole("button", { name: "Expand sidebar" }).count())
      .toBe(0);
    await expect
      .poll(() => toolbar.getByRole("button", { name: "Open command palette" }).count())
      .toBe(0);
    await expect.poll(() => toolbar.getByRole("button", { name: "New session" }).count()).toBe(0);
  });

  it("keeps the document root scroll-locked in the Settings takeover", async () => {
    const page = await openPage({ webChrome: true });
    const response = await page.goto(`${suite.server.baseUrl}settings/general`);
    expect(response?.status()).toBe(200);
    await page.locator(".settings-sidebar").waitFor({ state: "visible" });

    // WKWebView scrolls the document whenever it overflows, dragging the
    // settings sidebar and content along. Force overflow the way stray
    // content would, then confirm the root refuses to move.
    const metrics = await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "3000px";
      document.body.append(spacer);
      window.scrollTo(0, 500);
      document.documentElement.scrollTop = 500;
      document.body.scrollTop = 500;
      return {
        bodyScrollTop: document.body.scrollTop,
        htmlScrollTop: document.documentElement.scrollTop,
        rootScrollY: window.scrollY,
      };
    });
    expect(metrics).toEqual({ bodyScrollTop: 0, htmlScrollTop: 0, rootScrollY: 0 });
  });

  it("keeps drawer and search reachable from the narrow chat title bar", async () => {
    const page = await openPage({ width: 900 });
    const header = page.locator(".chat-pane__header").first();
    await expect
      .poll(() => page.locator(".shell").getAttribute("class"))
      .toContain("shell--merged-chat-chrome");
    await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);
    await expect
      .poll(() => header.getByRole("button", { name: "Expand sidebar" }).isVisible())
      .toBe(true);
    await expect.poll(() => header.locator(".chat-pane__palette-open").count()).toBe(0);
    await header.locator(".chat-header-session-menu__trigger").click();
    await page.getByText("Open command palette", { exact: true }).click();
    await page.locator(".cmd-palette__input").waitFor({ state: "visible" });
  });

  it("keeps browser sidebar header geometry aligned in LTR and RTL", async () => {
    const page = await openPage({ width: 1440 });
    const sidebarBrand = page.locator(".sidebar-brand");
    const agentName = sidebarBrand.locator(".sidebar-agent-card__name-text");

    await expect
      .poll(() =>
        sidebarBrand
          .locator(".sidebar-brand__collapse, .sidebar-brand__search")
          .evaluateAll((buttons) =>
            buttons.map((button) => {
              const icon = button.querySelector("svg");
              if (!icon) {
                return null;
              }
              const buttonBox = button.getBoundingClientRect();
              const iconBox = icon.getBoundingClientRect();
              return Math.round(
                buttonBox.left + buttonBox.width / 2 - (iconBox.left + iconBox.width / 2),
              );
            }),
          ),
      )
      .toEqual([0, 0]);
    await expect
      .poll(() =>
        sidebarBrand.locator(".sidebar-agent-card__avatar").evaluate((avatar) => {
          const style = getComputedStyle(avatar);
          return [style.width, style.height];
        }),
      )
      .toEqual(["28px", "28px"]);
    await expect
      .poll(() =>
        sidebarBrand.locator(".sidebar-brand__new-thread").evaluate((button) => {
          const style = getComputedStyle(button);
          return [style.width, style.height, style.boxShadow];
        }),
      )
      .toEqual(["28px", "28px", "none"]);
    const actionStyles = await sidebarBrand
      .locator(".sidebar-brand__collapse, .sidebar-brand__search, .sidebar-brand__new-thread")
      .evaluateAll((actions) =>
        actions.map((action) => {
          const icon = action.querySelector("svg");
          const actionStyle = getComputedStyle(action);
          const iconStyle = icon ? getComputedStyle(icon) : null;
          return {
            backgroundColor: actionStyle.backgroundColor,
            borderStyle: actionStyle.borderTopStyle,
            borderWidth: actionStyle.borderTopWidth,
            boxShadow: actionStyle.boxShadow,
            color: actionStyle.color,
            iconOpacity: iconStyle?.opacity,
            iconStrokeWidth: iconStyle?.strokeWidth,
          };
        }),
      );
    expect(actionStyles).toHaveLength(3);
    expect(actionStyles[1]).toEqual(actionStyles[0]);
    expect(actionStyles[2]).toEqual(actionStyles[0]);
    await expect
      .poll(() =>
        sidebarBrand
          .locator(".sidebar-brand__collapse, .sidebar-brand__search, .sidebar-brand__new-thread")
          .evaluateAll((actions) =>
            actions.map((action) => {
              const icon = action.querySelector("svg");
              if (!icon) {
                return null;
              }
              const shapes = Array.from(
                icon.querySelectorAll<SVGGraphicsElement>(
                  "circle, ellipse, line, path, polygon, polyline, rect",
                ),
              );
              const bounds = shapes.map((shape) => shape.getBBox());
              const left = Math.min(...bounds.map((box) => box.x));
              const right = Math.max(...bounds.map((box) => box.x + box.width));
              return Math.round((right - left) * (icon.getBoundingClientRect().width / 24));
            }),
          ),
      )
      .toEqual([12, 12, 12]);

    const actionInset = async (direction: "ltr" | "rtl") => {
      const [brandBox, actionsBox] = await Promise.all([
        sidebarBrand.boundingBox(),
        sidebarBrand.locator(".sidebar-brand__actions").boundingBox(),
      ]);
      if (!brandBox || !actionsBox) {
        return null;
      }
      return direction === "rtl"
        ? Math.round(actionsBox.x - brandBox.x)
        : Math.round(brandBox.x + brandBox.width - (actionsBox.x + actionsBox.width));
    };
    const nameFade = () =>
      agentName.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.paddingLeft, style.paddingRight, style.maskImage];
      });

    await expect.poll(() => actionInset("ltr")).toBe(2);
    await expect.poll(nameFade).toEqual(["0px", "8px", expect.stringContaining("90deg")]);
    await page.evaluate(() => {
      document.documentElement.dir = "rtl";
    });
    await expect.poll(() => actionInset("rtl")).toBe(0);
    await expect.poll(nameFade).toEqual(["8px", "0px", expect.stringContaining("270deg")]);
  });

  it("keeps the native sidebar avatar larger", async () => {
    const page = await openPage({ webChrome: true, width: 1440 });
    await expect
      .poll(() =>
        page.locator(".sidebar-agent-card__avatar").evaluate((avatar) => {
          const style = getComputedStyle(avatar);
          return [style.width, style.height];
        }),
      )
      .toEqual(["32px", "32px"]);
  });

  it("opens the mobile drawer by swipe across the full mobile-layout range", async () => {
    const page = await openPage({ hasTouch: true, height: 393, width: 852 });
    const shell = page.locator(".shell");
    await expect.poll(() => shell.getAttribute("class")).toContain("shell--mobile-nav");

    await page.locator(".content").evaluate((content) => {
      const touch = (clientX: number, clientY: number) =>
        new Touch({
          identifier: 1,
          target: content,
          clientX,
          clientY,
          pageX: clientX,
          pageY: clientY,
          screenX: clientX,
          screenY: clientY,
        });
      content.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          composed: true,
          touches: [touch(24, 180)],
          changedTouches: [touch(24, 180)],
        }),
      );
      content.dispatchEvent(
        new TouchEvent("touchmove", {
          bubbles: true,
          cancelable: true,
          composed: true,
          touches: [touch(210, 184)],
          changedTouches: [touch(210, 184)],
        }),
      );
      content.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          composed: true,
          touches: [],
          changedTouches: [touch(210, 184)],
        }),
      );
    });

    await expect.poll(() => shell.getAttribute("class")).toContain("shell--nav-drawer-open");
    await expect.poll(() => page.locator(".shell-nav.nav-drawer").isVisible()).toBe(true);
  });
});
