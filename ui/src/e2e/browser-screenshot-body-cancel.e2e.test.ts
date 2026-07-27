import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.resolve(
  process.cwd(),
  ".artifacts/control-ui-e2e/browser-screenshot-body-cancel",
);

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI browser screenshot failed-body E2E", () => {
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

  it("keeps the status error visible and cancels the unread media body", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.removeItem("openclaw.browser.panel.v1");
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await originalFetch(input, init);
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes("/__openclaw__/assistant-media")) {
          return response;
        }
        const source = response.body;
        if (!source) {
          return response;
        }
        type ScreenshotProof = {
          cancelCount: number;
          cancelResolvedCount: number;
          fetchCount: number;
          statuses: number[];
        };
        const proofWindow = window as Window & { openclawScreenshotProof?: ScreenshotProof };
        const proof = (proofWindow.openclawScreenshotProof ??= {
          cancelCount: 0,
          cancelResolvedCount: 0,
          fetchCount: 0,
          statuses: [],
        });
        proof.fetchCount += 1;
        proof.statuses.push(response.status);
        const originalCancel = source.cancel.bind(source);
        source.cancel = async (reason) => {
          proof.cancelCount += 1;
          await originalCancel(reason);
          proof.cancelResolvedCount += 1;
        };
        return response;
      };
    });
    let mediaRequest: { authorization: string; source: string | null } | null = null;
    await page.route("**/__openclaw__/assistant-media**", (route) => {
      const request = route.request();
      mediaRequest = {
        authorization: request.headers().authorization ?? "",
        source: new URL(request.url()).searchParams.get("source"),
      };
      return route.fulfill({
        body: "screenshot unavailable",
        contentType: "text/plain; charset=utf-8",
        status: 404,
      });
    });
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "browser.request"],
      methodResponses: {
        "browser.request": {
          cases: [
            {
              match: { method: "GET", path: "/tabs" },
              response: {
                running: true,
                tabs: [
                  {
                    targetId: "target-1",
                    tabId: "t1",
                    title: "Example",
                    url: "https://example.test/",
                  },
                ],
              },
            },
            {
              match: { method: "POST", path: "/screenshot" },
              response: {
                path: "/proof/missing.png",
                targetId: "target-1",
                url: "https://example.test/",
              },
            },
          ],
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}chat`);
      expect(response?.status()).toBe(200);
      const showFiles = page.getByRole("button", { name: "Show thread files", exact: true });
      await showFiles.waitFor();
      await showFiles.click();
      const toggle = page.getByRole("button", { name: "Toggle browser panel", exact: true });
      await toggle.waitFor();
      await toggle.click();

      const panel = page.locator("section.bp");
      await panel.waitFor();
      const alert = panel.getByRole("alert");
      await alert.waitFor();
      expect(await alert.textContent()).toContain("screenshot fetch failed (404)");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  openclawScreenshotProof?: {
                    cancelCount?: number;
                    cancelResolvedCount?: number;
                    fetchCount?: number;
                    statuses?: number[];
                  };
                }
              ).openclawScreenshotProof,
          ),
        )
        .toEqual({
          cancelCount: 1,
          cancelResolvedCount: 1,
          fetchCount: 1,
          statuses: [404],
        });

      const requests = await gateway.getRequests("browser.request");
      expect(requests.map((request) => request.params)).toEqual([
        { method: "GET", path: "/tabs" },
        {
          body: { targetId: "t1", type: "png" },
          method: "POST",
          path: "/screenshot",
        },
      ]);
      expect(mediaRequest).toEqual({
        authorization: "Bearer e2e-device-token",
        source: "/proof/missing.png",
      });

      if (captureUiProofEnabled) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          path: path.join(proofDir, "failed-screenshot.png"),
        });
        const stream = await page.evaluate(
          () => (window as Window & { openclawScreenshotProof?: unknown }).openclawScreenshotProof,
        );
        await writeFile(
          path.join(proofDir, "proof.json"),
          `${JSON.stringify(
            {
              error: (await alert.textContent())?.trim() ?? "",
              mediaRequest,
              requests,
              stream,
            },
            null,
            2,
          )}\n`,
        );
        console.log(
          `CONTROL_UI_BROWSER_SCREENSHOT_PROOF=${JSON.stringify({
            error: (await alert.textContent())?.trim() ?? "",
            mediaRequest,
            requests: requests.map((request) => request.params),
            stream,
          })}`,
        );
      }
    } finally {
      await context.close();
    }
  });
});
