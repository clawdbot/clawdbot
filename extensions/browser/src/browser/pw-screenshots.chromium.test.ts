import path from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { captureScreenshot } from "./cdp.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";
import {
  screenshotWithLabelsViaPlaywright,
  takeScreenshotViaPlaywright,
} from "./pw-tools-core.interactions.content.js";
import {
  resizeViewportViaPlaywright,
  snapshotRoleViaPlaywright,
} from "./pw-tools-core.snapshot.js";
import { setDeviceViaPlaywright } from "./pw-tools-core.state.js";
import { getFreePort } from "./test-port.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}html,body{margin:0}section{height:600px;border:8px solid #23d7b3;background:#102a43;position:relative}
section+section{background:#334e68}button{position:absolute;left:25px;top:430px;width:120px;height:60px;border:0;background:#e04f5f}</style>
<section><button aria-label="Target"></button></section><section></section>`;
const readGeometry = () => ({
  width: innerWidth,
  height: innerHeight,
  dpr: devicePixelRatio,
  scrollX,
  scrollY,
  screen: [screen.width, screen.height, screen.orientation.type],
  touch: navigator.maxTouchPoints,
});

async function withBrowser(
  run: (target: { cdpUrl: string; targetId: string }, page: Page, wsUrl: string) => Promise<void>,
) {
  const port = await getFreePort();
  const cdpUrl = `http://127.0.0.1:${port}`;
  const context = await getPlaywrightCore().chromium.launchPersistentContext(
    path.join(tempDirs.make("openclaw-screenshot-geometry-"), "profile"),
    {
      headless: true,
      viewport: null,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: [`--remote-debugging-port=${port}`],
    },
  );
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setContent(html);
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    const tabs = (await fetch(`${cdpUrl}/json/list`).then((response) => response.json())) as Array<{
      id: string;
      webSocketDebuggerUrl: string;
    }>;
    const tab = tabs.find(({ id }) => id === targetInfo.targetId)!;
    await run({ cdpUrl, targetId: targetInfo.targetId }, page, tab.webSocketDebuggerUrl);
  } finally {
    await closePlaywrightBrowserConnection({ cdpUrl });
    await context.close();
  }
}

async function expectImage(
  page: Page,
  buffer: Buffer,
  size: [number, number],
  points: Array<{ x: number; y: number; rgb: number[] }>,
) {
  expect([buffer.readUInt32BE(16), buffer.readUInt32BE(20)]).toEqual(size);
  const pixels = await page.evaluate(
    async ({ base64, points: samplePoints }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return samplePoints.map(({ x, y }) =>
        Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3),
      );
    },
    { base64: buffer.toString("base64"), points },
  );
  expect(pixels).toEqual(points.map(({ rgb }) => rgb));
}

describe.runIf(process.env.OPENCLAW_BROWSER_SNAPSHOT_E2E === "1")(
  "Chromium screenshot ownership",
  () => {
    it("captures a native full page without changing the page geometry", async () => {
      await withBrowser(async (_target, page, wsUrl) => {
        await page.evaluate(() => scrollTo(0, 420));
        const before = await page.evaluate(readGeometry);
        const buffer = await captureScreenshot({ wsUrl, fullPage: true, headless: true });
        await expectImage(
          page,
          buffer,
          [before.width, 1200],
          [
            { x: 20, y: 20, rgb: [16, 42, 67] },
            { x: before.width - 20, y: 1180, rgb: [51, 78, 104] },
          ],
        );
        expect(await page.evaluate(readGeometry)).toEqual(before);
      });
    }, 30_000);

    it("preserves resized viewport content to the right and bottom edges", async () => {
      await withBrowser(async (target) => {
        await resizeViewportViaPlaywright({ ...target, width: 1280, height: 720 });
        const page = await getPageForTargetId(target);
        const before = await page.evaluate(readGeometry);
        const { buffer } = await takeScreenshotViaPlaywright(target);
        await expectImage(
          page,
          buffer,
          [1280, 720],
          [
            { x: 1250, y: 20, rgb: [16, 42, 67] },
            { x: 1250, y: 700, rgb: [51, 78, 104] },
          ],
        );
        expect(await page.evaluate(readGeometry)).toEqual(before);
      });
    }, 30_000);

    it("keeps device DPR, screen, scroll, and touch across viewport, element, labels, and full-page captures", async () => {
      await withBrowser(async (target) => {
        await setDeviceViaPlaywright({ ...target, name: "iPhone 13" });
        await resizeViewportViaPlaywright({ ...target, width: 640, height: 480 });
        await setDeviceViaPlaywright({ ...target, name: "iPhone 13" });
        await resizeViewportViaPlaywright({ ...target, width: 390, height: 664 });
        const page = await getPageForTargetId(target);
        await page.evaluate(() => scrollTo(0, 420));
        const before = await page.evaluate(readGeometry);
        expect(before).toMatchObject({ width: 390, height: 664, dpr: 3, touch: 1 });
        const { refs } = await snapshotRoleViaPlaywright(target);
        const ref = Object.keys(refs)[0]!;
        for (const mode of ["viewport", "element", "ref", "labels", "fullpage"] as const) {
          const result =
            mode === "labels"
              ? await screenshotWithLabelsViaPlaywright({ ...target, refs })
              : await takeScreenshotViaPlaywright({
                  ...target,
                  element: mode === "element" ? "button" : undefined,
                  ref: mode === "ref" ? ref : undefined,
                  fullPage: mode === "fullpage",
                });
          const element = mode === "element" || mode === "ref";
          await expectImage(
            page,
            result.buffer,
            element ? [360, 180] : [1170, mode === "fullpage" ? 3600 : 1992],
            [
              element
                ? { x: 180, y: 90, rgb: [224, 79, 95] }
                : { x: 100, y: mode === "fullpage" ? 3000 : 1700, rgb: [51, 78, 104] },
            ],
          );
          expect(await page.evaluate(readGeometry), mode).toEqual(before);
        }

        await resizeViewportViaPlaywright({ ...target, width: 640, height: 480 });
        await page.locator("button").evaluate((element) => {
          element.style.width = "900px";
          element.style.height = "700px";
        });
        const touch = await page.evaluate(() => navigator.maxTouchPoints);
        const cropped = await takeScreenshotViaPlaywright({ ...target, element: "button" });
        await expectImage(
          page,
          cropped.buffer,
          [900, 700],
          [{ x: 850, y: 350, rgb: [224, 79, 95] }],
        );
        expect(await page.evaluate(() => navigator.maxTouchPoints)).toBe(touch);
      });
    }, 30_000);
  },
);
