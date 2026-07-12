// Control UI E2E tests cover session-list event scope through the Gateway WebSocket.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser | undefined;
let page: Page | undefined;
let server: ControlUiE2eServer | undefined;

describeControlUiE2e("Control UI session-list event scope", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
  });

  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    await browser?.close().catch(() => {});
    page = undefined;
    browser = undefined;
  });

  afterAll(async () => {
    await server?.close();
  });

  it("refetches instead of showing a row excluded by configured-agent filtering", async () => {
    const visibleLabel = "Visible configured session";
    const hiddenLabel = "Hidden unconfigured session";
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "unknown",
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          path: "",
          sessions: [
            {
              key: "agent:main:visible",
              kind: "direct",
              label: visibleLabel,
              updatedAt: 1,
            },
          ],
          ts: 1,
        },
      },
    });

    await currentPage.goto(`${server?.baseUrl ?? ""}sessions`);
    const visibleRow = currentPage.getByText(visibleLabel, { exact: true }).first();
    await visibleRow.waitFor({ timeout: 10_000 });
    const requestsBeforeEvent = await gateway.getRequests("sessions.list");
    expect(
      requestsBeforeEvent.some(
        (request) =>
          (request.params as { configuredAgentsOnly?: unknown } | undefined)
            ?.configuredAgentsOnly === true,
      ),
    ).toBe(true);

    await gateway.deferNext("sessions.list");
    await gateway.emitGatewayEvent("sessions.changed", {
      sessionKey: "agent:local:hidden",
      reason: "create",
      key: "agent:local:hidden",
      kind: "direct",
      label: hiddenLabel,
      updatedAt: 2,
    });

    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).length)
      .toBeGreaterThan(requestsBeforeEvent.length);
    expect(await currentPage.getByText(hiddenLabel, { exact: true }).count()).toBe(0);
    await gateway.resolveDeferred("sessions.list", {
      count: 1,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      path: "",
      sessions: [
        {
          key: "agent:main:visible",
          kind: "direct",
          label: visibleLabel,
          updatedAt: 3,
        },
      ],
      ts: 3,
    });
    await visibleRow.waitFor();
    expect(await currentPage.getByText(hiddenLabel, { exact: true }).count()).toBe(0);
  });
});
