import { writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import type { StoredComposerState } from "../lib/chat/outbox-store.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const proofRoot = path.resolve(".artifacts/control-ui-e2e/outbox-capacity/after");
const largePngBytes = 2_404_765;
const smallPngBytes = 25_536;
const storageError =
  "Could not store this message for reconnect. Free browser storage or reconnect before sending.";

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function sizedPng(size: number, color: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk("IHDR", header);
  const idat = pngChunk("IDAT", deflateSync(Buffer.from([0, color, 100, 180, 255])));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  // A CRC-covered tEXt ancillary chunk pads a decodable PNG, not trailing junk.
  const padding = Buffer.alloc(
    size - signature.length - ihdr.length - idat.length - iend.length - 12,
    120,
  );
  padding.write("Padding\0", 0, "ascii");
  return Buffer.concat([signature, ihdr, pngChunk("tEXt", padding), idat, iend]);
}

async function observeMockSends(page: Page) {
  return page.evaluateHandle(() => {
    const sends: Array<{
      message: string;
      queueMode?: string;
      sessionKey: string;
      runId: string;
      durableBeforeSend: boolean;
      storedSendState?: string;
      attachments: Array<{ fileName: string; mimeType: string; sizeBytes: number }>;
    }> = [];
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the mock method for call(this, raw) and restore it on teardown.
    const send = WebSocket.prototype.send;
    // Observe the existing mock transport synchronously; storage and admission
    // remain native. Reading after chat.send alone cannot prove admission order.
    WebSocket.prototype.send = function (raw) {
      if (typeof raw === "string") {
        const frame = JSON.parse(raw) as {
          method?: string;
          params: {
            message: string;
            queueMode?: string;
            sessionKey: string;
            idempotencyKey: string;
            attachments?: Array<{ fileName: string; mimeType: string; content: string }>;
          };
        };
        if (frame.method === "chat.send") {
          const params = frame.params;
          const queue = Object.keys(sessionStorage)
            .filter((key) => key.startsWith("openclaw.control.chatComposer.v4:"))
            .flatMap((key) => {
              const stored = JSON.parse(sessionStorage.getItem(key)!) as StoredComposerState;
              return Object.values(stored.sessions).flatMap((session) => session.queue ?? []);
            });
          const persisted = queue.find((item) => item.sendRunId === params.idempotencyKey);
          const attachments = params.attachments ?? [];
          sends.push({
            message: params.message,
            queueMode: params.queueMode,
            sessionKey: params.sessionKey,
            runId: params.idempotencyKey,
            durableBeforeSend:
              persisted?.text === params.message &&
              persisted.queueMode === params.queueMode &&
              persisted.attachments?.length === attachments.length &&
              attachments.every((attachment, index) => {
                const stored = persisted.attachments?.[index];
                return (
                  stored?.fileName === attachment.fileName &&
                  stored.mimeType === attachment.mimeType &&
                  !stored.dataUrl &&
                  Boolean(persisted.attachmentPayload?.key)
                );
              }),
            storedSendState: persisted?.sendState,
            attachments: attachments.map((attachment) => ({
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              sizeBytes: atob(attachment.content).length,
            })),
          });
        }
      }
      return send.call(this, raw);
    };
    return {
      sends,
      dispose: () => {
        WebSocket.prototype.send = send;
      },
    };
  });
}

suite.define(() => {
  it.each([
    { name: "one-large", sizes: [largePngBytes] },
    { name: "large-and-small", sizes: [largePngBytes, smallPngBytes] },
    { name: "two-large", sizes: [largePngBytes, largePngBytes] },
  ])(
    "durably admits $name PNG attachments before steering an active run (mock Gateway)",
    async ({ name, sizes }) => {
      const proofDir = createControlUiE2eArtifactDir(`outbox-capacity-${name}`, proofRoot);
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1280, height: 900 },
          recordVideo: { dir: path.join(proofDir, "video"), size: { width: 1280, height: 900 } },
        },
        async ({ page }) => {
          const runId = "mock-active-capacity-run";
          const activeText = "Mock Gateway: the active run is still working.";
          const historyText = "Mock Gateway: inspect the attachment batch.";
          const gateway = await installMockGateway(page, {
            historyMessages: [{ role: "user", content: historyText }],
            inFlightRun: { runId, text: activeText },
            sessionInfo: { activeRunIds: [runId], hasActiveRun: true, key: "main" },
            deferredMethods: ["chat.send"],
          });
          await page.goto(`${suite.server.baseUrl}settings/appearance`);
          await page.locator("[data-settings-follow-up-mode]").selectOption("steer");
          await gateway.waitForRequest("config.patch");
          await page.goto(`${suite.server.baseUrl}chat`);
          const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
          const composer = pane.locator(".agent-chat__composer-combobox textarea");
          const steer = pane.getByRole("button", {
            name: "Steer into the active run",
            exact: true,
          });
          await pane.getByText(historyText, { exact: true }).waitFor();
          await pane.getByText(activeText, { exact: true }).waitFor();
          await pane.getByRole("button", { name: "Stop generating" }).waitFor();
          const files = sizes.map((size, index) => ({
            name: `mock-${name}-${index + 1}.png`,
            mimeType: "image/png",
            buffer: sizedPng(size, 60 + index * 100),
          }));
          expect(files.map((file) => file.buffer.length)).toEqual(sizes);
          const message = `Mock Gateway: steer with ${name} PNG batch.`;
          await composer.fill(message);
          await pane.locator(".agent-chat__file-input").setInputFiles(files);
          const previews = pane.locator(".chat-attachment-thumb img");
          await expect.poll(() => previews.count()).toBe(files.length);
          await expect
            .poll(() =>
              previews.evaluateAll((images) =>
                images.every(
                  (image) =>
                    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
                ),
              ),
            )
            .toBe(true);
          const acceptedBytes = await previews.evaluateAll(async (images) =>
            Promise.all(
              images.map(
                async (image) => (await (await fetch((image as HTMLImageElement).src)).blob()).size,
              ),
            ),
          );
          expect(acceptedBytes).toEqual(sizes);
          await expect.poll(() => steer.isEnabled()).toBe(true);
          expect(await pane.locator(".chat-queue__item").count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          const observation = await observeMockSends(page);
          try {
            await steer.click();
            const outcomeHandle = await page.waitForFunction(
              ({ proof, error }) => {
                const errorVisible = [...document.querySelectorAll('[role="alert"]')].some(
                  (alert) => alert.textContent?.includes(error),
                );
                return proof.sends.length > 0 ? "sent" : errorVisible ? "storage-rejected" : false;
              },
              { proof: observation, error: storageError },
            );
            const outcome = await outcomeHandle.jsonValue();
            await outcomeHandle.dispose();
            const sends = await observation.evaluate((proof) => proof.sends);
            const requests = await gateway.getRequests("chat.send");
            const sessionStorageUsage = await page.evaluate(() =>
              Object.keys(sessionStorage).map((key) => ({
                key,
                utf16Bytes: 2 * (key.length + sessionStorage.getItem(key)!.length),
              })),
            );
            const error = await pane.getByRole("alert").allInnerTexts();
            const evidence = {
              gateway: "mock; no provider or operator Gateway contacted",
              browser: suite.browser.version(),
              name,
              acceptedBytes,
              dataUrlUtf16Bytes: sizes.reduce(
                (sum, size) => sum + 2 * (22 + 4 * Math.ceil(size / 3)),
                0,
              ),
              sessionStorageUsage,
              outcome,
              error,
              sends,
              draft: await composer.inputValue(),
              attachmentPreviews: await previews.count(),
              queueRows: await pane.locator(".chat-queue__item").count(),
            };
            await writeFile(
              path.join(proofDir, `${name}.json`),
              `${JSON.stringify(evidence, null, 2)}\n`,
            );
            // Failed admission must retain the entire draft, with no phantom queue
            // entry or send. The success contract below still fails on that outcome.
            if (outcome === "storage-rejected") {
              expect(evidence.draft).toBe(message);
              expect(evidence.attachmentPreviews).toBe(files.length);
              expect(evidence.queueRows).toBe(0);
              await expectRequestCountStable(gateway, "chat.send", 0);
            }
            const captureImages = pane.locator(".chat-attachment-thumb img, .chat-message-image");
            await expect.poll(() => captureImages.count()).toBe(files.length);
            await expect
              .poll(() =>
                captureImages.evaluateAll((images) =>
                  images.every(
                    (image) =>
                      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
                  ),
                ),
              )
              .toBe(true);
            await pane.getByText(historyText, { exact: true }).waitFor();
            await pane.getByText(activeText, { exact: true }).waitFor();
            await writeFile(
              path.join(proofDir, `${name}-${outcome}.png`),
              await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
                pane.getByText(historyText, { exact: true }),
                pane.getByText(activeText, { exact: true }),
                captureImages.first(),
              ]),
            );

            expect(outcome, JSON.stringify(evidence)).toBe("sent");
            const payloads = await page.evaluate(async () => {
              const database = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open("openclaw-control-ui");
                request.onsuccess = () => resolve(request.result);
                request.addEventListener("error", () =>
                  reject(request.error ?? new Error("IndexedDB request failed")),
                );
              });
              try {
                const records = await new Promise<Array<{ attachments: Array<{ blob: Blob }> }>>(
                  (resolve, reject) => {
                    const request = database
                      .transaction("outboxPayloads")
                      .objectStore("outboxPayloads")
                      .getAll();
                    request.onsuccess = () => resolve(request.result);
                    request.addEventListener("error", () =>
                      reject(request.error ?? new Error("IndexedDB request failed")),
                    );
                  },
                );
                return Promise.all(
                  records
                    .flatMap((record) => record.attachments)
                    .map(async ({ blob }) => {
                      const bytes = new Uint8Array(await blob.arrayBuffer());
                      let binary = "";
                      for (const byte of bytes) {
                        binary += String.fromCharCode(byte);
                      }
                      return btoa(binary);
                    }),
                );
              } finally {
                database.close();
              }
            });
            expect(payloads).toEqual(files.map((file) => file.buffer.toString("base64")));
            expect(requests[0]?.params).toEqual(
              expect.objectContaining({
                attachments: files.map((file) => ({
                  type: "image",
                  mimeType: file.mimeType,
                  fileName: file.name,
                  content: file.buffer.toString("base64"),
                })),
              }),
            );
            expect(sends).toEqual([
              {
                message,
                queueMode: "steer",
                sessionKey: "agent:main:main",
                runId: expect.any(String),
                durableBeforeSend: true,
                storedSendState: "waiting-reconnect",
                attachments: files.map((file) => ({
                  fileName: file.name,
                  mimeType: file.mimeType,
                  sizeBytes: file.buffer.length,
                })),
              },
            ]);
            await expect.poll(() => composer.inputValue()).toBe("");
            await expect.poll(() => previews.count()).toBe(0);
            await pane.locator(".chat-group.user", { hasText: message }).waitFor();
            expect(await pane.locator(".chat-queue__item").count()).toBe(0);
            await pane.getByRole("button", { name: "Stop generating" }).waitFor();
            await expectRequestCountStable(gateway, "chat.send", 1);
            const sent = sends[0];
            assert(sent, "Expected the observed chat.send before emitting its terminal");
            await gateway.resolveDeferred("chat.send", {
              runId: sent.runId,
              status: "started",
            });
            await pane.getByRole("button", { name: "Stop generating" }).waitFor();
            await gateway.deferNext("chat.history");
            await gateway.emitChatFinal({
              runId: sent.runId,
              text: "Mock Gateway: attachment delivery finished before history persisted.",
            });
            await expect
              .poll(() =>
                page.evaluate(
                  (deliveredRunId) =>
                    Object.keys(sessionStorage)
                      .filter((key) => key.startsWith("openclaw.control.chatComposer.v4:"))
                      .flatMap((key) =>
                        Object.values(
                          (JSON.parse(sessionStorage.getItem(key)!) as StoredComposerState)
                            .sessions,
                        ),
                      )
                      .flatMap((session) => session.queue ?? [])
                      .filter((item) => item.sendRunId === deliveredRunId).length,
                  sent.runId,
                ),
              )
              .toBe(0);
            const deliveredImages = pane
              .locator(".chat-group.user", { hasText: message })
              .locator(".chat-message-image");
            await expect.poll(() => deliveredImages.count()).toBe(files.length);
            await expect
              .poll(() =>
                deliveredImages.evaluateAll((images) =>
                  images.every(
                    (image) =>
                      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
                  ),
                ),
              )
              .toBe(true);
            const deliveredBytes = await deliveredImages.evaluateAll((images) =>
              Promise.all(
                images.map(async (image) => {
                  const bytes = new Uint8Array(
                    await (await fetch((image as HTMLImageElement).src)).arrayBuffer(),
                  );
                  let binary = "";
                  for (const byte of bytes) {
                    binary += String.fromCharCode(byte);
                  }
                  return btoa(binary);
                }),
              ),
            );
            expect(deliveredBytes).toEqual(files.map((file) => file.buffer.toString("base64")));
            await expect
              .poll(() =>
                page.evaluate(async () => {
                  const database = await new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open("openclaw-control-ui");
                    request.onsuccess = () => resolve(request.result);
                    request.addEventListener("error", () =>
                      reject(request.error ?? new Error("IndexedDB request failed")),
                    );
                  });
                  try {
                    return await new Promise<number>((resolve, reject) => {
                      const request = database
                        .transaction("outboxPayloads")
                        .objectStore("outboxPayloads")
                        .count();
                      request.onsuccess = () => resolve(request.result);
                      request.addEventListener("error", () =>
                        reject(request.error ?? new Error("IndexedDB request failed")),
                      );
                    });
                  } finally {
                    database.close();
                  }
                }),
              )
              .toBe(0);
            await expectRequestCountStable(gateway, "chat.send", 1);
            await writeFile(
              path.join(proofDir, `${name}-terminal-handoff.png`),
              await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
                deliveredImages.first(),
              ]),
            );
          } finally {
            await observation.evaluate((proof) => proof.dispose());
            await observation.dispose();
          }
        },
      );
    },
  );
});
