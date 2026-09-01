import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const QUEUED = ["review the migration", "then update the docs", "finally run the smoke"] as const;

suite.define(() => {
  it("edits a queued message in its row and returns it to its place", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 15_000 });

      // Offline holds the queue still, so the round-trip stays observable.
      await gateway.setOnline(false);
      await gateway.closeLatest();
      for (const message of QUEUED) {
        await composer.fill(message);
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
      }
      const queueText = () =>
        page.locator(".chat-queue__item").evaluateAll((rows) =>
          rows.map((row) => {
            const editor = row.querySelector(".chat-queue__edit-input");
            return editor instanceof HTMLTextAreaElement
              ? editor.value
              : (row.querySelector(".chat-queue__text")?.textContent ?? "");
          }),
        );
      expect(await queueText()).toEqual([...QUEUED]);

      await composer.fill("a separate composer draft");

      // Double-click is the shortcut; the pencil on the row is the visible path.
      await page.locator(".chat-queue__item").nth(1).dblclick();

      const rowEditor = page.locator(".chat-queue__item").nth(1).locator(".chat-queue__edit-input");
      await rowEditor.waitFor({ timeout: 10_000 });
      await rowEditor.press("ControlOrMeta+A");
      expect(await rowEditor.inputValue()).toBe(QUEUED[1]);
      expect(await composer.inputValue()).toBe("a separate composer draft");
      // The row stays where it is, marked as the one being edited.
      expect(await queueText()).toEqual([...QUEUED]);
      expect(await page.locator(".chat-queue__item--editing").count()).toBe(1);

      await page.keyboard.insertText("then update the docs and the changelog");
      await page.locator(".chat-queue__edit-submit").click();

      await expect
        .poll(queueText, { timeout: 10_000 })
        .toEqual([QUEUED[0], "then update the docs and the changelog", QUEUED[2]]);
      expect(await composer.inputValue()).toBe("a separate composer draft");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("puts the row back untouched when the edit is cancelled", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 15_000 });
      await gateway.setOnline(false);
      await gateway.closeLatest();
      for (const message of QUEUED) {
        await composer.fill(message);
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
      }

      await composer.fill("a separate composer draft");
      const row = page.locator(".chat-queue__item").nth(1);
      await row.dblclick();
      const rowEditor = row.locator(".chat-queue__edit-input");
      await rowEditor.waitFor({ timeout: 10_000 });
      await rowEditor.fill("a replacement the operator abandons");

      await rowEditor.press("Escape");

      await expect
        .poll(() => page.locator(".chat-queue__item .chat-queue__text").allTextContents(), {
          timeout: 10_000,
        })
        .toEqual([...QUEUED]);
      expect(await composer.inputValue()).toBe("a separate composer draft");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps a normal composer send separate from an open row edit", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 15_000 });
      await gateway.setOnline(false);
      await gateway.closeLatest();
      for (const message of QUEUED) {
        await composer.fill(message);
        await composer.press("Enter");
        await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
      }

      const row = page.locator(".chat-queue__item").nth(1);
      await row.dblclick();
      const rowEditor = row.locator(".chat-queue__edit-input");
      await rowEditor.waitFor({ timeout: 10_000 });
      await composer.fill("a separate composer send");
      await composer.press("Enter");

      await page
        .locator(".chat-queue__item", { hasText: "a separate composer send" })
        .waitFor({ timeout: 10_000 });
      await expect.poll(() => rowEditor.inputValue(), { timeout: 10_000 }).toBe(QUEUED[1]);
      expect(await composer.inputValue()).toBe("");
      expect(await page.locator(".chat-queue__item").count()).toBe(4);

      await rowEditor.press("Escape");
      await expect
        .poll(() => page.locator(".chat-queue__item .chat-queue__text").allTextContents(), {
          timeout: 10_000,
        })
        .toEqual([...QUEUED, "a separate composer send"]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps edit, remove, and reorder outcomes exact through reconnect", async () => {
    const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactDirParent
      ? createControlUiE2eArtifactDir("chat-flow.queue-edit", artifactDirParent)
      : undefined;
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionId: "session:agent:main:main",
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.goto(`${suite.server.baseUrl}chat?session=main`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 15_000 });
      await composer.fill("keep the first run active");
      await page.getByRole("button", { name: "Send message" }).click();
      const active = requireRecord((await gateway.waitForRequest("chat.send")).params);
      const activeRunId = requireString(active.idempotencyKey, "active run idempotency key");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      // The active seed turn is delivered; only the four later turns are queued.
      const acceptedSession = {
        key: "agent:main:main",
        sessionId: "session:agent:main:main",
        hasActiveRun: true,
        activeRunIds: [activeRunId],
        status: "running",
      };
      await gateway.setMethodResponse("chat.history", {
        sessionId: acceptedSession.sessionId,
        sessionInfo: acceptedSession,
        messages: [
          {
            role: "user",
            content: "keep the first run active",
            idempotencyKey: `${activeRunId}:user`,
          },
        ],
      });
      await gateway.emitGatewayEvent("sessions.changed", acceptedSession);
      await page.locator(".chat-send-status").waitFor({ state: "detached" });

      for (const message of ["send first", "edit before send", "remove me", "send last"]) {
        await composer.fill(message);
        await page.getByRole("button", { name: "Queue message" }).click();
        await page.locator(".chat-queue__item", { hasText: message }).waitFor({ timeout: 10_000 });
      }
      await gateway.setOnline(false);
      await gateway.closeLatest();
      await page
        .locator(
          '.agent-chat__composer-underlaps[data-tone="warn"] .agent-chat__composer-status-band',
        )
        .waitFor({ timeout: 10_000 });

      const editRow = page.locator(".chat-queue__item", { hasText: "edit before send" });
      await editRow.dblclick();
      // `hasText` stops matching once the row text becomes a textarea value.
      const inlineEditor = page.locator(".chat-queue__edit-input");
      await inlineEditor.waitFor({ timeout: 10_000 });
      await inlineEditor.press("ControlOrMeta+A");
      await page.keyboard.insertText("edited before send");
      await inlineEditor.press("Control+Enter");
      await page.locator(".chat-queue__item", { hasText: "edited before send" }).waitFor();

      const lastGrip = page
        .locator(".chat-queue__item", { hasText: "send last" })
        .locator(".chat-queue__grip");
      await lastGrip.focus();
      for (const expected of [
        ["send first", "edited before send", "send last", "remove me"],
        ["send first", "send last", "edited before send", "remove me"],
        ["send last", "send first", "edited before send", "remove me"],
      ]) {
        await page.keyboard.press("ArrowUp");
        await expect
          .poll(() => page.locator(".chat-queue__item .chat-queue__text").allTextContents())
          .toEqual(expected);
      }

      const row = page.locator(".chat-queue__item", {
        hasText: "remove me",
      });

      await page.evaluate(() => {
        const descriptor = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem");
        if (!descriptor || typeof descriptor.value !== "function") {
          throw new Error("Storage.setItem is unavailable");
        }
        const original = descriptor.value as (this: Storage, key: string, value: string) => void;
        Object.defineProperty(window, "restoreQueueStorage", {
          configurable: true,
          value: () => {
            Object.defineProperty(Storage.prototype, "setItem", descriptor);
            delete (window as Window & { restoreQueueStorage?: () => void }).restoreQueueStorage;
          },
        });
        Object.defineProperty(Storage.prototype, "setItem", {
          ...descriptor,
          value(this: Storage, ...args: [string, string]) {
            if (this === window.sessionStorage) {
              throw new DOMException("exceeded the quota", "QuotaExceededError");
            }
            return Reflect.apply(original, this, args);
          },
        });
      });
      await row.locator(".chat-queue__remove").click();

      await page
        .getByRole("alert")
        .getByText("Could not store this message for reconnect.", { exact: false })
        .waitFor({ timeout: 10_000 });
      await row.waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      if (artifactDir) {
        await page.waitForTimeout(100);
        await page.screenshot({ path: `${artifactDir}/01-remove-rejected.png`, fullPage: true });
      }

      await page.evaluate(() => {
        (window as Window & { restoreQueueStorage?: () => void }).restoreQueueStorage?.();
      });
      await page.evaluate(() => {
        const trace: Array<{ detail: number; rowText?: string }> = [];
        Object.defineProperty(window, "queueRemovalEventTrace", {
          configurable: true,
          value: trace,
        });
        document.addEventListener(
          "click",
          (event) => {
            const target = event.target instanceof Element ? event.target : null;
            trace.push({
              detail: (event as MouseEvent).detail,
              rowText: target?.closest(".chat-queue__item")?.querySelector(".chat-queue__text")
                ?.textContent,
            });
          },
          { capture: true },
        );
      });
      await row.locator(".chat-queue__remove").click();
      await row.waitFor({ state: "detached", timeout: 10_000 });
      // Queue reflow can move the next row away from the first click's coordinates.
      // Aim the native second click at its remove control without another first click.
      await page
        .locator(".chat-queue__item", { hasText: "edited before send" })
        .locator(".chat-queue__remove")
        .hover();
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      expect(
        await page.evaluate(
          () =>
            (
              window as Window & {
                queueRemovalEventTrace?: Array<{ detail: number; rowText?: string }>;
              }
            ).queueRemovalEventTrace,
        ),
      ).toEqual([
        { detail: 1, rowText: "remove me" },
        { detail: 2, rowText: "edited before send" },
      ]);
      await page.getByRole("alert").waitFor({ state: "detached", timeout: 10_000 });
      await expect
        .poll(() => page.locator(".chat-queue__item .chat-queue__text").allTextContents())
        .toEqual(["send last", "send first", "edited before send"]);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      const queueDisposable = async (text: string) => {
        await composer.fill(text);
        await composer.press("Enter");
        const disposable = page.locator(".chat-queue__item", { hasText: text });
        await disposable.waitFor({ timeout: 10_000 });
        return disposable;
      };
      const singleClickRow = await queueDisposable("single-click removal");
      await singleClickRow.locator(".chat-queue__remove").click();
      await singleClickRow.waitFor({ state: "detached", timeout: 10_000 });
      const keyboardRow = await queueDisposable("keyboard removal");
      await keyboardRow.locator(".chat-queue__remove").focus();
      await page.keyboard.press("Enter");
      await keyboardRow.waitFor({ state: "detached", timeout: 10_000 });
      const programmaticRow = await queueDisposable("programmatic removal");
      await programmaticRow
        .locator(".chat-queue__remove")
        .evaluate((button: HTMLElement) => button.click());
      await programmaticRow.waitFor({ state: "detached", timeout: 10_000 });
      await page.getByRole("alert").waitFor({ state: "detached", timeout: 10_000 });
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/02-duplicate-noop.png`, fullPage: true });
      }

      const terminalSession = {
        ...acceptedSession,
        activeRunIds: [],
        hasActiveRun: false,
        lastRunId: activeRunId,
        status: "done",
      };
      await gateway.setMethodResponse("chat.history", {
        sessionId: acceptedSession.sessionId,
        sessionInfo: terminalSession,
        messages: [
          {
            role: "user",
            content: "keep the first run active",
            idempotencyKey: `${activeRunId}:user`,
          },
        ],
      });
      await gateway.deferNext("chat.send");
      await gateway.setOnline(true);
      await page
        .locator(
          '.agent-chat__composer-underlaps[data-tone="warn"] .agent-chat__composer-status-band',
        )
        .waitFor({ state: "detached", timeout: 10_000 });
      await gateway.emitChatFinal({ runId: activeRunId, text: "Initial run completed." });
      await gateway.emitGatewayEvent("sessions.changed", terminalSession);

      const first = requireRecord((await waitForRequests(gateway, "chat.send", 2))[1]?.params);
      expect(first.message).toBe("send last");
      const firstRunId = requireString(first.idempotencyKey, "first queued send idempotency key");
      await gateway.resolveDeferred("chat.send", { runId: firstRunId, status: "started" });
      await gateway.emitChatFinal({ runId: firstRunId, text: "First queued turn completed." });

      const second = requireRecord((await waitForRequests(gateway, "chat.send", 3))[2]?.params);
      const secondRunId = requireString(
        second.idempotencyKey,
        "second queued send idempotency key",
      );
      await gateway.emitChatFinal({ runId: secondRunId, text: "Second queued turn completed." });

      const sends = await waitForRequests(gateway, "chat.send", 4);
      const third = requireRecord(sends[3]?.params);
      const thirdRunId = requireString(third.idempotencyKey, "third queued send idempotency key");
      await gateway.emitChatFinal({ runId: thirdRunId, text: "Third queued turn completed." });
      const params = sends.map((request) => requireRecord(request.params));
      expect(params.map((entry) => entry.message)).toEqual([
        "keep the first run active",
        "send last",
        "send first",
        "edited before send",
      ]);
      expect(new Set(params.map((entry) => entry.idempotencyKey)).size).toBe(4);
      await expectRequestCountStable(gateway, "chat.send", 4);
      await page.locator(".chat-queue").waitFor({ state: "detached", timeout: 10_000 });
      if (artifactDir) {
        await page.screenshot({ path: `${artifactDir}/03-exact-drain.png`, fullPage: true });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
