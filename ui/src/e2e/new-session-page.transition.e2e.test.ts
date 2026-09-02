import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureControlUiE2eFailureDiagnostics,
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
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
});
