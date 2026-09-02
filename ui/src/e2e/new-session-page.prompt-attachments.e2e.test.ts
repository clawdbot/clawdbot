import { Buffer } from "node:buffer";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import {
  ONE_PIXEL_PNG_B64,
  SESSION_LIST_DEFAULTS,
  WORKSPACE,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
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

async function expectDecodedThumbnail(image: Locator) {
  await image.waitFor({ state: "visible" });
  await image.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      image.evaluate(async (element) => {
        if (!(element instanceof HTMLImageElement)) {
          return false;
        }
        await element.decode();
        const bounds = element.getBoundingClientRect();
        return (
          Math.min(element.naturalWidth, element.naturalHeight, bounds.width, bounds.height) >=
            32 &&
          bounds.top >= 0 &&
          bounds.left >= 0 &&
          bounds.bottom <= window.innerHeight &&
          bounds.right <= window.innerWidth
        );
      }),
    )
    .toBe(true);
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
      const authoritative = {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: "/persisted-image.png" },
          },
          { type: "text", text: message },
        ],
        timestamp: Date.now(),
        __openclaw: {
          id: "persisted-image-prompt",
          idempotencyKey: `${runId}:user`,
          seq: 1,
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
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      await composer.fill(message);
      await pastePng(composer);
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
      const initialImageSrc = await userImage.getAttribute("src");
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
      await expect.poll(() => userImage.getAttribute("data-initial-image-node")).toBe("true");
      await expect.poll(() => userImage.getAttribute("src")).toBe(initialImageSrc);

      await gateway.resolveDeferred("chat.startup");

      await expect.poll(() => userRow.count()).toBe(1);
      await expect.poll(() => userImage.count()).toBe(1);
      await expect.poll(() => userImage.getAttribute("data-initial-image-node")).toBe("true");
      await expect.poll(() => userImage.getAttribute("src")).toBe(initialImageSrc);
      await expect.poll(() => promptBubbles.count()).toBe(1);
      await expect.poll(() => durableBubble.count()).toBe(1);
      await pollLocatorText(userRow).toContain(message);
      await pollLocatorText(userRow).not.toContain("Attached image");
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
    await withNewSessionPage(async (page) => {
      await page.addInitScript(() => {
        const readAsDataUrl = Object.getOwnPropertyDescriptor(FileReader.prototype, "readAsDataURL")
          ?.value as FileReader["readAsDataURL"];
        let readCount = 0;
        FileReader.prototype.readAsDataURL = function (blob: Blob) {
          readCount += 1;
          if (readCount === 1) {
            readAsDataUrl.call(this, blob);
          }
        };
        const createObjectURL = URL.createObjectURL.bind(URL);
        const revokeObjectURL = URL.revokeObjectURL.bind(URL);
        const proof = { created: 0, revoked: 0 };
        (globalThis as unknown as { attachmentUrlProof: typeof proof }).attachmentUrlProof = proof;
        URL.createObjectURL = (blob: Blob) => {
          proof.created += 1;
          return createObjectURL(blob);
        };
        URL.revokeObjectURL = (url: string) => {
          proof.revoked += 1;
          revokeObjectURL(url);
        };
      });
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      await pastePng(composer, 2);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (globalThis as unknown as { attachmentUrlProof: { created: number } })
                .attachmentUrlProof.created,
          ),
        )
        .toBe(1);

      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context: { navigate: (routeId: string) => void } };
        };
        app.runtime?.context.navigate("chat");
      });
      await page.waitForURL((url) => url.pathname.endsWith("/chat"));
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (globalThis as unknown as { attachmentUrlProof: { revoked: number } })
                .attachmentUrlProof.revoked,
          ),
        )
        .toBe(1);
    });
  });

  it("shows the submitted prompt before creation responds and restores it after failure", async () => {
    await withNewSessionPage(async (page) => {
      const sessionKey = "agent:main:locked-new-session-draft";
      const submittedSummary = "keep this submitted draft atomic";
      const fileReference = "src/example.ts";
      const referencedSessionKey = "agent:main:referenced-preview";
      const submittedMessage = [
        `**${submittedSummary}**`,
        "",
        "| Item | State |",
        "| --- | --- |",
        "| Lobster | Ready |",
        "",
        `References: ${fileReference} and ${referencedSessionKey}.`,
        "",
        "[Documentation](https://example.com/guide)",
        "",
        `![Inline marker](data:image/png;base64,${ONE_PIXEL_PNG_B64})`,
      ].join("\n");
      const runId = "submitted-image-run";
      const imageFileName = "apple-touch-icon.png";
      const imageFile = path.join(process.cwd(), "ui/public", imageFileName);
      const imageContent = (await readFile(imageFile)).toString("base64");
      const gateway = await installMockGateway(page, {
        heldMethods: ["chat.startup"],
        workspaceGit: true,
        methodResponses: {
          "agents.list": {
            agents: [
              {
                id: "main",
                identity: { name: "Main" },
                name: "Main",
                workspace: WORKSPACE,
                workspaceGit: true,
              },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "worktrees.branches": {
            branches: [{ kind: "local", name: "main" }],
            defaultBranch: "main",
            repositoryStatus: "git",
          },
          "sessions.list": {
            count: 0,
            defaults: SESSION_LIST_DEFAULTS,
            path: "",
            sessions: [],
            ts: Date.now(),
          },
          "sessions.create": { key: sessionKey, runId, runStarted: true, messageSeq: 1 },
          "chat.startup": {
            messages: [],
            sessionId: "submitted-image-session",
            sessionInfo: {
              activeRunIds: [runId],
              hasActiveRun: true,
              key: sessionKey,
              status: "running",
            },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.deferNext("sessions.create");

      const message = page.locator(".new-session-page__message");
      const placeSelect = page.locator("wa-popover.new-session-page__project-popover");
      const placeSummary = page.locator("#new-session-project-trigger");
      const startup = page.locator(".new-session-page__starting");
      const submittedPrompt = startup.locator(".chat-group.user");
      const announcement = page.locator('.new-session-page > [role="status"][aria-live="polite"]');
      const draftImage = page.locator(".chat-attachment-thumb").getByRole("img", {
        name: imageFileName,
      });

      await message.fill(submittedMessage);
      await page.locator(".agent-chat__photo-input").setInputFiles(imageFile);
      await expectDecodedThumbnail(draftImage);
      await placeSummary.click();
      expect(await placeSelect.getAttribute("open")).not.toBeNull();
      await page.getByRole("button", { name: "Start session" }).dblclick();

      const create = await gateway.waitForRequest("sessions.create");
      const submittedPayload = {
        message: submittedMessage,
        attachments: [
          { type: "image", mimeType: "image/png", fileName: imageFileName, content: imageContent },
        ],
      };
      expect(create.params).toMatchObject(submittedPayload);
      await expect.poll(() => submittedPrompt.isVisible()).toBe(true);
      const pendingMarkdown = submittedPrompt.locator(".chat-text");
      await pollLocatorText(pendingMarkdown.locator("strong")).toBe(submittedSummary);
      await pendingMarkdown.getByRole("cell", { name: "Ready", exact: true }).waitFor();
      await pollLocatorText(pendingMarkdown).toContain(fileReference);
      await pollLocatorText(pendingMarkdown).toContain(referencedSessionKey);
      expect(
        await pendingMarkdown.getByRole("link", { name: "Documentation" }).getAttribute("href"),
      ).toBe("https://example.com/guide");
      await pendingMarkdown.locator("img.markdown-inline-image").waitFor({ state: "visible" });
      expect(
        await pendingMarkdown
          .locator("button, [role=button], [data-file-path], [data-session-key]")
          .count(),
      ).toBe(0);
      await expectDecodedThumbnail(submittedPrompt.locator("img.chat-message-image"));
      await pollLocatorText(startup.locator('.chat-working-indicator[role="status"]')).toContain(
        "Starting…",
      );
      await pollLocatorText(announcement).toContain("Starting…");
      expect(new URL(page.url()).pathname).toBe("/new");
      expect(await message.isVisible()).toBe(false);
      expect(await placeSelect.isVisible()).toBe(false);
      await captureUiProof(suite, page, "new-session-create-pending.png");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Control+Enter");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      await submittedPrompt.locator(".chat-message-image-button").click();
      const attachmentViewer = page.locator("openclaw-image-lightbox");
      await expectDecodedThumbnail(attachmentViewer.locator("img.image"));
      expect(await attachmentViewer.locator("img.image").getAttribute("src")).toBe(
        `data:image/png;base64,${imageContent}`,
      );
      await page.keyboard.press("Escape");
      await attachmentViewer.waitFor({ state: "detached" });

      await gateway.rejectDeferred("sessions.create", {
        code: "UNAVAILABLE",
        message: "session creation unavailable",
      });
      await page.getByRole("alert").filter({ hasText: "session creation unavailable" }).waitFor();
      await expect.poll(() => message.isVisible()).toBe(true);
      await expect.poll(() => message.isDisabled()).toBe(false);
      expect(await startup.isVisible()).toBe(false);
      await expect.poll(async () => (await announcement.textContent())?.trim()).toBe("");
      expect(await message.inputValue()).toBe(submittedMessage);
      expect(await placeSummary.isDisabled()).toBe(false);
      await expectDecodedThumbnail(draftImage);
      await captureUiProof(suite, page, "new-session-create-failure-restored.png");

      await page.getByRole("button", { name: "Start session" }).click();
      await expect.poll(async () => (await gateway.getRequests("sessions.create")).length).toBe(2);
      const retry = (await gateway.getRequests("sessions.create")).at(-1);
      expect(retry?.params).toMatchObject(submittedPayload);
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
        timeout: 30_000,
      });
      await gateway.waitForRequest("chat.startup");
      await waitForCommittedChatRoute(page);
      const acceptedPrompt = page.locator(".chat-group.user");
      await expect.poll(() => acceptedPrompt.count()).toBe(1);
      await pollLocatorText(acceptedPrompt).toContain(submittedSummary);
      const acceptedMarkdown = acceptedPrompt.locator(".chat-text");
      await acceptedMarkdown
        .locator(`a[data-file-path="${fileReference}"]`)
        .waitFor({ state: "visible" });
      await acceptedMarkdown
        .locator(`a[data-session-key="${referencedSessionKey}"]`)
        .waitFor({ state: "visible" });
      await acceptedMarkdown
        .getByRole("button", { name: "Open image Inline marker", exact: true })
        .waitFor({ state: "visible" });
      await acceptedMarkdown.getByRole("button", { name: "Expand table", exact: true }).click();
      const expandedTable = page.getByRole("dialog", { name: "Expanded table", exact: true });
      await expandedTable.getByRole("cell", { name: "Ready", exact: true }).waitFor();
      await expandedTable
        .getByRole("button", { name: "Close expanded table", exact: true })
        .click();
      await expandedTable.waitFor({ state: "detached" });
      await expectDecodedThumbnail(acceptedPrompt.locator("img.chat-message-image"));
      await captureUiProof(suite, page, "new-session-create-retry-accepted.png");
      await gateway.resolveDeferred("chat.startup");
      await expect.poll(() => acceptedPrompt.count()).toBe(1);
      await expectDecodedThumbnail(acceptedPrompt.locator("img.chat-message-image"));
      expect(await gateway.getRequests("sessions.create")).toHaveLength(2);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("keeps a rejected first message visible and retryable after reload", async () => {
    await withNewSessionPage(async (page) => {
      const sessionKey = "agent:main:rejected-first-message";
      const message = "keep this rejected first message";
      const runError = "send blocked by session policy";
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": {
            agents: [
              {
                id: "main",
                identity: { name: "Main" },
                name: "Main",
                workspace: WORKSPACE,
                workspaceGit: true,
              },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "worktrees.branches": {
            branches: [{ kind: "local", name: "main" }],
            defaultBranch: "main",
            repositoryStatus: "git",
          },
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
