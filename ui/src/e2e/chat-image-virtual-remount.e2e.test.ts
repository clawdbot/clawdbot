import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProof,
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const source = "media://inbound/virtual-remount.png";
const imageAlt = "Virtual remount proof";

type RemountTrace = {
  at: number;
  image: boolean;
  row: boolean;
  skeleton: boolean;
};

type MediaProxy = {
  baseUrl: string;
  close: () => Promise<void>;
  requests: { image: number; metadata: number };
};

const forwardedHeaderBlocklist = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

async function listenOnLoopback(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Control UI media proxy did not expose a loopback port"));
        return;
      }
      resolve(address);
    });
  });
}

async function startMediaProxy(options: {
  imageBytes: Buffer;
  upstreamBaseUrl: string;
  waitForRepeatedMetadata: Promise<void>;
}): Promise<MediaProxy> {
  const requests = { image: 0, metadata: 0 };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://control-ui.invalid");
      if (url.pathname === "/__openclaw__/assistant-media") {
        expect(url.searchParams.get("source")).toBe(source);
        if (url.searchParams.get("meta") === "1") {
          requests.metadata += 1;
          if (requests.metadata > 1) {
            await options.waitForRepeatedMetadata;
          }
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              available: true,
              mediaTicket: `virtual-remount-ticket-${requests.metadata}`,
              mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            }),
          );
          return;
        }
        requests.image += 1;
        response.writeHead(200, {
          "Cache-Control": "private, max-age=300",
          "Content-Type": "image/png",
        });
        response.end(options.imageBytes);
        return;
      }

      const upstream = await fetch(
        new URL(`${url.pathname}${url.search}`, options.upstreamBaseUrl),
        {
          headers: { Accept: request.headers.accept ?? "*/*" },
          method: request.method,
        },
      );
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (!forwardedHeaderBlocklist.has(name)) {
          response.setHeader(name, value);
        }
      }
      response.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch((error: unknown) => {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  const address = await listenOnLoopback(server);
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    requests,
  };
}

suite.define(() => {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    it(`keeps a loaded image out of the loading state after a ${viewport.name} virtual remount`, async () => {
      const imageBytes = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      const proofDir = captureUiProofEnabled ? suite.artifactDir : undefined;
      let releaseRepeatedMetadata!: () => void;
      const repeatedMetadataGate = new Promise<void>((resolve) => {
        releaseRepeatedMetadata = resolve;
      });
      const mediaProxy = await startMediaProxy({
        imageBytes,
        upstreamBaseUrl: suite.server.baseUrl,
        waitForRepeatedMetadata: repeatedMetadataGate,
      });
      try {
        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            viewport,
            ...(proofDir
              ? {
                  recordVideo: {
                    dir: proofDir,
                    size: { width: viewport.width, height: viewport.height },
                  },
                }
              : {}),
          },
          async ({ page }) => {
            const baseTimestamp = Date.now() - 100_000;
            const historyMessages = Array.from({ length: 80 }, (_, index) =>
              index === 2
                ? {
                    id: "virtual-remount-image",
                    role: "user",
                    content: [{ type: "text", text: "Image near the start of a long transcript" }],
                    __openclaw: {
                      media: [{ path: source, contentType: "image/png", fileName: imageAlt }],
                    },
                    timestamp: baseTimestamp + index,
                  }
                : {
                    role: index % 2 === 0 ? "assistant" : "user",
                    content: [
                      {
                        type: "text",
                        text: `Virtual remount history ${index}\n${"extra transcript line\n".repeat(3)}`,
                      },
                    ],
                    timestamp: baseTimestamp + index,
                  },
            );
            await installMockGateway(page, { historyMessages });

            try {
              await page.goto(new URL("chat", mediaProxy.baseUrl).href);
              await page.getByText("Virtual remount history 79", { exact: false }).waitFor();
              await waitForChatScrollIdle(page);
              await scrollChatThreadToTop(page);
              await waitForChatScrollIdle(page);

              const image = page.locator("img.chat-message-image");
              await expect
                .poll(() =>
                  image.evaluate((element) =>
                    element instanceof HTMLImageElement && element.complete
                      ? element.naturalWidth
                      : 0,
                  ),
                )
                .toBeGreaterThan(0);
              const rowKey = await image.evaluate(
                (element) =>
                  element.closest<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey,
              );
              expect(rowKey).toBeTruthy();
              await captureUiProof(suite, page, viewport.name, "01-image-loaded.png");

              const trace = await page.evaluateHandle((targetRowKey) => {
                const samples: RemountTrace[] = [];
                const sample = () => {
                  const row = document.querySelector(
                    `.chat-virtual-row[data-virtual-row-key=${JSON.stringify(targetRowKey)}]`,
                  );
                  samples.push({
                    at: performance.now(),
                    image: Boolean(row?.querySelector("img.chat-message-image")),
                    row: Boolean(row),
                    skeleton: Boolean(
                      row?.querySelector(
                        '.chat-assistant-attachment-card--checking[aria-busy="true"]',
                      ),
                    ),
                  });
                };
                const observer = new MutationObserver(sample);
                observer.observe(document.querySelector(".chat-thread")!, {
                  childList: true,
                  subtree: true,
                });
                const frameTimes: number[] = [];
                let frame = 0;
                let previous = performance.now();
                const sampleFrame = (now: number) => {
                  frameTimes.push(now - previous);
                  previous = now;
                  frame = requestAnimationFrame(sampleFrame);
                };
                frame = requestAnimationFrame(sampleFrame);
                const longTasks: number[] = [];
                const performanceObserver = new PerformanceObserver((list) => {
                  longTasks.push(...list.getEntries().map((entry) => entry.duration));
                });
                performanceObserver.observe({ entryTypes: ["longtask"] });
                sample();
                return {
                  stop: () => {
                    observer.disconnect();
                    performanceObserver.disconnect();
                    cancelAnimationFrame(frame);
                    return { frameTimes, longTasks, samples };
                  },
                };
              }, rowKey);

              const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
              await thread.evaluate((element) => {
                element.scrollTop = element.scrollHeight;
                element.dispatchEvent(new Event("scroll", { bubbles: true }));
              });
              await waitForChatScrollIdle(page);
              await expect.poll(() => image.count()).toBe(0);
              await captureUiProof(suite, page, viewport.name, "02-image-away.png");

              await scrollChatThreadToTop(page);
              await expect
                .poll(async () => {
                  const skeleton = await page
                    .locator('.chat-assistant-attachment-card--checking[aria-busy="true"]')
                    .count();
                  return skeleton + (await image.count());
                })
                .toBeGreaterThan(0);
              await captureUiProof(suite, page, viewport.name, "03-image-returned.png");
              releaseRepeatedMetadata();
              await waitForChatScrollIdle(page);
              await expect
                .poll(() =>
                  image.evaluate((element) =>
                    element instanceof HTMLImageElement && element.complete
                      ? element.naturalWidth
                      : 0,
                  ),
                )
                .toBeGreaterThan(0);

              const traceResult = await trace.evaluate((recorder) => recorder.stop());
              await trace.dispose();
              const sortedFrames = traceResult.frameTimes.toSorted((left, right) => left - right);
              const p95Index = Math.max(0, Math.ceil(sortedFrames.length * 0.95) - 1);
              const evidence = {
                imageRequests: mediaProxy.requests.image,
                metadataRequests: mediaProxy.requests.metadata,
                performance: {
                  frameMaxMs: Math.max(0, ...traceResult.frameTimes),
                  frameP95Ms: sortedFrames[p95Index] ?? 0,
                  longTaskCount: traceResult.longTasks.length,
                  longTaskTotalMs: traceResult.longTasks.reduce(
                    (sum, duration) => sum + duration,
                    0,
                  ),
                },
                trace: traceResult.samples,
                viewport,
              };
              if (proofDir) {
                await writeFile(
                  path.join(proofDir, viewport.name, "remount-evidence.json"),
                  `${JSON.stringify(evidence, null, 2)}\n`,
                );
              }
              expect(traceResult.samples.some((sample) => !sample.row)).toBe(true);
              expect(traceResult.samples.filter((sample) => sample.skeleton)).toEqual([]);
              expect(mediaProxy.requests.metadata).toBe(1);
              expect(mediaProxy.requests.image).toBe(1);
            } finally {
              releaseRepeatedMetadata();
            }
          },
        );
      } finally {
        releaseRepeatedMetadata();
        await mediaProxy.close();
      }
    }, 120_000);
  }
});
