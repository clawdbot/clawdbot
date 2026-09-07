import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  takeControlUiElementScreenshot,
  takeControlUiViewportScreenshot,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import type { ControlUiMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps a submitted image visible through custody and canonical history loading", async () => {
    const proofDir = captureUiProofEnabled ? suite.artifactDir : undefined;
    const imageBytes = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(proofDir ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1280 } } } : {}),
      },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        const sessionId = "image-handoff-session";
        const source = "media://inbound/stable-preview.png";
        const prompt = "Keep this image visible while the prompt is accepted.";
        let releaseMetadata!: () => void;
        let releaseImage!: () => void;
        const metadataGate = new Promise<void>((resolve) => {
          releaseMetadata = resolve;
        });
        const imageGate = new Promise<void>((resolve) => {
          releaseImage = resolve;
        });
        let metadataRequested = false;
        let imageRequested = false;
        await page.route("**/__openclaw__/assistant-media?**", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          expect(url.searchParams.get("source")).toBe(source);
          if (url.searchParams.get("meta") === "1") {
            metadataRequested = true;
            expect(request.headers().authorization).toBe("Bearer e2e-device-token");
            await metadataGate;
            await route.fulfill({
              json: {
                available: true,
                mediaTicket: "stable-image-ticket",
                mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
              },
            });
          } else {
            imageRequested = true;
            expect(url.searchParams.get("mediaTicket")).toBe("stable-image-ticket");
            expect(request.headers().authorization).toBeUndefined();
            await imageGate;
            await route.fulfill({ contentType: "image/png", body: imageBytes });
          }
        });
        const initialHistory = {
          messages: [],
          sessionId,
          sessionInfo: { key: sessionKey, kind: "direct", hasActiveRun: false, status: "done" },
        };
        const gateway = await installMockGateway(page, {
          historyMessages: [],
          methodResponses: { "chat.startup": initialHistory, "chat.history": initialHistory },
        });
        const capture = async (stage: string) => {
          if (proofDir) {
            await writeFile(
              path.join(proofDir, `${stage}.png`),
              await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
                page.locator(".chat-group.user img.chat-message-image"),
              ]),
            );
          }
        };

        try {
          await page.goto(`${suite.server.baseUrl}chat`);
          await gateway.waitForRequest("chat.startup");
          await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
          await page.locator(".agent-chat__file-input").setInputFiles({
            name: "stable-preview.png",
            mimeType: "image/png",
            buffer: imageBytes,
          });
          await page.getByRole("img", { name: "stable-preview.png" }).waitFor();
          await gateway.deferNext("chat.send");
          await page.getByRole("button", { name: "Send message" }).click();
          const request = await gateway.waitForRequest("chat.send");
          expect(request.params).toMatchObject({
            message: prompt,
            attachments: [{ fileName: "stable-preview.png", mimeType: "image/png" }],
          });
          const runId = requireString(
            requireRecord(request.params).idempotencyKey,
            "image send identity",
          );
          const userImage = page.locator(".chat-group.user img.chat-message-image");
          await expect
            .poll(() =>
              userImage.evaluate((image) =>
                image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
              ),
            )
            .toBe(180);
          expect(await userImage.getAttribute("src")).toMatch(/^blob:/u);
          const displayed = expectDefined(await userImage.elementHandle(), "submitted image");
          const initialPixels = await takeControlUiElementScreenshot(page, userImage, [userImage]);
          const continuity = await displayed.evaluateHandle((image) => {
            const gateway = (
              window as Window & {
                openclawControlUiE2eGateway: ControlUiMockGateway;
              }
            ).openclawControlUiE2eGateway;
            let sequence = 0;
            let frameRecords = 0;
            const record = (kind: string, details: Record<string, unknown>) => {
              console.info(
                "[image-handoff]",
                JSON.stringify({
                  sequence: ++sequence,
                  at: Date.now(),
                  kind,
                  ...details,
                }),
              );
            };
            const ancestors = [
              ".chat-image-frame",
              ".chat-bubble",
              ".chat-group.user",
              ".chat-virtual-row",
              ".chat-thread",
            ].map((selector) => ({ selector, element: image.closest(selector) }));
            const originalChain = new Map<Node, { label: string; depth: number }>();
            for (let node: Node | null = image; node !== null; node = node.parentNode) {
              originalChain.set(node, {
                label:
                  node === image
                    ? "image"
                    : node === document
                      ? "document"
                      : (ancestors.find(({ element }) => element === node)?.selector ?? "ancestor"),
                depth: originalChain.size,
              });
            }
            const snapshot = () => {
              const group = document.querySelector(".chat-group.user");
              const identity = (element: Element | null | undefined) =>
                element?.getAttribute("data-virtual-row-key")?.slice(0, 160) ??
                element?.getAttribute("data-message-id")?.slice(0, 160) ??
                null;
              return {
                imageConnected: image.isConnected,
                currentImageIsOriginal: group?.querySelector("img.chat-message-image") === image,
                imageCount: group?.querySelectorAll("img.chat-message-image").length ?? 0,
                ancestors: ancestors.map(({ selector, element }) => {
                  const current = group?.closest(selector) ?? group?.querySelector(selector);
                  return {
                    selector,
                    connected: element?.isConnected ?? false,
                    currentIsOriginal: Boolean(element && current === element),
                    originalKey: identity(element),
                    currentKey: identity(current),
                    entryId: current?.getAttribute("data-entry-id")?.slice(0, 160) ?? null,
                  };
                }),
              };
            };
            gateway.observeFrame = (value) => {
              const frame = value as {
                type?: string;
                id?: string;
                event?: string;
                payload?: {
                  status?: string;
                  sessionId?: string;
                  messageId?: string;
                  messageSeq?: number;
                  messages?: Array<{ __openclaw?: { id?: string; seq?: number } }>;
                  pendingInputs?: { items?: unknown[] };
                };
              };
              const index = gateway.requests.findIndex(({ id }) => id === frame.id);
              const request = gateway.requests[index];
              if (
                !(
                  frame.type === "res" &&
                  ["chat.send", "chat.history"].includes(request?.method ?? "")
                ) &&
                !(
                  frame.type === "event" &&
                  ["sessions.changed", "session.message"].includes(frame.event ?? "")
                )
              ) {
                return;
              }
              if (frameRecords++ >= 31) {
                if (frameRecords === 32) {
                  record("frame-cap-reached", { limit: 31 });
                }
                return;
              }
              const payload = frame.payload;
              record("before-frame-dispatch", {
                requestOrdinal: index < 0 ? null : index + 1,
                method: request?.method,
                event: frame.event,
                status: payload?.status?.slice(0, 160),
                sessionId: payload?.sessionId?.slice(0, 160),
                messageCount: payload?.messages?.length,
                pendingCount: payload?.pendingInputs?.items?.length,
                messageId: (payload?.messageId ?? payload?.messages?.[0]?.__openclaw?.id)?.slice(
                  0,
                  160,
                ),
                messageSeq: payload?.messageSeq ?? payload?.messages?.[0]?.__openclaw?.seq,
                ...snapshot(),
              });
            };
            let firstRemoval = false;
            let mutationOrdinal = 0;
            const observer = new MutationObserver((records) => {
              const batchStart = mutationOrdinal + 1;
              let firstMatch: Record<string, unknown> | undefined;
              for (const mutation of records) {
                const recordOrdinal = ++mutationOrdinal;
                if (firstRemoval || firstMatch) {
                  continue;
                }
                let removedNodeOrdinal = 0;
                for (const removed of mutation.removedNodes) {
                  removedNodeOrdinal += 1;
                  const owner = originalChain.get(removed);
                  if (!owner) {
                    continue;
                  }
                  const target = originalChain.get(mutation.target);
                  firstMatch = {
                    recordOrdinal,
                    removedNodeOrdinal,
                    removedOwnerLabel: owner.label,
                    removedOwnerDepth: owner.depth,
                    targetLabel: target?.label ?? "outside-original-chain",
                    targetDepth: target?.depth ?? null,
                  };
                  break;
                }
              }
              if (firstMatch) {
                firstRemoval = true;
                record("first-owner-removal", { removal: firstMatch, callbackState: snapshot() });
              }
              if (!image.isConnected) {
                observer.disconnect();
                record("first-observed-disconnect", {
                  observedAfterRecords: { first: batchStart, last: mutationOrdinal },
                  callbackState: snapshot(),
                });
              }
            });
            observer.observe(document, { childList: true, subtree: true });
            record("submitted", snapshot());
            const frames: boolean[] = [];
            const initialBounds = image.getBoundingClientRect();
            let frame = 0;
            const sample = () => {
              const bounds = image.getBoundingClientRect();
              frames.push(
                image.isConnected &&
                  bounds.width > 0 &&
                  bounds.height > 0 &&
                  bounds.width === initialBounds.width &&
                  bounds.height === initialBounds.height &&
                  document.querySelectorAll(".chat-group.user img.chat-message-image").length ===
                    1 &&
                  document.querySelector(".chat-group.user [aria-busy='true']") === null,
              );
              frame = requestAnimationFrame(sample);
            };
            sample();
            return {
              stop: () => {
                cancelAnimationFrame(frame);
                observer.disconnect();
                gateway.observeFrame = undefined;
                return frames;
              },
            };
          });
          const expectImageStillVisible = async (stage: string) => {
            await capture(stage);
            expect(await displayed.evaluate((image) => image.isConnected)).toBe(true);
            expect(await userImage.count()).toBe(1);
            // Native pending sources may report zero dimensions while the browser
            // still paints the current decoded image. Compare the actual pixels.
            expect(
              (await takeControlUiElementScreenshot(page, userImage, [userImage])).equals(
                initialPixels,
              ),
              `${stage} preserves the displayed image pixels`,
            ).toBe(true);
            expect(await page.locator(".chat-group.user [aria-busy='true']").count()).toBe(0);
          };
          await expectImageStillVisible("01-submitted");
          const acceptedAt = Date.now();
          const pendingInput = {
            id: "accepted-image-input",
            runId,
            acceptedAt,
            state: "queued",
            message: {
              role: "user",
              content: prompt,
              timestamp: acceptedAt,
              __openclaw: {
                id: "pending:accepted-image-input",
                mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
                media: [{ path: source, contentType: "image/png", fileName: "stable-preview.png" }],
              },
            },
          };
          const sessionInfo = {
            key: sessionKey,
            kind: "direct",
            activeRunIds: [runId],
            hasActiveRun: true,
            status: "running",
          };
          const custodyHistory = {
            messages: [],
            sessionId,
            sessionInfo,
            pendingInputs: { items: [pendingInput], total: 1 },
          };
          await gateway.setMethodResponse("chat.history", custodyHistory);
          const histories = (await gateway.getRequests("chat.history")).length;
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey,
            sessionId,
            reason: "send",
            hasActiveRun: true,
            session: sessionInfo,
          });
          await gateway.waitForRequest("chat.history", { after: histories });
          await expect.poll(() => page.locator(".chat-send-status").count()).toBe(0);
          await expectImageStillVisible("02-custody");
          await gateway.resolveDeferred("chat.send", { runId, status: "started" });

          const canonical = {
            ...pendingInput.message,
            __openclaw: {
              ...pendingInput.message["__openclaw"],
              id: pendingInput.id,
              seq: 1,
              idempotencyKey: `${runId}:user`,
            },
          };
          await gateway.setMethodResponse("chat.history", {
            ...custodyHistory,
            messages: [canonical],
            pendingInputs: { items: [], total: 0 },
          });
          await gateway.emitGatewayEvent("session.message", {
            sessionKey,
            sessionId,
            hasActiveRun: true,
            messageId: pendingInput.id,
            messageSeq: 1,
            message: canonical,
          });
          await page.locator('.chat-bubble[data-entry-id="accepted-image-input"]').waitFor();
          await expect.poll(() => metadataRequested).toBe(true);
          await expectImageStillVisible("03-canonical-metadata-loading");
          releaseMetadata();
          await expect.poll(() => imageRequested).toBe(true);
          await expectImageStillVisible("04-canonical-image-loading");
          releaseImage();
          await expect.poll(() => userImage.getAttribute("src")).toContain("stable-image-ticket");
          await expect
            .poll(() =>
              userImage.evaluate((image) =>
                image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
              ),
            )
            .toBe(180);
          await expectImageStillVisible("05-canonical-image-ready");
          const frames = await continuity.evaluate((sampler) => sampler.stop());
          await continuity.dispose();
          expect(frames.length).toBeGreaterThan(1);
          expect(frames.every(Boolean)).toBe(true);
        } finally {
          releaseMetadata();
          releaseImage();
          await capture("06-final");
        }
      },
    );
  });
});
