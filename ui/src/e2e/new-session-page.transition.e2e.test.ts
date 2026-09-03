import { Buffer } from "node:buffer";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import {
  ONE_PIXEL_PNG_B64,
  SESSION_LIST_DEFAULTS,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  captureUiProof,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  expectDecodedThumbnail,
  expectPendingNewSessionPresentation,
  installMockGateway,
  pollLocatorText,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const SESSION_KEY = "agent:main:dashboard:0f403cb8-3920-4cf1-8eb7-79f2f00ce488";
const RUN_ID = "transition-proof-run";
const captureProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

type SessionTransitionFrames = {
  invalid: number;
  running: boolean;
  transition: {
    activeViewTransition: boolean;
    chatSurfaceReady: boolean;
    routeAnimation: boolean;
  } | null;
};

function transitionProofDir() {
  return path.join(suite.artifactDir, "new-session-transition");
}

async function captureProof(page: import("playwright").Page, fileName: string) {
  if (!captureProofEnabled) {
    return;
  }
  const proofDir = transitionProofDir();
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(proofDir, fileName) });
}

suite.define(() => {
  it.each([
    { label: "desktop", viewport: { height: 900, width: 1280 } },
    { label: "mobile", viewport: { height: 844, width: 390 } },
  ])("starts a draft in the background on $label", async ({ label, viewport }) => {
    const proofDir = captureProofEnabled ? transitionProofDir() : undefined;
    const context = await suite.browser.newContext({
      locale: "en-US",
      ...(proofDir ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    const video = page.video();
    const sessionKey = `agent:main:dashboard:background-${label}`;
    const runId = `run-background-${label}`;
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.create": {
          key: sessionKey,
          entry: {
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            sessionId: `session-background-${label}`,
            updatedAt: Date.now(),
          },
          runId,
          runStarted: true,
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.deferNext("agent.wait");
      const composer = page.locator(".new-session-page__message");
      await composer.fill(`run this separately on ${label}`);
      await captureProof(page, `background-${label}-ready.png`);
      if (captureProofEnabled) {
        await page.waitForTimeout(400);
      }
      await composer.press("Control+Enter");

      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { agentId: "main", message: `run this separately on ${label}` },
      });
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await expect.poll(() => composer.inputValue()).toBe("");
      await expect
        .poll(() =>
          page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`).count(),
        )
        .toBe(1);
      await captureProof(page, `background-${label}-running.png`);
      if (captureProofEnabled) {
        await page.waitForTimeout(600);
      }

      await expect(gateway.waitForRequest("agent.wait")).resolves.toMatchObject({
        params: { runId, timeoutMs: 30_000 },
      });
      await gateway.resolveDeferred("agent.wait", { endedAt: Date.now(), runId, status: "ok" });
      const toast = page.locator(".app-toast");
      await toast.getByText("Done").waitFor({ timeout: 10_000 });
      await captureProof(page, `background-${label}-complete.png`);
      if (captureProofEnabled) {
        await page.waitForTimeout(800);
      }
      await toast.getByRole("button", { name: "Open" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
      await waitForCommittedChatRoute(page);
      await page.locator("openclaw-chat-page").waitFor();
      await captureProof(page, `background-${label}-opened.png`);
      if (captureProofEnabled) {
        await page.waitForTimeout(400);
      }
    } finally {
      await context.close();
      if (proofDir && video) {
        await rename(await video.path(), path.join(proofDir, `background-${label}.webm`));
      }
    }
  });

  it("uses shifted Enter for background start in modifier mode", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
    await context.addInitScript(
      ({ key, url }) => {
        localStorage.setItem(
          key,
          JSON.stringify({ chatSendShortcut: "modifier-enter", gatewayUrl: url }),
        );
      },
      { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), url: gatewayUrl },
    );
    const page = await context.newPage();
    const sessionKey = "agent:main:dashboard:modifier-background";
    const runId = "run-modifier-background";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agent.wait": { endedAt: Date.now(), runId, status: "ok" },
        "sessions.create": { key: sessionKey, runId, runStarted: true },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");
      await composer.fill("start in the background");
      await composer.press("Control+Shift+Enter");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { agentId: "main", message: "start in the background" },
      });
    } finally {
      await context.close();
    }
  });

  it("creates and lists a session with the default mock Gateway", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").fill("verify the default mock");
      await page.getByRole("button", { name: "Start session" }).click();

      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { agentId: "main", message: "verify the default mock" },
      });
      const sessionKeys = ["agent:main:mock-created-1", "agent:main:mock-created-2"] as const;
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath(sessionKeys[0]));

      await page.getByRole("link", { name: "New session" }).first().click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await page.locator(".new-session-page__message").fill("verify another default mock");
      await page.getByRole("button", { name: "Start session" }).click();
      await expect.poll(async () => (await gateway.getRequests("sessions.create")).length).toBe(2);
      expect((await gateway.getRequests("sessions.create")).at(-1)).toMatchObject({
        params: { agentId: "main", message: "verify another default mock" },
      });
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath(sessionKeys[1]));
      for (const sessionKey of sessionKeys) {
        await expect
          .poll(() =>
            page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`).count(),
          )
          .toBe(1);
      }
      await expect.poll(() => page.locator(".new-session-page__error").count()).toBe(0);
      await captureProof(page, "default-mock-created.png");

      const listRequestsBeforeReconnect = (await gateway.getRequests("sessions.list")).length;
      await gateway.closeLatest(1006, "mock reconnect");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(1);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(listRequestsBeforeReconnect);
      for (const sessionKey of sessionKeys) {
        await expect
          .poll(() =>
            page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`).count(),
          )
          .toBe(1);
      }
      await captureProof(page, "default-mock-reconnected.png");
    } finally {
      await context.close();
    }
  });

  it("opens the confirmed session before roster or reference lookup completes and preserves effort", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const thinkingLevels = ["off", "low", "medium", "high", "xhigh"].map((id) => ({
      id,
      label: id,
    }));
    const entry = {
      sessionId: "created-session",
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      thinkingLevel: "xhigh",
      updatedAt: Date.now(),
    };
    const createdSessionList = createdSessionListResult(SESSION_KEY);
    createdSessionList.sessions = createdSessionList.sessions.map((row) => ({ ...row, ...entry }));
    let releaseChatModule!: () => void;
    let chatModuleRequested = false;
    const chatModuleBlocked = new Promise<void>((resolve) => {
      releaseChatModule = resolve;
    });
    await page.route("**/assets/chat-page-*.js*", async (route) => {
      chatModuleRequested = true;
      await chatModuleBlocked;
      await route.continue();
    });
    const gateway = await installMockGateway(page, {
      agentModel: "openai/gpt-5.6-sol",
      heldMethods: ["sessions.resolve"],
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          reasoning: true,
          thinkingDefault: "high",
          thinkingLevels,
        },
      ],
      methodResponses: {
        "agents.list": {
          agents: [{ id: "main", thinkingLevels, thinkingDefault: "high" }],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "sessions.create": {
          key: SESSION_KEY,
          entry,
          messageSeq: 1,
          runId: RUN_ID,
          runStarted: true,
        },
        "sessions.list": { ...createdSessionListResult(SESSION_KEY), count: 0, sessions: [] },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const effortPicker = page.locator('[data-chat-thinking-select="true"]');
      await effortPicker.click();
      const thinkingSlider = page.locator('[data-chat-thinking-slider="true"]');
      const xhighIndex = await thinkingSlider.evaluate(
        (element) =>
          element.getAttribute("data-chat-thinking-values")?.split(",").indexOf("xhigh") ?? -1,
      );
      expect(xhighIndex).toBeGreaterThanOrEqual(0);
      await thinkingSlider.fill(String(xhighIndex));
      await expect.poll(() => effortPicker.getAttribute("data-chat-thinking-value")).toBe("xhigh");
      await page.keyboard.press("Escape");
      const message = page.locator(".new-session-page__message");
      const start = page.locator(".new-session-page__start-submit");
      await message.fill("keep progress moving");
      await expect.poll(() => start.isEnabled()).toBe(true);
      await gateway.waitForRequest("sessions.list");
      expect(
        await page.locator(`.sidebar-recent-session[data-session-key="${SESSION_KEY}"]`).count(),
      ).toBe(0);
      const listRequestsBeforeSubmit = (await gateway.getRequests("sessions.list")).length;

      await gateway.deferNext("sessions.create");
      await gateway.deferNext("sessions.list");
      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ thinkingLevel: "xhigh" });
      const startup = page.locator(".new-session-page__starting");
      const submittedPrompt = startup.locator(".chat-group.user");
      await expect.poll(() => submittedPrompt.isVisible()).toBe(true);
      await pollLocatorText(submittedPrompt).toContain("keep progress moving");
      await pollLocatorText(startup.locator('.chat-working-indicator[role="status"]')).toContain(
        "Starting…",
      );
      await captureProof(page, "00-create-pending.png");
      await expectPendingNewSessionPresentation(page);
      await gateway.resolveDeferred("sessions.create", {
        key: SESSION_KEY,
        entry,
        messageSeq: 1,
        runId: RUN_ID,
        runStarted: true,
      });
      await gateway.waitForRequest("sessions.list", { after: listRequestsBeforeSubmit });
      await expect.poll(() => chatModuleRequested).toBe(true);

      expect(await submittedPrompt.isVisible()).toBe(true);
      expect(await submittedPrompt.count()).toBe(1);
      await captureProof(page, "01-chat-route-preparing.png");
      await expectPendingNewSessionPresentation(page);

      await page.evaluate(() => {
        const frames: SessionTransitionFrames = { invalid: 0, running: true, transition: null };
        Reflect.set(globalThis, "__openclawSessionTransitionFrames", frames);
        const sample = () => {
          const outlet = document.querySelector("openclaw-router-outlet");
          const handoffCover = outlet?.classList.contains("session-route-handoff") === true;
          const newSessionVisible = Boolean(
            document.querySelector(".new-session-page__starting")?.getClientRects().length,
          );
          const composer = document.querySelector(".agent-chat__composer-combobox");
          const chatVisible = Boolean(composer?.getClientRects().length);
          const chatSurfaceReady = Boolean(composer);
          if (
            document.activeViewTransition ||
            handoffCover ||
            (!newSessionVisible && !chatVisible)
          ) {
            frames.invalid += 1;
          }
          const routeAnimation = document.getAnimations().some((animation) => {
            const effect = animation.effect as KeyframeEffect | null;
            return (
              effect?.target === outlet &&
              effect.getKeyframes().every((keyframe) => keyframe.opacity === undefined)
            );
          });
          // Record the brief animation in-page before protocol round-trips can miss it.
          if (frames.transition === null && chatSurfaceReady && routeAnimation) {
            frames.transition = {
              activeViewTransition: Boolean(document.activeViewTransition),
              chatSurfaceReady,
              routeAnimation,
            };
          }
          if (frames.running) {
            requestAnimationFrame(sample);
          }
        };
        requestAnimationFrame(sample);
      });

      await gateway.deferNext("chat.startup");
      releaseChatModule();
      await gateway.waitForRequest("chat.startup");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const frames = Reflect.get(
              globalThis,
              "__openclawSessionTransitionFrames",
            ) as SessionTransitionFrames;
            return frames.transition;
          }),
        )
        .toEqual({ activeViewTransition: false, chatSurfaceReady: true, routeAnimation: true });
      await expect
        .poll(() => page.getByText("keep progress moving", { exact: true }).count())
        .toBe(1);
      const chatEffortPicker = page
        .locator(".agent-chat__input")
        .locator('[data-chat-thinking-select="true"]');
      await expect
        .poll(() => chatEffortPicker.getAttribute("data-chat-thinking-value"))
        .toBe("xhigh");
      await waitForCommittedChatRoute(page);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(SESSION_KEY));
      expect(await gateway.getRequests("sessions.list")).toHaveLength(listRequestsBeforeSubmit + 1);
      expect(await gateway.getRequests("sessions.resolve")).toHaveLength(0);
      const invalidFrames = await page.evaluate(() => {
        const frames = Reflect.get(
          globalThis,
          "__openclawSessionTransitionFrames",
        ) as SessionTransitionFrames;
        frames.running = false;
        return frames.invalid;
      });
      expect(invalidFrames).toBe(0);
      await captureProof(page, "02-session-route-transition.png");
      await gateway.resolveDeferred("sessions.list", createdSessionList);
      await gateway.resolveDeferred("chat.startup");
      await waitForCommittedChatRoute(page);
      await page.locator("openclaw-chat-page").waitFor();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.activeElement?.matches(".agent-chat__composer-combobox textarea") === true,
          ),
        )
        .toBe(true);
      await expect
        .poll(() => page.getByText("keep progress moving", { exact: true }).count())
        .toBe(1);
      await expect
        .poll(() => chatEffortPicker.getAttribute("data-chat-thinking-value"))
        .toBe("xhigh");
      await captureProof(page, "03-chat-route-ready.png");
    } catch (error) {
      await captureControlUiE2eFailureDiagnostics(page, {
        error: error instanceof Error ? error : new Error(String(error)),
        label: "new-session-selected-effort-transition",
      });
      throw error;
    } finally {
      releaseChatModule();
      await context.close();
    }
  });
  it.each(
    (["dark", "light"] as const).flatMap((mode) =>
      (["no-preference", "reduce"] as const).flatMap((motion) =>
        [1280, 390].flatMap((width) =>
          (["markdown", "json"] as const).map((content) => ({ mode, motion, width, content })),
        ),
      ),
    ),
  )(
    "shows the submitted prompt before creation responds and restores it after failure ($width, $mode, $motion, $content)",
    async ({ mode, motion, width, content }) => {
      await suite.withPage(
        {
          locale: "en-US",
          ...(captureProofEnabled
            ? { recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1280 } } }
            : {}),
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
        },
        async ({ page }) => {
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: mode, reducedMotion: motion });
          const proofName = `pending-${width}-${mode}-${motion}-${content}`;
          const sessionKey = "agent:main:locked-new-session-draft";
          const submittedSummary = "keep this submitted draft atomic";
          const fileReference = "src/example.ts";
          const referencedSessionKey = "agent:main:referenced-preview";
          const markdownMessage = [
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
          const submittedMessage =
            content === "json"
              ? JSON.stringify({ task: submittedSummary, files: [fileReference] }, null, 2)
              : markdownMessage;
          const runId = "submitted-image-run";
          const imageFileName = "apple-touch-icon.png";
          const imageFile = path.join(process.cwd(), "ui/public", imageFileName);
          const imageContent = (await readFile(imageFile)).toString("base64");
          const gateway = await installMockGateway(page, {
            heldMethods: ["chat.startup"],
            workspaceGit: true,
            methodResponses: {
              ...LOCAL_GIT_WORKSPACE_RESPONSES,
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
          await page.locator(".new-session-page__message").waitFor();
          await page.evaluate((nextMode) => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime: { context: ApplicationContext };
            };
            app.runtime.context.theme.setMode(nextMode);
          }, mode);
          await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
          await gateway.deferNext("sessions.create");

          const message = page.locator(".new-session-page__message");
          const placeSelect = page.locator("wa-popover.new-session-page__project-popover");
          const placeSummary = page.locator("#new-session-project-trigger");
          const startup = page.locator(".new-session-page__starting");
          const submittedPrompt = startup.locator(".chat-group.user");
          const announcement = page.locator(
            '.new-session-page > [role="status"][aria-live="polite"]',
          );
          const draftImage = page.locator(".chat-attachment-thumb").getByRole("img", {
            name: imageFileName,
          });

          await message.fill(submittedMessage);
          await page.locator(".agent-chat__photo-input").setInputFiles(imageFile);
          await expectDecodedThumbnail(draftImage);
          await page.locator(".agent-chat__file-input").setInputFiles({
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Pending attachment proof"),
          });
          await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(2);
          await placeSummary.click();
          expect(await placeSelect.getAttribute("open")).not.toBeNull();
          const scroll = page.locator(".new-session-page__scroll");
          const initialScrollPadding = await scroll.evaluate((el) => getComputedStyle(el).padding);
          await page.getByRole("button", { name: "Start session" }).dblclick();

          const create = await gateway.waitForRequest("sessions.create");
          const submittedPayload = {
            message: submittedMessage,
            attachments: [
              {
                type: "image",
                mimeType: "image/png",
                fileName: imageFileName,
                content: imageContent,
              },
              {
                type: "file",
                mimeType: "text/plain",
                fileName: "notes.txt",
                content: Buffer.from("Pending attachment proof").toString("base64"),
              },
            ],
          };
          expect(create.params).toMatchObject(submittedPayload);
          await expect.poll(() => submittedPrompt.isVisible()).toBe(true);
          if (content === "json") {
            await submittedPrompt.locator(".chat-json-summary").click();
            await pollLocatorText(submittedPrompt.locator(".chat-json-content")).toBe(
              submittedMessage,
            );
          } else {
            const pendingMarkdown = submittedPrompt.locator(".chat-text");
            await pollLocatorText(pendingMarkdown.locator("strong")).toBe(submittedSummary);
            await pendingMarkdown.getByRole("cell", { name: "Ready", exact: true }).waitFor();
            await pollLocatorText(pendingMarkdown).toContain(fileReference);
            await pollLocatorText(pendingMarkdown).toContain(referencedSessionKey);
            expect(
              await pendingMarkdown
                .getByRole("link", { name: "Documentation" })
                .getAttribute("href"),
            ).toBe("https://example.com/guide");
            await pendingMarkdown
              .locator("img.markdown-inline-image")
              .waitFor({ state: "visible" });
            expect(
              await pendingMarkdown
                .locator("button, [role=button], [data-file-path], [data-session-key]")
                .count(),
            ).toBe(0);
          }
          const attachmentCard = submittedPrompt.locator(
            ".chat-assistant-attachment-card--compact",
          );
          await attachmentCard.getByText("notes.txt", { exact: true }).waitFor();
          const cardBox = await attachmentCard.boundingBox();
          expect(cardBox?.width).toBeLessThanOrEqual(width);
          expect(cardBox?.height).toBeGreaterThan(30);
          await expectDecodedThumbnail(submittedPrompt.locator("img.chat-message-image"));
          await pollLocatorText(
            startup.locator('.chat-working-indicator[role="status"]'),
          ).toContain("Starting…");
          await pollLocatorText(announcement).toContain("Starting…");
          expect(new URL(page.url()).pathname).toBe("/new");
          expect(await message.isVisible()).toBe(false);
          expect(await placeSelect.isVisible()).toBe(false);
          // Pending chat classes must preserve New Session's native titlebar drag inset.
          expect(await scroll.evaluate((el) => getComputedStyle(el).padding)).toBe(
            initialScrollPadding,
          );
          await captureUiProof(suite, page, `${proofName}-submitted.png`);
          const presentation = await expectPendingNewSessionPresentation(page);
          if (captureProofEnabled) {
            await writeFile(
              path.join(suite.artifactDir, `${proofName}.json`),
              JSON.stringify(presentation, null, 2),
            );
          }
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
          await page
            .getByRole("alert")
            .filter({ hasText: "session creation unavailable" })
            .waitFor();
          await expect.poll(() => message.isVisible()).toBe(true);
          await expect.poll(() => message.isDisabled()).toBe(false);
          expect(await startup.isVisible()).toBe(false);
          await expect.poll(async () => (await announcement.textContent())?.trim()).toBe("");
          expect(await message.inputValue()).toBe(submittedMessage);
          expect(await placeSummary.isDisabled()).toBe(false);
          await expectDecodedThumbnail(draftImage);
          await captureUiProof(suite, page, `${proofName}-restored.png`);

          await page.getByRole("button", { name: "Start session" }).click();
          await expect
            .poll(async () => (await gateway.getRequests("sessions.create")).length)
            .toBe(2);
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
          if (content === "markdown") {
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
            await acceptedMarkdown
              .getByRole("button", { name: "Expand table", exact: true })
              .click();
            const expandedTable = page.getByRole("dialog", { name: "Expanded table", exact: true });
            await expandedTable.getByRole("cell", { name: "Ready", exact: true }).waitFor();
            await expandedTable
              .getByRole("button", { name: "Close expanded table", exact: true })
              .click();
            await expandedTable.waitFor({ state: "detached" });
          } else {
            await acceptedPrompt.locator(".chat-json-summary").click();
            await pollLocatorText(acceptedPrompt.locator(".chat-json-content")).toBe(
              submittedMessage,
            );
          }
          await expectDecodedThumbnail(acceptedPrompt.locator("img.chat-message-image"));
          await captureUiProof(suite, page, `${proofName}-accepted.png`);
          await gateway.resolveDeferred("chat.startup");
          await expect.poll(() => acceptedPrompt.count()).toBe(1);
          await expectDecodedThumbnail(acceptedPrompt.locator("img.chat-message-image"));
          expect(await gateway.getRequests("sessions.create")).toHaveLength(2);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    },
  );
});
