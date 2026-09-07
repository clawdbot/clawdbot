import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

function largeOwnerList(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: "human" as const,
    id: index === count - 1 ? `profile-${"owner-without-label-".repeat(10)}` : `profile-${index}`,
    ...(index === count - 1 ? {} : { label: `Owner ${index + 1}` }),
  }));
}

suite.define(() => {
  it("navigates the owner filter submenu with arrow, Enter, and Escape keys", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-patrick", name: "Patrick" }],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": {
          ...sessionsListResponse([
            sessionRow("agent:main:ada", "Ada research", 2),
            sessionRow("agent:main:bob", "Bob operations", 1),
          ]),
          owners: [
            { type: "human", id: "profile-ada", label: "Ada Lovelace Byron" },
            { type: "human", id: "profile-bob", label: "Bob" },
            { type: "human", id: "profile-carol", label: "Carol" },
            { type: "human", id: "profile-dave", label: "Dave" },
          ],
        },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
      const trigger = page.getByRole("button", { name: "Filter & sort" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const menu = page.locator(".sidebar-session-sort-menu");
      const ownerSubmenu = menu.getByRole("menuitem", {
        name: "Specific owner: 5 available",
        exact: true,
      });
      const allOwnersLabel = menu.locator('[value="owner:"] .session-menu__text');
      const ownersLabel = ownerSubmenu.locator(":scope > .session-menu__text");
      const labelAlignment = await allOwnersLabel.evaluate(
        (allOwners, owners) =>
          Math.abs(allOwners.getBoundingClientRect().left - owners.getBoundingClientRect().left),
        await ownersLabel.elementHandle(),
      );
      expect(labelAlignment).toBeLessThanOrEqual(0.5);
      expect(await ownersLabel.evaluate((label) => getComputedStyle(label).color)).toBe(
        await allOwnersLabel.evaluate((label) => getComputedStyle(label).color),
      );
      await expect
        .poll(() => ownerSubmenu.locator(".sidebar-session-owner-count").textContent())
        .toBe("5");
      expect(
        await ownerSubmenu
          .locator(":scope > .sidebar-session-owner-selection .viewer-avatar")
          .count(),
      ).toBe(0);
      const trailingGap = (item: typeof ownerSubmenu, selector: string) =>
        item.evaluate((element, contentSelector) => {
          const details = element.querySelector<HTMLElement>(":scope > [slot='details']");
          const chevron = element.shadowRoot?.querySelector<HTMLElement>("[part='submenu-icon']");
          const content = element.querySelector<HTMLElement>(contentSelector);
          if (!details || !chevron || !content) {
            throw new Error("expected owner trailing content and submenu chevron");
          }
          const contentBounds = content.getBoundingClientRect();
          if (details !== content) {
            const range = document.createRange();
            range.selectNodeContents(content);
            return chevron.getBoundingClientRect().left - range.getBoundingClientRect().right;
          }
          return chevron.getBoundingClientRect().left - contentBounds.right;
        }, selector);
      expect(await trailingGap(ownerSubmenu, ".sidebar-session-owner-count")).toBeLessThanOrEqual(
        8,
      );
      const focusedTopLevelItem = menu.locator(
        ':scope > wa-dropdown-item:not([slot="submenu"]):focus',
      );
      await expect.poll(() => focusedTopLevelItem.count()).toBe(1);
      const parentIndex = await ownerSubmenu.evaluate((element) =>
        [...(element.parentElement?.children ?? [])]
          .filter(
            (item) =>
              item.localName === "wa-dropdown-item" && item.getAttribute("slot") !== "submenu",
          )
          .indexOf(element),
      );
      expect(parentIndex).toBeGreaterThanOrEqual(0);

      const focusOwnerSubmenu = async () => {
        await page.keyboard.press("Home");
        for (let step = 0; step < parentIndex; step += 1) {
          await page.keyboard.press("ArrowDown");
        }
      };
      await focusOwnerSubmenu();
      await expect
        .poll(() => ownerSubmenu.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await page.keyboard.press("ArrowRight");
      await expect.poll(() => ownerSubmenu.getAttribute("aria-expanded")).toBe("true");
      await expect
        .poll(() =>
          ownerSubmenu.evaluate((element) =>
            element.shadowRoot?.querySelector('[part="submenu"]')?.getAttribute("aria-label"),
          ),
        )
        .toBe("Specific owner: 5 available");
      await page.keyboard.press("Escape");
      await expect.poll(() => ownerSubmenu.getAttribute("aria-expanded")).toBe("false");
      await expect.poll(() => menu.getAttribute("open")).toBeNull();
      await expect
        .poll(() => trigger.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await page.keyboard.press("Enter");
      await expect.poll(() => focusedTopLevelItem.count()).toBe(1);
      await focusOwnerSubmenu();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => ownerSubmenu.getAttribute("aria-expanded")).toBe("true");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) =>
              (request.params as { ownerId?: unknown } | undefined)?.ownerId === "profile-ada",
          ),
        )
        .toBe(true);
      await expect.poll(() => menu.count()).toBe(0);
      await trigger.click();
      await expect
        .poll(() =>
          page
            .getByRole("menuitem", { name: "Specific owner: Ada Lovelace Byron", exact: true })
            .locator(".sidebar-session-owner-selection .viewer-avatar")
            .count(),
        )
        .toBe(1);
      const selectedOwnerSubmenu = page.getByRole("menuitem", {
        name: "Specific owner: Ada Lovelace Byron",
        exact: true,
      });
      await expect
        .poll(() =>
          selectedOwnerSubmenu.locator(".sidebar-session-owner-selection__name").textContent(),
        )
        .toBe("Ada Lovelace Byron");
      await expect
        .poll(() => page.locator('[value="owner:"]').getAttribute("aria-checked"))
        .toBe("false");
      expect(
        await trailingGap(selectedOwnerSubmenu, ".sidebar-session-owner-selection__name"),
      ).toBeLessThanOrEqual(8);
      // The long owner name must truncate; the row label keeps its full text
      // and never runs underneath the avatar and name rail.
      const { labelClipped, overlap } = await selectedOwnerSubmenu.evaluate((element) => {
        const label = element.querySelector<HTMLElement>(":scope > .session-menu__text");
        const details = element.querySelector<HTMLElement>(":scope > [slot='details']");
        if (!label || !details) {
          throw new Error("expected owner label and selection rail");
        }
        const range = document.createRange();
        range.selectNodeContents(label);
        return {
          labelClipped: label.scrollWidth > label.clientWidth,
          overlap: range.getBoundingClientRect().right - details.getBoundingClientRect().left,
        };
      });
      expect(labelClipped).toBe(false);
      expect(overlap).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });

  it.each([
    { name: "desktop", ownerCount: 60, viewport: { height: 800, width: 1200 } },
    { name: "compact", ownerCount: 30, viewport: { height: 650, width: 390 } },
  ])("contains a large owner roster in the $name menu", async ({ name, ownerCount, viewport }) => {
    const context = await suite.browser.newContext({ viewport });
    const page = await context.newPage();
    await installMockGateway(page, {
      sessionKey: "agent:main:large-roster",
      methodResponses: {
        "sessions.list": {
          ...sessionsListResponse([
            sessionRow("agent:main:large-roster", "Large owner roster", Date.now()),
          ]),
          owners: largeOwnerList(ownerCount),
        },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:large-roster"));
      if (name === "compact") {
        await page.getByRole("button", { name: "Expand sidebar" }).click();
      }
      await page.getByRole("button", { name: "Filter & sort" }).click();
      const menu = page.locator(".sidebar-session-sort-menu");
      const specificOwner = menu.getByRole("menuitem", { name: /Specific owner/ });
      await specificOwner.waitFor();
      await expect
        .poll(() => specificOwner.getAttribute("aria-label"))
        .toMatch(/^Specific owner: \d+ available$/u);

      if (name === "compact") {
        expect(await specificOwner.getAttribute("aria-haspopup")).toBeNull();
        await specificOwner.evaluate((element) => {
          const menuPart = element
            .closest("wa-dropdown")
            ?.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
          if (menuPart) {
            menuPart.scrollTop = menuPart.scrollHeight;
          }
        });
        await specificOwner.click();
        const back = menu.getByRole("menuitem", { name: "Back", exact: true });
        await back.waitFor();
        expect(await menu.locator('[slot="submenu"]').count()).toBe(0);
        await expect
          .poll(() =>
            menu.evaluate(
              (dropdown) =>
                dropdown.shadowRoot?.querySelector<HTMLElement>('[part="menu"]')?.scrollTop,
            ),
          )
          .toBe(0);
        await expect.poll(() => menu.locator('[value="owner:profile-0"]').isVisible()).toBe(true);
        await back.click();
        await menu.getByRole("menuitem", { name: /Specific owner/ }).click();
        await menu.locator('[value^="owner:"]').last().click();
        await expect.poll(() => menu.count()).toBe(0);
        await page.getByRole("button", { name: "Filter & sort" }).click();
        const selected = page.getByRole("menuitem", { name: /Specific owner:/ });
        const selectedGeometry = await selected.evaluate((element) => {
          const dropdown = element.closest("wa-dropdown");
          const menuPart = dropdown?.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
          const label = element
            .querySelector<HTMLElement>(".session-menu__text")
            ?.getBoundingClientRect();
          const chevron = element
            .querySelector<HTMLElement>(".session-menu__chevron")
            ?.getBoundingClientRect();
          const selectedName = element.querySelector<HTMLElement>(
            ".sidebar-session-owner-selection__name",
          );
          const menuBounds = menuPart?.getBoundingClientRect();
          return {
            menuWidth: menuBounds?.width ?? 0,
            labelLeft: label?.left ?? 0,
            chevronRight: chevron?.right ?? 0,
            menuRight: menuBounds?.right ?? 0,
            nameOverflows: Boolean(
              selectedName && selectedName.scrollWidth > selectedName.clientWidth,
            ),
          };
        });
        expect(selectedGeometry.menuWidth).toBeLessThanOrEqual(220);
        expect(selectedGeometry.labelLeft).toBeGreaterThan(0);
        expect(selectedGeometry.chevronRight).toBeLessThanOrEqual(selectedGeometry.menuRight);
        expect(selectedGeometry.nameOverflows).toBe(true);
        return;
      }

      await specificOwner.hover();
      const submenuMetrics = await specificOwner.evaluate((element) => {
        const submenu = element.shadowRoot?.querySelector<HTMLElement>('[part="submenu"]');
        const lastLabel = element.querySelector<HTMLElement>(
          'wa-dropdown-item[slot="submenu"]:last-of-type .session-menu__text',
        );
        if (!submenu || !lastLabel) {
          throw new Error("expected a complete owner submenu");
        }
        const style = getComputedStyle(submenu);
        return {
          clientHeight: submenu.clientHeight,
          scrollHeight: submenu.scrollHeight,
          width: submenu.getBoundingClientRect().width,
          maxHeight: style.maxHeight,
          maxWidth: style.maxWidth,
          overflowY: style.overflowY,
          labelOverflows: lastLabel.scrollWidth > lastLabel.clientWidth,
        };
      });
      expect(submenuMetrics.clientHeight).toBeLessThanOrEqual(viewport.height - 16);
      expect(submenuMetrics.scrollHeight).toBeGreaterThan(submenuMetrics.clientHeight);
      expect(submenuMetrics.width).toBeLessThanOrEqual(220);
      expect(submenuMetrics.overflowY).toBe("auto");
      expect(submenuMetrics.labelOverflows).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("mirrors compact owner navigation arrows in RTL", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 650, width: 390 } });
    const page = await context.newPage();
    await installMockGateway(page, {
      sessionKey: "agent:main:rtl-owners",
      methodResponses: {
        "sessions.list": {
          ...sessionsListResponse([sessionRow("agent:main:rtl-owners", "RTL owners", Date.now())]),
          owners: largeOwnerList(3),
        },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:rtl-owners"));
      await page.locator("html").evaluate((element) => {
        element.setAttribute("dir", "rtl");
      });
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await page.getByRole("button", { name: "Filter & sort" }).click();
      const specificOwner = page.getByRole("menuitem", { name: /Specific owner/ });
      await expect
        .poll(() =>
          specificOwner
            .locator(".session-menu__chevron")
            .evaluate((element) => getComputedStyle(element).transform),
        )
        .toContain("-1");
      await specificOwner.click();
      await expect
        .poll(() =>
          page
            .getByRole("menuitem", { name: "Back", exact: true })
            .locator(":scope > .session-menu__icon")
            .evaluate((element) => getComputedStyle(element).transform),
        )
        .toContain("-1");
    } finally {
      await context.close();
    }
  });
});
