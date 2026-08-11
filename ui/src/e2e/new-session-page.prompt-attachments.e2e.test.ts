import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
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
  reconnectProofArtifactDir,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

async function withNewSessionPage(run: (page: Page) => Promise<void>): Promise<void> {
  const context = await suite.browser.newContext({
    locale: "en-US",
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
  it("grows the first prompt through ten lines before using a narrow scrollbar", async () => {
    await withNewSessionPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.waitFor();

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
        };
      });

      expect(tenLines.height).toBeGreaterThan(initial.height);
      expect(tenLines.height).toBeGreaterThanOrEqual(
        Math.floor(tenLines.lineHeight * 10 + tenLines.padding) - 1,
      );
      expect(tenLines.overflowY).toBe("hidden");
      expect(tenLines.scrollbarWidth).toBe("thin");
      expect(Number.parseFloat(tenLines.webkitScrollbarWidth)).toBeLessThanOrEqual(6);
      await captureUiProof(page, "new-session-composer-ten-lines.png");

      const longPrompt = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n");
      await message.fill(longPrompt);
      const capped = await message.evaluate((element) => ({
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
      }));
      expect(capped.clientHeight).toBeLessThan(capped.scrollHeight);
      expect(capped.overflowY).toBe("auto");
      await captureUiProof(page, "new-session-composer-capped-scrollbar.png");
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
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.create": { key: "agent:main:image-draft", runStarted: true },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.waitFor();
      await pastePng(message);

      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
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
        await mkdir(reconnectProofArtifactDir, { recursive: true });
        await page.screenshot({
          path: path.join(reconnectProofArtifactDir, "reconnected-session.png"),
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

      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
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

  it("releases pasted image previews after remove, reset, disconnect, and success", async () => {
    await withNewSessionPage(async (page) => {
      await page.addInitScript(() => {
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
      await installMockGateway(page, {
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
            agents: [
              { id: "main", name: "Main" },
              { id: "writer", name: "Writer" },
            ],
          },
          "sessions.create": { key: "agent:main:preview-cleanup", runStarted: true },
        },
      });
      const proof = () =>
        page.evaluate(
          () =>
            (globalThis as unknown as { attachmentUrlProof: { created: number; revoked: number } })
              .attachmentUrlProof,
        );
      const navigate = (routeId: string, search = "") =>
        page.evaluate(
          ({ targetRouteId, targetSearch }) => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: {
                context: {
                  navigate: (routeId: string, options?: { search?: string }) => void;
                };
              };
            };
            if (!app.runtime) {
              throw new Error("OpenClaw application runtime is unavailable");
            }
            app.runtime.context.navigate(targetRouteId, { search: targetSearch });
          },
          { targetRouteId: routeId, targetSearch: search },
        );
      await page.goto(`${suite.server.baseUrl}new`);
      const composer = page.locator(".new-session-page__message");

      await pastePng(composer);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await page.getByRole("button", { name: "Remove attachment" }).click();
      await expect.poll(async () => (await proof()).revoked).toBe(1);

      await pastePng(composer);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      const agentDropdown = page.locator(".new-session-page__select--agent wa-dropdown");
      await page.locator(".new-session-page__select--agent .agent-select__trigger").click();
      await expect
        .poll(() =>
          agentDropdown.evaluate((dropdown) => (dropdown as HTMLElement & { open: boolean }).open),
        )
        .toBe(true);
      await navigate("new-session", "?agent=main&catalog=missing");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                document.querySelector(".new-session-page__select--agent wa-dropdown") as
                  | (HTMLElement & { open: boolean })
                  | null
              )?.open ?? false,
          ),
        )
        .toBe(false);
      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
      await expect.poll(async () => (await proof()).revoked).toBe(2);

      await navigate("new-session");
      await composer.waitFor();
      await pastePng(composer);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await navigate("chat");
      await page.waitForURL((url) => url.pathname.endsWith("/chat"));
      await expect.poll(async () => (await proof()).revoked).toBe(3);

      await navigate("new-session");
      await composer.waitFor();
      await pastePng(composer);
      await page.locator('.chat-attachment-thumb img[alt="Attachment preview"]').waitFor();
      await page.getByRole("button", { name: "Start session" }).click();
      await page.waitForURL(
        (url) => url.pathname === controlUiSessionPath("agent:main:preview-cleanup"),
      );
      await expect.poll(async () => await proof()).toEqual({ created: 4, revoked: 4 });
    });
  });

  it("locks the submitted draft until creation settles and restores it after failure", async () => {
    await withNewSessionPage(async (page) => {
      const sessionKey = "agent:main:locked-new-session-draft";
      const submittedMessage = "keep this submitted draft atomic";
      const gateway = await installMockGateway(page, {
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
          "sessions.create": { key: sessionKey },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.deferNext("sessions.create");

      const draft = page.locator(".new-session-page__scroll");
      const message = page.locator(".new-session-page__message");
      const placeSelect = page.locator("wa-popover.new-session-page__place-popover");
      const placeSummary = page.locator("#new-session-place-trigger");

      await message.fill(submittedMessage);
      await placeSummary.click();
      expect(await placeSelect.getAttribute("open")).not.toBeNull();
      await page.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ message: submittedMessage });
      await expect.poll(() => message.isDisabled()).toBe(true);
      expect(await draft.getAttribute("inert")).not.toBeNull();
      expect(await draft.getAttribute("aria-busy")).toBe("true");
      expect(await placeSelect.getAttribute("open")).toBeNull();
      expect(await placeSummary.isDisabled()).toBe(true);

      await expect(
        message.fill("silently discarded late edit", { timeout: 250 }),
      ).rejects.toThrow();
      await placeSummary.click({ force: true });
      await page.locator(".agent-chat__suggestion").first().click({ force: true });
      expect(await placeSelect.getAttribute("open")).toBeNull();
      expect(await message.inputValue()).toBe(submittedMessage);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);

      await gateway.rejectDeferred("sessions.create", {
        code: "UNAVAILABLE",
        message: "session creation unavailable",
      });
      await expect.poll(() => message.isDisabled()).toBe(false);
      expect(await draft.getAttribute("inert")).toBeNull();
      expect(await draft.getAttribute("aria-busy")).toBe("false");
      expect(await message.inputValue()).toBe(submittedMessage);
      expect(await placeSummary.isDisabled()).toBe(false);

      await page.getByRole("button", { name: "Start session" }).click();
      await expect.poll(async () => (await gateway.getRequests("sessions.create")).length).toBe(2);
      const retry = (await gateway.getRequests("sessions.create")).at(-1);
      expect(retry?.params).toMatchObject({ message: submittedMessage });
      await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
        timeout: 30_000,
      });
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
      await expect
        .poll(() => page.locator(".chat-queue__text").allInnerTexts(), { timeout: 30_000 })
        .toContain(message);
      await expect
        .poll(() => page.locator(".chat-queue__error").allInnerTexts(), { timeout: 30_000 })
        .toContain(runError);

      await page.reload();
      await expect
        .poll(() => page.locator(".chat-queue__text").allInnerTexts(), { timeout: 30_000 })
        .toContain(message);
      await expect
        .poll(() => page.locator(".chat-queue__error").allInnerTexts(), { timeout: 30_000 })
        .toContain(runError);

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
      await expect
        .poll(() => page.locator(".chat-queue__text").allInnerTexts(), { timeout: 30_000 })
        .toContain(message);
      await expect
        .poll(() => page.locator(".chat-queue__error").allInnerTexts(), { timeout: 30_000 })
        .toContain(runError);
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
