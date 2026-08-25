import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  actionOpacity,
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("vertically centers session actions in a two-line row", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          Object.assign(
            sessionRow("agent:main:two-line", "Two-line session", Date.now() - 1, {
              pinned: true,
            }),
            { lastMessagePreview: "Finishing repository setup review" },
          ),
        ]),
      },
      sessionKey: "agent:main:two-line",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:two-line"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      const pin = row.getByRole("button", { name: "Unpin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await pin.hover();
      await captureUiProof(page, "sidebar-session-actions-centered.png");

      const [rowBounds, titleBounds, subtitleBounds, pinBounds, pinGlyphBounds, menuBounds] =
        await Promise.all([
          row.boundingBox(),
          row.locator(".sidebar-recent-session__name").boundingBox(),
          row.locator(".sidebar-recent-session__subtitle").boundingBox(),
          pin.boundingBox(),
          pin.locator("svg").boundingBox(),
          menu.boundingBox(),
        ]);
      if (
        !rowBounds ||
        !titleBounds ||
        !subtitleBounds ||
        !pinBounds ||
        !pinGlyphBounds ||
        !menuBounds
      ) {
        throw new Error("Expected visible two-line session action geometry");
      }
      const rowCenter = rowBounds.y + rowBounds.height / 2;
      const titleCenter = titleBounds.y + titleBounds.height / 2;
      // Two-line rows anchor the actions to the title line so the subtitle keeps
      // its own line; the row centre falls between the two lines instead.
      expect(subtitleBounds.y + subtitleBounds.height / 2).toBeGreaterThan(rowCenter);
      expect(Math.abs(pinBounds.y + pinBounds.height / 2 - titleCenter)).toBeLessThanOrEqual(1);
      expect(Math.abs(menuBounds.y + menuBounds.height / 2 - titleCenter)).toBeLessThanOrEqual(1);
      expect(pinBounds.width).toBeGreaterThanOrEqual(24);
      expect(pinBounds.height).toBeGreaterThanOrEqual(24);
      expect(menuBounds.width).toBeGreaterThanOrEqual(24);
      expect(menuBounds.height).toBeGreaterThanOrEqual(24);
      expect(pinGlyphBounds.y + pinGlyphBounds.height).toBeLessThanOrEqual(subtitleBounds.y);
      const subtitleHitTarget = await page.evaluate(
        ({ x, y }) => {
          const target = document.elementFromPoint(x, y);
          return {
            action: target?.closest(".session-action")?.getAttribute("aria-label") ?? null,
            link: target?.closest(".sidebar-recent-session__link") !== null,
          };
        },
        {
          x: pinBounds.x + pinBounds.width / 2,
          y: subtitleBounds.y + 1,
        },
      );
      expect(subtitleHitTarget).toEqual({ action: null, link: true });

      await page.evaluate(() => {
        document.documentElement.style.setProperty("--control-ui-text-scale", "1.4");
      });
      const [
        scaledTitleBounds,
        scaledSubtitleBounds,
        scaledPinBounds,
        scaledPinGlyphBounds,
        scaledMenuBounds,
      ] = await Promise.all([
        row.locator(".sidebar-recent-session__name").boundingBox(),
        row.locator(".sidebar-recent-session__subtitle").boundingBox(),
        pin.boundingBox(),
        pin.locator("svg").boundingBox(),
        menu.boundingBox(),
      ]);
      if (
        !scaledTitleBounds ||
        !scaledSubtitleBounds ||
        !scaledPinBounds ||
        !scaledPinGlyphBounds ||
        !scaledMenuBounds
      ) {
        throw new Error("Expected scaled two-line session action geometry");
      }
      const scaledTitleCenter = scaledTitleBounds.y + scaledTitleBounds.height / 2;
      expect(
        Math.abs(scaledPinBounds.y + scaledPinBounds.height / 2 - scaledTitleCenter),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(scaledMenuBounds.y + scaledMenuBounds.height / 2 - scaledTitleCenter),
      ).toBeLessThanOrEqual(1);
      expect(scaledPinGlyphBounds.y + scaledPinGlyphBounds.height).toBeLessThanOrEqual(
        scaledSubtitleBounds.y,
      );
    } finally {
      await context.close();
    }
  });

  it("keeps action-only text widest at rest and keeps active state lit", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:hover-actions",
            "A deliberately long action-only sidebar title",
            Date.now() - 1,
          ),
          sessionRow("agent:main:hover-active", "Hover active", Date.now() - 1, {
            hasActiveRun: true,
            status: "running",
          }),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const actionOnlyRow = page.locator('[data-session-key="agent:main:hover-actions"]');
      await actionOnlyRow.waitFor({ state: "visible", timeout: 10_000 });
      const actionOnlyText = actionOnlyRow.locator(".sidebar-recent-session__text");
      const actionOnlyLink = actionOnlyRow.locator(".sidebar-recent-session__link");
      const actionOnlyPin = actionOnlyRow.getByRole("button", { name: "Pin session" });
      await expect
        .poll(() => actionOnlyRow.getAttribute("class"))
        .toContain("sidebar-recent-session--single-line");
      await expect
        .poll(() => actionOnlyLink.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("2px");
      const restingTextBounds = await actionOnlyText.boundingBox();

      await actionOnlyRow.hover();
      await expect.poll(() => actionOpacity(actionOnlyPin)).toBe("1");
      const [actionOnlyHoveredTextBounds, actionOnlyHoveredNameBounds, actionOnlyHoveredPinBounds] =
        await Promise.all([
          actionOnlyText.boundingBox(),
          actionOnlyRow.locator(".sidebar-recent-session__name").boundingBox(),
          actionOnlyPin.boundingBox(),
        ]);

      await page.mouse.move(0, 0);
      await actionOnlyPin.focus();
      await expect.poll(() => actionOpacity(actionOnlyPin)).toBe("1");
      const [actionOnlyFocusedTextBounds, actionOnlyFocusedNameBounds, actionOnlyFocusedPinBounds] =
        await Promise.all([
          actionOnlyText.boundingBox(),
          actionOnlyRow.locator(".sidebar-recent-session__name").boundingBox(),
          actionOnlyPin.boundingBox(),
        ]);
      if (
        !restingTextBounds ||
        !actionOnlyHoveredTextBounds ||
        !actionOnlyHoveredNameBounds ||
        !actionOnlyHoveredPinBounds ||
        !actionOnlyFocusedTextBounds ||
        !actionOnlyFocusedNameBounds ||
        !actionOnlyFocusedPinBounds
      ) {
        throw new Error("Expected visible action-only text geometry");
      }
      expect(actionOnlyHoveredTextBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      expect(actionOnlyFocusedTextBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      expect(actionOnlyHoveredNameBounds.x + actionOnlyHoveredNameBounds.width).toBeLessThanOrEqual(
        actionOnlyHoveredPinBounds.x + 1,
      );
      expect(actionOnlyFocusedNameBounds.x + actionOnlyFocusedNameBounds.width).toBeLessThanOrEqual(
        actionOnlyFocusedPinBounds.x + 1,
      );

      const row = page.locator('[data-session-key="agent:main:hover-active"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const state = row.locator(".session-row-state");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => actionOpacity(state)).toBe("1");

      await row.hover();
      // The spinner is the signal that the row is still working; hovering to
      // reach the actions must not take it away on a two-line row.
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");

      const [nameBounds, pinBounds, menuBounds, stateBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__name").boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
        state.boundingBox(),
      ]);
      if (!nameBounds || !pinBounds || !menuBounds || !stateBounds) {
        throw new Error("Expected visible hovered action geometry");
      }
      expect(nameBounds.y + nameBounds.height / 2).toBeCloseTo(
        pinBounds.y + pinBounds.height / 2,
        1,
      );
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);
      // The reservation slides the endcap clear instead of hiding it, so the
      // run spinner and unread dot survive the hover that reveals the buttons.
      expect(stateBounds.x + stateBounds.width).toBeLessThanOrEqual(pinBounds.x);

      await page.mouse.move(0, 0);
      await pin.focus();
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");

      const [focusedNameBounds, focusedPinBounds, focusedMenuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__name").boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!focusedNameBounds || !focusedPinBounds || !focusedMenuBounds) {
        throw new Error("Expected visible focused action geometry");
      }
      expect(focusedNameBounds.y + focusedNameBounds.height / 2).toBeCloseTo(
        focusedPinBounds.y + focusedPinBounds.height / 2,
        1,
      );
      expect(focusedPinBounds.x + focusedPinBounds.width).toBeLessThanOrEqual(focusedMenuBounds.x);
    } finally {
      await context.close();
    }
  });

  it("keeps fork provenance in the title above always-visible touch actions", async () => {
    const context = await suite.browser.newContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:touch-forked",
            "A deliberately long non-running touch session title that must not overlap controls",
            Date.now() - 1,
            {
              forkSource: { sessionKey: "agent:main:main", sessionId: "source-session" },
              hasActiveRun: false,
              status: "done",
            },
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:touch-forked"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const fork = row.locator(".sidebar-recent-session__name .sidebar-session-fork-indicator");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => fork.isVisible()).toBe(true);
      await expect.poll(() => row.locator(".session-row-state").count()).toBe(0);

      const [nameBounds, forkBounds, pinBounds, menuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__name").boundingBox(),
        fork.boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!nameBounds || !forkBounds || !pinBounds || !menuBounds) {
        throw new Error("Expected visible fork and touch action geometry");
      }
      expect(
        Math.abs(forkBounds.y + forkBounds.height / 2 - (nameBounds.y + nameBounds.height / 2)),
      ).toBeLessThanOrEqual(2);
      // The actions ride the title's midline now, and the title ends before them.
      expect(
        Math.abs(nameBounds.y + nameBounds.height / 2 - (pinBounds.y + pinBounds.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(pinBounds.x + 1);
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);
    } finally {
      await context.close();
    }
  });

  it("lines the whole trailing column up on one pitch", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          // A preview gives the row its second line, which is where the endcap
          // sits directly under the action icons.
          Object.assign(
            sessionRow("agent:main:badged", "Badged session", Date.now() - 1, {
              hasAutomation: true,
              incognito: true,
              status: "done",
              unread: true,
            }),
            { lastMessagePreview: "Kept the endcap lit under the hover actions" },
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:badged"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => row.locator(".session-unread-dot").isVisible()).toBe(true);
      await row.hover();
      await expect
        .poll(() =>
          row.locator("[data-session-menu]").evaluate((el) => getComputedStyle(el).opacity),
        )
        .toBe("1");

      const column = await row.evaluate((element) => {
        const centres = (root: Element | null, selector: string) =>
          [...(root?.querySelectorAll(selector) ?? [])]
            .map((glyph) => glyph.getBoundingClientRect())
            .filter((rect) => rect.width > 0)
            .map((rect) => Math.round((rect.left + rect.width / 2) * 10) / 10)
            .toSorted((left, right) => left - right);
        return {
          actions: centres(element, ".session-action svg"),
          endcap: centres(
            element.querySelector(".sidebar-recent-session__details-endcap"),
            "svg, .session-unread-dot, .session-run-spinner",
          ),
        };
      });

      // The endcap's bare glyphs and the action icons above them read as one
      // column, so they need one pitch and one right-hand axis. Sized to their
      // own boxes the buttons stepped 25px while the badges stepped 20px and
      // ended 5px further right, so nothing sat under anything.
      expect(column.endcap.length).toBeGreaterThan(1);
      expect(column.actions.length).toBeGreaterThan(1);
      const stepsOf = (centres: number[]) =>
        centres.slice(1).map((centre, index) => Math.round(centre - (centres[index] as number)));
      const steps = [...stepsOf(column.endcap), ...stepsOf(column.actions)];
      for (const step of steps) {
        expect(step, JSON.stringify(column)).toBe(steps[0]);
      }
      expect(column.endcap.at(-1), JSON.stringify(column)).toBeCloseTo(
        column.actions.at(-1) as number,
        0,
      );
    } finally {
      await context.close();
    }
  });

  it("draws every row glyph at one size", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow("agent:main:mixed", "Mixed glyphs", Date.now() - 1, {
            forkSource: { sessionKey: "agent:main:main", sessionId: "source-session" },
            hasActiveRun: true,
            hasAutomation: true,
            incognito: true,
            status: "running",
            unread: true,
          }),
          sessionRow("agent:main:archived", "Archived glyph", Date.now() - 2, {
            archived: true,
          }),
          sessionRow("agent:main:queued", "Queued glyph", Date.now() - 3, {
            hasActiveRun: true,
            status: "queued",
          }),
        ]),
      },
      sessionKey: "agent:main:archived",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:mixed"]');
      const archivedRow = page.locator('[data-session-key="agent:main:archived"]');
      const queuedRow = page.locator('[data-session-key="agent:main:queued"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await archivedRow.waitFor({ state: "visible", timeout: 10_000 });
      await queuedRow.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await expect
        .poll(() =>
          row.locator("[data-session-menu]").evaluate((el) => getComputedStyle(el).opacity),
        )
        .toBe("1");

      // Badges, fork provenance and the action icons drew themselves at
      // different sizes on the same line, which reads as broken alignment. The
      // unread dot is a dot rather than a glyph and keeps its own size.
      const measured = await page
        .locator(
          '[data-session-key="agent:main:mixed"], [data-session-key="agent:main:archived"], [data-session-key="agent:main:queued"]',
        )
        .evaluateAll((elements) => {
          const glyphSizes = new Set<string>();
          for (const element of elements) {
            for (const glyph of element.querySelectorAll("svg")) {
              if (glyph.getBoundingClientRect().width === 0) {
                continue;
              }
              const style = getComputedStyle(glyph);
              glyphSizes.add(
                `${Number.parseFloat(style.width)}x${Number.parseFloat(style.height)}`,
              );
            }
          }
          const spinner = elements[0]?.querySelector(".session-run-spinner");
          return {
            glyphSizes: [...glyphSizes],
            spinnerWidth: spinner ? Number.parseFloat(getComputedStyle(spinner).width) : null,
          };
        });

      expect(measured.glyphSizes.length, JSON.stringify(measured.glyphSizes)).toBe(1);
      // The ring inks its whole box while the icons only ink 9-10px of theirs,
      // so it sits three px down rather than matching box for box.
      const glyphWidth = Number.parseFloat(measured.glyphSizes[0] as string);
      expect(measured.spinnerWidth).toBe(glyphWidth - 3);
    } finally {
      await context.close();
    }
  });

  it("keeps semantic state beside always-visible touch actions", async () => {
    const context = await suite.browser.newContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          Object.assign(
            sessionRow("agent:main:touch-active", "Touch active", Date.now() - 1, {
              hasActiveRun: true,
              status: "running",
            }),
            { lastMessagePreview: "Persistent touch subtitle" },
          ),
          sessionRow("agent:main:touch-idle", "Touch idle", Date.now() - 2),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:touch-active"]');
      const singleLineRow = page.locator('[data-session-key="agent:main:touch-idle"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await singleLineRow.waitFor({ state: "visible", timeout: 10_000 });
      const state = row.locator(".session-row-state");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => pin.isVisible()).toBe(true);
      await expect.poll(() => menu.isVisible()).toBe(true);

      const [rowBounds, stateBounds, pinBounds, menuBounds] = await Promise.all([
        row.boundingBox(),
        state.boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!rowBounds || !stateBounds || !pinBounds || !menuBounds) {
        throw new Error("Expected visible touch state and action geometry");
      }
      expect(rowBounds.height).toBeGreaterThanOrEqual(44);
      expect(pinBounds.width).toBeGreaterThanOrEqual(44);
      expect(pinBounds.height).toBeGreaterThanOrEqual(44);
      expect(menuBounds.width).toBeGreaterThanOrEqual(44);
      expect(menuBounds.height).toBeGreaterThanOrEqual(44);
      expect(stateBounds.x + stateBounds.width).toBeLessThanOrEqual(pinBounds.x);
      const [singleLineRowBounds, singleLineLinkBounds] = await Promise.all([
        singleLineRow.boundingBox(),
        singleLineRow.locator(".sidebar-recent-session__link").boundingBox(),
      ]);
      if (!singleLineRowBounds || !singleLineLinkBounds) {
        throw new Error("Expected visible single-line touch row geometry");
      }
      expect(singleLineLinkBounds.height).toBeGreaterThanOrEqual(singleLineRowBounds.height);
      const topBandIsLink = await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest(".sidebar-recent-session__link") !== null,
        {
          x: singleLineRowBounds.x + 20,
          y: singleLineRowBounds.y + 1,
        },
      );
      expect(topBandIsLink).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("contains touch actions within consecutive pinned rows", async () => {
    const context = await suite.browser.newContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const now = Date.now();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", now),
          sessionRow("agent:main:pinned-first", "Pinned first", now - 1, {
            pinned: true,
            pinnedAt: now - 1,
          }),
          sessionRow("agent:main:pinned-second", "Pinned second", now - 2, {
            pinned: true,
            pinnedAt: now - 2,
          }),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const firstRow = page.locator(
        '[data-sidebar-entry="session:agent:main:pinned-first"] .sidebar-recent-session',
      );
      const secondRow = page.locator(
        '[data-sidebar-entry="session:agent:main:pinned-second"] .sidebar-recent-session',
      );
      await firstRow.waitFor({ state: "visible", timeout: 10_000 });
      await secondRow.waitFor({ state: "visible", timeout: 10_000 });
      const firstMenu = firstRow.getByRole("button", { name: "Open session menu: Pinned first" });
      const [firstRowBounds, secondRowBounds, firstMenuBounds] = await Promise.all([
        firstRow.boundingBox(),
        secondRow.boundingBox(),
        firstMenu.boundingBox(),
      ]);
      if (!firstRowBounds || !secondRowBounds || !firstMenuBounds) {
        throw new Error("Expected visible pinned touch row geometry");
      }
      expect(firstRowBounds.height).toBeGreaterThanOrEqual(44);
      expect(secondRowBounds.height).toBeGreaterThanOrEqual(44);
      expect(firstMenuBounds.y).toBeGreaterThanOrEqual(firstRowBounds.y);
      expect(firstMenuBounds.y + firstMenuBounds.height).toBeLessThanOrEqual(
        firstRowBounds.y + firstRowBounds.height,
      );
      const boundaryTarget = await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest<HTMLElement>(".sidebar-recent-session")
            ?.getAttribute("data-session-key") ?? null,
        {
          x: firstMenuBounds.x + firstMenuBounds.width / 2,
          y: secondRowBounds.y + 1,
        },
      );
      expect(boundaryTarget).toBe("agent:main:pinned-second");
    } finally {
      await context.close();
    }
  });

  it("does not widen desktop session text or dim trailing state under hover actions", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.patch",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:combined-state",
            "Combined state with a deliberately long resting sidebar title",
            Date.now() - 1,
            {
              forkSource: { sessionKey: "agent:main:main", sessionId: "source-session" },
              hasActiveRun: true,
              status: "running",
              unread: true,
              worktree: {
                id: "combined-state-worktree",
                branch: "fix/combined-state",
                repoRoot: "/tmp/openclaw",
              },
            },
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const codingToggle = page.locator(
        '[data-session-section="work"] .sidebar-session-group-toggle',
      );
      await codingToggle.waitFor({ state: "visible" });
      await codingToggle.click();
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
          return requests.some((request) => {
            const sessionKeys = requireRecord(request.params).sessionKeys;
            return Array.isArray(sessionKeys) && sessionKeys.includes("agent:main:combined-state");
          });
        })
        .toBe(true);
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          "agent:main:combined-state": {
            pullRequests: [
              {
                branch: "fix/combined-state",
                number: 1,
                owner: "openclaw",
                repo: "openclaw",
                state: "open",
                title: "Combined state fix",
                url: "https://example.test/openclaw/openclaw/pull/1",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        },
      });

      const row = page.locator('[data-session-key="agent:main:combined-state"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const state = row.locator(".session-row-state");
      await expect
        .poll(() =>
          row.locator(".sidebar-recent-session__name .sidebar-session-fork-indicator").isVisible(),
        )
        .toBe(true);
      await expect.poll(() => state.locator('[aria-label="Forked session"]').count()).toBe(0);
      await expect
        .poll(() => state.locator("[data-session-pr-state='open']").isVisible())
        .toBe(true);
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => state.locator(".session-unread-dot").count()).toBe(0);
      const [pullRequestGlyphStyle, actionGlyphStyle] = await Promise.all([
        state.locator("[data-session-pr-state='open'] svg").evaluate((glyph) => {
          const style = getComputedStyle(glyph);
          return { height: style.height, strokeWidth: style.strokeWidth, width: style.width };
        }),
        row
          .locator(".session-action svg")
          .first()
          .evaluate((glyph) => {
            const style = getComputedStyle(glyph);
            return { height: style.height, strokeWidth: style.strokeWidth, width: style.width };
          }),
      ]);
      expect(pullRequestGlyphStyle).toEqual(actionGlyphStyle);
      const stateLayout = await row.evaluate((element) => {
        const endcap = element.querySelector<HTMLElement>(
          ".sidebar-recent-session__details-endcap",
        );
        const atoms = Array.from(
          element.querySelectorAll<HTMLElement>(
            ".session-row-state :is([data-session-pr-state='open'], .session-run-spinner)",
          ),
        );
        if (!endcap || atoms.length !== 2) {
          throw new Error("Expected visible session state geometry");
        }
        const layoutLeft = (node: HTMLElement) => {
          let left = 0;
          for (
            let current: HTMLElement | null = node;
            current;
            current = current.offsetParent as HTMLElement | null
          ) {
            left += current.offsetLeft;
          }
          return left;
        };
        const endcapLeft = layoutLeft(endcap);
        return {
          endcapLeft,
          endcapRight: endcapLeft + endcap.offsetWidth,
          atoms: atoms.map((atom) => ({
            left: layoutLeft(atom),
            right: layoutLeft(atom) + atom.offsetWidth,
          })),
        };
      });
      for (const atom of stateLayout.atoms) {
        expect(atom.left).toBeGreaterThanOrEqual(stateLayout.endcapLeft);
        expect(atom.right).toBeLessThanOrEqual(stateLayout.endcapRight);
      }
      const link = row.locator(".sidebar-recent-session__link");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect
        .poll(() => link.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("2px");

      const [restingTextBounds, restingStateBounds, restingPinBounds, restingMenuBounds] =
        await Promise.all([
          row.locator(".sidebar-recent-session__text").boundingBox(),
          state.boundingBox(),
          pin.boundingBox(),
          menu.boundingBox(),
        ]);
      if (!restingTextBounds || !restingStateBounds || !restingPinBounds || !restingMenuBounds) {
        throw new Error("Expected visible resting session state geometry");
      }
      const actionSurfaceWidth = restingMenuBounds.x + restingMenuBounds.width - restingPinBounds.x;
      expect(restingTextBounds.x + restingTextBounds.width).toBeGreaterThan(
        restingStateBounds.x - actionSurfaceWidth,
      );
      const restingNameBounds = await row.locator(".sidebar-recent-session__name").boundingBox();
      if (!restingNameBounds) {
        throw new Error("Expected visible resting session title geometry");
      }
      expect(restingNameBounds.y + restingNameBounds.height / 2).toBeLessThan(
        restingStateBounds.y + restingStateBounds.height / 2,
      );
      await row.hover();
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");

      const [textBounds, nameBounds, pinBounds, pinGlyphBounds, menuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__text").boundingBox(),
        row.locator(".sidebar-recent-session__name").boundingBox(),
        pin.boundingBox(),
        pin.locator("svg").boundingBox(),
        menu.boundingBox(),
      ]);
      if (!textBounds || !nameBounds || !pinBounds || !pinGlyphBounds || !menuBounds) {
        throw new Error("Expected visible combined session action geometry");
      }
      expect(textBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      // A control taller than the title line would paint its hover fill over the
      // badges that now stay lit directly below it.
      const detailsBounds = await row.locator(".sidebar-recent-session__details").boundingBox();
      if (!detailsBounds) {
        throw new Error("Expected a visible second line");
      }
      expect(pinGlyphBounds.y + pinGlyphBounds.height).toBeLessThanOrEqual(detailsBounds.y);
      // The actions ride the title's midline now, and the title ends before them.
      expect(
        Math.abs(nameBounds.y + nameBounds.height / 2 - (pinBounds.y + pinBounds.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(pinBounds.x + 1);
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);
      await page.mouse.move(0, 0);
      await pin.focus();
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");

      const [focusedTextBounds, focusedNameBounds, focusedPinBounds, focusedMenuBounds] =
        await Promise.all([
          row.locator(".sidebar-recent-session__text").boundingBox(),
          row.locator(".sidebar-recent-session__name").boundingBox(),
          pin.boundingBox(),
          menu.boundingBox(),
        ]);
      if (!focusedTextBounds || !focusedNameBounds || !focusedPinBounds || !focusedMenuBounds) {
        throw new Error("Expected visible focused session action geometry");
      }
      expect(focusedTextBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      expect(
        Math.abs(
          focusedNameBounds.y +
            focusedNameBounds.height / 2 -
            (focusedPinBounds.y + focusedPinBounds.height / 2),
        ),
      ).toBeLessThanOrEqual(1);
      expect(focusedNameBounds.x + focusedNameBounds.width).toBeLessThanOrEqual(
        focusedPinBounds.x + 1,
      );
      expect(focusedPinBounds.x + focusedPinBounds.width).toBeLessThanOrEqual(focusedMenuBounds.x);
    } finally {
      await context.close();
    }
  });
});
