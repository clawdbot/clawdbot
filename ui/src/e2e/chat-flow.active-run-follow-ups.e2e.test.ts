import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReconnecting } from "../test-helpers/control-ui-e2e-readiness.ts";
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
        sessionKey: "agent:main:main",
      });
      await page.locator(".chat-queue").waitFor({ state: "detached", timeout: 10_000 });
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
      sessionInfo: { activeRunIds: [runId], hasActiveRun: true, key: "agent:main:main" },
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
        sessionKey: "agent:main:main",
        stream: "item",
        ts: Date.now(),
      });
      const transcript = page.locator(".chat-thread-inner");
      await transcript.getByText(commentaryText, { exact: true }).waitFor();
      const emitTool = (data: Record<string, unknown>) =>
        gateway.emitGatewayEvent("agent", {
          data,
          runId,
          seq: ++agentSequence,
          sessionKey: "agent:main:main",
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
        sessionKey: "agent:main:main",
      });
      expect(steerParams).not.toHaveProperty("expectedRunId");
      expect(steerParams).not.toHaveProperty("expectedLeafEntryId");
      const steerRunId = requireString(
        steerParams.idempotencyKey,
        "steer chat send idempotency key",
      );
      await expect
        .poll(() => transcript.getByText(commentaryText, { exact: true }).count())
        .toBe(1);
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
          key: "agent:main:main",
          kind: "direct",
          status: "running",
          updatedAt: Date.now(),
        },
        sessionKey: "agent:main:main",
      });
      await page.locator(".chat-group.user", { hasText: steerText }).waitFor();
      await gateway.emitGatewayEvent("chat", {
        runId: steerRunId,
        sessionKey: "agent:main:main",
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
        .locator("[data-virtual-row-key^='agent-run:']")
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
        sessionKey: "agent:main:main",
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
      const steerElement = await steerBubble.elementHandle();
      // Scrolling between separate protocol reads can make adjacent rows appear to overlap.
      const [steerBounds, streamingBounds] = await streamingBubble.evaluate(
        (streaming, steer) =>
          [steer, streaming].map((element) => {
            if (!element?.isConnected || element.getClientRects().length === 0) {
              return null;
            }
            const { y, height } = element.getBoundingClientRect();
            return { y, height };
          }),
        steerElement,
      );
      await steerElement?.dispose();
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
        sessionKey: "agent:main:main",
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
        sessionKey: "agent:main:main",
      });
      await expect
        .poll(() =>
          page.locator("[data-virtual-row-key^='agent-run:'] .chat-bubble.streaming").count(),
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

  it.each(["before", "after"] as const)(
    "keeps cumulative stream text ordered when history resolves %s the live steer event",
    async (historyOrder) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const runId = "run-steer-order";
      const steerRunId = "steer-order";
      const startedAt = Date.now() - 3_000;
      const initialText = "Explain the long running operation.";
      const beforeText = "This explanation streamed before the steering message.";
      const steerText = "Now focus on the remaining work.";
      const afterText = "This continuation streamed after the steering message.";
      const userMessage = {
        role: "user",
        content: initialText,
        timestamp: startedAt - 1_000,
        __openclaw: { id: "order-user", idempotencyKey: `${runId}:user`, seq: 1 },
      };
      const steerMessage = {
        role: "user",
        content: steerText,
        timestamp: startedAt + 1_000,
        __openclaw: {
          id: "order-steer",
          idempotencyKey: `${steerRunId}:user`,
          seq: 2,
          steerTargetRunId: runId,
        },
      };
      const sessionInfo = { activeRunIds: [runId], hasActiveRun: true, key: "agent:main:main" };
      const gateway = await installMockGateway(page, {
        historyMessages: [userMessage],
        inFlightRun: { runId, startedAt, text: "" },
        sessionInfo,
      });
      const emitSteer = () =>
        gateway.emitGatewayEvent("session.message", {
          ...sessionInfo,
          clientRunId: steerRunId,
          message: steerMessage,
          messageId: "order-steer",
          messageSeq: 2,
          sessionKey: "agent:main:main",
        });
      const emitDelta = (text: string) =>
        gateway.emitGatewayEvent("chat", {
          message: { role: "assistant", content: [{ type: "text", text }] },
          runId,
          sessionKey: "agent:main:main",
          state: "delta",
        });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const transcript = page.locator(".chat-thread-inner");
        await transcript.getByText(initialText, { exact: true }).waitFor();
        await emitDelta(beforeText);
        await transcript.getByText(beforeText, { exact: true }).waitFor();
        if (historyOrder === "after") {
          await emitSteer();
          await transcript.getByText(steerText, { exact: true }).waitFor();
        }

        await gateway.setMethodResponse("chat.history", {
          messages: [userMessage, steerMessage],
          inFlightRun: { runId, startedAt, text: beforeText },
          sessionInfo,
        });
        const startupsBefore = (await gateway.getRequests("chat.startup")).length;
        await gateway.deferNext("chat.startup");
        await gateway.setOnline(false);
        await waitForControlUiGatewayReconnecting(page);
        await gateway.setOnline(true);
        await gateway.waitForRequest("chat.startup", { after: startupsBefore });
        await gateway.resolveDeferred("chat.startup");
        await transcript.getByText(steerText, { exact: true }).waitFor();
        await page.getByRole("button", { name: "Stop generating" }).waitFor();
        if (historyOrder === "before") {
          await emitSteer();
        }
        await emitDelta(`${beforeText}\n\n${afterText}`);

        try {
          await expect
            .poll(() =>
              transcript
                .locator(".chat-bubble .chat-text")
                .evaluateAll((bubbles) => bubbles.map((bubble) => bubble.textContent?.trim())),
            )
            .toEqual([initialText, beforeText, steerText, afterText]);
        } finally {
          const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
          if (artifactDir) {
            await mkdir(artifactDir, { recursive: true });
            await page.screenshot({
              fullPage: true,
              path: path.join(artifactDir, `steer-history-${historyOrder}-live-event.png`),
            });
          }
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("replaces a retained cumulative steer prefix with split history around keyed commentary", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const runId = "run-steer-split";
    const steerRunId = "steer-split";
    const startedAt = Date.now() - 5_000;
    const initialText = "Explain the long running operation.";
    const beforeText = "A B";
    const commentaryText = "Checking the intermediate result.";
    const steerText = "Now focus on the remaining work.";
    const afterText = "The remaining work continues after steering.";
    const userMessage = {
      role: "user",
      content: initialText,
      timestamp: startedAt - 1_000,
      __openclaw: { id: "split-user", idempotencyKey: `${runId}:user`, seq: 1 },
    };
    const steerMessage = {
      role: "user",
      content: steerText,
      timestamp: startedAt + 3_000,
      __openclaw: {
        id: "split-steer",
        idempotencyKey: `${steerRunId}:user`,
        seq: 5,
        steerTargetRunId: runId,
      },
    };
    const sessionInfo = { activeRunIds: [runId], hasActiveRun: true, key: "agent:main:main" };
    const gateway = await installMockGateway(page, {
      historyMessages: [userMessage],
      inFlightRun: { runId, startedAt, text: "" },
      sessionInfo,
    });
    const emitDelta = (text: string) =>
      gateway.emitGatewayEvent("chat", {
        message: { role: "assistant", content: [{ type: "text", text }] },
        runId,
        sessionKey: "agent:main:main",
        state: "delta",
      });
    const capture = async (name: string) => {
      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, `steer-split-commentary-${name}.png`),
        });
      }
    };

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const transcript = page.locator(".chat-thread-inner");
      const bubbleTexts = () =>
        transcript
          .locator(".chat-bubble .chat-text")
          .evaluateAll((bubbles) => bubbles.map((bubble) => bubble.textContent?.trim()));
      await transcript.getByText(initialText, { exact: true }).waitFor();
      await emitDelta(beforeText);
      await transcript.getByText(beforeText, { exact: true }).waitFor();
      // The live steer closes one combined segment before split history replaces it.
      await gateway.emitGatewayEvent("session.message", {
        ...sessionInfo,
        clientRunId: steerRunId,
        message: steerMessage,
        messageId: "split-steer",
        messageSeq: 5,
        sessionKey: "agent:main:main",
      });
      await expect.poll(bubbleTexts).toEqual([initialText, beforeText, steerText]);
      await capture("retained-prefix");

      await gateway.setMethodResponse("chat.history", {
        messages: [
          userMessage,
          {
            role: "assistant",
            content: "A",
            timestamp: startedAt,
            __openclaw: { id: "split-a", idempotencyKey: runId, seq: 2 },
          },
          {
            role: "assistant",
            content: commentaryText,
            timestamp: startedAt + 1_000,
            __openclaw: { id: "split-commentary", idempotencyKey: runId, seq: 3 },
            openclawStreamFallback: {
              itemId: "split-commentary-item",
              source: "segment",
              replacementText: commentaryText,
              runId,
            },
          },
          {
            role: "assistant",
            content: "B",
            timestamp: startedAt + 2_000,
            __openclaw: { id: "split-b", idempotencyKey: runId, seq: 4 },
          },
          steerMessage,
        ],
        inFlightRun: { runId, startedAt, text: beforeText },
        sessionInfo,
      });
      const startupsBefore = (await gateway.getRequests("chat.startup")).length;
      await gateway.deferNext("chat.startup");
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await gateway.setOnline(true);
      await gateway.waitForRequest("chat.startup", { after: startupsBefore });
      await gateway.resolveDeferred("chat.startup");
      await transcript.getByText(commentaryText, { exact: true }).waitFor();
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
      await emitDelta(`${beforeText} ${afterText}`);

      try {
        await expect
          .poll(bubbleTexts)
          .toEqual([initialText, "A", commentaryText, "B", steerText, afterText]);
      } finally {
        await capture("recovered-continuation");
      }
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
      await expectRequestCountStable(gateway, "chat.send", 1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("projects one disconnected state for an offline steer follow-up", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("steer");
      await page.locator("[data-settings-send-shortcut]").selectOption("enter");
      await page.goto(`${suite.server.baseUrl}chat`);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("keep the disconnect run active");
      await page.getByRole("button", { name: "Send message" }).click();
      const initial = requireRecord((await gateway.waitForRequest("chat.send")).params);
      const activeRunId = requireString(initial.idempotencyKey, "initial accepted run");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      // Establish delivery before disconnect; the follow-up is the only unsent turn.
      const acceptedSession = {
        key: "agent:main:main",
        sessionId: "session:agent:main:main",
        hasActiveRun: true,
        activeRunIds: [activeRunId],
        status: "running",
      };
      await gateway.setMethodResponse("chat.history", {
        sessionId: acceptedSession.sessionId,
        sessionInfo: acceptedSession,
        messages: [
          {
            role: "user",
            content: "keep the disconnect run active",
            idempotencyKey: `${activeRunId}:user`,
          },
        ],
      });
      await gateway.emitGatewayEvent("sessions.changed", acceptedSession);
      await page.locator(".chat-send-status").waitFor({ state: "detached" });

      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);

      const followUpText = "steer after the gateway returns";
      await composer.fill(followUpText);
      await page.locator(".agent-chat__composer-actions .chat-send-btn--send").click();

      const rows = page.locator(".chat-queue__item");
      await expect.poll(() => rows.count()).toBe(1);
      await expect.poll(() => rows.getByText("Waiting for reconnect").count()).toBe(1);
      expect(await rows.getByText("Steer", { exact: true }).count()).toBe(0);
      await expectRequestCountStable(gateway, "chat.send", 1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("sends a queued follow-up after an exact terminal session publication", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionInfo: { hasActiveRun: false, status: "done" },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.goto(`${suite.server.baseUrl}chat`);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const initialText = "keep this run active until session state settles it";
      await composer.fill(initialText);
      await page.getByRole("button", { name: "Send message" }).click();
      const initialSend = await gateway.waitForRequest("chat.send");
      const initialSendParams = requireRecord(initialSend.params);
      const activeRunId = requireString(initialSendParams.idempotencyKey, "active chat run id");
      const activeSessionKey = requireString(initialSendParams.sessionKey, "active session key");
      await page.getByRole("button", { name: "Stop generating" }).waitFor({ timeout: 10_000 });

      const followUp = "send after the missed terminal event";
      await composer.fill(followUp);
      await page.getByRole("button", { name: "Queue message" }).click();
      const queuedRow = page.locator(".chat-queue__item", { hasText: followUp });
      await queuedRow.waitFor({ timeout: 10_000 });
      await expectRequestCountStable(gateway, "chat.send", 1);

      await gateway.setHistoryMessages([
        {
          __openclaw: {
            idempotencyKey: `${activeRunId}:user`,
          },
          content: [{ text: initialText, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
      ]);
      const sessionListsBeforeTerminal = (await gateway.getRequests("sessions.list")).length;
      await gateway.deferNext("sessions.list");
      await gateway.emitGatewayEvent("sessions.changed", {
        activeRunIds: [activeRunId],
        hasActiveRun: true,
        key: activeSessionKey,
        kind: "direct",
        reason: "lifecycle",
        status: "running",
        updatedAt: Date.now(),
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(sessionListsBeforeTerminal);
      await gateway.resolveDeferred(
        "sessions.list",
        chatSessionListResponse([
          {
            activeRunIds: [],
            hasActiveRun: false,
            key: activeSessionKey,
            sessionId: `session:${activeSessionKey}`,
            kind: "direct",
            label: "Main",
            lastRunId: activeRunId,
            status: "done",
            updatedAt: Date.now(),
          },
        ]),
      );

      const sends = await waitForRequests(gateway, "chat.send", 2);
      expect(requireRecord(sends[1]?.params)).toMatchObject({ message: followUp });
      await queuedRow.waitFor({ state: "detached", timeout: 10_000 });
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
    const sessionKey = "agent:main:main";
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
        sessionKey: "agent:main:main",
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
            key: "agent:main:main",
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
        sessionKey: "agent:main:main",
      });
      expect(steerParams).not.toHaveProperty("expectedRunId");
      expect(steerParams).not.toHaveProperty("expectedLeafEntryId");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
