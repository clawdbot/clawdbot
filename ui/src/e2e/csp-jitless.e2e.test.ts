// Control UI tests cover startup under the Gateway's strict script policy.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
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

describeControlUiE2e("Control UI strict CSP E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("starts without probing eval under the Gateway script policy", async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.addInitScript(() => {
      const violations: Array<{ blockedUri: string; effectiveDirective: string }> = [];
      Object.assign(globalThis, { __openclawCspViolations: violations });
      document.addEventListener("securitypolicyviolation", (event) => {
        violations.push({
          blockedUri: event.blockedURI,
          effectiveDirective: event.effectiveDirective,
        });
      });
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);
    await page.route(server.baseUrl, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const csp = buildControlUiCspHeader({
        inlineScriptHashes: computeInlineScriptHashes(body),
      });
      await route.fulfill({
        body,
        headers: { ...response.headers(), "content-security-policy": csp },
        response,
      });
    });

    try {
      const response = await page.goto(server.baseUrl);
      expect(response?.status()).toBe(200);
      const csp = response?.headers()["content-security-policy"];
      expect(csp).toBeDefined();
      expect(csp).not.toContain("'unsafe-eval'");
      await gateway.waitForRequest("connect");
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .waitFor({ state: "visible", timeout: 10_000 });

      const evalViolations = await page.evaluate(() => {
        const violations = (
          globalThis as typeof globalThis & {
            __openclawCspViolations?: Array<{
              blockedUri: string;
              effectiveDirective: string;
            }>;
          }
        )["__openclawCspViolations"];
        return (violations ?? []).filter(
          (violation) =>
            violation.blockedUri === "eval" &&
            violation.effectiveDirective.startsWith("script-src"),
        );
      });
      expect(evalViolations).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
