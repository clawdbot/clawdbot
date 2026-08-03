import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const proofDir = process.env.OPENCLAW_MEDIA_PROOF_DIR?.trim() || null;

let server: ControlUiE2eServer;

describe("Control UI managed media under a UI base path", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
    }
  });

  afterAll(async () => {
    await server?.close();
  });

  it("keeps origin-root managed-media APIs outside the UI base path", async () => {
    const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
    const browser = await chromium.launch({ executablePath });
    const context = await browser.newContext({
      ...(proofDir ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } } : {}),
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const mediaPath =
      "/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000001/full";
    const imageBytes = await readFile(
      path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
    );
    const requests: Array<{ contentType: string; path: string }> = [];

    await page.route("**/api/chat/media/outgoing/**", async (route) => {
      const requestPath = new URL(route.request().url()).pathname;
      if (requestPath === mediaPath) {
        requests.push({ contentType: "image/png", path: requestPath });
        await route.fulfill({ body: imageBytes, contentType: "image/png", status: 200 });
        return;
      }
      requests.push({ contentType: "text/html", path: requestPath });
      await route.fulfill({
        body: "<!doctype html><title>OpenClaw</title>",
        contentType: "text/html",
        status: 200,
      });
    });

    const gateway = await installMockGateway(page, {
      basePath: "/rosita",
      historyMessages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Managed attachment proof" },
            { type: "image", url: mediaPath, alt: "Managed proof image" },
          ],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Distinct second reply" }],
          timestamp: 2,
        },
      ],
    });

    try {
      // The Vite harness mounts at `/`; bootstrap models the reverse proxy
      // prefix that Gateway strips before serving the Control UI.
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const image = page.getByAltText("Managed proof image");
      await image.waitFor({ state: "attached", timeout: 10_000 });
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "state.png"), fullPage: true });
      }

      const naturalWidth = await image.evaluate((node) =>
        node instanceof HTMLImageElement ? node.naturalWidth : 0,
      );
      expect(requests).toEqual([{ contentType: "image/png", path: mediaPath }]);
      expect(naturalWidth).toBeGreaterThan(0);
      expect(await page.getByText("Managed attachment proof", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Distinct second reply", { exact: true }).count()).toBe(1);
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
