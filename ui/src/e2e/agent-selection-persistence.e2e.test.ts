import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  type ControlUiMockGatewayScenario,
  type MockGatewayControls,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent selection persistence",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("agent-selection-persistence");
  }
});

const agentsList = {
  agents: [
    { id: "dummy", identity: { name: "Dummy" }, kind: "agent", name: "Dummy" },
    { id: "openclaw", identity: { name: "OpenClaw" }, kind: "agent", name: "OpenClaw" },
  ],
  defaultId: "dummy",
  mainKey: "main",
  scope: "global",
};

const scenario: ControlUiMockGatewayScenario = {
  assistantAgentId: "dummy",
  assistantName: "Dummy",
  defaultAgentId: "dummy",
  sessionKey: "global",
  sessionScope: "global",
  methodResponses: {
    "agent.identity.get": {
      cases: [
        {
          match: { agentId: "dummy" },
          response: { agentId: "dummy", avatar: "", emoji: "D", name: "Dummy" },
        },
        {
          match: { agentId: "openclaw" },
          response: { agentId: "openclaw", avatar: "", emoji: "O", name: "OpenClaw" },
        },
      ],
    },
    "agents.list": agentsList,
    "chat.startup": {
      agentsList,
      messages: [],
      metadata: { models: [] },
      sessionId: "control-ui-agent-selection-persistence",
      thinkingLevel: null,
    },
    "sessions.list": {
      count: 1,
      defaults: {},
      path: "",
      sessions: [{ key: "global", kind: "global", updatedAt: 1 }],
      ts: 1,
    },
  },
};

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.waitForTimeout(600);
  await writeFile(
    path.join(proofDir, name),
    await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
      page.locator(".sidebar-agent-card__name"),
    ]),
  );
}

async function selectedAgentName(page: Page): Promise<string> {
  const text =
    (await page.locator("openclaw-app-sidebar .sidebar-agent-card__name").textContent()) ?? "";
  return text.trim();
}

async function hasOpenClawStartup(gateway: MockGatewayControls): Promise<boolean> {
  return (await gateway.getRequests("chat.startup")).some((request) => {
    const params = request.params as
      | { agentId?: unknown; limit?: unknown; sessionKey?: unknown }
      | undefined;
    return (
      params?.agentId === "openclaw" &&
      params.sessionKey === "agent:openclaw:main" &&
      params.limit === 80
    );
  });
}

async function persistCanonicalGlobalSession(page: Page): Promise<void> {
  await page.evaluate(
    ({ gatewayUrl, settingsKey }) => {
      const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as {
        sessionsByGateway?: Record<string, { lastActiveSessionKey?: string; sessionKey?: string }>;
      };
      const session = settings.sessionsByGateway?.[gatewayUrl];
      if (!session) {
        throw new Error("Bundled Gateway session selection was not persisted");
      }
      session.sessionKey = "global";
      session.lastActiveSessionKey = "global";
      localStorage.setItem(settingsKey, JSON.stringify(settings));
    },
    {
      gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
      settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
    },
  );
}

async function openPage(
  context: BrowserContext,
): Promise<{ gateway: MockGatewayControls; page: Page }> {
  const page = await context.newPage();
  const gateway = await installMockGateway(page, scenario);
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator("openclaw-app-sidebar").waitFor();
  return { gateway, page };
}

suite.define(() => {
  it("restores the selected agent when a fresh shell reopens the canonical global session", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
      ...(captureUiProof
        ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1440 } } }
        : {}),
    });
    try {
      const first = await openPage(context);
      const firstPage = first.page;
      const sidebar = firstPage.locator("openclaw-app-sidebar");
      await first.gateway.waitForRequest("chat.startup");
      await expect.poll(() => selectedAgentName(firstPage)).toBe("Dummy");
      await screenshot(firstPage, "01-default-agent.png");

      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      await sidebar
        .locator("wa-dropdown.sidebar-agent-menu")
        .getByRole("menuitemradio", { name: "OpenClaw" })
        .click();
      await waitForControlUiRoute(firstPage, { pathname: "/chat/openclaw", routeId: "chat" });
      await expect.poll(() => selectedAgentName(firstPage)).toBe("OpenClaw");
      await expect
        .poll(() => firstPage.getByRole("heading", { name: "OpenClaw" }).isVisible())
        .toBe(true);
      await screenshot(firstPage, "02-selected-openclaw.png");

      // The macOS host reopens the Gateway's canonical session key. Unlike the
      // browser-only route alias, `global` cannot encode which agent owns it.
      await persistCanonicalGlobalSession(firstPage);

      await firstPage.close();
      const reopened = await openPage(context);
      const reopenedPage = reopened.page;
      await reopened.gateway.waitForRequest("chat.startup");
      await waitForControlUiRoute(reopenedPage, {
        pathname: "/chat/openclaw",
        routeId: "chat",
      });
      await screenshot(reopenedPage, "03-reopened-agent.png");
      await expect.poll(() => hasOpenClawStartup(reopened.gateway)).toBe(true);
      await expect.poll(() => selectedAgentName(reopenedPage)).toBe("OpenClaw");
      await expect
        .poll(() => reopenedPage.getByRole("heading", { name: "OpenClaw" }).isVisible())
        .toBe(true);
      await screenshot(reopenedPage, "04-verified-reopened-agent.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
