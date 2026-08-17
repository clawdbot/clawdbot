import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

async function expectChatBubbleAbove(page: Page, upperText: string, lowerText: string) {
  const thread = page.locator(".chat-thread-inner");
  await expect
    .poll(() =>
      thread.evaluate(
        (element, texts) => {
          const bubbles = Array.from(element.querySelectorAll<HTMLElement>(".chat-bubble"));
          const matches = texts.map((text) =>
            bubbles.filter((bubble) => bubble.textContent?.includes(text)),
          );
          const counts = matches.map((matchingBubbles) => matchingBubbles.length);
          const upperBubble = matches[0]?.[0];
          const lowerBubble = matches[1]?.[0];
          if (counts.some((count) => count !== 1) || !upperBubble || !lowerBubble) {
            return { counts, lowerTop: null, ordered: false, upperTop: null };
          }
          const upperTop = upperBubble.getBoundingClientRect().top;
          const lowerTop = lowerBubble.getBoundingClientRect().top;
          return { counts, lowerTop, ordered: upperTop < lowerTop, upperTop };
        },
        [upperText, lowerText],
      ),
    )
    .toEqual({
      counts: [1, 1],
      lowerTop: expect.any(Number),
      ordered: true,
      upperTop: expect.any(Number),
    });
}

suite.define(() => {
  it("keeps cumulative assistant output ordered across a consumed steer", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const runtimeConfig = {
      messages: { queue: { byChannel: { webchat: "steer" }, mode: "followup" } },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config: runtimeConfig,
          hash: "queue-steer-config",
          issues: [],
          raw: JSON.stringify(runtimeConfig),
          runtimeConfig,
          valid: true,
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const originalPrompt = "keep this run active";
      await page.locator(".agent-chat__composer-combobox textarea").fill(originalPrompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const initialSend = await gateway.waitForRequest("chat.send");
      const activeRunId = requireString(
        requireRecord(initialSend.params).idempotencyKey,
        "active chat run id",
      );
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [activeRunId],
        clientRunId: activeRunId,
        hasActiveRun: true,
        message: {
          __openclaw: {
            id: "persisted-original-user",
            idempotencyKey: `${activeRunId}:user`,
            seq: 1,
          },
          content: [{ text: originalPrompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        messageId: "persisted-original-user",
        messageSeq: 1,
        session: {
          activeRunIds: [activeRunId],
          hasActiveRun: true,
          key: "main",
          kind: "direct",
          status: "running",
          updatedAt: Date.now(),
        },
        sessionKey: "main",
      });
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const preSteerReply = "Assistant output before the steer.";
      await gateway.emitGatewayEvent("chat", {
        deltaText: preSteerReply,
        message: {
          content: [{ text: preSteerReply, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId: activeRunId,
        sessionKey: "main",
        state: "delta",
      });
      await page.getByText(preSteerReply, { exact: true }).waitFor({ timeout: 10_000 });

      const followUp = "tighten the active plan";
      await page.locator(".agent-chat__composer-combobox textarea").fill(followUp);
      await page.getByRole("button", { name: "Steer into the active run" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      const steerParams = requireRecord(sends[1]?.params);
      expect(steerParams).toMatchObject({
        deliver: false,
        message: followUp,
        sessionKey: "main",
      });
      const steerRunId = requireString(steerParams.idempotencyKey, "steer run id");
      const queue = page.locator(".chat-queue");
      await queue.locator(".chat-queue__badge--steered", { hasText: "Steering" }).waitFor({
        timeout: 10_000,
      });
      await queue.getByText(followUp).waitFor({ timeout: 10_000 });
      await gateway.emitGatewayEvent("chat", {
        runId: steerRunId,
        sessionKey: "main",
        state: "final",
      });
      await queue.getByText(followUp).waitFor({ state: "detached", timeout: 10_000 });
      await expect
        .poll(() => page.locator(".chat-thread .chat-group.user", { hasText: followUp }).count())
        .toBe(1);
      await expectChatBubbleAbove(page, originalPrompt, preSteerReply);
      await expectChatBubbleAbove(page, preSteerReply, followUp);

      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [activeRunId],
        clientRunId: activeRunId,
        hasActiveRun: true,
        message: {
          __openclaw: {
            id: "persisted-steer-user",
            idempotencyKey: `${steerRunId}:user`,
            seq: 3,
            steerTargetRunId: activeRunId,
          },
          content: [{ text: followUp, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        messageId: "persisted-steer-user",
        messageSeq: 3,
        session: {
          activeRunIds: [activeRunId],
          hasActiveRun: true,
          key: "main",
          kind: "direct",
          status: "running",
          updatedAt: Date.now(),
        },
        sessionKey: "main",
      });

      await expect
        .poll(() => page.locator(".chat-thread .chat-group.user", { hasText: followUp }).count())
        .toBe(1);
      const postSteerReply = "Assistant output after the steer.";
      const cumulativeReply = `${preSteerReply} ${postSteerReply}`;
      const terminalPostSteerReply = `${postSteerReply} Final unseen suffix.`;
      const terminalReply = `${preSteerReply} ${terminalPostSteerReply}`;
      await gateway.emitGatewayEvent("chat", {
        deltaText: ` ${postSteerReply}`,
        message: {
          content: [{ text: cumulativeReply, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId: activeRunId,
        sessionKey: "main",
        state: "delta",
      });
      await page.locator(".chat-bubble", { hasText: postSteerReply }).waitFor({ timeout: 10_000 });
      await expectChatBubbleAbove(page, originalPrompt, preSteerReply);
      await expectChatBubbleAbove(page, preSteerReply, followUp);
      await expectChatBubbleAbove(page, followUp, postSteerReply);
      const authoritativeMessages = [
        {
          __openclaw: {
            id: "persisted-original-user",
            idempotencyKey: `${activeRunId}:user`,
            seq: 1,
          },
          content: [{ text: originalPrompt, type: "text" }],
          role: "user",
          timestamp: 100,
        },
        {
          __openclaw: { id: "persisted-pre-steer", idempotencyKey: activeRunId, seq: 2 },
          content: [{ text: preSteerReply, type: "text" }],
          role: "assistant",
          timestamp: 200,
        },
        {
          __openclaw: {
            id: "persisted-steer-user",
            idempotencyKey: `${steerRunId}:user`,
            seq: 3,
            steerTargetRunId: activeRunId,
          },
          content: [{ text: followUp, type: "text" }],
          role: "user",
          timestamp: 50,
        },
        {
          __openclaw: { id: "persisted-post-steer", idempotencyKey: activeRunId, seq: 4 },
          content: [{ text: terminalPostSteerReply, type: "text" }],
          role: "assistant",
          timestamp: 300,
        },
      ];
      const terminalHistory = {
        messages: authoritativeMessages,
        sessionId: "control-ui-e2e-session",
        sessionInfo: {
          activeRunIds: [],
          hasActiveRun: false,
          key: "main",
          kind: "direct",
          status: "done",
          updatedAt: Date.now(),
        },
        thinkingLevel: null,
      };
      await gateway.setMethodResponse("chat.history", terminalHistory);
      await gateway.setMethodResponse("chat.startup", terminalHistory);
      await gateway.emitChatFinal({ runId: activeRunId, text: terminalReply });
      await page
        .getByRole("button", { name: "Stop generating" })
        .waitFor({ state: "detached", timeout: 10_000 });
      await page
        .locator(".chat-bubble", { hasText: terminalPostSteerReply })
        .waitFor({ timeout: 10_000 });
      await expectChatBubbleAbove(page, preSteerReply, followUp);
      await expectChatBubbleAbove(page, followUp, postSteerReply);

      await page.reload();
      await page
        .locator(".chat-bubble", { hasText: terminalPostSteerReply })
        .waitFor({ timeout: 10_000 });
      await expectChatBubbleAbove(page, originalPrompt, preSteerReply);
      await expectChatBubbleAbove(page, preSteerReply, followUp);
      await expectChatBubbleAbove(page, followUp, postSteerReply);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

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
      const firstSend = requireRecord((await gateway.waitForRequest("chat.send")).params);
      const firstRunId = requireString(firstSend.idempotencyKey, "first active run id");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const steerText = "steer this keyboard follow-up now";
      await composer.fill(steerText);
      await composer.press("Control+Enter");

      const firstRunSends = await waitForRequests(gateway, "chat.send", 2);
      const steerParams = requireRecord(firstRunSends[1]?.params);
      expect(steerParams).toMatchObject({
        deliver: false,
        expectedRunId: firstRunId,
        message: steerText,
        queueMode: "steer",
        sessionKey: "main",
      });
      const steeredRow = page.locator(".chat-queue__item--steered", { hasText: steerText });
      await steeredRow.waitFor({ timeout: 10_000 });
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

  it("dismisses an informational steer notice when the steer request lands", async () => {
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

      const originalPrompt = "keep this run active";
      await page.locator(".agent-chat__composer-combobox textarea").fill(originalPrompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const activeRequest = await gateway.waitForRequest("chat.send");
      const activeRunId = requireString(
        requireRecord(activeRequest.params).idempotencyKey,
        "active run idempotency key",
      );
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [activeRunId],
        clientRunId: activeRunId,
        hasActiveRun: true,
        message: {
          __openclaw: {
            id: "persisted-notice-original-user",
            idempotencyKey: `${activeRunId}:user`,
            seq: 1,
          },
          content: [{ text: originalPrompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        messageId: "persisted-notice-original-user",
        messageSeq: 1,
        session: {
          activeRunIds: [activeRunId],
          hasActiveRun: true,
          key: "main",
          kind: "direct",
          status: "running",
          updatedAt: Date.now(),
        },
        sessionKey: "main",
      });
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const steerText = "route this into the active run";
      await page.locator(".agent-chat__composer-combobox textarea").fill(steerText);
      await page.getByRole("button", { name: "Queue message" }).click();
      const queue = page.locator(".chat-queue");
      await queue.getByText(steerText).waitFor({ timeout: 10_000 });
      await queue.getByRole("button", { name: "Steer" }).click();

      const sends = await waitForRequests(gateway, "chat.send", 2);
      const steerParams = requireRecord(sends[1]?.params);
      expect(steerParams).toMatchObject({
        expectedRunId: activeRunId,
        message: steerText,
        queueMode: "steer",
      });
      const steerRunId = requireString(steerParams.idempotencyKey, "steer idempotency key");
      const row = queue.locator(".chat-queue__item--steered", { hasText: steerText });
      await row.waitFor({ timeout: 10_000 });
      const pendingPresentation = await row.evaluate((element) => {
        const badge = element.querySelector<HTMLElement>(".chat-queue__badge--steered");
        const icon = element.querySelector(".chat-queue__icon");
        const probe = document.createElement("span");
        probe.style.color = "var(--info)";
        probe.style.background = "var(--info-subtle)";
        document.body.append(probe);
        const probeStyle = getComputedStyle(probe);
        const infoColor = probeStyle.color;
        const infoSubtle = probeStyle.backgroundColor;
        probe.remove();
        return {
          badgeColor: badge ? getComputedStyle(badge).color : "",
          backgroundColor: getComputedStyle(element).backgroundColor,
          iconPoints: icon?.querySelector("polyline")?.getAttribute("points") ?? "",
          infoColor,
          infoSubtle,
        };
      });
      await gateway.emitGatewayEvent("chat", {
        runId: steerRunId,
        sessionKey: "main",
        state: "final",
      });
      await row.waitFor({ state: "detached", timeout: 10_000 });
      await page.getByText(steerText, { exact: true }).waitFor({ timeout: 10_000 });
      await expectChatBubbleAbove(page, "keep this run active", steerText);

      expect(pendingPresentation).toMatchObject({
        badgeColor: pendingPresentation.infoColor,
        backgroundColor: pendingPresentation.infoSubtle,
        iconPoints: "15 10 20 15 15 20",
      });
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });
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
        expectedLeafEntryId: "leaf-active",
        expectedRunId: "active-run",
        message: queuedPrompt,
        queueMode: "steer",
        sessionKey: "main",
      });
      await queue.locator(".chat-queue__badge--steered", { hasText: "Steering" }).waitFor({
        timeout: 10_000,
      });
      await gateway.emitChatFinal({
        runId: requireString(steerParams.idempotencyKey, "restored steer idempotency key"),
        text: "Restored steer completed.",
      });
      await queue.getByText(queuedPrompt).waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
