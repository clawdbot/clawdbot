import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import {
  buildLocalWebchatAudioMessage,
  captureUiProofEnabled,
  copiedViaExec,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
  installPlainHttpClipboardCapture,
  managedImageCacheProofDir,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("exposes an assistant document download with its Unicode filename and ticketed URL", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const source = "/tmp/openclaw/测试 report.pdf";
    const mediaUrl = `/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&mediaTicket=ticket-download`;
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Your report is ready." },
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: "测试 report.pdf",
                mimeType: "application/pdf",
                url: mediaUrl,
              },
            },
          ],
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const card = page
        .locator(".chat-assistant-attachment-card--compact")
        .filter({ hasText: "测试 report.pdf" });
      const link = card.locator(".chat-assistant-attachment-card__download");
      await link.waitFor({ state: "visible", timeout: 10_000 });
      expect(await link.getAttribute("href")).toBe(mediaUrl);
      await card.hover();
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
      await download.path();

      expect(download.suggestedFilename()).toBe("测试 report.pdf");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([
    {
      kind: "audio",
      source: "/home/node/.openclaw/media/outbound/bootstrap-voice.mp3",
      ticket: "ticket-bootstrap-audio",
    },
    {
      kind: "image",
      source: "/home/node/.openclaw/media/outbound/bootstrap-image.png",
      ticket: "ticket-bootstrap-image",
    },
    {
      kind: "image",
      source: "FILE:///home/node/.openclaw/media/outbound/bootstrap-uppercase-image.png",
      ticket: "ticket-bootstrap-uppercase-image",
    },
    {
      kind: "image",
      source: "file:/home/node/.openclaw/media/outbound/bootstrap-authorityless-image.png",
      ticket: "ticket-bootstrap-authorityless-image",
    },
    {
      kind: "audio",
      source: `FILE:${path.join(managedImageCacheProofDir, "bootstrap-structured-audio.mp3")}`,
      ticket: "ticket-bootstrap-structured-audio",
      structured: true,
    },
  ] as const)(
    "renders local assistant $kind through server metadata before preview roots load",
    async ({ kind, source, ticket, ...options }) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const requestedMediaUrls: URL[] = [];
      const expectedSource = "structured" in options ? new URL(source).pathname : source;

      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requestedMediaUrls.push(url);
        expect(url.searchParams.get("source")).toBe(expectedSource);
        if (url.searchParams.get("meta") === "1") {
          expect(request.headers().authorization).toBe("Bearer e2e-device-token");
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              available: true,
              mediaTicket: ticket,
              mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            }),
          });
          return;
        }

        expect(url.searchParams.get("mediaTicket")).toBe(ticket);
        expect(request.headers().authorization).toBeUndefined();
        await route.fulfill(
          kind === "image"
            ? {
                contentType: "image/png",
                body: await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png")),
              }
            : {
                contentType: "audio/mpeg",
                body: createPlaybackMediaFixture("mp3"),
              },
        );
      });

      await installMockGateway(page, {
        historyMessages: [
          kind === "image"
            ? {
                id: "assistant-bootstrap-local-image",
                role: "assistant",
                content: [{ type: "image", url: source, alt: "Local bootstrap image" }],
                timestamp: Date.now(),
              }
            : {
                id: "assistant-bootstrap-local-audio",
                role: "assistant",
                content:
                  "structured" in options
                    ? (await buildLocalWebchatAudioMessage(source)).content
                    : [{ type: "text", text: `Your recording\nMEDIA:${source}` }],
                timestamp: Date.now(),
              },
        ],
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const media =
          kind === "image"
            ? page.getByAltText("Local bootstrap image")
            : page.locator("openclaw-chat-audio-player");
        await media.waitFor({
          state: "visible",
          timeout: 10_000,
        });
        await expect
          .poll(() => requestedMediaUrls.length, { timeout: 10_000 })
          .toBeGreaterThanOrEqual(2);
        expect(requestedMediaUrls[0]?.searchParams.get("meta")).toBe("1");
        expect(
          requestedMediaUrls.slice(1).some((url) => url.searchParams.get("mediaTicket") === ticket),
        ).toBe(true);
        if (kind === "audio") {
          expect(
            await media.locator(".chat-assistant-attachment-card__download").getAttribute("href"),
          ).toContain(`mediaTicket=${ticket}`);
          await expect
            .poll(() =>
              media
                .locator("audio")
                .evaluate((element) => (element as HTMLMediaElement).readyState),
            )
            .toBeGreaterThanOrEqual(1);
        }
        expect(await page.getByText("Outside allowed folders").count()).toBe(0);

        if (kind === "image") {
          await expect
            .poll(() =>
              media.evaluate((element) =>
                element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
              ),
            )
            .toBe(180);
        }

        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            fullPage: true,
            path: path.join(artifactDir, `bootstrap-local-${kind}-${ticket}.png`),
          });
        }
        if (process.env.OPENCLAW_BEHAVIOR_PROOF === "1") {
          process.stdout.write(
            `${JSON.stringify({
              proof: "control-ui-local-media-bootstrap",
              kind,
              source,
              metadataAuthenticated: true,
              ticketScoped: true,
              rawRequestHasBearer: false,
              requests: requestedMediaUrls.map((url) => ({
                source: url.searchParams.get("source"),
                meta: url.searchParams.get("meta"),
                mediaTicket: url.searchParams.get("mediaTicket"),
              })),
            })}\n`,
          );
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each([
    {
      code: "outside-allowed-folders",
      reason: "Outside allowed folders",
      source: "/home/node/private/bootstrap-secret.mp3",
    },
    {
      code: "file-not-found",
      reason: "File not found",
      source: "/home/node/.openclaw/media/outbound/bootstrap-missing.mp3",
    },
  ] as const)(
    "keeps server-rejected $code media blocked before preview roots load",
    async ({ code, reason, source }) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const requestedMediaUrls: URL[] = [];

      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requestedMediaUrls.push(url);
        expect(url.searchParams.get("source")).toBe(source);
        expect(url.searchParams.get("meta")).toBe("1");
        expect(request.headers().authorization).toBe("Bearer e2e-device-token");
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ available: false, code, reason }),
        });
      });

      await installMockGateway(page, {
        historyMessages: [
          {
            id: `assistant-bootstrap-blocked-${code}`,
            role: "assistant",
            content: [{ type: "text", text: `Unavailable recording\nMEDIA:${source}` }],
            timestamp: Date.now(),
          },
        ],
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const status = page.locator(".chat-assistant-attachment-card__status-meta");
        await status.waitFor({ state: "visible", timeout: 10_000 });
        await expect.poll(() => status.textContent()).toContain(reason);
        expect(requestedMediaUrls).toHaveLength(1);
        expect(await page.locator(".chat-assistant-attachment-card audio").count()).toBe(0);
        expect(await page.locator(".chat-assistant-attachment-card__download").count()).toBe(0);

        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            fullPage: true,
            path: path.join(artifactDir, `bootstrap-blocked-${code}.png`),
          });
        }
        if (process.env.OPENCLAW_BEHAVIOR_PROOF === "1") {
          process.stdout.write(
            `${JSON.stringify({
              proof: "control-ui-local-media-bootstrap",
              code,
              source,
              metadataAuthenticated: true,
              rawMediaRequested: false,
              visibleReason: reason,
            })}\n`,
          );
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("renders a direct tool-result image from Gateway history", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const imageData =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X3q8AAAAAElFTkSuQmCC";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [
            { alt: "Tool result preview", data: imageData, mimeType: "image/png", type: "image" },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const image = page.getByAltText("Tool result preview");
      await image.waitFor({ state: "visible", timeout: 10_000 });
      expect(await image.getAttribute("src")).toBe(`data:image/png;base64,${imageData}`);
      await gateway.waitForRequest("chat.startup");
      await expect
        .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
        .toBe(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("renders a managed image through an artifact-scoped ticket", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const attachmentId = crypto.randomUUID();
    const artifactId = `artifact_managed_image_${attachmentId}`;
    const imageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const ticketedUrl = `${imageUrl}?mediaTicket=ticket-e2e`;
    await page.route("**/api/chat/media/outgoing/**", async (route) => {
      const request = route.request();
      expect(new URL(request.url()).searchParams.get("mediaTicket")).toBe("ticket-e2e");
      expect(request.headers().authorization).toBeUndefined();
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    });
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "image",
              artifactId,
              url: imageUrl,
              alt: "Ticketed generated image",
              mimeType: "image/png",
              width: 1,
              height: 1,
            },
          ],
          timestamp: Date.now(),
        },
      ],
      methodResponses: {
        "artifacts.download": {
          artifact: {
            id: artifactId,
            type: "image",
            title: "Ticketed generated image",
            mimeType: "image/png",
            download: { mode: "url" },
          },
          url: ticketedUrl,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const image = page.getByAltText("Ticketed generated image");
      await image.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() =>
          image.evaluate((element) =>
            element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
          ),
        )
        .toBe(1);
      const request = await gateway.waitForRequest("artifacts.download");
      expect(request.params).toMatchObject({
        sessionKey: "agent:main:main",
        artifactId,
      });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([
    {
      name: "canonical inbound",
      source: "media://inbound/telegram-photo.png",
      workspaceDir: undefined,
      screenshotName: "canonical-inbound-image",
    },
    {
      name: "sandbox-staged inbound",
      source: "/workspace/media/inbound/fabricated-sandbox.png",
      workspaceDir: "/workspace",
      screenshotName: "sandbox-inbound-image",
    },
  ] as const)(
    "renders a $name image through the ticketed media route",
    async ({ source, workspaceDir, screenshotName }) => {
      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const requestedMediaUrls: URL[] = [];
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requestedMediaUrls.push(url);
        expect(url.searchParams.get("source")).toBe(source);
        if (url.searchParams.get("meta") === "1") {
          expect(request.headers().authorization).toBe("Bearer e2e-device-token");
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              available: true,
              mediaTicket: "ticket-inbound",
              mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            }),
          });
          return;
        }
        expect(url.searchParams.get("mediaTicket")).toBe("ticket-inbound");
        expect(request.headers().authorization).toBeUndefined();
        await route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
            "base64",
          ),
        });
      });
      await installMockGateway(page, {
        historyMessages: [
          {
            id: "user-inbound-media-ref",
            role: "user",
            content: [{ type: "text", text: "🖼️ Attached image" }],
            __openclaw: {
              media: [
                {
                  path: source,
                  contentType: "image/png",
                  ...(workspaceDir ? { workspaceDir } : {}),
                },
              ],
            },
            timestamp: Date.now(),
          },
        ],
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await expect.poll(() => requestedMediaUrls.length, { timeout: 10_000 }).toBe(2);
        const image = page.locator("img.chat-message-image");
        await image.waitFor({ state: "visible", timeout: 10_000 });
        await expect
          .poll(() =>
            image.evaluate((element) =>
              element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
            ),
          )
          .toBe(1);
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            fullPage: true,
            path: `${artifactDir}/${screenshotName}.png`,
          });
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("evicts and refetches managed image Blob URLs after the cache reaches capacity", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const originalCreateObjectURL = URL.createObjectURL.bind(URL);
      const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
      const proof = { created: [] as string[], revoked: [] as string[] };
      Object.defineProperty(globalThis, "managedImageCacheProof", {
        configurable: true,
        value: proof,
      });
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: (blob: Blob) => {
          const blobUrl = originalCreateObjectURL(blob);
          proof.created.push(blobUrl);
          return blobUrl;
        },
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: (blobUrl: string) => {
          proof.revoked.push(blobUrl);
          originalRevokeObjectURL(blobUrl);
        },
      });
    });

    const imageUrls = Array.from({ length: 65 }, (_, index) => {
      const id = String(index + 1).padStart(12, "0");
      return `/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-${id}/full`;
    });
    const managedImageBody = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      "base64",
    );
    const fetchedMedia: Array<{
      authorization: string | undefined;
      pathname: string;
      requesterSessionKey: string | undefined;
    }> = [];
    await page.route("**/api/chat/media/outgoing/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      fetchedMedia.push({
        authorization: request.headers().authorization,
        pathname: url.pathname,
        requesterSessionKey: request.headers()["x-openclaw-requester-session-key"],
      });
      await route.fulfill({
        body: managedImageBody,
        contentType: "image/png",
      });
    });

    const historyFor = (indexes: number[], labelPrefix: string) => [
      {
        content: indexes.map((index) => ({
          alt: `${labelPrefix} ${index + 1}`,
          type: "image",
          url: imageUrls[index],
        })),
        role: "assistant",
        timestamp: Date.now(),
      },
    ];
    const gateway = await installMockGateway(page, {
      historyMessages: historyFor(
        Array.from({ length: 64 }, (_, index) => index),
        "Initial managed image",
      ),
    });
    const readBlobProof = () =>
      page.evaluate(() => {
        const proof = (
          globalThis as typeof globalThis & {
            managedImageCacheProof: { created: string[]; revoked: string[] };
          }
        ).managedImageCacheProof;
        return { created: [...proof.created], revoked: [...proof.revoked] };
      });
    let proofMessageSequence = 100;
    const replaceHistory = async (messages: unknown[], visibleAlt: string) => {
      const historyRequestsBefore = (await gateway.getRequests("chat.history")).length;
      await gateway.setHistoryMessages(messages);
      proofMessageSequence += 1;
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        hasActiveRun: false,
        message: messages[0],
        messageId: `managed-image-cache-proof-${proofMessageSequence}`,
        messageSeq: proofMessageSequence,
        session: {
          activeRunIds: [],
          hasActiveRun: false,
          key: "main",
          kind: "direct",
          status: "done",
          updatedAt: Date.now(),
        },
        sessionKey: "main",
      });
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).length, {
          timeout: 15_000,
        })
        .toBeGreaterThan(historyRequestsBefore);
      await page.getByAltText(visibleAlt).waitFor({ state: "visible", timeout: 10_000 });
    };

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await expect.poll(async () => (await readBlobProof()).created.length).toBe(64);
      await expect
        .poll(() =>
          page
            .locator("img.chat-message-image")
            .evaluateAll(
              (images) =>
                images.filter(
                  (image) =>
                    image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1,
                ).length,
            ),
        )
        .toBe(64);
      const initialBlobUrls = await page
        .locator("img.chat-message-image")
        .evaluateAll((images) => images.map((image) => image.getAttribute("src")));
      const retainedRecentBlobUrl = expectDefined(
        initialBlobUrls[0],
        "recent managed image Blob URL",
      );

      await replaceHistory(
        historyFor([0], "Recently viewed managed image"),
        "Recently viewed managed image 1",
      );
      expect((await readBlobProof()).created).toHaveLength(64);

      await replaceHistory(historyFor([64], "Overflow managed image"), "Overflow managed image 65");
      await expect.poll(async () => (await readBlobProof()).created.length).toBe(65);
      const overflowProof = await readBlobProof();
      // Concurrent image fetches can resolve in any order. Find the real LRU
      // rather than assuming that creation order matches transcript order.
      expect(overflowProof.revoked).toHaveLength(1);
      const evictedBlobUrl = expectDefined(
        overflowProof.revoked.find((blobUrl) => blobUrl !== retainedRecentBlobUrl),
        "evicted managed image Blob URL",
      );
      expect(overflowProof.created).toContain(evictedBlobUrl);
      const evictedImageIndex = initialBlobUrls.indexOf(evictedBlobUrl);
      expect(evictedImageIndex).toBeGreaterThanOrEqual(0);
      expect(overflowProof.revoked).not.toContain(retainedRecentBlobUrl);

      const evictedUrl = new URL(
        expectDefined(imageUrls[evictedImageIndex], "evicted managed image URL"),
        suite.server.baseUrl,
      );
      const evictedPath = evictedUrl.pathname.replace(/\/full$/u, "/thumbnail");
      const fetchesBeforeRevisit = fetchedMedia.filter(
        (request) => request.pathname === evictedPath,
      ).length;
      const revisitedImageAlt = `Refetched managed image ${evictedImageIndex + 1}`;
      await replaceHistory(
        historyFor([evictedImageIndex], "Refetched managed image"),
        revisitedImageAlt,
      );
      const revisitedImage = page.getByAltText(revisitedImageAlt);
      await expect
        .poll(() =>
          revisitedImage.evaluate((image) =>
            image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
          ),
        )
        .toBe(1);
      await expect.poll(async () => (await readBlobProof()).created.length).toBe(66);
      const finalProof = await readBlobProof();
      const evictedImageFetches = fetchedMedia.filter(
        (request) => request.pathname === evictedPath,
      ).length;
      expect(evictedImageFetches).toBe(fetchesBeforeRevisit + 1);
      expect(fetchedMedia).not.toHaveLength(0);
      expect(
        fetchedMedia.every((request) => request.authorization === "Bearer e2e-device-token"),
      ).toBe(true);
      expect(
        fetchedMedia.every((request) => request.requesterSessionKey === "agent:main:main"),
      ).toBe(true);

      const proofSummary = {
        cacheCapacity: 64,
        createdBlobUrls: finalProof.created.length,
        evictedBlobIndex: evictedImageIndex,
        evictedImageFetches,
        refetchedImageNaturalWidth: await revisitedImage.evaluate(
          (image) => (image as HTMLImageElement).naturalWidth,
        ),
        retainedRecentBlobRevoked: finalProof.revoked.includes(retainedRecentBlobUrl),
        revokedBlobUrls: finalProof.revoked.length,
      };
      if (captureUiProofEnabled) {
        await mkdir(managedImageCacheProofDir, { recursive: true });
        await page.evaluate((summary) => {
          const panel = document.createElement("pre");
          panel.setAttribute("data-managed-image-cache-proof", "true");
          panel.style.cssText =
            "position:fixed;right:16px;bottom:16px;z-index:99999;max-width:460px;padding:16px;border:2px solid #5eead4;border-radius:10px;background:#0f172a;color:#ccfbf1;font:14px/1.45 monospace;white-space:pre-wrap";
          panel.textContent = `Managed image cache browser proof\n${JSON.stringify(summary, null, 2)}`;
          document.body.append(panel);
        }, proofSummary);
        await page.screenshot({
          fullPage: true,
          path: path.join(managedImageCacheProofDir, "after-refetch.png"),
        });
        await writeFile(
          path.join(managedImageCacheProofDir, "after-refetch.json"),
          `${JSON.stringify(proofSummary, null, 2)}\n`,
          "utf8",
        );
      }
      if (process.env.OPENCLAW_BEHAVIOR_PROOF === "1") {
        process.stdout.write(
          `${JSON.stringify({ proof: "managed-image-cache", ...proofSummary })}\n`,
        );
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("copies a code block over a non-secure context via the execCommand fallback", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    // Simulate a plain-HTTP deployment where navigator.clipboard is unavailable.
    await installPlainHttpClipboardCapture(page);
    const code = "const hello = 1;";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [
            {
              text: `${"long response line\n\n".repeat(80)}\`\`\`js\n${code}\n\`\`\``,
              type: "text",
            },
          ],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const copyButton = page.locator(".code-block-copy").first();
      await copyButton.waitFor({ timeout: 10_000 });
      await waitForChatScrollIdle(page);
      await copyButton.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const thread = page.locator(".chat-thread");
      const scrollTopBefore = await thread.evaluate((element) =>
        Math.round((element as HTMLElement).scrollTop),
      );
      // The copied class clears after 1500ms, so click and read it in one browser step.
      const copied = await copyButton.evaluate(async (element) => {
        const button = element as HTMLButtonElement;
        const owner = element.closest("openclaw-chat-pane") as
          | (HTMLElement & {
              updateComplete: Promise<unknown>;
            })
          | null;
        if (!owner) {
          throw new Error("Chat pane owner is unavailable");
        }
        let copyObserver: MutationObserver | undefined;
        const copySettled = new Promise<void>((resolve) => {
          copyObserver = new MutationObserver(() => {
            if (button.classList.contains("copied")) {
              copyObserver?.disconnect();
              resolve();
            }
          });
          copyObserver.observe(button, { attributeFilter: ["class"], attributes: true });
        });
        button.click();
        await owner.updateComplete;
        if (!button.classList.contains("copied")) {
          await copySettled;
        }
        copyObserver?.disconnect();
        return button.classList.contains("copied");
      });
      expect(copied).toBe(true);
      expect(await copiedViaExec(page)).toContain(code);
      await expect
        .poll(() => thread.evaluate((element) => Math.round((element as HTMLElement).scrollTop)))
        .toBe(scrollTopBefore);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("copies a workspace file path over a non-secure context via the execCommand fallback", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installPlainHttpClipboardCapture(page);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "artifacts.list": { artifacts: [] },
        "sessions.files.list": {
          browser: { entries: [], path: "" },
          files: [
            {
              kind: "modified",
              missing: false,
              name: "AGENTS.md",
              path: "/workspace/AGENTS.md",
              size: 2048,
            },
          ],
          root: "/workspace",
          sessionKey: "main",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await openChatSidePanelType(page, "Files");
      await page.locator(".chat-workspace-rail__file-name", { hasText: "AGENTS.md" }).waitFor({
        timeout: 10_000,
      });

      await page.getByRole("button", { name: "Copy path" }).click();

      expect(await copiedViaExec(page)).toContain("/workspace/AGENTS.md");
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
