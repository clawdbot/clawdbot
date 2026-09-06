// Control UI tests cover the responsive disconnected login gate.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { closeContext, renderLoginGate } from "./login-gate-e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI responsive login gate E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});
let RECOVERY_ARTIFACT_DIR: string;

beforeEach(() => {
  RECOVERY_ARTIFACT_DIR = createControlUiE2eArtifactDir("zombie-reload");
});

suite.define(() => {
  it("shows a bare protocol mismatch as compatibility guidance without reconnecting", async () => {
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

      const failure = page.locator('.login-gate__failure[data-kind="protocol-mismatch"]');
      await failure.waitFor({ timeout: 10_000 });
      expect((await failure.textContent())?.toLowerCase()).toContain(
        "supported connection protocol",
      );
      expect(await failure.locator(".login-gate__failure-refresh").isVisible()).toBe(true);
      await page.clock.runFor(1_600);
      expect(await gateway.getRequests("connect")).toHaveLength(1);
    } finally {
      await closeContext(context);
    }
  });

  it("lets reload-required recovery outrank a manually pinned login gate", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      sessionStorage.setItem("openclaw.controlUi.staleChunkReloadBuildId", "replacement-build");
    });
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    try {
      await page.goto(suite.server.baseUrl);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", {
        code: "INVALID_REQUEST",
        message: "token missing",
        details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
      });
      await page.locator('.login-gate__failure[data-kind="auth-required"]').waitFor();

      await gateway.deferNext("connect");
      await page.getByRole("button", { name: "Connect" }).click();
      await expect.poll(async () => (await gateway.getRequests("connect")).length).toBe(2);
      await gateway.rejectDeferred("connect", {
        code: "UNAVAILABLE",
        message: "protocol mismatch: Control UI updated; reload this page to continue",
        details: {
          code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
          gatewayBuildId: "replacement-build",
          reloadRequired: true,
        },
        retryable: false,
      });

      await expect
        .poll(() =>
          page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: { context: { gateway: { snapshot: { phase: string } } } };
            };
            return app.runtime?.context.gateway.snapshot.phase;
          }),
        )
        .toBe("reload-required");
      await page.getByRole("button", { name: /Server updated/u }).waitFor();
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    } finally {
      await closeContext(context);
    }
  });

  it("blocks non-chat page actions visibly while reconnecting", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(new URL("settings/connection", suite.server.baseUrl).href);
      await page.locator("openclaw-app-shell").waitFor();
      await page.locator("openclaw-connection-page .content-header").waitFor();
      await gateway.deferNext("connect");
      await gateway.closeLatest(1012, "test reconnect");

      const notice = page.locator('.connection-action-block[role="status"]');
      await notice.waitFor();
      expect((await notice.textContent())?.trim()).toBe(
        "Changes to settings are disabled while the Gateway is reconnecting.",
      );
      expect(await notice.locator("svg").count()).toBe(1);
      const outlet = page.locator("openclaw-router-outlet");
      expect(await outlet.getAttribute("inert")).not.toBeNull();
      expect(await outlet.getAttribute("aria-disabled")).toBe("true");
      const bounds = await page.evaluate(() => {
        const noticeRect = document
          .querySelector(".connection-action-block")
          ?.getBoundingClientRect();
        const navRect = document.querySelector(".shell-nav")?.getBoundingClientRect();
        const mainRect = document.querySelector("#control-ui-main")?.getBoundingClientRect();
        const headerRect = document
          .querySelector("openclaw-connection-page .content-header")
          ?.getBoundingClientRect();
        return {
          headerTop: headerRect?.top,
          noticeBottom: noticeRect?.bottom,
          noticeTop: noticeRect?.top,
          noticeLeft: noticeRect?.left,
          noticeRight: noticeRect?.right,
          mainTop: mainRect?.top,
          navRight: navRect?.right,
          mainRight: mainRect?.right,
        };
      });
      expect(bounds.noticeTop).toBe(bounds.mainTop);
      expect((bounds.headerTop ?? 0) - (bounds.noticeBottom ?? 0)).toBeCloseTo(44, 3);
      expect(bounds.noticeLeft).toBe(bounds.navRight);
      expect(bounds.noticeRight).toBe(bounds.mainRight);
      await page.screenshot({
        path: path.join(RECOVERY_ARTIFACT_DIR, "02-reconnecting-actions-blocked.png"),
        fullPage: true,
      });
    } finally {
      await closeContext(context);
    }
  });

  it("keeps the session header available while disabling Gateway actions on reconnect", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    const sessionKey = "agent:main:main";
    const gateway = await installMockGateway(page, { sessionKey });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const header = page.locator(".chat-pane__header");
      await header.waitFor({ state: "visible" });
      await header.locator(".chat-side-panel-toggle").click();
      await header.getByRole("button", { name: "Focus", exact: true }).click();
      await gateway.setOnline(false);

      await expect
        .poll(() =>
          page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: { context: { gateway: { snapshot: { phase: string } } } };
            };
            return app.runtime?.context.gateway.snapshot.phase;
          }),
        )
        .toBe("reconnecting");
      await page.screenshot({
        path: path.join(RECOVERY_ARTIFACT_DIR, "03-session-reconnecting-after.png"),
        fullPage: true,
      });

      expect(await page.locator(".connection-action-block").count()).toBe(0);
      expect(await page.locator("#control-ui-main").getAttribute("inert")).toBeNull();
      const outlet = page.locator("openclaw-router-outlet");
      expect(await outlet.getAttribute("inert")).toBeNull();
      expect(await outlet.getAttribute("aria-disabled")).toBeNull();
      expect(await header.isVisible()).toBe(true);

      const headerActions = header.locator("fieldset.chat-pane__actions");
      expect(
        await headerActions.evaluate((element) => (element as HTMLFieldSetElement).disabled),
      ).toBe(true);
      const actionButtons = headerActions.getByRole("button");
      expect(await actionButtons.count()).toBeGreaterThan(0);
      for (const button of await actionButtons.all()) {
        expect(await button.isDisabled()).toBe(true);
      }
      const restore = header.getByRole("button", { name: "Restore split", exact: true });
      expect(await restore.isEnabled()).toBe(true);
      await restore.click();
      await page.locator(".side-panel-empty--selector").waitFor();
      expect(await header.locator(".chat-side-panel-toggle").isEnabled()).toBe(true);
    } finally {
      await closeContext(context);
    }
  });

  it.each([
    { name: "tablet", width: 1024 },
    { name: "phone", width: 390 },
  ])("spans the $name settings viewport while reconnecting", async ({ width }) => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(new URL("settings/connection", suite.server.baseUrl).href);
      await page.locator("openclaw-app-shell").waitFor();
      await gateway.deferNext("connect");
      await gateway.closeLatest(1012, "test reconnect");

      const notice = page.locator('.connection-action-block[role="status"]');
      await notice.waitFor();
      const bounds = await notice.boundingBox();
      expect(bounds?.x).toBe(0);
      expect(bounds?.width).toBe(width);
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
      name: "missing identity header",
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: ConnectErrorDetailCodes.AUTH_IDENTITY_HEADER_REQUIRED },
      },
      expectedKind: "trusted-proxy",
      expectedTitle: "Proxy authentication required",
    },
    {
      name: "proxy account rejection",
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: {
          code: ConnectErrorDetailCodes.AUTH_UNAUTHORIZED,
          authReason: "trusted_proxy_user_not_allowed",
        },
      },
      expectedKind: "trusted-proxy",
      expectedTitle: "Proxy authentication required",
    },
    {
      name: "disallowed browser origin",
      error: {
        code: "INVALID_REQUEST",
        message: "origin not allowed",
        details: { code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED },
      },
      expectedKind: "origin-not-allowed",
      expectedTitle: "Browser origin not allowed",
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
    {
      name: "profile verification",
      error: {
        code: "UNAVAILABLE",
        message: "Authenticated profile verification is unavailable; retry the request.",
        details: { code: ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE },
        retryable: true,
      },
      expectedKind: "profile-unavailable",
      expectedTitle: "Profile verification unavailable",
    },
    {
      name: "GitHub profile rate limit",
      error: {
        code: "UNAVAILABLE",
        message:
          "GitHub is rate limiting profile verification. Retry shortly; if this continues, ask a gateway administrator to check the GitHub API credential.",
        details: { code: ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE },
        retryable: true,
      },
      expectedKind: "profile-unavailable",
      expectedTitle: "Profile verification unavailable",
    },
  ])("renders $name guidance from the application gateway snapshot", async (fixture) => {
    const viewport = { height: 900, width: 1280 };
    const context = await suite.browser.newContext({
      viewport,
      recordVideo: { dir: RECOVERY_ARTIFACT_DIR, size: viewport },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { connect: { __mockError: fixture.error } },
    });

    try {
      await page.goto(suite.server.baseUrl);
      await gateway.waitForRequest("connect");

      await page.locator(".login-gate__failure").waitFor();
      // Retryable guidance must survive a real reconnect, including time spent capturing proof.
      if (fixture.error.code === "UNAVAILABLE") {
        await gateway.waitForRequest("connect", { after: 1 });
      }
      await writeFile(
        path.join(RECOVERY_ARTIFACT_DIR, "login-failure.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".login-gate__card"), [
          page.locator(".login-gate__failure"),
        ]),
      );
      const failure = page.locator(`.login-gate__failure[data-kind="${fixture.expectedKind}"]`);
      await failure.waitFor({ timeout: 10_000 });
      expect(await failure.locator(".login-gate__failure-title").textContent()).toBe(
        fixture.expectedTitle,
      );
    } catch (error) {
      await captureControlUiE2eFailureDiagnostics(page, {
        error: error instanceof Error ? error : new Error(String(error)),
        label: `login-guidance-${fixture.name}`,
      });
      throw error;
    } finally {
      await closeContext(context);
    }
  });

  it("copies an exact recovery command from the application gateway snapshot", async () => {
    const context = await suite.browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    try {
      await page.goto(suite.server.baseUrl);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", {
        code: "INVALID_REQUEST",
        message: "token missing",
        details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
      });

      const failure = page.locator('.login-gate__failure[data-kind="auth-required"]');
      await failure.waitFor({ timeout: 10_000 });
      const command = failure
        .locator(".login-gate__command")
        .filter({ hasText: "openclaw gateway auth-token --show" });
      await command.click();

      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe("openclaw gateway auth-token --show");
      expect(await command.locator(".chat-copy-btn").getAttribute("aria-label")).toBe("Copied!");
    } finally {
      await closeContext(context);
    }
  });

  it("retires the static startup fallback after rendering auth-required guidance", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.addEventListener("openclaw-control-ui-rendered", () => {
        const key = "openclaw.control-ui-e2e.render-count";
        const count = Number.parseInt(sessionStorage.getItem(key) ?? "0", 10);
        sessionStorage.setItem(key, String(count + 1));
      });
    });
    await page.clock.install();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    try {
      await page.goto(suite.server.baseUrl);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", {
        code: "INVALID_REQUEST",
        message: "token missing",
        details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
      });

      const authRequired = page.locator('.login-gate__failure[data-kind="auth-required"]');
      await authRequired.waitFor({ timeout: 10_000 });
      await page.clock.runFor(12_001);

      expect(await authRequired.isVisible()).toBe(true);
      expect(await page.locator("#openclaw-mount-fallback").isHidden()).toBe(true);
      expect((await page.locator("body").getAttribute("class")) ?? "").not.toContain(
        "openclaw-mount-fallback-active",
      );
      expect(
        await page.evaluate(() => sessionStorage.getItem("openclaw.control-ui-e2e.render-count")),
      ).toBe("1");
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
      await renderLoginGate(page, suite.server.baseUrl);
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
        const commands = Array.from(
          document.querySelectorAll<HTMLElement>(".login-gate__failure-steps .login-gate__command"),
        );
        if (!gate || !card || !connect) {
          throw new Error("Missing login gate elements");
        }
        const gateStyle = getComputedStyle(gate);
        const cardStyle = getComputedStyle(card);
        return {
          cardPadding: cardStyle.padding,
          cardTop: card.getBoundingClientRect().top,
          commandBounds: commands.map((command) => {
            const bounds = command.getBoundingClientRect();
            return {
              left: bounds.left,
              right: bounds.right,
            };
          }),
          connectMinHeight: getComputedStyle(connect).minHeight,
          documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
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
      expect(metrics.documentScrollWidth).toBe(metrics.documentClientWidth);
      expect(metrics.commandBounds.length).toBeGreaterThan(0);
      expect(metrics.commandBounds.every(({ left, right }) => left >= 0 && right <= 375)).toBe(
        true,
      );
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
      await renderLoginGate(page, suite.server.baseUrl);
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
      await renderLoginGate(page, suite.server.baseUrl);
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
