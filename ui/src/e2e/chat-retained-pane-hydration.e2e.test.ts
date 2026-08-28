import { expect, it } from "vitest";
import {
  controlUiSessionPath,
  installMockGateway,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI retained pane hydration",
  startServerBeforeBrowser: true,
});

const sessionKeys = ["agent:main:perf-a", "agent:main:perf-b", "agent:main:perf-c"] as const;
const hydrationMethods = new Set(["tasks.list", "artifacts.list"]);

function countSessionHydrationRequests(requests: MockGatewayRequest[], sessionKey: string): number {
  return requests.filter((request) => {
    const params = request.params as { sessionKey?: unknown } | undefined;
    return params?.sessionKey === sessionKey && hydrationMethods.has(request.method);
  }).length;
}

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
        await page.goto(new URL(controlUiSessionPath(sessionKeys[0]), suite.server.baseUrl).href);
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
          counts[key] = countSessionHydrationRequests(requests, key);
        }
        expect(requests.filter((request) => request.method === "sessions.files.list")).toHaveLength(
          0,
        );
        rounds.push(counts);
        const beforeEvents = (await gateway.getRequests()).length;
        const sessionListCount = (await gateway.getRequests("sessions.list")).length;
        const branchListCount = (await gateway.getRequests("sessions.branches.list")).length;
        const hiddenSessionKey = sessionKeys[0];
        await gateway.emitGatewayEvent("task", {
          action: "upserted",
          task: {
            id: "task-hidden",
            taskId: "task-hidden",
            kind: "subagent",
            runtime: "subagent",
            status: "running",
            title: "Hidden retained task",
            agentId: "main",
            sessionKey: hiddenSessionKey,
            createdAt: 1,
            updatedAt: 1,
          },
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: hiddenSessionKey,
          agentId: "main",
          reason: "branch-switch",
        });
        await gateway.emitGatewayEvent("chat", {
          sessionKey: hiddenSessionKey,
          runId: "run-hidden",
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        });
        await page.waitForFunction((sessionKey) => {
          const pane = [...document.querySelectorAll("openclaw-chat-pane")].find(
            (element) =>
              (element as HTMLElement & { sessionKey?: string }).sessionKey === sessionKey,
          ) as (HTMLElement & { state?: { chatMessages?: unknown[] } }) | undefined;
          return JSON.stringify(pane?.state?.chatMessages ?? []).includes("Done.");
        }, hiddenSessionKey);
        await expect
          .poll(async () => (await gateway.getRequests("sessions.list")).length)
          .toBeGreaterThan(sessionListCount);
        expect(await gateway.getRequests("sessions.branches.list")).toHaveLength(branchListCount);
        const afterEvents = (await gateway.getRequests()).slice(beforeEvents);
        expect(countSessionHydrationRequests(afterEvents, hiddenSessionKey)).toBe(0);
        const hiddenLink = page.locator(
          `.sidebar-recent-session[data-session-key="${hiddenSessionKey}"] a`,
        );
        await hiddenLink.click();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath(hiddenSessionKey));
        await expect
          .poll(async () => {
            const later = (await gateway.getRequests()).slice(before + requests.length);
            return countSessionHydrationRequests(later, hiddenSessionKey);
          })
          .toBe(2);
      } finally {
        await suite.closeBrowserContext(context);
      }
    }
    expect(rounds).toEqual(
      Array.from({ length: 5 }, () => ({
        [sessionKeys[0]]: 0,
        [sessionKeys[1]]: 0,
        [sessionKeys[2]]: 2,
      })),
    );
  });
});
