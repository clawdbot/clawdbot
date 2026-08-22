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

  it("keeps the active run across a live steer operation", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const runId = "run-a";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "user",
          content: "run the long command",
          __openclaw: { id: "user-a", idempotencyKey: `${runId}:user`, seq: 1 },
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "callExec", name: "exec", arguments: {} }],
          __openclaw: { id: "exec-call", seq: 2 },
        },
        {
          role: "toolResult",
          toolCallId: "callExec",
          toolName: "exec",
          content: [{ type: "text", text: "process still running" }],
          __openclaw: { id: "exec-result", seq: 3 },
        },
      ],
      inFlightRun: { runId, text: "" },
      sessionInfo: { activeRunIds: [runId], hasActiveRun: true, key: "main" },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const configPatchesBefore = (await gateway.getRequests("config.patch")).length;
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await waitForRequests(gateway, "config.patch", configPatchesBefore + 1);
      const shortcut = page.locator("[data-settings-send-shortcut]");
      await shortcut.selectOption("enter");
      expect(await shortcut.inputValue()).toBe("enter");
      await page.goto(`${suite.server.baseUrl}chat`);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await page.locator(".chat-tool-msg-summary", { hasText: "Exec" }).waitFor();
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
      let agentSequence = 0;
      const commentaryText = "The active commentary stays visible.";
      await gateway.emitGatewayEvent("agent", {
        data: {
          kind: "preamble",
          itemId: "active-commentary",
          progressText: commentaryText,
        },
        runId,
        seq: ++agentSequence,
        sessionKey: "main",
        stream: "item",
        ts: Date.now(),
      });
      await page.getByText(commentaryText, { exact: true }).waitFor();
      const emitTool = (data: Record<string, unknown>) =>
        gateway.emitGatewayEvent("agent", {
          data,
          runId,
          seq: ++agentSequence,
          sessionKey: "main",
          stream: "tool",
          ts: Date.now(),
        });

      const steerText = "steer while the process runs";
      const sendsBeforeSteer = (await gateway.getRequests("chat.send")).length;
      await gateway.deferNext("chat.send");
      await composer.fill(steerText);
      await composer.press("Control+Enter");
      const steerSend = await gateway.waitForRequest("chat.send", { after: sendsBeforeSteer });
      const steerParams = requireRecord(steerSend.params);
      expect(steerParams).toMatchObject({
        deliver: false,
        message: steerText,
        queueMode: "steer",
        sessionKey: "main",
      });
      expect(steerParams).not.toHaveProperty("expectedRunId");
      expect(steerParams).not.toHaveProperty("expectedLeafEntryId");
      const steerRunId = requireString(
        steerParams.idempotencyKey,
        "steer chat send idempotency key",
      );
      await expect.poll(() => page.getByText(commentaryText, { exact: true }).count()).toBe(1);
      await gateway.resolveDeferred("chat.send", { runId: steerRunId, status: "started" });
      const steerUser = {
        __openclaw: {
          id: "ui4-steer-user",
          idempotencyKey: `${steerRunId}:user`,
          seq: 4,
          steerTargetRunId: runId,
        },
        content: [{ text: steerText, type: "text" }],
        role: "user",
        timestamp: Date.now(),
      };
      await gateway.deferNext("chat.history");
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [runId],
        clientRunId: steerRunId,
        hasActiveRun: true,
        message: steerUser,
        messageId: "ui4-steer-user",
        messageSeq: 4,
        session: {
          activeRunIds: [runId],
          hasActiveRun: true,
          key: "main",
          kind: "direct",
          status: "running",
          updatedAt: Date.now(),
        },
        sessionKey: "main",
      });
      await page.locator(".chat-group.user", { hasText: steerText }).waitFor();
      await gateway.emitGatewayEvent("chat", {
        runId: steerRunId,
        sessionKey: "main",
        state: "final",
      });

      await emitTool({
        args: { action: "poll" },
        name: "process",
        phase: "start",
        toolCallId: "callProcess",
      });
      await emitTool({
        name: "process",
        phase: "result",
        result: "process complete",
        toolCallId: "callProcess",
      });
      const workingRowKey = await page
        .locator("[data-virtual-row-key^='stream-run:']")
        .last()
        .getAttribute("data-virtual-row-key");
      const finalText = Array.from(
        { length: 18 },
        (_, index) =>
          `Terminal response paragraph ${index + 1}. ` +
          "The durable reply must replace every transient projection before the browser paints.",
      ).join("\n\n");
      await gateway.emitGatewayEvent("chat", {
        deltaText: finalText,
        message: {
          content: [{ text: finalText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      const streamingBubble = page.locator(".chat-bubble.streaming", {
        hasText: "Terminal response paragraph 1.",
      });
      await streamingBubble.waitFor();
      const streamingRow = streamingBubble.locator(
        "xpath=ancestor::div[contains(@class, 'chat-virtual-row')]",
      );
      await streamingRow.waitFor();
      expect(await streamingRow.getAttribute("data-virtual-row-key")).not.toBe(workingRowKey);
      const steerBubble = page.locator(".chat-group.user", { hasText: steerText }).last();
      const [steerBounds, streamingBounds] = await Promise.all([
        steerBubble.boundingBox(),
        streamingBubble.boundingBox(),
      ]);
      expect(steerBounds).not.toBeNull();
      expect(streamingBounds).not.toBeNull();
      expect(streamingBounds!.y).toBeGreaterThanOrEqual(steerBounds!.y + steerBounds!.height - 1);
      const durableFinalMessage = {
        role: "assistant",
        content: [{ text: finalText, type: "text" }],
        __openclaw: { id: "ui4-final", seq: 5 },
      };
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [runId],
        clientRunId: runId,
        hasActiveRun: true,
        message: durableFinalMessage,
        messageId: "ui4-final",
        messageSeq: 5,
        runId,
        sessionKey: "main",
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let frames = 12;
            const wait = () => {
              frames -= 1;
              if (frames <= 0) {
                resolve();
                return;
              }
              requestAnimationFrame(wait);
            };
            requestAnimationFrame(wait);
          }),
      );
      await streamingBubble.waitFor({ state: "detached" });
      expect(
        await page.locator(".chat-thread-inner").getByText(finalText, { exact: true }).count(),
      ).toBe(1);
      const overlaps = await page.locator(".chat-thread").evaluate((thread) => {
        const rows = Array.from(thread.querySelectorAll<HTMLElement>(".chat-virtual-row"))
          .map((row) => {
            const rect = row.getBoundingClientRect();
            return {
              bottom: rect.bottom,
              key: row.dataset.virtualRowKey ?? "",
              top: rect.top,
            };
          })
          .filter((row) => row.bottom > row.top)
          .toSorted((left, right) => left.top - right.top);
        return rows.slice(1).flatMap((row, index) => {
          const previous = rows[index];
          return previous && row.key !== previous.key && row.top < previous.bottom - 1
            ? [`${previous.key}->${row.key}`]
            : [];
        });
      });
      expect(overlaps).toEqual([]);
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        clientRunId: runId,
        hasActiveRun: false,
        message: durableFinalMessage,
        messageId: "ui4-final",
        messageSeq: 5,
        runId,
        sessionKey: "main",
      });
      await expect
        .poll(() =>
          page
            .locator(
              "[data-virtual-row-key^='stream-run:'] .chat-group.assistant:not(.chat-group--working)",
            )
            .count(),
        )
        .toBe(0);
      await gateway.emitChatFinal({ runId, text: finalText });
      await expect
        .poll(() =>
          page.locator(".chat-thread-inner").getByText(finalText, { exact: true }).count(),
        )
        .toBe(1);
      await expect
        .poll(() => page.locator(".chat-work-group", { hasText: "used process" }).count())
        .toBe(0);
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

  it("routes /redirect through one interrupt-mode chat.send", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("/redirect start over cleanly");
      await page.getByRole("button", { name: "Send message" }).click();

      const request = await gateway.waitForRequest("chat.send");
      expect(requireRecord(request.params)).toMatchObject({
        message: "start over cleanly",
        queueMode: "interrupt",
        sessionKey: "main",
        idempotencyKey: expect.any(String),
      });
      await page.getByText("Redirected.").waitFor({ timeout: 10_000 });
      await expectRequestCountStable(gateway, "chat.send", 1);
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
