import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const runStartedAt = Date.now() - 5_000;

suite.define(() => {
  it("stops the session run spinner when a terminal sessions.changed event clears the active run", async () => {
    const agentsList = {
      agents: [{ id: "main", name: "Main" }],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    };

    // Initial session state: active run (spinner will show in the sidebar).
    const activeHistory = {
      messages: [],
      sessionId: "main-global-session",
      sessionInfo: {
        activeRunIds: ["run-active"],
        hasActiveRun: true,
        key: "global",
        startedAt: runStartedAt,
        status: "running",
      },
      thinkingLevel: null,
    };

    const activeSessionRow = {
      activeRunIds: ["run-active"],
      hasActiveRun: true,
      key: "global",
      kind: "global",
      label: "Main Session",
      startedAt: runStartedAt,
      status: "running",
      updatedAt: runStartedAt + 1_000,
    };

    const recordVideo = artifactDir
      ? { dir: artifactDir, size: { width: 1440, height: 900 } as const }
      : undefined;

    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(recordVideo ? { recordVideo } : {}),
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });

    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": agentsList,
        "chat.history": activeHistory,
        "chat.startup": { ...activeHistory, agentsList },
        "sessions.list": chatSessionListResponse([activeSessionRow]),
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const response = await page
        .locator(".agent-chat__composer-combobox textarea")
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => null);

      // Wait for the sidebar session list to render.
      await expect
        .poll(() => page.locator(".sidebar-recent-session").count(), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);

      // The spinner must be visible while the run is active (before the terminal event).
      await expect
        .poll(() => page.locator(".session-run-spinner").count())
        .toBeGreaterThanOrEqual(1);

      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/spinner-before.png`,
          fullPage: true,
        });
      }

      // Emit a terminal sessions.changed event — hasActiveRun: false with a
      // matching startedAt so the reconciler accepts it as the authoritative
      // final state for the active run (regression gate for the stale-spinner).
      await gateway.emitGatewayEvent("sessions.changed", {
        hasActiveRun: false,
        key: "global",
        kind: "global",
        startedAt: runStartedAt,
        status: "done",
        endedAt: runStartedAt + 2_000,
        updatedAt: runStartedAt + 2_000,
      });

      // The spinner must disappear once the terminal event clears the active run.
      await expect
        .poll(() => page.locator(".session-run-spinner").count(), { timeout: 10_000 })
        .toBe(0);

      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/spinner-after.png`,
          fullPage: true,
        });
      }

      // The "New Session" action must be enabled after the terminal event.
      const newSessionButton = page.locator(".sidebar-session-new, .sidebar-new-session");
      await expect.poll(() => newSessionButton.count()).toBeGreaterThanOrEqual(1);
      await expect
        .poll(() =>
          newSessionButton
            .first()
            .evaluate((el) => el instanceof HTMLElement && !el.hasAttribute("disabled")),
        )
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
