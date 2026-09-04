import { Buffer } from "node:buffer";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import {
  ONE_PIXEL_PNG_B64,
  SESSION_LIST_DEFAULTS,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  expectDecodedThumbnail,
  installMockGateway,
  navigateInApp,
  pastePng,
  pollLocatorText,
  waitForCommittedChatRoute,
  waitForCommittedNewSessionDraft,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

async function withNewSessionPage(run: (page: Page) => Promise<void>): Promise<void> {
  const context = await suite.browser.newContext({
    locale: "en-US",
    ...(captureUiProofEnabled
      ? { recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1280 } } }
      : {}),
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

suite.define(() => {
  it("restores a prompt and image in a fresh page, then clears them after creation", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
      ? suite.artifactDir
      : undefined;
    const context = await suite.browser.newContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    try {
      const firstPage = await context.newPage();
      await installMockGateway(firstPage);
      await firstPage.goto(`${suite.server.baseUrl}new`);
      const firstMessage = firstPage.locator(".new-session-page__message");
      await firstMessage.fill("restore this prompt after restart");
      await pastePng(firstMessage);
      await firstPage.locator('.chat-attachment-thumb img[alt="pixel.png"]').waitFor();
      const incognito = firstPage.getByRole("switch", { name: "Incognito" });
      await incognito.click();
      await expect.poll(() => incognito.getAttribute("aria-checked")).toBe("true");
      await waitForCommittedNewSessionDraft(firstPage, null, 0);
      await incognito.click();
      await expect.poll(() => incognito.getAttribute("aria-checked")).toBe("false");
      await firstMessage.fill("restore this prompt after restart and incognito");
      await expect.poll(() => firstPage.locator(".chat-attachment-thumb").count()).toBe(1);
      await waitForCommittedNewSessionDraft(
        firstPage,
        "restore this prompt after restart and incognito",
        1,
      );
      await firstPage.reload();
      await expect
        .poll(() => firstMessage.inputValue())
        .toBe("restore this prompt after restart and incognito");
      await expect.poll(() => firstPage.locator(".chat-attachment-thumb").count()).toBe(1);
      await firstPage.close();

      const restoredPage = await context.newPage();
      const restoredGateway = await installMockGateway(restoredPage, {
        methodResponses: {
          "sessions.create": { key: "agent:main:restart-draft", runStarted: true },
        },
      });
      await restoredPage.goto(`${suite.server.baseUrl}new`);
      const restoredMessage = restoredPage.locator(".new-session-page__message");
      await expect
        .poll(() => restoredMessage.inputValue())
        .toBe("restore this prompt after restart and incognito");
      await expect.poll(() => restoredPage.locator(".chat-attachment-thumb").count()).toBe(1);
      await captureUiProof(suite, restoredPage, "new-session-restart-draft-restored.png");
      if (artifactDir) {
        await restoredPage.screenshot({
          path: path.join(artifactDir, "new-session-restart-draft-restored.png"),
        });
      }
      await restoredPage.getByRole("button", { name: "Start session" }).click();

      const create = await restoredGateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: "restore this prompt after restart and incognito",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: ONE_PIXEL_PNG_B64,
          },
        ],
      });
      await restoredPage.waitForURL(
        (url) => url.pathname === controlUiSessionPath("agent:main:restart-draft"),
      );
      await restoredPage.close();

      const clearedPage = await context.newPage();
      await installMockGateway(clearedPage);
      await clearedPage.goto(`${suite.server.baseUrl}new`);
      await expect
        .poll(() => clearedPage.locator(".new-session-page__message").inputValue())
        .toBe("");
      await expect.poll(() => clearedPage.locator(".chat-attachment-thumb").count()).toBe(0);
      await captureUiProof(suite, clearedPage, "new-session-restart-draft-cleared.png");
      if (artifactDir) {
        await clearedPage.screenshot({
          path: path.join(artifactDir, "new-session-restart-draft-cleared.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it("grows the first prompt downward without moving the identity, then caps at ten lines", async () => {
    await withNewSessionPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.waitFor();

      const identity = page.locator(
        ".agent-chat__welcome-clawd, .agent-chat__welcome-avatar, .agent-chat__avatar--text",
      );
      const triggers = page.locator(".new-session-page__triggers");
      const composer = page.locator(".new-session-page__composer");
      const [identityBox, triggersBox, composerBox] = await Promise.all([
        identity.boundingBox(),
        triggers.boundingBox(),
        composer.boundingBox(),
      ]);
      expect(identityBox).not.toBeNull();
      expect(triggersBox).not.toBeNull();
      expect(composerBox).not.toBeNull();

      const initial = await message.evaluate((element) => ({
        height: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));
      await message.fill(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
      const tenLines = await message.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          height: element.clientHeight,
          lineHeight: Number.parseFloat(style.lineHeight),
          overflowY: style.overflowY,
          padding: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
          scrollbarWidth: style.scrollbarWidth,
          webkitScrollbarWidth: getComputedStyle(element, "::-webkit-scrollbar").width,
          webkitThumbInset: getComputedStyle(element, "::-webkit-scrollbar-thumb").borderLeftWidth,
        };
      });

      expect(tenLines.height).toBeGreaterThan(initial.height);
      expect(tenLines.height).toBeGreaterThanOrEqual(
        Math.floor(tenLines.lineHeight * 10 + tenLines.padding) - 1,
      );
      expect(tenLines.overflowY).toBe("hidden");
      expect(tenLines.scrollbarWidth).toBe("thin");
      // The composer used to buy thinness by shrinking its hit target to 6px.
      // The canonical profile keeps the full 12px drag target and paints a 6px
      // thumb inside it (transparent border + content-box clip), so this asserts
      // the visible thumb stays as thin as before without a cramped grab area.
      const composerScrollbar = Number.parseFloat(tenLines.webkitScrollbarWidth);
      const composerThumbInset = Number.parseFloat(tenLines.webkitThumbInset);
      expect(composerScrollbar).toBe(12);
      expect(composerScrollbar - composerThumbInset * 2).toBe(6);
      await captureUiProof(suite, page, "new-session-composer-ten-lines.png");

      const longPrompt = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n");
      await message.fill(longPrompt);
      const capped = await message.evaluate((element) => ({
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
      }));
      const [expandedIdentityBox, expandedTriggersBox, expandedComposerBox] = await Promise.all([
        identity.boundingBox(),
        triggers.boundingBox(),
        composer.boundingBox(),
      ]);
      expect(capped.clientHeight).toBeLessThan(capped.scrollHeight);
      expect(capped.overflowY).toBe("auto");
      // Browser subpixel rounding may shift stable blocks by a pixel; larger movement is visible.
      for (const [before, after] of [
        [identityBox, expandedIdentityBox],
        [triggersBox, expandedTriggersBox],
        [composerBox, expandedComposerBox],
      ]) {
        expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2);
      }
      await captureUiProof(suite, page, "new-session-composer-capped-scrollbar.png");
      const start = page.getByRole("button", { name: "Start session" });
      await expect(start.isVisible()).resolves.toBe(true);
      await expect(start.isEnabled()).resolves.toBe(true);
      await start.focus();
      await expect(start.evaluate((element) => document.activeElement === element)).resolves.toBe(
        true,
      );
      await start.press("Enter");
      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { message: longPrompt },
      });
    });
  });

  it("pastes an image into the draft and forwards it with the initial turn", async () => {
    await withNewSessionPage(async (page) => {
      await page.setViewportSize({ width: 393, height: 852 });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.create": { key: "agent:main:image-draft", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.waitFor();
      await pastePng(message);

      await page.getByRole("img", { name: "pixel.png" }).waitFor();
      await captureUiProof(suite, page, "mobile-composer-new-session-attachment.png");
      await page.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: ONE_PIXEL_PNG_B64,
          },
        ],
      });
    });
  });

  it("enlarges and removes a picked image without object URL support", async () => {
    await withNewSessionPage(async (page) => {
      await page.addInitScript(() => {
        Object.defineProperty(URL, "createObjectURL", { configurable: true, value: undefined });
      });
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new`);

      await page
        .locator(".agent-chat__photo-input")
        .setInputFiles(path.join(process.cwd(), "ui/public/favicon-32.png"));

      const attachment = page.locator(".chat-attachment-thumb");
      const preview = attachment.getByRole("img", { name: "favicon-32.png" });
      const previewButton = page.getByRole("button", { name: "Open image favicon-32.png" });
      await preview.waitFor({ state: "visible" });
      await expect.poll(() => preview.getAttribute("src")).toMatch(/^data:image\/png;base64,/u);
      await captureUiProof(suite, page, "new-session-picked-image-preview.png");
      await previewButton.click();
      const lightbox = page.locator("openclaw-image-lightbox");
      const dialog = page.getByRole("dialog", { name: "Image preview: favicon-32.png" });
      await dialog.waitFor({ state: "visible" });
      await expect(lightbox.getAttribute("title")).resolves.toBeNull();
      await page.getByAltText("favicon-32.png").last().waitFor({ state: "visible" });
      await captureUiProof(suite, page, "new-session-picked-image-lightbox.png");
      await page.keyboard.press("Escape");
      await lightbox.waitFor({ state: "detached" });
      await previewButton.press("Enter");
      await dialog.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Remove attachment" }).click();
      await expect.poll(() => attachment.count()).toBe(0);
      await captureUiProof(suite, page, "new-session-picked-image-removed.png");
    });
  });

  it("keeps blob-backed SVG previews out of original-document navigation", async () => {
    await withNewSessionPage(async (page) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new`);

      await page.locator(".agent-chat__photo-input").setInputFiles({
        name: "untrusted.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          "<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>",
        ),
      });

      const previewButton = page.getByRole("button", { name: "Open image untrusted.svg" });
      await expect.poll(() => previewButton.locator("img").getAttribute("src")).toMatch(/^blob:/u);
      await previewButton.click();
      await page.getByRole("dialog", { name: "Image preview: untrusted.svg" }).waitFor();
      await expect(page.getByRole("link", { name: "Open in new tab" }).count()).resolves.toBe(0);
      await captureUiProof(suite, page, "new-session-svg-lightbox.png");
    });
  });

  it("shows the initial prompt while the newly created session is still running", async () => {
    await withNewSessionPage(async (page) => {
      const sessionKey = "agent:main:visible-initial-prompt";
      const message = "keep this prompt visible while the agent works";
      const activeOutputTimestamp = Date.now() + 60_000;
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.create": {
            key: sessionKey,
            runId: "visible-initial-run",
            runStarted: true,
            messageSeq: 1,
          },
          "sessions.list": createdSessionListResult(sessionKey),
          "chat.startup": {
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "active-tool-call",
                    name: "read",
                    arguments: { path: "SKILL.md" },
                  },
                ],
                timestamp: activeOutputTimestamp,
                __openclaw: { id: "active-assistant", seq: 2 },
              },
              {
                role: "toolResult",
                toolCallId: "active-tool-call",
                toolName: "read",
                content: [{ type: "text", text: "working" }],
                timestamp: activeOutputTimestamp + 1,
                __openclaw: { id: "active-tool-result", seq: 3 },
              },
            ],
            sessionId: "visible-initial-prompt",
            sessionInfo: { hasActiveRun: true, key: sessionKey, status: "running" },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
        timeout: 30_000,
      });
      await gateway.waitForRequest("chat.startup");
      await page.getByText("SKILL.md", { exact: true }).waitFor();

      await pollLocatorText(page.locator(".chat-group.user")).toContain(message);
      const userRow = await page.locator(".chat-group.user").boundingBox();
      const toolRow = await page.getByText("SKILL.md", { exact: true }).boundingBox();
      expect(userRow).not.toBeNull();
      expect(toolRow).not.toBeNull();
      if (!userRow || !toolRow) {
        throw new Error("expected visible prompt and tool rows");
      }
      expect(userRow.y).toBeLessThan(toolRow.y);
    });
  });

  it("keeps the initial prompt visible across a Gateway reconnect", async () => {
    await withNewSessionPage(async (page) => {
      const sessionKey = "agent:main:reconnected-initial-prompt";
      const message = "keep this first prompt through reconnect";
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.create": {
            key: sessionKey,
            runId: "reconnected-initial-run",
            runStarted: true,
            messageSeq: 1,
          },
          "sessions.list": createdSessionListResult(sessionKey),
          "chat.startup": {
            messages: [],
            sessionId: "reconnected-initial-prompt",
            sessionInfo: { hasActiveRun: true, key: sessionKey, status: "running" },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
        timeout: 30_000,
      });
      await gateway.waitForRequest("chat.startup");
      await pollLocatorText(page.locator(".chat-group.user")).toContain(message);

      const socketsBeforeReconnect = await gateway.getSocketCount();
      await gateway.setOnline(false);
      await expect
        .poll(() => gateway.getSocketCount(), { timeout: 10_000 })
        .toBeGreaterThan(socketsBeforeReconnect);
      await gateway.setOnline(true);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: { context: { gateway: { snapshot: { phase: string } } } };
            };
            return app.runtime?.context.gateway.snapshot.phase;
          }),
        )
        .toBe("connected");
      if (captureUiProofEnabled) {
        await mkdir(path.join(suite.artifactDir, "initial-prompt-reconnect"), { recursive: true });
        await page.screenshot({
          path: path.join(
            path.join(suite.artifactDir, "initial-prompt-reconnect"),
            "reconnected-session.png",
          ),
          fullPage: true,
        });
      }
      await pollLocatorText(page.locator(".chat-group.user")).toContain(message);
      await expect.poll(() => page.locator(".chat-group.user").count()).toBe(1);
    });
  });

  it("reconciles an image-bearing initial prompt into one user row", async () => {
    await withNewSessionPage(async (page) => {
      const sessionKey = "agent:main:single-image-prompt";
      const runId = "initial-image-send";
      const message = "testing if dual prompts show";
      const source = "media://inbound/initial-prompt.png";
      const imageBytes = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      let releaseMedia!: () => void;
      const mediaGate = new Promise<void>((resolve) => {
        releaseMedia = resolve;
      });
      let metadataRequested = false;
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const url = new URL(route.request().url());
        expect(url.searchParams.get("source")).toBe(source);
        const metadata = url.searchParams.get("meta") === "1";
        metadataRequested ||= metadata;
        await mediaGate;
        await route.fulfill(
          metadata
            ? {
                json: {
                  available: true,
                  mediaTicket: "initial-prompt-ticket",
                  mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                },
              }
            : { contentType: "image/png", body: imageBytes },
        );
      });
      const authoritative = {
        role: "user",
        content: [{ type: "text", text: message }],
        timestamp: Date.now(),
        __openclaw: {
          id: "persisted-image-prompt",
          idempotencyKey: `${runId}:user`,
          seq: 1,
          media: [{ path: source, contentType: "image/png", fileName: "pixel.png" }],
          mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
        },
      };
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.startup"],
        methodResponses: {
          "sessions.create": {
            key: sessionKey,
            runId,
            runStarted: true,
            messageSeq: 1,
          },
          "sessions.list": createdSessionListResult(sessionKey),
          "chat.startup": {
            messages: [authoritative],
            sessionId: "single-image-prompt",
            sessionInfo: {
              activeRunIds: [runId],
              hasActiveRun: true,
              key: sessionKey,
              status: "running",
            },
          },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        const composer = page.locator(".new-session-page__message");
        await composer.fill(message);
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "pixel.png",
          mimeType: "image/png",
          buffer: imageBytes,
        });
        await page.getByRole("button", { name: "Start session" }).click();
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
          timeout: 30_000,
        });
        await gateway.waitForRequest("chat.startup");

        const userRow = page.locator(".chat-group.user");
        const userImage = userRow.locator("img.chat-message-image");
        await expect.poll(() => userRow.count()).toBe(1);
        await expect.poll(() => userImage.count()).toBe(1);
        await expect.poll(() => userImage.getAttribute("src")).toMatch(/^data:image\/png;base64,/u);
        await expectDecodedThumbnail(userImage, 180);
        const initialImageSrc = await userImage.getAttribute("src");
        const initialPixels = await userImage.screenshot({ animations: "disabled" });
        await userImage.evaluate((image) => image.setAttribute("data-initial-image-node", "true"));
        await pollLocatorText(userRow).toContain(message);
        await pollLocatorText(userRow).not.toContain("Attached image");

        const promptBubbles = page.locator(".chat-bubble").filter({ hasText: message });
        const durableBubble = page.locator('.chat-bubble[data-entry-id="persisted-image-prompt"]');
        await expect.poll(() => promptBubbles.count()).toBe(1);
        await gateway.emitGatewayEvent("session.message", {
          activeRunIds: [runId],
          clientRunId: runId,
          hasActiveRun: true,
          message: authoritative,
          messageId: "persisted-image-prompt",
          messageSeq: 1,
          session: {
            activeRunIds: [runId],
            hasActiveRun: true,
            key: sessionKey,
            kind: "direct",
            status: "running",
            updatedAt: Date.now(),
          },
          sessionKey,
        });
        await durableBubble.waitFor({ timeout: 10_000 });
        await expect.poll(() => durableBubble.count()).toBe(1);
        await expect.poll(() => promptBubbles.count()).toBe(1);
        await expect.poll(() => metadataRequested).toBe(true);
        await expect.poll(() => userImage.getAttribute("data-initial-image-node")).toBe("true");
        await expect.poll(() => userImage.getAttribute("src")).toBe(initialImageSrc);
        expect((await userImage.screenshot({ animations: "disabled" })).equals(initialPixels)).toBe(
          true,
        );
        expect(await userRow.locator('[aria-busy="true"]').count()).toBe(0);
        await captureUiProof(suite, page, "initial-image-metadata-loading.png");

        await gateway.resolveDeferred("chat.startup");

        await expect.poll(() => userRow.count()).toBe(1);
        await expect.poll(() => userImage.count()).toBe(1);
        await expect.poll(() => userImage.getAttribute("data-initial-image-node")).toBe("true");
        await expect.poll(() => userImage.getAttribute("src")).toBe(initialImageSrc);
        await expect.poll(() => promptBubbles.count()).toBe(1);
        await expect.poll(() => durableBubble.count()).toBe(1);
        await pollLocatorText(userRow).toContain(message);
        await pollLocatorText(userRow).not.toContain("Attached image");
        releaseMedia();
        await expect.poll(() => userImage.getAttribute("src")).toContain("initial-prompt-ticket");
        await expectDecodedThumbnail(userImage, 180);
        expect(await userImage.getAttribute("data-initial-image-node")).toBe("true");
        expect((await userImage.screenshot({ animations: "disabled" })).equals(initialPixels)).toBe(
          true,
        );
        await captureUiProof(suite, page, "initial-image-canonical-ready.png");
      } finally {
        releaseMedia();
      }
    });
  });

  it("waits for pasted image reads before enabling session creation", async () => {
    await withNewSessionPage(async (page) => {
      await page.addInitScript(() => {
        const readAsDataUrl = Object.getOwnPropertyDescriptor(FileReader.prototype, "readAsDataURL")
          ?.value as FileReader["readAsDataURL"];
        FileReader.prototype.readAsDataURL = function (blob: Blob) {
          (globalThis as unknown as { finishPastedImageRead?: () => void }).finishPastedImageRead =
            () => readAsDataUrl.call(this, blob);
        };
      });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.create": { key: "agent:main:delayed-image-draft", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      const submit = page.getByRole("button", { name: "Start session" });
      await composer.fill("include the image that is still loading");
      await pastePng(composer);

      await expect.poll(() => submit.isDisabled()).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await page.evaluate(() => {
        const finish = (globalThis as unknown as { finishPastedImageRead?: () => void })
          .finishPastedImageRead;
        if (!finish) {
          throw new Error("Pasted image read was not started");
        }
        finish();
      });

      await page.getByRole("img", { name: "pixel.png" }).waitFor();
      await expect.poll(() => submit.isEnabled()).toBe(true);
      await submit.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: "include the image that is still loading",
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
    });
  });

  it("releases a completed file when the rest of its pasted batch is aborted", async () => {
    type PasteProof = {
      reads: number;
      loaded: number;
      aborts: number;
      created: number;
      revoked: number;
    };
    await withNewSessionPage(async (page) => {
      await page.addInitScript(() => {
        const readAsDataUrl = Reflect.get(
          FileReader.prototype,
          "readAsDataURL",
        ) as FileReader["readAsDataURL"];
        const abort = Reflect.get(FileReader.prototype, "abort") as FileReader["abort"];
        const createObjectURL = URL.createObjectURL.bind(URL);
        const revokeObjectURL = URL.revokeObjectURL.bind(URL);
        const proof: PasteProof = { reads: 0, loaded: 0, aborts: 0, created: 0, revoked: 0 };
        (globalThis as unknown as { partialPasteProof: PasteProof }).partialPasteProof = proof;
        FileReader.prototype.readAsDataURL = function (blob: Blob) {
          proof.reads += 1;
          if (proof.reads === 1) {
            this.addEventListener(
              "load",
              () => {
                proof.loaded += 1;
              },
              { once: true },
            );
            readAsDataUrl.call(this, blob);
          }
        };
        FileReader.prototype.abort = function () {
          proof.aborts += 1;
          abort.call(this);
        };
        URL.createObjectURL = (blob: Blob) => {
          proof.created += 1;
          return createObjectURL(blob);
        };
        URL.revokeObjectURL = (url: string) => {
          proof.revoked += 1;
          revokeObjectURL(url);
        };
      });
      const gateway = await installMockGateway(page);
      const readProof = () =>
        page.evaluate(
          () => (globalThis as unknown as { partialPasteProof: PasteProof }).partialPasteProof,
        );
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      await pastePng(composer, 2);
      await expect
        .poll(readProof)
        .toEqual({ reads: 2, loaded: 1, aborts: 0, created: 0, revoked: 0 });
      expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);

      await navigateInApp(page, "chat");
      await waitForCommittedChatRoute(page);
      await expect
        .poll(readProof)
        .toEqual({ reads: 2, loaded: 1, aborts: 1, created: 0, revoked: 0 });
      await navigateInApp(page, "new-session");
      await composer.waitFor();
      expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    });
  });

  it("keeps a rejected first message visible and retryable after reload", async () => {
    await withNewSessionPage(async (page) => {
      const sessionKey = "agent:main:rejected-first-message";
      const message = "keep this rejected first message";
      const runError = "send blocked by session policy";
      const gateway = await installMockGateway(page, {
        methodResponses: {
          ...LOCAL_GIT_WORKSPACE_RESPONSES,
          "sessions.list": {
            count: 1,
            defaults: SESSION_LIST_DEFAULTS,
            path: "",
            sessions: [
              {
                hasActiveRun: false,
                key: sessionKey,
                kind: "direct",
                status: "done",
                updatedAt: Date.now(),
              },
            ],
            ts: Date.now(),
          },
          "sessions.create": {
            key: sessionKey,
            runStarted: false,
            runError: { code: "INVALID_REQUEST", message: runError },
          },
          "chat.history": {
            messages: [],
            sessionId: "rejected-first-message",
            sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
          },
          "chat.send": { runId: "retry-run", status: "started" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      await composer.fill(message);
      await pastePng(composer);
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });

      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
        timeout: 30_000,
      });
      const failedGroup = page.locator(".chat-group.user", { hasText: message });
      const failedStatus = failedGroup.locator(".chat-send-status");
      await failedGroup.waitFor({ state: "visible", timeout: 30_000 });
      expect(await failedStatus.textContent()).toContain("Not sent");
      await expect.poll(() => tooltipTitleText(failedStatus)).toBe(runError);

      await page.reload();
      await failedGroup.waitFor({ state: "visible", timeout: 30_000 });
      expect(await failedStatus.textContent()).toContain("Not sent");
      await expect.poll(() => tooltipTitleText(failedStatus)).toBe(runError);

      await page.getByRole("button", { name: "Retry queued message" }).click();
      const retry = await gateway.waitForRequest("chat.send");
      expect(retry.params).toMatchObject({
        sessionKey,
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    });
  });

  it("adopts a created session when rejected-turn persistence exceeds browser storage", async () => {
    await withNewSessionPage(async (page) => {
      await page.addInitScript(() => {
        const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")
          ?.value as Storage["setItem"];
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key.startsWith("openclaw.control.chatComposer.v2:")) {
            throw new DOMException("Quota exceeded", "QuotaExceededError");
          }
          return setItem.call(this, key, value);
        };
      });
      const sessionKey = "agent:main:storage-failed-initial-turn";
      const message = "retry this in the session that already exists";
      const runError = "initial send rejected";
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.create": {
            key: sessionKey,
            runStarted: false,
            runError: { code: "INVALID_REQUEST", message: runError },
          },
          "sessions.list": createdSessionListResult(sessionKey),
          "chat.history": {
            messages: [],
            sessionId: "storage-failed-initial-turn",
            sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
          },
          "chat.send": { runId: "storage-failure-retry", status: "started" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      await composer.fill(message);
      await pastePng(composer);
      await page.getByRole("button", { name: "Start session" }).click();

      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
        timeout: 30_000,
      });
      const failedGroup = page.locator(".chat-group.user", { hasText: message });
      const failedStatus = failedGroup.locator(".chat-send-status");
      await failedGroup.waitFor({ state: "visible", timeout: 30_000 });
      expect(await failedStatus.textContent()).toContain("Not sent");
      await expect.poll(() => tooltipTitleText(failedStatus)).toBe(runError);
      await page.getByRole("button", { name: "Retry queued message" }).click();
      const retry = await gateway.waitForRequest("chat.send");
      expect(retry.params).toMatchObject({
        sessionKey,
        message,
        attachments: [{ fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 }],
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    });
  });
});
