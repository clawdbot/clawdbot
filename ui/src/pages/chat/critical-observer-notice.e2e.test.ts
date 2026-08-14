import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
} from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI critical observer notice mocked Gateway E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const artifactDir = path.resolve(
  process.cwd(),
  ".artifacts/control-ui-e2e/critical-observer-notice",
);
const selectedSessionKey = "agent:main:main";
const backgroundSessionKey = "agent:main:other";
const baseTime = Date.parse("2026-07-25T18:00:00.000Z");

function sessionsListResponse() {
  return {
    count: 2,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    path: "",
    sessions: [
      {
        key: selectedSessionKey,
        kind: "direct",
        label: "Main session",
        updatedAt: baseTime,
      },
      {
        key: backgroundSessionKey,
        kind: "direct",
        label: "Background investigation",
        updatedAt: baseTime - 1_000,
      },
    ],
    ts: baseTime,
  };
}

function observerDigest(params: {
  agentId?: string;
  sessionKey: string;
  health: "on-track" | "stuck";
  revision: number;
  headline: string;
}) {
  return {
    ...params,
    runId: `observer-run-${params.sessionKey}`,
    updatedAt: baseTime + params.revision,
  };
}

async function waitForToastUpdate(page: Page): Promise<void> {
  await page.locator("openclaw-toast-host").evaluate(async (element) => {
    await (element as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
  });
}

async function emitObserverAndReadToast(
  page: Page,
  payload: ReturnType<typeof observerDigest>,
  action?: "open" | "dismiss",
): Promise<{ actionable: boolean | null; message: string; visible: boolean }> {
  // Toasts auto-dismiss after 6000ms. Keep emit, read, and any action in one browser
  // step, including the shell's lazy runtime load and the toast host's Lit update.
  return await page.locator("openclaw-toast-host").evaluate(
    async (element, params) => {
      const host = element as HTMLElement & { updateComplete: Promise<unknown> };
      const app = document.querySelector("openclaw-app-shell") as
        | (HTMLElement & {
            criticalNoticeRuntime?: Promise<unknown> | null;
          })
        | null;
      const gateway = (
        window as Window & {
          openclawControlUiE2eGateway?: {
            emit: (event: string, payload?: unknown) => void;
          };
        }
      ).openclawControlUiE2eGateway;
      if (!app || !gateway) {
        throw new Error("Critical observer notice owner is unavailable");
      }

      gateway.emit("session.observer", params.payload);
      const runtime = app.criticalNoticeRuntime;
      if (!runtime) {
        throw new Error("Critical observer notice runtime did not start");
      }
      await runtime;
      await host.updateComplete;

      const toast = host.querySelector<HTMLElement>(".app-toast");
      const isVisible = (target: HTMLElement | null): target is HTMLElement => {
        if (!target?.isConnected) {
          return false;
        }
        const style = getComputedStyle(target);
        const bounds = target.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const visible = isVisible(toast);
      let actionable: boolean | null = null;
      const result = () => ({
        actionable,
        message: toast?.querySelector(".app-toast__message")?.textContent ?? "",
        visible,
      });
      if (params.action) {
        const selector = params.action === "open" ? ".app-toast__action" : ".app-toast__dismiss";
        const button = toast?.querySelector<HTMLButtonElement>(selector);
        if (!button) {
          throw new Error(`Toast ${params.action} action is unavailable`);
        }
        const bounds = button.getBoundingClientRect();
        const hitTarget = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        actionable =
          visible &&
          isVisible(button) &&
          !button.disabled &&
          Boolean(hitTarget && (hitTarget === button || button.contains(hitTarget)));
        if (!actionable) {
          return result();
        }
        button.click();
        await host.updateComplete;
      }
      return result();
    },
    { action, payload },
  );
}

suite.define(() => {
  it("keeps a critical notice above a shadow-root modal through nested overlay hides", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            {
              content: [{ type: "text", text: "Selected session A is ready." }],
              role: "assistant",
              timestamp: baseTime,
            },
          ],
          methodResponses: {
            "sessions.list": sessionsListResponse(),
          },
          sessionKey: selectedSessionKey,
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        await page.getByText("Selected session A is ready.").waitFor({ state: "visible" });

        await page.evaluate(() => {
          const owner = document.createElement("div");
          owner.id = "toast-shadow-owner";
          const modal = document.createElement("openclaw-modal-dialog");
          modal.label = "Shadow modal";
          const content = document.createElement("button");
          content.textContent = "Modal action";
          modal.append(content);
          owner.attachShadow({ mode: "open" }).append(modal);
          document.body.append(owner);
        });
        const modal = page.locator("#toast-shadow-owner").locator("openclaw-modal-dialog");
        await page.getByRole("dialog", { name: "Shadow modal" }).waitFor({ state: "visible" });

        const headline = "Shadow-root session needs attention";
        const result = await emitObserverAndReadToast(
          page,
          observerDigest({
            sessionKey: backgroundSessionKey,
            health: "stuck",
            headline,
            revision: 1,
          }),
        );
        expect(result.visible).toBe(true);
        expect(result.message).toContain(headline);

        const host = modal.locator(":scope > openclaw-toast-host");
        await expect.poll(() => host.count()).toBe(1);
        await modal.evaluate((element) => {
          const nestedOverlay = document.createElement("div");
          element.append(nestedOverlay);
          nestedOverlay.dispatchEvent(
            new CustomEvent("wa-after-hide", { bubbles: true, composed: true }),
          );
          nestedOverlay.remove();
        });
        await expect.poll(() => host.count()).toBe(1);
        await host.locator(".app-toast__action").click({ trial: true });

        await modal.evaluate((element) => (element as HTMLElement & { hide: () => void }).hide());
        const appToast = page.locator(".shell > openclaw-toast-host .app-toast");
        await expect.poll(() => appToast.textContent()).toContain(headline);
        await appToast.getByRole("button", { name: "Dismiss" }).click();
      },
    );
  });

  it("announces critical background sessions, navigates, and dedupes after dismissal", async () => {
    await rm(artifactDir, { force: true, recursive: true });
    await mkdir(artifactDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        page.setDefaultTimeout(10_000);

        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              content: [{ type: "text", text: "Selected session A is ready." }],
              role: "assistant",
              timestamp: baseTime,
            },
          ],
          methodResponses: {
            "sessions.list": sessionsListResponse(),
          },
          sessionKey: selectedSessionKey,
        });

        const response = await page.goto(
          controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey),
        );
        expect(response?.status()).toBe(200);
        await page.getByText("Selected session A is ready.").waitFor({ state: "visible" });
        expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(selectedSessionKey));

        const toast = page.locator(".app-toast");
        await gateway.emitGatewayEvent(
          "session.observer",
          observerDigest({
            sessionKey: backgroundSessionKey,
            health: "on-track",
            headline: "Background session is healthy",
            revision: 1,
          }),
        );
        await waitForToastUpdate(page);
        expect(await toast.count()).toBe(0);

        await gateway.emitGatewayEvent(
          "session.observer",
          observerDigest({
            sessionKey: selectedSessionKey,
            health: "stuck",
            headline: "Selected session needs attention",
            revision: 1,
          }),
        );
        await waitForToastUpdate(page);
        expect(await toast.count()).toBe(0);

        const firstHeadline = "Background verification is stuck";
        const firstToast = await emitObserverAndReadToast(
          page,
          observerDigest({
            sessionKey: backgroundSessionKey,
            health: "stuck",
            headline: firstHeadline,
            revision: 2,
          }),
          "open",
        );
        expect(firstToast.visible).toBe(true);
        expect(firstToast.actionable).toBe(true);
        expect(firstToast.message).toContain(firstHeadline);
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "01-critical-background-session.png"),
        });

        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath(backgroundSessionKey));
        expect(await toast.count()).toBe(0);
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "02-after-open-thread-navigation.png"),
        });

        await page.locator("a.nav-item--home").click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath(selectedSessionKey));

        await gateway.emitGatewayEvent(
          "session.observer",
          observerDigest({
            sessionKey: backgroundSessionKey,
            health: "on-track",
            headline: "Background verification recovered",
            revision: 3,
          }),
        );
        await waitForToastUpdate(page);
        expect(await toast.count()).toBe(0);

        const dismissToast = await emitObserverAndReadToast(
          page,
          observerDigest({
            sessionKey: backgroundSessionKey,
            health: "stuck",
            headline: "Background verification is stuck again",
            revision: 4,
          }),
          "dismiss",
        );
        expect(dismissToast.visible).toBe(true);
        expect(dismissToast.actionable).toBe(true);
        expect(await toast.count()).toBe(0);

        await gateway.emitGatewayEvent(
          "session.observer",
          observerDigest({
            sessionKey: backgroundSessionKey,
            health: "stuck",
            headline: "Repeated stuck update remains deduped",
            revision: 5,
          }),
        );
        await waitForToastUpdate(page);
        expect(await toast.count()).toBe(0);
      },
    );
  });

  it.each([
    {
      name: "suppresses the configured selected-agent foreground alias",
      agentId: "work",
      sessionKey: "agent:work:primary",
      visible: false,
    },
    {
      name: "suppresses the canonical selected-agent global foreground",
      agentId: "work",
      sessionKey: "global",
      visible: false,
    },
    {
      name: "announces a genuine selected-agent background session",
      agentId: "work",
      sessionKey: "agent:work:investigation",
      visible: true,
    },
    {
      name: "announces a genuine other-agent configured-main session",
      agentId: "other",
      sessionKey: "agent:other:primary",
      visible: true,
    },
  ])("mocked-Gateway Chromium configured-global alias: $name", async (testCase) => {
    const historyMessages = [
      {
        content: [{ type: "text", text: "Configured global foreground is ready." }],
        role: "assistant",
        timestamp: baseTime,
      },
    ];
    const agentsList = {
      agents: [
        { id: "work", identity: { name: "Work" }, name: "Work" },
        { id: "other", identity: { name: "Other" }, name: "Other" },
      ],
      defaultId: "work",
      mainKey: "primary",
      scope: "global",
    };
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        page.setDefaultTimeout(10_000);

        const gateway = await installMockGateway(page, {
          assistantAgentId: "work",
          defaultAgentId: "work",
          historyMessages,
          methodResponses: {
            "agents.list": agentsList,
            "chat.startup": {
              agentsList,
              messages: historyMessages,
              metadata: {
                models: [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }],
              },
              sessionId: "configured-global-observer-session",
              thinkingLevel: null,
            },
            "sessions.list": {
              count: 3,
              defaults: {
                contextTokens: null,
                model: "gpt-5.5",
                modelProvider: "openai",
              },
              path: "",
              sessions: [
                {
                  key: "global",
                  kind: "global",
                  label: "Configured global foreground",
                  updatedAt: baseTime,
                },
                {
                  key: "agent:work:investigation",
                  kind: "direct",
                  label: "Selected-agent background investigation",
                  updatedAt: baseTime - 1_000,
                },
                {
                  key: "agent:other:primary",
                  kind: "direct",
                  label: "Other-agent configured main",
                  updatedAt: baseTime - 2_000,
                },
              ],
              ts: baseTime,
            },
          },
          sessionKey: "global",
        });

        const globalRouteKey = "agent:work:global";
        const response = await page.goto(controlUiSessionUrl(suite.server.baseUrl, globalRouteKey));
        expect(response?.status()).toBe(200);
        await page
          .getByText("Configured global foreground is ready.")
          .waitFor({ state: "visible" });
        expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(globalRouteKey));
        expect(await gateway.getRequests("connect")).toHaveLength(1);

        const headline = `Configured-global observer notice for ${testCase.sessionKey}`;
        const digest = observerDigest({
          agentId: testCase.agentId,
          sessionKey: testCase.sessionKey,
          health: "stuck",
          headline,
          revision: 1,
        });

        const toast = page.locator(".app-toast");
        if (testCase.visible) {
          const toastState = await emitObserverAndReadToast(page, digest);
          expect(toastState.visible).toBe(true);
          expect(toastState.message).toContain(headline);
        } else {
          await gateway.emitGatewayEvent("session.observer", digest);
          await waitForToastUpdate(page);
          expect(await toast.count()).toBe(0);
        }
      },
    );
  });
});
