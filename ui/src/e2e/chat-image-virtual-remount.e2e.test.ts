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
const imageSource = "media://inbound/virtual-remount.png";
const imageAlt = "Virtual remount proof";
const documentArtifactId = "artifact_managed_media_77777777-7777-4777-8777-777777777777";
const documentSource =
  "/api/chat/media/outgoing/agent%3Amain%3Amain/77777777-7777-4777-8777-777777777777/full";
const documentLabel = "virtual-remount-notes.pdf";

type RemountTrace = {
  at: number;
  document: boolean;
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
        expect(url.searchParams.get("source")).toBe(imageSource);
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
    for (const colorScheme of ["light", "dark"] as const) {
      it(`keeps loaded attachments out of the loading state after a ${viewport.name} ${colorScheme} virtual remount`, async () => {
        const imageBytes = await readFile(
          path.join(process.cwd(), "ui/public/apple-touch-icon.png"),
        );
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
              colorScheme,
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
                      id: "virtual-remount-attachments",
                      role: "assistant",
                      content: [
                        {
                          type: "text",
                          text: "Mixed attachments near the start of a long transcript",
                        },
                        {
                          type: "attachment",
                          attachment: {
                            kind: "image",
                            label: imageAlt,
                            mimeType: "image/png",
                            url: imageSource,
                          },
                        },
                        {
                          type: "attachment",
                          attachment: {
                            artifactId: documentArtifactId,
                            kind: "document",
                            label: documentLabel,
                            mimeType: "application/pdf",
                            sizeBytes: 12_345,
                            url: documentSource,
                          },
                        },
                      ],
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
              const gateway = await installMockGateway(page, {
                heldMethods: ["artifacts.download"],
                historyMessages,
                methodResponses: {
                  "artifacts.download": {
                    cases: [
                      {
                        match: {
                          artifactId: documentArtifactId,
                          sessionKey: "agent:main:main",
                        },
                        response: {
                          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                          url: `${documentSource}?mediaTicket=virtual-remount-document`,
                        },
                      },
                    ],
                  },
                },
              });

              try {
                await page.goto(new URL("chat", mediaProxy.baseUrl).href);
                await page.getByText("Virtual remount history 79", { exact: false }).waitFor();
                await waitForChatScrollIdle(page);
                await scrollChatThreadToTop(page);
                await waitForChatScrollIdle(page);

                expect(await page.locator("html").getAttribute("data-theme-mode")).toBe(
                  colorScheme,
                );

                const image = page.locator("img.chat-message-image");
                const documentCard = page
                  .locator(".chat-assistant-attachment-card")
                  .filter({ hasText: documentLabel });
                await expect
                  .poll(() =>
                    image.evaluate((element) =>
                      element instanceof HTMLImageElement && element.complete
                        ? element.naturalWidth
                        : 0,
                    ),
                  )
                  .toBeGreaterThan(0);
                const actionSkeleton = documentCard.locator(
                  ".chat-assistant-attachment-card__action-skeleton",
                );
                await actionSkeleton.waitFor({ state: "visible" });
                const actionSkeletonSize = await actionSkeleton.evaluate((element) => {
                  const rect = element.getBoundingClientRect();
                  return { height: rect.height, width: rect.width };
                });
                expect(actionSkeletonSize).toEqual({ height: 30, width: 30 });
                await captureUiProof(
                  suite,
                  page,
                  `${viewport.name}-${colorScheme}`,
                  "00-attachment-skeleton.png",
                );
                await gateway.resolveDeferred("artifacts.download");
                await documentCard.waitFor({ state: "visible" });
                await expect(
                  documentCard.evaluate((element) =>
                    element.classList.contains("chat-assistant-attachment-card--compact"),
                  ),
                ).resolves.toBe(true);
                const composer = page.locator(".agent-chat__input");
                await composer.locator(".agent-chat__file-input").setInputFiles({
                  name: "virtual-remount-draft.txt",
                  mimeType: "text/plain",
                  buffer: Buffer.from("attachment chip proof"),
                });
                await composer.locator(".chat-attachment-thumb--file").waitFor();
                const rowKey = await image.evaluate(
                  (element) =>
                    element.closest<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey,
                );
                expect(rowKey).toBeTruthy();
                const readLayout = () =>
                  page.evaluate(() => {
                    const geometry = (selector: string) => {
                      const element = document.querySelector<HTMLElement>(selector);
                      if (!element) {
                        return null;
                      }
                      const rect = element.getBoundingClientRect();
                      const style = getComputedStyle(element);
                      return {
                        borderRadius: style.borderRadius,
                        display: style.display,
                        gap: style.gap,
                        height: Math.round(rect.height * 1_000) / 1_000,
                        maxHeight: style.maxHeight,
                        maxWidth: style.maxWidth,
                        objectFit: style.objectFit,
                        width: Math.round(rect.width * 1_000) / 1_000,
                      };
                    };
                    return {
                      attachmentCard: geometry(".chat-assistant-attachment-card--compact"),
                      attachmentChip: geometry(".chat-attachment-thumb--file"),
                      attachmentTrigger: geometry(".agent-chat__input-btn--attach"),
                      documentScrollWidth: document.documentElement.scrollWidth,
                      image: geometry("img.chat-message-image"),
                      imageButton: geometry(".chat-message-image-button"),
                      viewportWidth: window.innerWidth,
                    };
                  });
                const loadedLayout = await readLayout();
                expect(loadedLayout.documentScrollWidth).toBeLessThanOrEqual(
                  loadedLayout.viewportWidth + 1,
                );
                await captureUiProof(
                  suite,
                  page,
                  `${viewport.name}-${colorScheme}`,
                  "01-attachments-loaded.png",
                );

                const trace = await page.evaluateHandle((targetRowKey) => {
                  const samples: RemountTrace[] = [];
                  const sample = () => {
                    const row = document.querySelector(
                      `.chat-virtual-row[data-virtual-row-key=${JSON.stringify(targetRowKey)}]`,
                    );
                    samples.push({
                      at: performance.now(),
                      document: Boolean(
                        row?.querySelector(".chat-assistant-attachment-card--compact"),
                      ),
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
                await captureUiProof(
                  suite,
                  page,
                  `${viewport.name}-${colorScheme}`,
                  "02-attachments-away.png",
                );

                await gateway.deferNext("artifacts.download");
                await scrollChatThreadToTop(page);
                await expect
                  .poll(async () => {
                    const skeleton = await page
                      .locator('.chat-assistant-attachment-card--checking[aria-busy="true"]')
                      .count();
                    return skeleton + (await image.count());
                  })
                  .toBeGreaterThan(0);
                await captureUiProof(
                  suite,
                  page,
                  `${viewport.name}-${colorScheme}`,
                  "03-attachments-returned.png",
                );
                releaseRepeatedMetadata();
                const artifactRequests = await gateway.getRequests("artifacts.download");
                if (artifactRequests.length > 1) {
                  await gateway.resolveDeferred("artifacts.download");
                }
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
                await documentCard.waitFor({ state: "visible" });
                const returnedLayout = await readLayout();
                expect(returnedLayout).toEqual(loadedLayout);

                const traceResult = await trace.evaluate((recorder) => recorder.stop());
                await trace.dispose();
                const sortedFrames = traceResult.frameTimes.toSorted((left, right) => left - right);
                const p95Index = Math.max(0, Math.ceil(sortedFrames.length * 0.95) - 1);
                const evidence = {
                  imageRequests: mediaProxy.requests.image,
                  metadataRequests: mediaProxy.requests.metadata,
                  artifactRequests: artifactRequests.length,
                  layout: returnedLayout,
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
                    path.join(proofDir, `${viewport.name}-${colorScheme}`, "remount-evidence.json"),
                    `${JSON.stringify(evidence, null, 2)}\n`,
                  );
                }
                expect(traceResult.samples.some((sample) => !sample.row)).toBe(true);
                expect(traceResult.samples.filter((sample) => sample.skeleton)).toEqual([]);
                expect(traceResult.samples.some((sample) => sample.document)).toBe(true);
                expect(mediaProxy.requests.metadata).toBe(1);
                expect(mediaProxy.requests.image).toBe(1);
                expect(artifactRequests).toHaveLength(1);
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
  }
});
