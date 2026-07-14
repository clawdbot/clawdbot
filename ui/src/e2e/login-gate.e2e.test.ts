// Control UI tests cover the responsive disconnected login gate.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

async function renderLoginGate(page: Page): Promise<void> {
  const response = await page.goto(server.baseUrl);
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

describeControlUiE2e("Control UI responsive login gate E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows a protocol mismatch without reconnecting", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    await page.clock.install();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    try {
      await page.goto(server.baseUrl);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", {
        code: "INVALID_REQUEST",
        message: "protocol mismatch",
        details: { code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH },
      });

      const failure = page.locator(".login-gate__failure-summary");
      await failure.waitFor({ timeout: 10_000 });
      expect((await failure.textContent())?.toLowerCase()).toContain(
        "supported connection protocol",
      );
      await page.clock.runFor(1_600);
      expect(await gateway.getRequests("connect")).toHaveLength(1);
    } finally {
      await closeContext(context);
    }
  });

  it("keeps mobile controls compact, touchable, and keyboard-friendly", async () => {
    const context = await browser.newContext({
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
          document.querySelectorAll<HTMLElement>(".login-gate__secret-row .btn--icon"),
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
            return { height: style.height, minWidth: style.minWidth, width: style.width };
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
      expect(
        metrics.toggleSizes.every(
          ({ height, minWidth, width }) =>
            height === "44px" && minWidth === "44px" && width === "44px",
        ),
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
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
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
    const context = await browser.newContext({
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
