// Control UI tests cover the responsive disconnected login gate.
import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI responsive login gate E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

async function renderLoginGate(page: Page): Promise<void> {
  const response = await page.goto(suite.server.baseUrl);
  expect(response?.status()).toBe(200);

  await mountLoginGate(page);
}

async function mountLoginGate(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await customElements.whenDefined("openclaw-login-gate");
    const gate = document.createElement("openclaw-login-gate") as HTMLElement & {
      props: Record<string, unknown>;
      updateComplete: Promise<unknown>;
    };
    document.body.dataset.connectCount = "0";
    gate.props = {
      basePath: "",
      connected: false,
      lastError: "unauthorized: gateway token required",
      lastErrorCode: null,
      hasToken: false,
      hasPassword: false,
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      password: "",
      showGatewayToken: false,
      showGatewayPassword: false,
      onGatewayUrlChange: () => {},
      onTokenChange: () => {},
      onPasswordChange: () => {},
      onToggleGatewayToken: () => {},
      onToggleGatewayPassword: () => {},
      onConnect: () => {
        const current = Number.parseInt(document.body.dataset.connectCount ?? "0", 10);
        document.body.dataset.connectCount = String(current + 1);
      },
    };
    document.body.replaceChildren(gate);
    await gate.updateComplete;
  });
}

async function closeContext(context: BrowserContext): Promise<void> {
  await context.close().catch(() => {});
}

suite.define(() => {
  it("cache-busts stale-build recovery on a first dashboard navigation", async () => {
    const context = await suite.browser.newContext({
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const documentRequests: Array<{ fresh: boolean; pathname: string }> = [];
    const appOrigin = new URL(suite.server.baseUrl).origin;
    await page.route(`${appOrigin}/**`, async (route) => {
      const request = route.request();
      if (request.resourceType() === "document") {
        const url = new URL(request.url());
        documentRequests.push({
          fresh: url.searchParams.has("openclaw_mount_recovery"),
          pathname: url.pathname,
        });
      }
      await route.continue();
    });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["connect"],
      sessionKey: "agent:example-agent:example-session",
    });
    const mismatch = {
      code: "UNAVAILABLE",
      message: "Control UI updated; reload this page to continue",
      details: {
        code: ConnectErrorDetailCodes.CONTROL_UI_BUILD_MISMATCH,
        gatewayBuildId: "replacement-build",
        reloadRequired: true,
      },
      retryable: false,
    };
    const target = new URL("dashboard/example-agent/example-session", suite.server.baseUrl);

    try {
      await page.goto(target.href);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", mismatch);

      await expect.poll(() => documentRequests.length).toBe(2);
      await gateway.waitForRequest("connect");
      expect(documentRequests).toEqual([
        { fresh: false, pathname: target.pathname },
        { fresh: true, pathname: target.pathname },
      ]);
      await gateway.resolveDeferred("connect");

      await page.locator("openclaw-app-shell").waitFor();
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      await expect.poll(() => page.url()).toBe(target.href);
    } finally {
      await closeContext(context);
    }
  });

  it("reloads once for a build rejection, then keeps visible recovery guidance", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const key = "openclaw.control-ui-e2e.build-rejection-loads";
      const count = Number.parseInt(sessionStorage.getItem(key) ?? "0", 10);
      sessionStorage.setItem(key, String(count + 1));
    });
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });
    const mismatch = {
      code: "UNAVAILABLE",
      message: "Control UI updated; reload this page to continue",
      details: {
        code: ConnectErrorDetailCodes.CONTROL_UI_BUILD_MISMATCH,
        gatewayBuildId: "replacement-build",
        reloadRequired: true,
      },
      retryable: false,
    };

    try {
      await page.goto(suite.server.baseUrl);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", mismatch);
      await page.waitForFunction(
        () =>
          sessionStorage.getItem("openclaw.controlUi.staleChunkReloadBuildId") ===
            "replacement-build" &&
          sessionStorage.getItem("openclaw.control-ui-e2e.build-rejection-loads") === "2",
      );

      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", mismatch);
      const failure = page.locator('.login-gate__failure[data-kind="build-mismatch"]');
      await failure.waitFor({ timeout: 10_000 });
      expect(await failure.locator(".login-gate__failure-title").textContent()).toBe(
        "Server updated",
      );
      expect(await failure.locator(".login-gate__failure-refresh").isVisible()).toBe(true);
      expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
      expect(
        await page.evaluate(() =>
          sessionStorage.getItem("openclaw.control-ui-e2e.build-rejection-loads"),
        ),
      ).toBe("2");
    } finally {
      await closeContext(context);
    }
  });

  it("shows a protocol mismatch without reconnecting", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    await page.clock.install();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    try {
      await page.goto(suite.server.baseUrl);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", {
        code: "INVALID_REQUEST",
        message: "protocol mismatch: Control UI updated; reload this page to continue",
        details: { code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH },
      });

      const failure = page.locator(".login-gate__failure-summary");
      await failure.waitFor({ timeout: 10_000 });
      expect((await failure.textContent())?.toLowerCase()).toContain(
        "supported connection protocol",
      );
      expect(await page.locator(".login-gate__failure-refresh").isVisible()).toBe(true);
      await page.clock.runFor(1_600);
      expect(await gateway.getRequests("connect")).toHaveLength(1);
    } finally {
      await closeContext(context);
    }
  });

  it.each([
    {
      name: "missing token",
      error: {
        code: "INVALID_REQUEST",
        message: "token missing",
        details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
      },
      expectedKind: "auth-required",
      expectedTitle: "Auth required",
    },
    {
      name: "pairing approval",
      error: {
        code: "NOT_PAIRED",
        message: "device is not approved",
        details: { code: ConnectErrorDetailCodes.PAIRING_REQUIRED },
      },
      expectedKind: "pairing-required",
      expectedTitle: "Device pairing required",
    },
    {
      name: "generic transport",
      error: {
        code: "UNAVAILABLE",
        message: "WebSocket connection failed",
      },
      expectedKind: "network",
      expectedTitle: "Could not connect",
    },
  ])("renders $name guidance from the application gateway snapshot", async (fixture) => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    try {
      await page.goto(suite.server.baseUrl);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", fixture.error);

      const failure = page.locator(`.login-gate__failure[data-kind="${fixture.expectedKind}"]`);
      await failure.waitFor({ timeout: 10_000 });
      expect(await failure.locator(".login-gate__failure-title").textContent()).toBe(
        fixture.expectedTitle,
      );
    } finally {
      await closeContext(context);
    }
  });

  it("keeps mobile controls compact, touchable, and keyboard-friendly", async () => {
    const context = await suite.browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { height: 500, width: 375 },
    });
    const page = await context.newPage();

    try {
      await renderLoginGate(page);
      const gatewayInput = page.locator(".login-gate__form .field input").first();
      expect(await gatewayInput.getAttribute("inputmode")).toBe("url");
      expect(await gatewayInput.getAttribute("autocapitalize")).toBe("none");
      expect(await gatewayInput.getAttribute("autocorrect")).toBe("off");
      expect(await gatewayInput.getAttribute("spellcheck")).toBe("false");
      expect(await gatewayInput.getAttribute("enterkeyhint")).toBe("go");

      await gatewayInput.press("Enter");
      expect(await page.locator("body").getAttribute("data-connect-count")).toBe("1");

      const metrics = await page.evaluate(() => {
        const gate = document.querySelector<HTMLElement>(".login-gate");
        const card = document.querySelector<HTMLElement>(".login-gate__card");
        const inputs = Array.from(
          document.querySelectorAll<HTMLElement>(".login-gate__form .field input"),
        );
        const toggles = Array.from(
          document.querySelectorAll<HTMLElement>(".login-gate__form .settings-secret__toggle"),
        );
        const connect = document.querySelector<HTMLElement>(".login-gate__connect");
        if (!gate || !card || !connect) {
          throw new Error("Missing login gate elements");
        }
        const gateStyle = getComputedStyle(gate);
        const cardStyle = getComputedStyle(card);
        return {
          cardPadding: cardStyle.padding,
          cardTop: card.getBoundingClientRect().top,
          connectMinHeight: getComputedStyle(connect).minHeight,
          gateClientHeight: gate.clientHeight,
          gateOverflowY: gateStyle.overflowY,
          gatePadding: gateStyle.padding,
          gateScrollHeight: gate.scrollHeight,
          inputMinHeights: inputs.map((input) => getComputedStyle(input).minHeight),
          toggleSizes: toggles.map((toggle) => {
            const style = getComputedStyle(toggle);
            return { height: style.height, width: style.width };
          }),
        };
      });

      expect(metrics.gatePadding).toBe("16px 12px");
      expect(metrics.cardPadding).toBe("24px 20px");
      expect(metrics.cardTop).toBeGreaterThanOrEqual(0);
      expect(metrics.connectMinHeight).toBe("44px");
      expect(metrics.gateOverflowY).toBe("auto");
      expect(metrics.gateScrollHeight).toBeGreaterThan(metrics.gateClientHeight);
      expect(metrics.inputMinHeights.every((height) => height === "44px")).toBe(true);
      expect(metrics.toggleSizes).toHaveLength(2);
      expect(
        metrics.toggleSizes.every(({ height, width }) => height === "32px" && width === "32px"),
      ).toBe(true);

      const failureDocs = page.locator(".login-gate__failure-docs");
      await failureDocs.scrollIntoViewIfNeeded();
      const failureDocsBox = await failureDocs.boundingBox();
      if (!failureDocsBox) {
        throw new Error("Missing failure documentation link bounds");
      }
      expect(failureDocsBox.y + failureDocsBox.height).toBeLessThanOrEqual(500);
    } finally {
      await closeContext(context);
    }
  });

  it("keeps failure recovery visible while generic help stays collapsed", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();

    try {
      await renderLoginGate(page);
      const failure = page.locator(".login-gate__failure");
      expect(await failure.evaluate((element) => element.tagName)).toBe("DIV");
      expect(await page.locator(".login-gate__failure-summary").isVisible()).toBe(true);
      expect(await page.locator(".login-gate__failure-steps").isVisible()).toBe(true);
      expect(await page.locator(".login-gate__failure-docs").isVisible()).toBe(true);

      const help = page.locator(".login-gate__help");
      expect(await help.evaluate((element) => element.tagName)).toBe("DETAILS");
      expect(await help.getAttribute("open")).toBeNull();
      expect(await page.locator(".login-gate__steps").isVisible()).toBe(false);
    } finally {
      await closeContext(context);
    }
  });

  it("applies standalone safe-area insets exactly once", async () => {
    const context = await suite.browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { height: 500, width: 375 },
    });
    const page = await context.newPage();

    try {
      await renderLoginGate(page);
      const metrics = await page.evaluate(() => {
        const root = document.documentElement;
        root.style.setProperty("--safe-area-top", "34px");
        root.style.setProperty("--safe-area-right", "20px");
        root.style.setProperty("--safe-area-bottom", "21px");
        root.style.setProperty("--safe-area-left", "18px");

        const mediaRules = Array.from(document.styleSheets).flatMap((sheet) =>
          Array.from(sheet.cssRules).filter(
            (rule): rule is CSSMediaRule =>
              rule instanceof CSSMediaRule &&
              rule.conditionText.includes("display-mode: standalone"),
          ),
        );
        const standaloneBodyRule = mediaRules.find((mediaRule) =>
          Array.from(mediaRule.cssRules).some(
            (rule) => rule instanceof CSSStyleRule && rule.selectorText === "body",
          ),
        );
        const standaloneGateRule = mediaRules.find((mediaRule) =>
          Array.from(mediaRule.cssRules).some(
            (rule) => rule instanceof CSSStyleRule && rule.selectorText === ".login-gate",
          ),
        );
        if (!standaloneBodyRule || !standaloneGateRule) {
          throw new Error("Missing standalone safe-area ownership rules");
        }

        // Headless Chromium cannot toggle installed-app display mode reliably.
        // Apply the exact production inner rules to verify their computed layout.
        const activeStandaloneRules = document.createElement("style");
        activeStandaloneRules.textContent = [standaloneBodyRule, standaloneGateRule]
          .flatMap((mediaRule) => Array.from(mediaRule.cssRules, (rule) => rule.cssText))
          .join("\n");
        document.head.append(activeStandaloneRules);

        const gate = document.querySelector<HTMLElement>(".login-gate");
        if (!gate) {
          throw new Error("Missing login gate element");
        }
        const bodyStyle = getComputedStyle(document.body);
        const gateStyle = getComputedStyle(gate);
        const gateBounds = gate.getBoundingClientRect();
        return {
          bodyPadding: {
            bottom: bodyStyle.paddingBottom,
            left: bodyStyle.paddingLeft,
            right: bodyStyle.paddingRight,
            top: bodyStyle.paddingTop,
          },
          gateBottom: gateBounds.bottom,
          gatePadding: gateStyle.padding,
          gateRuleCondition: standaloneGateRule.conditionText,
          gateTop: gateBounds.top,
        };
      });

      expect(metrics.bodyPadding).toEqual({
        bottom: "21px",
        left: "18px",
        right: "20px",
        top: "34px",
      });
      expect(metrics.gatePadding).toBe("16px 12px");
      expect(metrics.gateRuleCondition).toContain("display-mode: standalone");
      expect(metrics.gateTop).toBe(34);
      expect(metrics.gateBottom).toBe(479);
    } finally {
      await closeContext(context);
    }
  });
});
