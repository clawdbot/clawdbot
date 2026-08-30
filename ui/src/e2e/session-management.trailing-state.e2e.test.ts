import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  actionOpacity,
  captureUiProof,
  controlUiSessionUrl,
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
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    await page.addInitScript(() => {
      localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
    });
    await installMockGateway(page, {
      mainSessionKey: "agent:main:main",
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", baseTime),
          Object.assign(
            sessionRow("agent:main:two-line", "Two-line session", baseTime - 1, {
              pinned: true,
              pinnedAt: baseTime,
            }),
            { lastMessagePreview: "Finishing repository setup review" },
          ),
        ]),
      },
      sessionKey: "agent:main:two-line",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:two-line"));
      const row = page.locator('[data-session-key="agent:main:two-line"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const pin = row.getByRole("button", { name: "Unpin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await captureUiProof(page, "sidebar-session-actions-centered.png");

      const [rowBounds, subtitleBounds, pinBounds, menuBounds] = await Promise.all([
        row.boundingBox(),
        row.locator(".sidebar-recent-session__subtitle").boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!rowBounds || !subtitleBounds || !pinBounds || !menuBounds) {
        throw new Error("Expected visible two-line session action geometry");
      }
      const rowCenter = rowBounds.y + rowBounds.height / 2;
      expect(subtitleBounds.y).toBeGreaterThan(rowCenter);
      expect(Math.abs(pinBounds.y + pinBounds.height / 2 - rowCenter)).toBeLessThanOrEqual(1);
      expect(Math.abs(menuBounds.y + menuBounds.height / 2 - rowCenter)).toBeLessThanOrEqual(1);

      await page.evaluate(() => {
        document.documentElement.style.setProperty("--control-ui-text-scale", "1.4");
      });
      await expect
        .poll(async () => {
          const [title, details] = await Promise.all([
            row.locator(".sidebar-recent-session__title-row").boundingBox(),
            row.locator(".sidebar-recent-session__details").boundingBox(),
          ]);
          return title && details ? title.y + title.height - details.y : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(0.5);
      await captureUiProof(page, "sidebar-session-text-scale-140.png");
    } finally {
      await context.close();
    }
  });

  it("keeps action-only text stable and active state visible with actions", async () => {
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
      await expect
        .poll(() => actionOnlyText.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("52px");
      const hoveredTextBounds = await actionOnlyText.boundingBox();

      await page.mouse.move(0, 0);
      await actionOnlyPin.focus();
      await expect.poll(() => actionOpacity(actionOnlyPin)).toBe("1");
      await expect
        .poll(() => actionOnlyText.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("52px");
      const focusedTextBounds = await actionOnlyText.boundingBox();
      if (!restingTextBounds || !hoveredTextBounds || !focusedTextBounds) {
        throw new Error("Expected visible action-only text geometry");
      }
      expect(hoveredTextBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      expect(focusedTextBounds.width).toBeCloseTo(restingTextBounds.width, 1);

      const row = page.locator('[data-session-key="agent:main:hover-active"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const state = row.locator(".session-row-state");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => actionOpacity(state)).toBe("1");

      await row.hover();
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");

      const [nameBounds, pinBounds, menuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__name").boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!nameBounds || !pinBounds || !menuBounds) {
        throw new Error("Expected visible hovered action geometry");
      }
      expect(nameBounds.y + nameBounds.height / 2).toBeCloseTo(
        pinBounds.y + pinBounds.height / 2,
        1,
      );
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);

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
      expect(nameBounds.y + nameBounds.height / 2).toBeCloseTo(
        pinBounds.y + pinBounds.height / 2,
        1,
      );
      expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(pinBounds.x + 1);
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);
    } finally {
      await context.close();
    }
  });

  it("aligns trailing unread dots and trades unread/PR icons for hover actions", async () => {
    const plainKey = "agent:main:unread-plain";
    const pullRequestKey = "agent:main:unread-pr";
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("openclaw:sidebar:sessions:show-preview", "false");
    });
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(plainKey, "Unread plain", Date.now() - 1, { unread: true }),
          sessionRow(pullRequestKey, "Unread with PR", Date.now() - 2, {
            unread: true,
            worktree: {
              id: "unread-pr-worktree",
              branch: "fix/unread-pr",
              repoRoot: "/tmp/openclaw",
            },
          }),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      // Worktree rows land in the Coding zone, which starts collapsed.
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
            return Array.isArray(sessionKeys) && sessionKeys.includes(pullRequestKey);
          });
        })
        .toBe(true);
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [pullRequestKey]: {
            pullRequests: [
              {
                branch: "fix/unread-pr",
                number: 1,
                owner: "openclaw",
                repo: "openclaw",
                state: "merged",
                title: "Unread row pull request",
                url: "https://example.test/openclaw/openclaw/pull/1",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        },
      });

      const plainRow = page.locator(`[data-session-key="${plainKey}"]`);
      const pullRequestRow = page.locator(`[data-session-key="${pullRequestKey}"]`);
      await plainRow.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => pullRequestRow.locator("[data-pull-request-state='merged']").isVisible())
        .toBe(true);

      const dotInsetFromRowRight = async (row: typeof plainRow) => {
        const [rowBounds, dotBounds] = await Promise.all([
          row.boundingBox(),
          row.locator(".session-unread-dot").boundingBox(),
        ]);
        if (!rowBounds || !dotBounds) {
          throw new Error("Expected visible row and unread dot geometry");
        }
        return rowBounds.x + rowBounds.width - (dotBounds.x + dotBounds.width / 2);
      };
      // The dot is the trailing glyph either way, so a PR icon ahead of it must
      // not pull it off the axis dot-only rows share with the action icons.
      // Centring the whole endcap group as one box moved it 3.5px inboard.
      expect(await dotInsetFromRowRight(pullRequestRow)).toBeCloseTo(
        await dotInsetFromRowRight(plainRow),
        0,
      );
      const pullRequestIcon = pullRequestRow.locator("[data-pull-request-state='merged']");
      const unreadDot = pullRequestRow.locator(".session-unread-dot");
      const trailingState = pullRequestRow.locator(".session-row-state");
      await captureUiProof(page, "sidebar-pr-before-hover.png");
      await pullRequestRow.hover();
      await captureUiProof(page, "sidebar-pr-hover.png");
      await pullRequestIcon.waitFor({ state: "hidden" });
      await unreadDot.waitFor({ state: "hidden" });
      await trailingState.waitFor({ state: "hidden" });
      await page.mouse.move(0, 0);
      await pullRequestIcon.waitFor({ state: "visible" });
      await unreadDot.waitFor({ state: "visible" });
      await pullRequestRow.getByRole("button", { name: "Open session menu" }).focus();
      await trailingState.waitFor({ state: "hidden" });
      await codingToggle.focus();
      await pullRequestIcon.waitFor({ state: "visible" });
      await unreadDot.waitFor({ state: "visible" });
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
          sessionRow("agent:main:touch-active", "Touch active", Date.now() - 1, {
            hasActiveRun: true,
            status: "running",
          }),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:touch-active"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const state = row.locator(".session-row-state");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => pin.isVisible()).toBe(true);
      await expect.poll(() => menu.isVisible()).toBe(true);

      const [stateBounds, pinBounds] = await Promise.all([state.boundingBox(), pin.boundingBox()]);
      if (!stateBounds || !pinBounds) {
        throw new Error("Expected visible touch state and action geometry");
      }
      expect(stateBounds.x + stateBounds.width).toBeLessThanOrEqual(pinBounds.x);
    } finally {
      await context.close();
    }
  });

  it("does not widen desktop session text when hover actions appear beside trailing state", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
    });
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
        .poll(() => row.locator("[data-pull-request-state='open']").isVisible())
        .toBe(true);
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => state.locator(".session-unread-dot").count()).toBe(0);
      const prIcon = row.locator("[data-pull-request-state='open'] svg");
      expect(
        await prIcon.evaluate((icon) => {
          const { width, height } = icon.getBoundingClientRect();
          return { width, height };
        }),
      ).toEqual({ width: 12, height: 12 });
      const stateLayout = await row.evaluate((element) => {
        const endcap = element.querySelector<HTMLElement>(
          ".sidebar-recent-session__details-endcap",
        );
        const atoms = Array.from(
          element.querySelectorAll<HTMLElement>(
            ".sidebar-recent-session__details-endcap :is([data-pull-request-state='open'], .session-run-spinner)",
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
      const titleRow = row.locator(".sidebar-recent-session__title-row");
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
      await expect
        .poll(() => titleRow.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("52px");

      const [textBounds, nameBounds, pinBounds, menuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__text").boundingBox(),
        row.locator(".sidebar-recent-session__name").boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!textBounds || !nameBounds || !pinBounds || !menuBounds) {
        throw new Error("Expected visible combined session action geometry");
      }
      expect(textBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      expect(nameBounds.y + nameBounds.height / 2).toBeCloseTo(
        pinBounds.y + pinBounds.height / 2,
        1,
      );
      expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(pinBounds.x + 1);
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);
      await page.mouse.move(0, 0);
      await pin.focus();
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");
      await expect
        .poll(() => titleRow.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("52px");

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
      expect(focusedNameBounds.y + focusedNameBounds.height / 2).toBeCloseTo(
        focusedPinBounds.y + focusedPinBounds.height / 2,
        1,
      );
      expect(focusedNameBounds.x + focusedNameBounds.width).toBeLessThanOrEqual(
        focusedPinBounds.x + 1,
      );
      expect(focusedPinBounds.x + focusedPinBounds.width).toBeLessThanOrEqual(focusedMenuBounds.x);
    } finally {
      await context.close();
    }
  });
});
