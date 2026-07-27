import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.resolve(
  process.cwd(),
  ".artifacts/control-ui-e2e/critical-observer-notice",
);
const selectedSessionKey = "agent:main:main";
const backgroundSessionKey = "agent:main:other";
const baseTime = Date.parse("2026-07-25T18:00:00.000Z");

let server: ControlUiE2eServer;
let browser: Browser;

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

describeControlUiE2e("Control UI critical observer notice mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("announces critical background sessions, navigates, and dedupes after dismissal", async () => {
    await rm(artifactDir, { force: true, recursive: true });
    await mkdir(artifactDir, { recursive: true });
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    try {
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

      const response = await page.goto(controlUiSessionUrl(server.baseUrl, selectedSessionKey));
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
      await gateway.emitGatewayEvent(
        "session.observer",
        observerDigest({
          sessionKey: backgroundSessionKey,
          health: "stuck",
          headline: firstHeadline,
          revision: 2,
        }),
      );
      await toast.waitFor({ state: "visible" });
      expect(await toast.locator(".app-toast__message").textContent()).toContain(firstHeadline);
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "01-critical-background-session.png"),
      });

      await toast.locator(".app-toast__action").click();
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

      await gateway.emitGatewayEvent(
        "session.observer",
        observerDigest({
          sessionKey: backgroundSessionKey,
          health: "stuck",
          headline: "Background verification is stuck again",
          revision: 4,
        }),
      );
      await toast.waitFor({ state: "visible" });
      await toast.locator(".app-toast__dismiss").click();
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
    } finally {
      await context.close();
    }
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
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    try {
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
      const response = await page.goto(controlUiSessionUrl(server.baseUrl, globalRouteKey));
      expect(response?.status()).toBe(200);
      await page.getByText("Configured global foreground is ready.").waitFor({ state: "visible" });
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(globalRouteKey));
      expect(await gateway.getRequests("connect")).toHaveLength(1);

      const headline = `Configured-global observer notice for ${testCase.sessionKey}`;
      await gateway.emitGatewayEvent(
        "session.observer",
        observerDigest({
          agentId: testCase.agentId,
          sessionKey: testCase.sessionKey,
          health: "stuck",
          headline,
          revision: 1,
        }),
      );

      const toast = page.locator(".app-toast");
      if (testCase.visible) {
        await toast.waitFor({ state: "visible" });
        expect(await toast.locator(".app-toast__message").textContent()).toContain(headline);
      } else {
        await waitForToastUpdate(page);
        expect(await toast.count()).toBe(0);
      }
    } finally {
      await context.close();
    }
  });
});
