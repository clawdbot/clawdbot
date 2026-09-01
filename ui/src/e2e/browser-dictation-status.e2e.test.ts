import path from "node:path";
// Control UI E2E tests cover visible browser dictation state through a real composer.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureComposerProof,
  installTalkBrowserFixtures,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser dictation status",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

suite.define(() => {
  it.each([
    { name: "caret insertion", start: 5, end: 5, expected: "ship please it", cancel: false },
    { name: "selection replacement", start: 5, end: 7, expected: "ship please", cancel: false },
    { name: "cancel after blur", start: 7, end: 7, expected: "ship it please", cancel: true },
  ])("preserves the draft through $name", async ({ name, start, end, expected, cancel }) => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["talk.session.create"],
        methodResponses: {
          "talk.catalog": {
            transcription: { ready: true, providers: [] },
            realtime: { providers: [] },
            speech: { providers: [] },
            modes: [],
            transports: [],
            brains: [],
          },
          "talk.session.create": {
            sessionId: "dictation-preview-proof",
            transcriptionSessionId: "dictation-preview-proof",
            audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
          },
        },
      });
      await installTalkBrowserFixtures(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const textarea = page.locator(".agent-chat__composer-combobox textarea");
      await textarea.fill("ship it");
      await textarea.evaluate(
        (element: HTMLTextAreaElement, selection) =>
          element.setSelectionRange(selection.start, selection.end),
        { start, end },
      );
      await page.getByRole("button", { name: "Start voice input" }).hover();
      await page.mouse.down();
      await gateway.waitForRequest("talk.session.create");
      await gateway.resolveDeferred("talk.session.create");
      await page.mouse.up();
      await gateway.emitGatewayEvent("talk.event", {
        transcriptionSessionId: "dictation-preview-proof",
        type: "partial",
        text: "please",
      });
      await expect.poll(() => textarea.inputValue()).toBe(expected);
      if (cancel) {
        await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
        await page.keyboard.press("Escape");
      } else {
        await page.getByRole("button", { name: "Stop and keep text" }).click();
      }
      await gateway.waitForRequest("talk.session.close");
      const committedDraft = cancel ? "ship it" : expected;
      expect(await textarea.inputValue()).toBe(committedDraft);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await captureComposerProof(
        suite,
        page,
        `dictation-${name.replaceAll(" ", "-")}-committed.png`,
      );
      expect(await textarea.inputValue()).toBe(committedDraft);
    });
  });

  it.each([false, true])(
    "cancels new-session dictation after dismissing any tooltip (open: %s)",
    async (tooltipOpen) => {
      await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["talk.session.create"],
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create", "sessions.dispatch"],
          methodResponses: {
            "talk.catalog": {
              transcription: { ready: true, providers: [] },
              realtime: { providers: [] },
              speech: { providers: [] },
              modes: [],
              transports: [],
              brains: [],
            },
            "talk.session.create": {
              sessionId: "dictation-direct-proof",
              transcriptionSessionId: "dictation-direct-proof",
              audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
            },
          },
        });
        await installTalkBrowserFixtures(page);
        await page.goto(`${suite.server.baseUrl}new`);
        const textarea = page.locator(".new-session-page__message");
        await textarea.fill("keep this draft");
        await page.getByRole("button", { name: "Dictate", exact: true }).click();
        await gateway.waitForRequest("talk.session.create");
        await gateway.resolveDeferred("talk.session.create");
        await gateway.emitGatewayEvent("talk.event", {
          transcriptionSessionId: "dictation-direct-proof",
          type: "partial",
          text: "discard this speech",
        });
        await expect.poll(() => textarea.inputValue()).toContain("discard this speech");
        await gateway.emitGatewayEvent("talk.event", {
          transcriptionSessionId: "dictation-direct-proof",
          type: "transcript",
          text: "discard this speech",
          final: true,
        });
        await expect.poll(() => textarea.inputValue()).toBe("keep this draft discard this speech");
        await gateway.emitGatewayEvent("talk.event", {
          transcriptionSessionId: "dictation-direct-proof",
          type: "partial",
          text: "too",
        });
        await expect
          .poll(() => textarea.inputValue())
          .toBe("keep this draft discard this speech too");
        await gateway.emitGatewayEvent("talk.event", {
          transcriptionSessionId: "dictation-direct-proof",
          type: "transcript",
          text: "",
          final: true,
        });
        await expect
          .poll(() => textarea.inputValue())
          .toBe("keep this draft discard this speech too");
        await captureComposerProof(
          suite,
          page,
          `dictation-new-session-${tooltipOpen ? "tooltip" : "composer"}-preview.png`,
        );
        // Clicking Dictate changes the hovered button into Stop; its hover hint
        // can open while transcripts arrive. Establish which surface Escape owns.
        await textarea.hover();
        await textarea.focus();
        const openTooltips = page.locator("openclaw-tooltip[open]");
        await expect.poll(() => openTooltips.count()).toBe(0);
        if (tooltipOpen) {
          const stop = page.getByRole("button", { name: "Stop and keep text" });
          const tooltip = stop.locator("..").locator("wa-tooltip");
          await stop.hover();
          await expect.poll(() => tooltip.getAttribute("open")).not.toBeNull();

          await page.keyboard.press("Escape");

          await expect.poll(() => tooltip.getAttribute("open")).toBeNull();
          expect(await textarea.inputValue()).toBe("keep this draft discard this speech too");
          expect(await textarea.evaluate((element: HTMLTextAreaElement) => element.readOnly)).toBe(
            true,
          );
          expect(await textarea.evaluate((element) => document.activeElement === element)).toBe(
            true,
          );
          expect(await gateway.getRequests("talk.session.close")).toHaveLength(0);
        }
        await page.keyboard.press("Escape");
        await expect.poll(() => textarea.inputValue()).toBe("keep this draft");
        await gateway.waitForRequest("talk.session.close");
        expect(await page.getByRole("button", { name: "Dictate", exact: true }).isVisible()).toBe(
          true,
        );
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await textarea.evaluate((element: HTMLTextAreaElement) => element.readOnly)).toBe(
          false,
        );
        expect(await gateway.getRequests("talk.session.close")).toHaveLength(1);
        await captureComposerProof(
          suite,
          page,
          `dictation-new-session-${tooltipOpen ? "tooltip" : "composer"}-cancelled.png`,
        );
      });
    },
  );

  it("keeps the hold-to-dictate switch interactive without closing the microphone picker", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "talk.catalog": {
            transcription: { ready: true, providers: [] },
            realtime: { ready: true, providers: [] },
            speech: { providers: [] },
            modes: [],
            transports: [],
            brains: [],
          },
        },
      });
      await installTalkBrowserFixtures(page);
      await page.goto(`${suite.server.baseUrl}chat`);

      const voice = page.getByRole("button", { name: "Start voice input" });
      await voice.hover();
      await page.getByRole("button", { name: "Microphone input" }).click();
      const picker = page.locator("wa-dropdown.chat-talk-input-picker");
      const toggle = page.locator('.chat-talk-input-picker__preference [role="switch"]');
      await expect.poll(() => picker.getAttribute("open")).not.toBeNull();
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("true");

      await toggle.click();

      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
      await expect.poll(() => picker.getAttribute("open")).not.toBeNull();
      await captureComposerProof(suite, page, "microphone-picker-hold-toggle.png");
      await page.screenshot({
        animations: "disabled",
        path: path.join(suite.artifactDir, "voice-controls/microphone-picker-hold-toggle-full.png"),
      });
    });
  });

  it("gates unavailable voice capabilities in the microphone picker", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "talk.catalog": {
            transcription: { ready: false, providers: [] },
            realtime: { ready: false, providers: [] },
            speech: { providers: [] },
            modes: [],
            transports: [],
            brains: [],
          },
        },
      });
      await installTalkBrowserFixtures(page);
      await page.goto(`${suite.server.baseUrl}chat`);

      await page.getByRole("button", { name: "Start voice input" }).click();
      const unavailable = page.locator('[data-status="unavailable"]');
      await expect.poll(() => unavailable.count()).toBe(2);
      await expect
        .poll(() => unavailable.getByRole("button", { name: "Configure" }).count())
        .toBe(2);
      await captureComposerProof(suite, page, "microphone-picker-capability-gating.png");
      await page.screenshot({
        animations: "disabled",
        path: path.join(
          suite.artifactDir,
          "voice-controls/microphone-picker-capability-gating-full.png",
        ),
      });
    });
  });

  it("keeps dictation activity and the insert/discard actions visible", async () => {
    await suite.withPage(
      { permissions: ["microphone"], viewport: { width: 390, height: 844 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "talk.catalog": {
              transcription: { ready: true, providers: [] },
              realtime: { providers: [] },
              speech: { providers: [] },
              modes: [],
              transports: [],
              brains: [],
            },
            "talk.session.create": {
              sessionId: "dictation-browser-proof",
              transcriptionSessionId: "dictation-browser-proof",
              audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
            },
          },
        });
        await installTalkBrowserFixtures(page);
        await page.goto(`${suite.server.baseUrl}chat`);

        const microphone = page.getByRole("button", { name: "Dictation" });
        await microphone.click();
        await gateway.waitForRequest("talk.session.create");

        const composer = page.locator(".agent-chat__input--dictating");
        const phase = composer.locator(".agent-chat__dictation-phase");
        const stop = composer.getByRole("button", { name: "Stop and keep text" });
        const send = composer.getByRole("button", { name: "Send", exact: true });
        await expect.poll(() => phase.isVisible()).toBe(true);
        await expect
          .poll(() => phase.textContent().then((text) => text?.trim()))
          .toBe("Listening…");
        expect(await composer.locator(".agent-chat__dictation-wave").count()).toBe(0);
        expect(await composer.locator(".agent-chat__dictation-elapsed").count()).toBe(0);
        await expect.poll(() => stop.isVisible()).toBe(true);
        await expect.poll(() => send.isVisible()).toBe(true);
        await captureComposerProof(suite, page, "dictation-status-actions.png");
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "voice-controls/dictation-latched-after-release.png"),
        });
        const composerBox = await composer.boundingBox();
        expect(composerBox).not.toBeNull();
        if (!composerBox) {
          throw new Error("expected active dictation composer layout box");
        }
        for (const control of [phase, stop, send]) {
          const box = await control.boundingBox();
          expect(box).not.toBeNull();
          if (!box) {
            throw new Error("expected visible dictation control layout box");
          }
          expect(box.x).toBeGreaterThanOrEqual(composerBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);
        }

        await stop.click();
        await expect.poll(() => microphone.isVisible()).toBe(true);
      },
    );
  });
});
