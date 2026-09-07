import { expectDefined } from "@openclaw/normalization-core";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { getPlaywrightCore } from "../playwright-core.runtime.js";
import { attachBrowserScreencastViewer, stopBrowserScreencasts } from "./session.js";
import { parseScreencastFrame, screencastParams, ScreencastViewer } from "./test-support.js";

const state = vi.hoisted(() => ({ page: undefined as Page | undefined }));
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => ({
    getPageForTargetId: async () => {
      if (!state.page) {
        throw new Error("Chromium page is not initialized");
      }
      return state.page;
    },
  }),
}));

describe.runIf(process.env.OPENCLAW_BROWSER_SCREENCAST_E2E === "1")(
  "browser screencast in Chromium",
  () => {
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
      browser = await getPlaywrightCore().chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      });
      page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(
        "<title>Screencast proof</title><style>body{height:2000px;background:#ffc}</style><h1>Live browser</h1>",
      );
      state.page = page;
    });

    afterAll(async () => {
      await stopBrowserScreencasts();
      state.page = undefined;
      await browser?.close();
    });

    it("streams JPEG with CSS viewport dimensions and closes when the page closes", async () => {
      const viewer = new ScreencastViewer();
      attachBrowserScreencastViewer(screencastParams(), viewer as unknown as WebSocket);
      await expect.poll(() => viewer.frames().length, { timeout: 5_000 }).toBeGreaterThan(0);
      const frame = parseScreencastFrame(
        expectDefined(viewer.frames()[0], "Chromium screencast frame"),
      );
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        scrollbarWidth: window.innerWidth - document.documentElement.clientWidth,
        scrollbarHeight: window.innerHeight - document.documentElement.clientHeight,
      }));
      expect(frame.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(frame.header.cssWidth).toBe(viewport.width);
      expect(frame.header.cssHeight).toBe(viewport.height);
      console.log(
        `Chromium screencast: JPEG FF D8; CSS ${frame.header.cssWidth}x${frame.header.cssHeight}; inner ${viewport.width}x${viewport.height}; scrollbar delta ${viewport.scrollbarWidth}x${viewport.scrollbarHeight}`,
      );
      await page.close();
      await expect.poll(() => viewer.close.mock.calls).toContainEqual([4004, "target_closed"]);
      console.log("Chromium screencast: page close -> 4004 target_closed");
    });
  },
);
