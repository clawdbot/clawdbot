import { expect, it } from "vitest";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI retained pane hydration",
  startServerBeforeBrowser: true,
});

const sessionKeys = ["agent:main:perf-a", "agent:main:perf-b", "agent:main:perf-c"];

function sessionsResponse() {
  return {
    count: sessionKeys.length,
    defaults: { contextTokens: null, model: "gpt-5.6-luna", modelProvider: "openai" },
    path: "",
    sessions: sessionKeys.map((key, index) => ({
      key,
      kind: "direct",
      label: `Perf ${index + 1}`,
      updatedAt: sessionKeys.length - index,
    })),
    ts: Date.now(),
  };
}

suite.define(() => {
  it("hydrates only the visible retained session after reconnect", async () => {
    const rounds: Array<Record<string, number>> = [];
    for (let round = 0; round < 5; round += 1) {
      const context = await suite.newBrowserContext({ viewport: { height: 900, width: 1440 } });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "artifacts.list",
          "chat.metadata",
          "chat.startup",
          "sessions.diff",
          "sessions.files.list",
          "tasks.list",
        ],
        methodResponses: {
          "artifacts.list": { artifacts: [] },
          "sessions.files.list": {
            browser: { entries: [], path: "" },
            files: [],
            gitCheckout: false,
            root: "",
          },
          "sessions.list": sessionsResponse(),
          "tasks.list": { tasks: [] },
        },
        sessionKey: sessionKeys[0],
      });
      try {
        await page.goto(new URL(controlUiSessionPath(sessionKeys[0]!), suite.server.baseUrl).href);
        for (const key of sessionKeys.slice(1)) {
          await page.locator(`.sidebar-recent-session[data-session-key="${key}"] a`).click();
          await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(key));
        }
        await expect.poll(() => page.locator("openclaw-chat-pane").count()).toBe(3);
        const before = (await gateway.getRequests()).length;
        const connectBefore = (await gateway.getRequests("connect")).length;
        await gateway.closeLatest(1012, "retained pane reconnect proof");
        await expect
          .poll(async () => (await gateway.getRequests("connect")).length, { timeout: 10_000 })
          .toBeGreaterThan(connectBefore);
        await expect
          .poll(async () => (await gateway.getRequests()).length, { timeout: 10_000 })
          .toBeGreaterThan(before + 6);
        const requests = (await gateway.getRequests()).slice(before);
        const counts: Record<string, number> = {};
        for (const key of sessionKeys) {
          counts[key] = requests.filter((request) => {
            const params = request.params as { sessionKey?: unknown } | undefined;
            return (
              params?.sessionKey === key &&
              ["tasks.list", "sessions.files.list", "artifacts.list"].includes(request.method)
            );
          }).length;
        }
        rounds.push(counts);
        const hiddenLink = page.locator(
          `.sidebar-recent-session[data-session-key="${sessionKeys[0]}"] a`,
        );
        await hiddenLink.click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath(sessionKeys[0]!));
        await expect
          .poll(async () => {
            const later = (await gateway.getRequests()).slice(before + requests.length);
            return later.filter((request) => {
              const params = request.params as { sessionKey?: unknown } | undefined;
              return (
                params?.sessionKey === sessionKeys[0] &&
                ["tasks.list", "sessions.files.list", "artifacts.list"].includes(request.method)
              );
            }).length;
          })
          .toBe(4);
      } finally {
        await suite.closeBrowserContext(context);
      }
    }
    expect(rounds).toEqual(
      Array.from({ length: 5 }, () => ({
        [sessionKeys[0]!]: 0,
        [sessionKeys[1]!]: 0,
        [sessionKeys[2]!]: 4,
      })),
    );
  });
});
