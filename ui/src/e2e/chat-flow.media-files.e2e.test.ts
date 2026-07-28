import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  copiedViaExec,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
  installPlainHttpClipboardCapture,
  managedImageCacheProofDir,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("downloads an assistant document with the server-provided Unicode filename", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const source = "/tmp/openclaw/测试 report.pdf";
    const mediaUrl = `/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&mediaTicket=ticket-download`;
    const requestedUrls: URL[] = [];
    // The document opens in a new tab, so intercept at the context boundary.
    await context.route("**/__openclaw__/assistant-media?**", async (route) => {
      const url = new URL(route.request().url());
      requestedUrls.push(url);
      await route.fulfill({
        body: "%PDF-1.4\n",
        contentType: "application/pdf",
        headers: {
          "Content-Disposition": `attachment; filename="__ report.pdf"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20report.pdf`,
        },
      });
    });
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
      const link = page.getByRole("link", { name: "测试 report.pdf" });
      await link.waitFor({ state: "visible", timeout: 10_000 });
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);

      expect(download.suggestedFilename()).toBe("测试 report.pdf");
      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]?.searchParams.get("source")).toBe(source);
      expect(requestedUrls[0]?.searchParams.get("mediaTicket")).toBe("ticket-download");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

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

  it("renders a canonical inbound image through the ticketed media route", async () => {
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
      expect(url.searchParams.get("source")).toBe("media://inbound/telegram-photo.png");
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
            media: [{ path: "media://inbound/telegram-photo.png", contentType: "image/png" }],
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
          path: `${artifactDir}/canonical-inbound-image.png`,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

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
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" rx="12" fill="#0f766e"/><text x="80" y="50" text-anchor="middle" fill="white" font-family="sans-serif" font-size="14">managed preview</text></svg>',
        contentType: "image/svg+xml",
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
                    image instanceof HTMLImageElement &&
                    image.complete &&
                    image.naturalWidth === 160,
                ).length,
            ),
        )
        .toBe(64);

      await replaceHistory(
        historyFor([0], "Recently viewed managed image"),
        "Recently viewed managed image 1",
      );
      expect((await readBlobProof()).created).toHaveLength(64);

      await replaceHistory(historyFor([64], "Overflow managed image"), "Overflow managed image 65");
      await expect.poll(async () => (await readBlobProof()).created.length).toBe(65);
      const overflowProof = await readBlobProof();
      const retainedRecentBlobUrl = expectDefined(
        overflowProof.created[0],
        "recent managed image Blob URL",
      );
      const evictedBlobUrl = expectDefined(
        overflowProof.created[1],
        "evicted managed image Blob URL",
      );
      expect(overflowProof.revoked).toContain(evictedBlobUrl);
      expect(overflowProof.revoked).not.toContain(retainedRecentBlobUrl);

      const evictedPath = new URL(
        expectDefined(imageUrls[1], "evicted managed image URL"),
        suite.server.baseUrl,
      ).pathname;
      const fetchesBeforeRevisit = fetchedMedia.filter(
        (request) => request.pathname === evictedPath,
      ).length;
      await replaceHistory(historyFor([1], "Refetched managed image"), "Refetched managed image 2");
      const revisitedImage = page.getByAltText("Refetched managed image 2");
      await expect
        .poll(() =>
          revisitedImage.evaluate((image) =>
            image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
          ),
        )
        .toBe(160);
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
        evictedBlobIndex: 1,
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
      await page.locator(".chat-workspace-toggle").click();
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

  it("starts the workspace files panel collapsed and toggles it open", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "artifacts.list": {
          artifacts: [
            {
              download: { mode: "bytes" },
              id: "artifact-1",
              mimeType: "image/png",
              sizeBytes: 128,
              title: "preview.png",
              type: "image",
            },
          ],
        },
        "sessions.files.list": {
          browser: {
            entries: [
              {
                kind: "directory",
                name: "src",
                path: "src",
                sessionKind: "modified",
              },
              {
                kind: "file",
                name: "package.json",
                path: "package.json",
                size: 4096,
              },
            ],
            path: "",
          },
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
      // Collapsed rails render nothing; the title-bar toggle carries the
      // changed-file badge.
      const opener = page.locator(".chat-workspace-toggle");
      await opener.waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
      expect(await page.locator(".chat-workspace-rail").count()).toBe(0);

      await opener.click();
      await page.locator(".chat-workspace-rail__collapse-toggle").waitFor({ timeout: 10_000 });
      await expect.poll(() => opener.getAttribute("aria-expanded")).toBe("true");
      await page.locator(".chat-workspace-rail__file-name", { hasText: "AGENTS.md" }).waitFor({
        timeout: 10_000,
      });
      await page
        .locator(".chat-workspace-rail__file-name", { hasText: "preview.png" })
        .waitFor({ timeout: 10_000 });
      await page.getByText("Project files").waitFor({ timeout: 10_000 });
      await page.locator(".chat-workspace-rail__file-name", { hasText: "package.json" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);
      expect(await gateway.getRequests("artifacts.list")).toHaveLength(1);
      // The rail docks flush to the window edge (no content gutter).
      expect(
        await page.locator(".chat-workspace-rail").evaluate((element) => {
          return window.innerWidth - element.getBoundingClientRect().right;
        }),
      ).toBe(0);

      await page.locator(".chat-workspace-rail__collapse-toggle").click();
      await opener.waitFor({ timeout: 10_000 });
      expect(await page.locator(".chat-workspace-rail").count()).toBe(0);

      await opener.click();
      await page.locator(".chat-workspace-rail__collapse-toggle").waitFor({ timeout: 10_000 });
      await page.locator(".chat-workspace-rail__file-name", { hasText: "AGENTS.md" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);

      await page.setViewportSize({ height: 900, width: 760 });
      const workbench = page.locator(".chat-workbench");
      await expect
        .poll(() => workbench.getAttribute("class"))
        .toContain("chat-workbench--dock-bottom");
      const workspaceRail = page.locator(".chat-workspace-rail");
      await expect
        .poll(async () => {
          const box = await workspaceRail.boundingBox();
          return Boolean(box && box.width > 0 && box.height > 0);
        })
        .toBe(true);
      expect(await page.locator(".chat-workspace-rail__dock").count()).toBe(0);
      expect(await page.locator(".chat-workspace-rail__grip").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps long workspace file sections scrollable inside the rail", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    const browserEntries = Array.from({ length: 60 }, (_, index) => ({
      kind: "file" as const,
      name: `file-${String(index + 1).padStart(2, "0")}.ts`,
      path: `src/file-${String(index + 1).padStart(2, "0")}.ts`,
      size: 2048 + index,
    }));
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.files.list": {
          browser: {
            entries: browserEntries,
            path: "",
          },
          files: [],
          root: "/workspace",
          sessionKey: "main",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".chat-workspace-toggle").click();
      await page.locator(".chat-workspace-rail__file-name", { hasText: "file-60.ts" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);

      const browserSection = page.locator(".chat-workspace-rail__section", {
        hasText: "Project files",
      });
      await expect
        .poll(
          () =>
            browserSection.evaluate((section) => {
              const element = section as HTMLElement;
              const scroll = element.closest(".chat-workspace-rail__scroll") as HTMLElement | null;
              if (!scroll) {
                throw new Error("Expected workspace rail scroll container");
              }
              const sectionRect = element.getBoundingClientRect();
              const scrollRect = scroll.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                bottomWithinRail: Math.ceil(sectionRect.bottom) <= Math.ceil(scrollRect.bottom),
                clientHeight: element.clientHeight,
                overflowY: style.overflowY,
                scrollHeight: element.scrollHeight,
              };
            }),
          { timeout: 10_000 },
        )
        .toMatchObject({
          bottomWithinRail: true,
          overflowY: "auto",
        });
      const sectionMetrics = await browserSection.evaluate((section) => {
        const element = section as HTMLElement;
        return {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
        };
      });
      expect(sectionMetrics.scrollHeight).toBeGreaterThan(sectionMetrics.clientHeight);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
