import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { getImageMetadata } from "../media/media-services.js";
import { captureScreenshot } from "./cdp.js";
import { resolveBrowserConfig } from "./config.js";
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
import { registerBrowserAgentSnapshotRoutes } from "./routes/agent.snapshot.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import type { AnnotationItem } from "./screenshot-annotate.js";
import { createBrowserRouteContext, type BrowserServerState } from "./server-context.js";
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
  visual: {
    x: visualViewport!.pageLeft,
    y: visualViewport!.pageTop,
    width: visualViewport!.width,
    height: visualViewport!.height,
  },
});

async function withBrowser(
  run: (target: { cdpUrl: string; targetId: string }, page: Page, wsUrl: string) => Promise<void>,
  deviceScaleFactor?: number,
  showScrollbars = false,
) {
  const port = await getFreePort();
  const cdpUrl = `http://127.0.0.1:${port}`;
  const context = await getPlaywrightCore().chromium.launchPersistentContext(
    path.join(tempDirs.make("openclaw-screenshot-geometry-"), "profile"),
    {
      headless: true,
      ...(showScrollbars ? { ignoreDefaultArgs: ["--hide-scrollbars"] } : {}),
      ...(deviceScaleFactor
        ? { viewport: { width: 640, height: 480 }, deviceScaleFactor }
        : { viewport: null }),
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

async function readLabelBox(page: Page, buffer: Buffer) {
  return await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    let redX = 0,
      redY = 0,
      redCount = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4;
        if (data[i]! > 170 && data[i + 1]! < 120 && data[i + 2]! < 150) {
          redX += x;
          redY += y;
          redCount++;
        }
      }
    }
    const centerX = Math.round(redX / redCount),
      centerY = Math.round(redY / redCount);
    const yellow = (x: number, y: number) => {
      const i = (y * image.width + x) * 4;
      return data[i]! > 200 && data[i + 1]! > 120 && data[i + 2]! < 100;
    };
    const xs = Array.from({ length: image.width }, (_, x) => x).filter((x) => yellow(x, centerY));
    const ys = Array.from({ length: image.height }, (_, y) => y).filter((y) => yellow(centerX, y));
    return {
      x: xs[0]!,
      y: ys[0]!,
      width: xs.at(-1)! - xs[0]! + 1,
      height: ys.at(-1)! - ys[0]! + 1,
    };
  }, buffer.toString("base64"));
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
          const result: { buffer: Buffer; annotations?: AnnotationItem[] } =
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
          if (result.annotations) {
            expect(result.annotations[0]?.box).toEqual({
              x: 99,
              y: 54,
              width: 360,
              height: 180,
            });
          }
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

    it.for([
      { device: "Native DPR 2", pageScale: 1, nativeDpr: 2 },
      { device: "Desktop Chrome", pageScale: 1 },
      { device: "iPad Mini", pageScale: 1 },
      { device: "iPhone 13", pageScale: 1 },
      { device: "iPhone 13", pageScale: 2 },
      { device: "Native classic scrollbars", pageScale: 1, nativeDpr: 1, showScrollbars: true },
    ])(
      "returns image-space annotations through routes for $device at page scale $pageScale",
      { timeout: 60_000 },
      async ({ device, pageScale, nativeDpr, showScrollbars }, { annotate }) => {
        await withBrowser(
          async (target) => {
            if (nativeDpr === undefined) {
              await setDeviceViaPlaywright({ ...target, name: device });
            }
            const page = await getPageForTargetId(target);
            if (showScrollbars) {
              await page.addStyleTag({
                content:
                  "html{overflow-y:scroll}::-webkit-scrollbar{width:16px;height:16px}::-webkit-scrollbar-thumb{background:#888}button{left:480px}",
              });
            }
            const zoom = await page.context().newCDPSession(page);
            await zoom.send("Emulation.setPageScaleFactor", { pageScaleFactor: pageScale });
            await zoom.detach();
            const state: BrowserServerState = {
              port: 0,
              resolved: resolveBrowserConfig({
                defaultProfile: "geometry",
                profiles: {
                  geometry: { cdpUrl: target.cdpUrl, color: "#123456", attachOnly: true },
                },
              }),
              profiles: new Map(),
            };
            const routes = createBrowserRouteApp();
            registerBrowserAgentSnapshotRoutes(
              routes.app,
              createBrowserRouteContext({ getState: () => state }),
            );
            for (const mode of ["viewport", "fullpage", "element", "snapshot"] as const) {
              await page.evaluate(() => scrollTo(0, 420));
              if (mode === "element") {
                await page
                  .locator("section")
                  .first()
                  .evaluate((section) => {
                    section.style.transform = "translate(0.5px, 0.5px)";
                  });
              }
              const before = await page.evaluate(readGeometry);
              if (showScrollbars) {
                expect(before.width - before.visual.width).toBe(16);
              }
              const response = createBrowserRouteResponse();
              const request = { targetId: target.targetId, labels: true };
              if (mode === "snapshot") {
                await routes.getHandlers.get("/snapshot")!(
                  { params: {}, query: { ...request, format: "ai" } },
                  response.res,
                );
              } else {
                await routes.postHandlers.get("/screenshot")!(
                  {
                    params: {},
                    query: {},
                    body: {
                      ...request,
                      fullPage: mode === "fullpage",
                      element: mode === "element" ? "section" : undefined,
                    },
                  },
                  response.res,
                );
              }
              expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
              const result = response.body as {
                path?: string;
                imagePath?: string;
                annotations: AnnotationItem[];
              };
              const imagePath = result.path ?? result.imagePath!;
              try {
                const buffer = await fs.readFile(imagePath);
                await annotate(`${device} ${mode}`, { path: imagePath });
                const metadata = await getImageMetadata(buffer);
                const imageWidth = metadata!.width;
                const imageHeight = metadata!.height;
                const annotation = result.annotations.find(({ name }) => name === "Target")!;
                const pixels = await readLabelBox(page, buffer);
                for (const coordinate of ["x", "y", "width", "height"] as const) {
                  expect(
                    Math.abs(annotation.box[coordinate] - pixels[coordinate]),
                    `${device} ${mode} ${coordinate}: annotation=${annotation.box[coordinate]} pixels=${pixels[coordinate]}`,
                  ).toBeLessThanOrEqual(1);
                }
                expect(Math.max(imageWidth, imageHeight)).toBeLessThanOrEqual(2000);
                if (device === "iPhone 13" && mode === "fullpage") {
                  expect(imageHeight).toBe(2000);
                  expect(imageHeight / 1200).toBeLessThan(before.dpr);
                }
              } finally {
                await fs.rm(imagePath);
                if (mode === "element") {
                  await page
                    .locator("section")
                    .first()
                    .evaluate((section) => {
                      section.style.transform = "";
                    });
                }
              }
            }
          },
          nativeDpr,
          showScrollbars,
        );
      },
    );
  },
);
