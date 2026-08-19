import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("preserves a non-steer server default for active-run follow-ups", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const runtimeConfig = {
      messages: { queue: { byChannel: { webchat: "followup" }, mode: "steer" } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config: runtimeConfig,
          hash: "queue-followup-config",
          issues: [],
          raw: JSON.stringify(runtimeConfig),
          runtimeConfig,
          valid: true,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const followUpSelect = page.locator("[data-settings-follow-up-mode]");
      await followUpSelect.waitFor({ state: "visible", timeout: 10_000 });
      expect(await followUpSelect.inputValue()).toBe("server");
      await page.getByText("Using server default (followup)").waitFor({ timeout: 10_000 });
      const configPatchCount = (await gateway.getRequests("config.patch")).length;
      const configGetCount = (await gateway.getRequests("config.get")).length;
      const overrideConfig = {
        ...runtimeConfig,
        ui: { prefs: { chatFollowUpMode: "steer" } },
      };
      await gateway.setMethodResponse("config.get", {
        config: overrideConfig,
        hash: "queue-followup-override-config",
        issues: [],
        raw: JSON.stringify(overrideConfig),
        runtimeConfig: overrideConfig,
        valid: true,
      });
      await followUpSelect.selectOption("steer");
      await waitForRequests(gateway, "config.patch", configPatchCount + 1);
      await waitForRequests(gateway, "config.get", configGetCount + 1);
      await page.getByText("Overriding server default (followup)").waitFor({ timeout: 10_000 });
      await gateway.setMethodResponse("config.get", {
        config: runtimeConfig,
        hash: "queue-followup-reset-config",
        issues: [],
        raw: JSON.stringify(runtimeConfig),
        runtimeConfig,
        valid: true,
      });
      await page.getByRole("button", { name: "Reset to server default" }).click();
      await waitForRequests(gateway, "config.patch", configPatchCount + 2);
      await waitForRequests(gateway, "config.get", configGetCount + 2);
      await page.getByText("Using server default (followup)").waitFor({ timeout: 10_000 });
      expect(await followUpSelect.inputValue()).toBe("server");

      await page.goto(`${suite.server.baseUrl}chat`);

      const activePrompt = "keep this run active";
      await page.locator(".agent-chat__composer-combobox textarea").fill(activePrompt);
      await page.getByRole("button", { name: "Send message" }).click();

      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const queuedPrompt = "queue this on the server";
      await page.locator(".agent-chat__composer-combobox textarea").fill(queuedPrompt);
      await page.getByRole("button", { name: "Queue message" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      expect(requireRecord(sends[1]?.params)).toMatchObject({
        message: queuedPrompt,
        queueMode: "followup",
        sessionKey: "main",
      });
      await page.locator(".chat-queue").waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("steers a queued follow-up with modified Enter in Enter shortcut mode", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.locator("[data-settings-send-shortcut]").selectOption("enter");
      await page.goto(`${suite.server.baseUrl}chat`);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("keep the first shortcut run active");
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const steerText = "steer this keyboard follow-up now";
      await composer.fill(steerText);
      await composer.press("Control+Enter");

      const firstRunSends = await waitForRequests(gateway, "chat.send", 2);
      const steerParams = requireRecord(firstRunSends[1]?.params);
      expect(steerParams).toMatchObject({
        deliver: false,
        message: steerText,
        queueMode: "steer",
        sessionKey: "main",
      });
      expect(steerParams).not.toHaveProperty("expectedRunId");
      expect(steerParams).not.toHaveProperty("expectedLeafEntryId");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps modified Enter queued in modifier-enter shortcut mode", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.locator("[data-settings-send-shortcut]").selectOption("modifier-enter");
      await page.goto(`${suite.server.baseUrl}chat`);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("keep the modifier shortcut run active");
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const queuedText = "leave this modifier follow-up queued";
      await composer.fill(queuedText);
      await composer.press("Control+Enter");

      const queuedRow = page.locator(".chat-queue__item", { hasText: queuedText });
      await queuedRow.waitFor({ timeout: 10_000 });
      await queuedRow.getByText("Waiting for current run").waitFor({ timeout: 10_000 });
      await expectRequestCountStable(gateway, "chat.send", 1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("honors a session interrupt override ahead of the webchat config default", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "main";
    const runtimeConfig = {
      messages: { queue: { byChannel: { webchat: "steer" }, mode: "steer" } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config: runtimeConfig,
          hash: "queue-session-override-config",
          issues: [],
          raw: JSON.stringify(runtimeConfig),
          runtimeConfig,
          valid: true,
        },
        "sessions.list": chatSessionListResponse([
          {
            effectiveQueueMode: "interrupt",
            key: "agent:main:main",
            kind: "direct",
            label: "Main",
            queueMode: "interrupt",
            updatedAt: Date.now(),
          },
        ]),
      },
      sessionInfo: {
        effectiveQueueMode: "interrupt",
        hasActiveRun: false,
        key: "agent:main:main",
        queueMode: "interrupt",
        status: "done",
      },
      sessionKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      await page.locator(".agent-chat__composer-combobox textarea").fill("keep this run active");
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const followUp = "interrupt for this session override";
      await page.locator(".agent-chat__composer-combobox textarea").fill(followUp);
      await page.getByRole("button", { name: "Send message" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      expect(requireRecord(sends[1]?.params)).toMatchObject({
        message: followUp,
        queueMode: "interrupt",
        sessionKey,
      });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("steers a restored queued message when only the session row reports the active run", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.goto(`${suite.server.baseUrl}chat?session=main`);
      await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/chat\/main$/);

      await page.locator(".agent-chat__composer-combobox textarea").fill("keep this run active");
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const queuedPrompt = "steer this after restoring the queue";
      await page.locator(".agent-chat__composer-combobox textarea").fill(queuedPrompt);
      await page.getByRole("button", { name: "Queue message" }).click();
      await page.locator(".chat-queue").getByText(queuedPrompt).waitFor({ timeout: 10_000 });

      await gateway.setMethodResponse(
        "sessions.list",
        chatSessionListResponse([
          {
            activeLeafEntryId: "leaf-active",
            activeRunIds: ["active-run"],
            hasActiveRun: true,
            key: "global",
            kind: "global",
            label: "Global",
            updatedAt: Date.now(),
          },
          {
            activeLeafEntryId: "leaf-active",
            activeRunIds: ["active-run"],
            hasActiveRun: true,
            key: "main",
            kind: "direct",
            label: "Main",
            updatedAt: Date.now(),
          },
        ]),
      );
      await page.reload();
      await gateway.waitForRequest("sessions.list");

      const queue = page.locator(".chat-queue");
      await queue.getByText(queuedPrompt).waitFor({ timeout: 10_000 });
      await queue.getByRole("button", { name: "Steer" }).click();

      const steerRequest = await gateway.waitForRequest("chat.send");
      const steerParams = requireRecord(steerRequest.params);
      expect(steerParams).toMatchObject({
        deliver: false,
        message: queuedPrompt,
        queueMode: "steer",
        sessionKey: "main",
      });
      expect(steerParams).not.toHaveProperty("expectedRunId");
      expect(steerParams).not.toHaveProperty("expectedLeafEntryId");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
