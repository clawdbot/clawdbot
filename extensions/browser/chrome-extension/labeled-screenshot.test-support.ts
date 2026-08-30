import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect } from "vitest";
import type { createBrowserRouteDispatcher } from "../src/browser/routes/dispatcher.js";

/** Run the real snapshot/ref screenshot flow and retain its labeled image for inspection. */
export async function proveLabeledRefScreenshot(params: {
  dispatcher: ReturnType<typeof createBrowserRouteDispatcher>;
  controlled: Page;
  profile: string;
  targetId: string;
  proofName: string;
}): Promise<void> {
  const { dispatcher, controlled, profile, targetId, proofName } = params;
  const snapshotResponse = await dispatcher.dispatch({
    method: "GET",
    path: "/snapshot",
    query: { profile, targetId, format: "ai" },
  });
  expect(snapshotResponse.status, JSON.stringify(snapshotResponse.body)).toBe(200);
  const refs = (snapshotResponse.body as { refs?: Record<string, { name?: string }> }).refs;
  const targetRef = Object.entries(refs ?? {}).find(
    ([, info]) => info.name === "Offscreen target",
  )?.[0];
  if (!targetRef) {
    throw new Error(`Offscreen target ref missing: ${JSON.stringify(snapshotResponse.body)}`);
  }
  await controlled.evaluate(() => window.scrollTo(0, 0));
  const screenshotResponse = await dispatcher.dispatch({
    method: "POST",
    path: "/screenshot",
    query: { profile },
    body: { targetId, ref: targetRef, labels: true, type: "png" },
  });
  const screenshot = screenshotResponse.body as { path?: string; labelsCount?: number };
  expect(screenshotResponse.status, JSON.stringify(screenshotResponse.body)).toBe(200);
  expect(screenshot.labelsCount).toBe(1);
  if (!screenshot.path) {
    throw new Error("Labeled ref screenshot did not return a path");
  }
  const proofPath = path.join(".artifacts/browser-lifecycle", proofName);
  await fs.mkdir(path.dirname(proofPath), { recursive: true });
  await fs.copyFile(screenshot.path, proofPath);
  const screenshotDataUrl = `data:image/png;base64,${(await fs.readFile(screenshot.path)).toString("base64")}`;
  const orangePixels = await controlled.evaluate(async (imageUrl) => {
    const image = new Image();
    image.src = imageUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) {
      return 0;
    }
    canvasContext.drawImage(image, 0, 0);
    const pixels = canvasContext.getImageData(0, 0, canvas.width, canvas.height).data;
    let matches = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (
        (pixels[index] ?? 0) > 220 &&
        (pixels[index + 1] ?? 255) >= 40 &&
        (pixels[index + 1] ?? 255) <= 120 &&
        (pixels[index + 2] ?? 255) < 80 &&
        (pixels[index + 3] ?? 0) > 200
      ) {
        matches += 1;
      }
    }
    return matches;
  }, screenshotDataUrl);
  expect(orangePixels).toBeGreaterThan(20);
  process.stderr.write(`[browser-extension-e2e] screenshot proof ${proofPath}\n`);
}
