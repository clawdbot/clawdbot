import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const SESSION_KEY = "agent:main:transition-proof-0f403cb8-3920-4cf1-8eb7-79f2f00ce488";
const RUN_ID = "transition-proof-run";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "new-session-transition");
const captureProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function captureProof(page: import("playwright").Page, fileName: string) {
  if (!captureProofEnabled) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(proofDir, fileName) });
}

suite.define(() => {
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

      await page.getByRole("button", { name: "New session" }).first().click();
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

  it("keeps the new-session view live until the focused chat is ready", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
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
      methodResponses: {
        "sessions.create": {
          key: SESSION_KEY,
          messageSeq: 1,
          runId: RUN_ID,
          runStarted: true,
        },
        "sessions.list": createdSessionListResult(SESSION_KEY),
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      const start = page.locator(".new-session-page__start-submit");
      await message.fill("keep progress moving");
      await expect.poll(() => start.isEnabled()).toBe(true);

      await gateway.deferNext("sessions.create");
      await start.click();
      await gateway.waitForRequest("sessions.create");
      await gateway.resolveDeferred("sessions.create", {
        key: SESSION_KEY,
        messageSeq: 1,
        runId: RUN_ID,
        runStarted: true,
      });
      await expect.poll(() => chatModuleRequested).toBe(true);

      await expect.poll(() => start.getAttribute("aria-busy")).toBe("true");
      const spinner = start.locator("svg");
      const initialSpinnerTransform = await spinner.evaluate(
        (element) => getComputedStyle(element).transform,
      );
      await expect
        .poll(() => spinner.evaluate((element) => getComputedStyle(element).transform))
        .not.toBe(initialSpinnerTransform);
      await captureProof(page, "01-chat-route-preparing.png");

      await page.evaluate(() => {
        const frames = { invalid: 0, running: true };
        Reflect.set(globalThis, "__openclawSessionTransitionFrames", frames);
        const sample = () => {
          const outlet = document.querySelector("openclaw-router-outlet");
          const handoffCover = outlet?.classList.contains("session-route-handoff") === true;
          const newSessionVisible = Boolean(
            document.querySelector(".new-session-page__start-submit")?.getClientRects().length,
          );
          const chatVisible = Boolean(
            document.querySelector(".agent-chat__composer-combobox")?.getClientRects().length,
          );
          if (handoffCover || (!newSessionVisible && !chatVisible)) {
            frames.invalid += 1;
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
          page.evaluate(() => ({
            activeViewTransition: Boolean(document.activeViewTransition),
            chatSurfaceReady: Boolean(document.querySelector(".agent-chat__composer-combobox")),
            routeAnimation: document.getAnimations().some((animation) => {
              const effect = animation.effect as KeyframeEffect | null;
              return (
                effect?.target instanceof HTMLElement &&
                effect.target.tagName === "OPENCLAW-ROUTER-OUTLET" &&
                effect.getKeyframes().every((keyframe) => keyframe.opacity === undefined)
              );
            }),
          })),
        )
        .toEqual({ activeViewTransition: false, chatSurfaceReady: true, routeAnimation: true });
      await expect
        .poll(() => page.getByText("keep progress moving", { exact: true }).count())
        .toBe(1);
      const invalidFrames = await page.evaluate(() => {
        const frames = Reflect.get(globalThis, "__openclawSessionTransitionFrames") as {
          invalid: number;
          running: boolean;
        };
        frames.running = false;
        return frames.invalid;
      });
      expect(invalidFrames).toBe(0);
      await captureProof(page, "02-session-route-transition.png");
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
      await captureProof(page, "03-chat-route-ready.png");
    } finally {
      releaseChatModule();
      await context.close();
    }
  });
});
