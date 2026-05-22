import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = chromium.executablePath();
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

function sessionRow(key: string, label: string, updatedAt: number) {
  return {
    contextTokens: null,
    displayName: label,
    hasActiveRun: false,
    key,
    kind: "direct",
    label,
    model: "gpt-5.5",
    modelProvider: "openai",
    status: "done",
    totalTokens: 0,
    updatedAt,
  };
}

function sessionsListResponse(
  sessions: unknown[],
  options: { hasMore: boolean; nextOffset: number | null; offset?: number; totalCount: number },
) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    hasMore: options.hasMore,
    limitApplied: 50,
    nextOffset: options.nextOffset,
    offset: options.offset ?? 0,
    path: "",
    sessions,
    totalCount: options.totalCount,
    ts: Date.now(),
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

async function waitForSessionsRequest(
  gateway: MockGatewayControls,
  predicate: (params: Record<string, unknown>) => boolean,
): Promise<MockGatewayRequest> {
  const deadline = Date.now() + 10_000;
  let requests: MockGatewayRequest[] = [];
  while (Date.now() < deadline) {
    requests = await gateway.getRequests("sessions.list");
    const match = requests.find((request) => predicate(requestParams(request)));
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No matching sessions.list request found: ${JSON.stringify(requests)}`);
}

describeControlUiE2e("Control UI chat picker mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("searches and pages chat sessions through the GUI", async () => {
    const baseTime = Date.parse("2026-05-22T09:00:00.000Z");
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { offset: 50, search: "telegram" },
              response: sessionsListResponse(
                [
                  sessionRow("agent:telegram-51", "Telegram archive page 51", baseTime - 180_000),
                  sessionRow("agent:telegram-52", "Telegram archive page 52", baseTime - 240_000),
                ],
                { hasMore: false, nextOffset: null, offset: 50, totalCount: 4 },
              ),
            },
            {
              match: { search: "telegram" },
              response: sessionsListResponse(
                [
                  sessionRow("agent:telegram", "Telegram follow-up", baseTime - 60_000),
                  sessionRow(
                    "agent:telegram-mobile",
                    "Telegram mobile handoff",
                    baseTime - 120_000,
                  ),
                ],
                { hasMore: true, nextOffset: 50, totalCount: 4 },
              ),
            },
            {
              match: {},
              response: sessionsListResponse(
                [
                  sessionRow("agent:alpha", "Alpha planning", baseTime - 1_000),
                  sessionRow("agent:design", "Design review", baseTime - 30_000),
                ],
                { hasMore: true, nextOffset: 50, totalCount: 125 },
              ),
            },
          ],
        },
      },
      sessionKey: "agent:alpha",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByRole("button", { name: "Chat session" }).click();
      await page.locator('[data-chat-session-search-toggle="true"]').last().click();

      const searchInput = page.locator('[data-chat-session-picker-search="true"]').last();
      await searchInput.waitFor({ state: "visible", timeout: 10_000 });

      const initialRequest = await waitForSessionsRequest(
        gateway,
        (params) => params.limit === 50 && params.includeGlobal === true,
      );
      expect(requestParams(initialRequest)).toMatchObject({
        configuredAgentsOnly: true,
        includeGlobal: true,
        includeUnknown: true,
        limit: 50,
      });
      expect(requestParams(initialRequest)).not.toHaveProperty("search");
      expect(requestParams(initialRequest)).not.toHaveProperty("offset");
      await page.getByRole("option", { name: /Alpha planning/u }).waitFor({ timeout: 10_000 });

      await searchInput.fill(" telegram ");
      await page.locator('[data-chat-session-search-submit="true"]').last().click();

      const searchRequest = await waitForSessionsRequest(
        gateway,
        (params) => params.search === "telegram" && !("offset" in params),
      );
      expect(requestParams(searchRequest)).toMatchObject({
        configuredAgentsOnly: true,
        includeGlobal: true,
        includeUnknown: true,
        limit: 50,
        search: "telegram",
      });
      await page.getByRole("option", { name: /Telegram follow-up/u }).waitFor({
        timeout: 10_000,
      });
      await page.getByText("2 / 4").waitFor({ timeout: 10_000 });

      await page.getByRole("button", { name: "Load more sessions" }).click();

      const nextPageRequest = await waitForSessionsRequest(
        gateway,
        (params) => params.search === "telegram" && params.offset === 50,
      );
      expect(requestParams(nextPageRequest)).toMatchObject({
        configuredAgentsOnly: true,
        includeGlobal: true,
        includeUnknown: true,
        limit: 50,
        offset: 50,
        search: "telegram",
      });
      await page.getByRole("option", { name: /Telegram archive page 51/u }).waitFor({
        timeout: 10_000,
      });
      await page.getByText("4 / 4").waitFor({ timeout: 10_000 });
      await expect
        .poll(async () => page.getByRole("button", { name: "Load more sessions" }).count())
        .toBe(0);
    } finally {
      await context.close();
    }
  });
});
