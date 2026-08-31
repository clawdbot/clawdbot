import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionPath,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("drains an inactive agent outbox while the selected global agent is active", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const activePane = page.locator(".chat-pane-cache__pane--active");
    const agentsList = {
      agents: [
        { id: "main", name: "Main" },
        { id: "work", name: "Work" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "global",
    };
    const historyResponse = (agentId: "main" | "work", active: boolean) => ({
      messages: [],
      sessionId: `${agentId}-global-session`,
      sessionInfo: {
        activeRunIds: active ? [`${agentId}-active-run`] : [],
        hasActiveRun: active,
        key: "global",
        status: active ? "running" : "done",
      },
      thinkingLevel: null,
    });
    const sessionsResponse = (active: boolean) =>
      chatSessionListResponse([
        {
          activeRunIds: active ? ["main-active-run"] : [],
          hasActiveRun: active,
          key: "global",
          kind: "global",
          label: "Main Session",
          status: active ? "running" : "done",
          updatedAt: Date.now(),
        },
      ]);
    const gateway = await installMockGateway(page, {
      sessionScope: "global",
      mainSessionKey: "global",
      methodResponses: {
        "agents.list": agentsList,
        "chat.history": {
          cases: [
            {
              match: { agentId: "work", sessionKey: "global" },
              response: historyResponse("work", true),
            },
            {
              match: { agentId: "main", sessionKey: "global" },
              response: historyResponse("main", true),
            },
          ],
        },
        "chat.startup": {
          cases: [
            {
              match: { agentId: "work" },
              response: { ...historyResponse("work", false), agentsList },
            },
            {
              match: { agentId: "main" },
              response: { ...historyResponse("main", true), agentsList },
            },
          ],
        },
        "sessions.list": {
          cases: [
            { match: { agentId: "work" }, response: sessionsResponse(false) },
            { match: { agentId: "main" }, response: sessionsResponse(true) },
          ],
        },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:work:main"));
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await gateway.setOnline(false);
      await page
        .locator(
          '.agent-chat__composer-underlaps[data-tone="warn"] .agent-chat__composer-status-band',
        )
        .waitFor({ timeout: 10_000 });

      const prompt = "deliver the work outbox independently";
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const queue = page.locator(".chat-queue");
      await queue.getByText("Waiting for reconnect").waitFor({ timeout: 10_000 });
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/inactive-agent-offline.png`,
          fullPage: true,
        });
      }
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context: { agentSelection: { set: (agentId: string) => void } } };
        };
        app.runtime?.context.agentSelection.set("main");
      });
      await gateway.setOnline(true);
      await page
        .locator(
          '.agent-chat__composer-underlaps[data-tone="warn"] .agent-chat__composer-status-band',
        )
        .waitFor({ state: "detached", timeout: 10_000 });
      await page.evaluate(async () => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context: { sessions: { refresh: (options: unknown) => Promise<void> } } };
        };
        await app.runtime?.context.sessions.refresh({ agentId: "main", force: true });
      });

      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (entry) => requireRecord(entry.params).agentId === "main",
          ),
        )
        .toBe(true);
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).length)
        .toBeGreaterThan(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await gateway.deferNext("chat.send");
      await gateway.setMethodResponse("chat.history", {
        cases: [
          {
            match: { agentId: "work", sessionKey: "global" },
            response: historyResponse("work", false),
          },
          {
            match: { agentId: "main", sessionKey: "global" },
            response: historyResponse("main", true),
          },
        ],
      });
      await gateway.emitGatewayEvent("sessions.changed", {
        activeRunIds: ["main-active-run"],
        agentId: "main",
        hasActiveRun: true,
        key: "global",
        kind: "global",
        status: "running",
      });

      const request = await gateway.waitForRequest("chat.send");
      const params = requireRecord(request.params);
      expect(params).toMatchObject({ agentId: "work", message: prompt, sessionKey: "global" });
      const runId = requireString(params.idempotencyKey, "inactive-agent outbox run id");
      await expectRequestCountStable(gateway, "chat.send", 1);
      const recoveryRequests = (await gateway.getRequests("chat.history"))
        .map((entry) => requireRecord(entry.params))
        .filter((historyParams) => Array.isArray(historyParams.inputRunIds));
      expect(recoveryRequests.length).toBeGreaterThan(0);
      for (const historyParams of recoveryRequests) {
        expect(historyParams).toMatchObject({
          agentId: "work",
          sessionKey: "global",
          inputRunIds: [runId],
        });
      }
      const workPath = controlUiSessionPath("agent:work:main");
      await page.evaluate((pathname) => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              agentSelection: { set: (agentId: string) => void };
              navigate: (routeId: string, options: { pathname: string }) => void;
            };
          };
        };
        if (!app.runtime) {
          throw new Error("OpenClaw application runtime is unavailable");
        }
        app.runtime.context.agentSelection.set("work");
        app.runtime.context.navigate("chat", { pathname });
      }, workPath);
      await page.waitForURL((url) => url.pathname === workPath);
      await gateway.setHistoryMessages([
        {
          content: prompt,
          idempotencyKey: `${runId}:user`,
          role: "user",
          timestamp: Date.now(),
        },
      ]);
      await gateway.emitGatewayEvent("session.message", {
        agentId: "work",
        clientRunId: runId,
        hasActiveRun: true,
        message: {
          __openclaw: { id: "work-outbox-user", idempotencyKey: `${runId}:user`, seq: 1 },
          content: [{ text: prompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        messageId: "work-outbox-user",
        messageSeq: 1,
        sessionKey: "global",
        status: "running",
      });
      await activePane.locator(".chat-group.user").getByText(prompt).waitFor({ timeout: 10_000 });
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/inactive-agent-dispatched.png`,
          fullPage: true,
        });
      }

      await gateway.emitGatewayEvent("chat", {
        agentId: "work",
        message: {
          content: [{ text: "Work outbox delivered.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "global",
        state: "final",
      });
      await queue.waitFor({ state: "detached", timeout: 10_000 });
      // Retained panes also receive this conversation's events; assert its rendered owner.
      const reply = activePane
        .locator(".chat-group.assistant")
        .getByText("Work outbox delivered.", { exact: true });
      await reply.waitFor({ timeout: 10_000 });
      await expectRequestCountStable(gateway, "chat.send", 1);
      expect(await activePane.count()).toBe(1);
      expect(await reply.count()).toBe(1);
      const messages = await activePane.evaluate(
        (pane) => (pane as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages,
      );
      expect(messages.map(requireRecord).filter((message) => message.role === "assistant")).toEqual(
        [
          expect.objectContaining({
            content: [{ text: "Work outbox delivered.", type: "text" }],
          }),
        ],
      );
      if (artifactDir) {
        await page.screenshot({
          path: `${artifactDir}/inactive-agent-delivered.png`,
          fullPage: true,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
