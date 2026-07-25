// Control UI tests cover startup under the Gateway's strict script policy.
import { chromium, firefox, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import {
  canRunPlaywrightChromium as canRunPlaywrightBrowser,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightBrowser(chromiumExecutablePath);
const firefoxExecutablePath = firefox.executablePath();
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const browsers: Array<{ name: string; launch: () => Promise<Browser> }> = [
  {
    name: "Chromium",
    launch: () => chromium.launch({ executablePath: chromiumExecutablePath }),
  },
];

if (canRunPlaywrightBrowser(firefoxExecutablePath)) {
  browsers.push({
    name: "Firefox",
    launch: () => firefox.launch({ executablePath: firefoxExecutablePath }),
  });
}

let server: ControlUiE2eServer;

describeControlUiE2e("Control UI strict CSP E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it.each(browsers)("starts without probing eval in $name", async ({ launch }) => {
    const browser = await launch();
    let context: BrowserContext | undefined;

    try {
      context = await browser.newContext({ serviceWorkers: "block" });
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

      const response = await page.goto(server.baseUrl);
      expect(response?.status()).toBe(200);
      const csp = response?.headers()["content-security-policy"];
      expect(csp).toBeDefined();
      expect(csp).not.toContain("'unsafe-eval'");
      await gateway.waitForRequest("connect");
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .waitFor({ state: "visible", timeout: 10_000 });

      const cspState = await page.evaluate(() => {
        const runtime = globalThis as typeof globalThis & {
          __openclawCspViolations?: Array<{
            blockedUri: string;
            effectiveDirective: string;
          }>;
          __zod_globalConfig?: { jitless?: boolean };
        };
        return {
          jitless: runtime["__zod_globalConfig"]?.jitless === true,
          evalViolations: (runtime["__openclawCspViolations"] ?? []).filter(
            (violation) =>
              violation.blockedUri === "eval" &&
              violation.effectiveDirective.startsWith("script-src"),
          ),
        };
      });
      expect(cspState.jitless).toBe(true);
      expect(cspState.evalViolations).toEqual([]);
    } finally {
      try {
        await context?.close();
      } finally {
        await browser.close();
      }
    }
  });
});
