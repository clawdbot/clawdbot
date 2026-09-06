import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const proofDirParent = process.env.OPENCLAW_MEDIA_PROOF_DIR?.trim() || null;
let proofDir: string | undefined;
beforeEach(() => {
  proofDir = proofDirParent
    ? createControlUiE2eArtifactDir("managed-media-base-path", proofDirParent)
    : undefined;
});

let server: ControlUiE2eServer;

describe("Control UI managed media under a UI base path", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("loads managed-media APIs beneath the configured UI base path", async () => {
    const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
    const browser = await chromium.launch({ executablePath });
    const context = await browser.newContext({
      ...(proofDir ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } } : {}),
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const sourcePath =
      "/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000001/full";
    const previewPath = `/rosita${sourcePath.replace(/\/full$/u, "/thumbnail")}`;
    const imageBytes = await readFile(
      path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
    );
    const requests: Array<{ contentType: string; path: string }> = [];

    await page.route("**/rosita/api/chat/media/outgoing/**", async (route) => {
      const requestPath = new URL(route.request().url()).pathname;
      if (requestPath === previewPath) {
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
            { type: "image", url: sourcePath, alt: "Managed proof image" },
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
      await page.goto(`${server.baseUrl}rosita/chat`);
      await gateway.waitForRequest("chat.startup");
      const image = page.getByAltText("Managed proof image");
      await image.waitFor({ state: "attached", timeout: 10_000 });
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      if (proofDir) {
        await writeFile(
          path.join(proofDir, "state.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [image]),
        );
      }

      const naturalWidth = await image.evaluate((node) =>
        node instanceof HTMLImageElement ? node.naturalWidth : 0,
      );
      expect(requests).toEqual([{ contentType: "image/png", path: previewPath }]);
      expect(naturalWidth).toBeGreaterThan(0);
      expect(await page.getByText("Managed attachment proof", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Distinct second reply", { exact: true }).count()).toBe(1);
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
