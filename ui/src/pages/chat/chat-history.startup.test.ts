// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  updateChatRunProgressSnapshot,
  type ChatRunProgressSnapshot,
} from "../../../../src/gateway/server-chat-progress-snapshot.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { materializeVisibleAssistantStreamMessages } from "./chat-history-stream.ts";
import { activeHistory, createState } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import { handleAgentEvent } from "./tool-stream.ts";

describe("chat history startup progress", () => {
  it.each([
    {
      name: "restores workspace preparation before visible activity",
      phase: "preparing_workspace",
      text: "",
      startup: { state: "status", runId: "run-live", phase: "preparing_workspace" },
    },
    ...["naming_worktree", "creating_worktree", "running_setup"].map((phase) => ({
      name: `restores ${phase} before visible activity`,
      phase,
      text: "",
      startup: { state: "status", runId: "run-live", phase },
    })),
    {
      name: "keeps actual assistant activity ahead of an older startup status",
      phase: "preparing_workspace",
      text: "The assistant already started responding.",
      startup: { state: "activity", runId: "run-live" },
    },
  ])("$name", async ({ phase, text, startup }) => {
    const history = activeHistory("run-live");
    history.inFlightRun!.text = text;
    history.inFlightRun!.events = [
      {
        runId: "run-live",
        seq: 1,
        stream: "run_status",
        ts: 900,
        sessionKey: "main",
        data: { phase },
      },
    ];
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunStartup).toEqual(
      startup.state === "status" ? { ...startup, seq: 1 } : startup,
    );
  });

  it.each([true, false])(
    "retains newer live startup progress through delayed history (snapshot status=%s)",
    async (hasStatus) => {
      const history = activeHistory("run-live");
      history.inFlightRun!.events = hasStatus
        ? [
            {
              runId: "run-live",
              seq: 2,
              stream: "run_status",
              ts: 900,
              sessionKey: "main",
              data: { phase: "naming_worktree" },
            },
          ]
        : [];
      let resolveHistory!: (result: ChatHistoryResult) => void;
      const state = createState(history);
      state.chatRunId = "run-live";
      const request = vi.fn().mockReturnValue(
        new Promise<ChatHistoryResult>((resolve) => {
          resolveHistory = resolve;
        }),
      );
      state.client = { request } as unknown as GatewayBrowserClient;
      const loading = loadChatHistory(state);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      handleChatGatewayEvent(state, {
        runId: "run-live",
        sessionKey: "main",
        seq: 3,
        state: "status",
        phase: "creating_worktree",
      });
      resolveHistory(history);
      await loading;
      expect(state.chatRunStartup).toMatchObject({
        state: "status",
        runId: "run-live",
        phase: "creating_worktree",
      });
    },
  );

  it.each([true, false])(
    "reconciles retry waits after progress (live event received: %s)",
    async (receivedLiveProgress) => {
      const history = activeHistory("run-live");
      history.inFlightRun!.text = "I finished the first step.";
      const retry = {
        runId: "run-live",
        seq: 2,
        stream: "run_status",
        ts: 901,
        sessionKey: "main",
        data: {
          phase: "retrying",
          message: "Rate limited. Retrying in 4 seconds (attempt 3/8).",
        },
      };
      history.inFlightRun!.events = [
        {
          runId: "run-live",
          seq: 1,
          stream: "tool",
          ts: 900,
          sessionKey: "main",
          data: { phase: "result", toolCallId: "read-1", name: "read", result: "done" },
        },
        retry,
      ];
      const state = createState(history);
      const retryLabel = () =>
        chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null);
      const visibleText = () =>
        materializeVisibleAssistantStreamMessages(state.chatMessages, state).map(extractText);

      await loadChatHistory(state);
      expect(retryLabel()).toBe(retry.data.message);
      expect(state.chatRunId).toBe("run-live");
      expect(visibleText()).toEqual(["I finished the first step."]);
      await loadChatHistory(state);
      expect(retryLabel()).toBe(retry.data.message);
      expect(visibleText()).toEqual(["I finished the first step."]);

      const progress = {
        runId: "run-live",
        seq: 3,
        stream: "assistant",
        ts: 902,
        sessionKey: "main",
        data: { text: "Continuing" },
      };
      if (receivedLiveProgress) {
        handleAgentEvent(state, progress);
      } else {
        const snapshot = history.inFlightRun!.events.reduce<ChatRunProgressSnapshot | undefined>(
          (current, event) => updateChatRunProgressSnapshot(current, event),
          undefined,
        );
        history.inFlightRun!.events = updateChatRunProgressSnapshot(snapshot, progress)!.events;
        history.inFlightRun!.text += " Continuing";
      }
      await loadChatHistory(state);
      expect(retryLabel()).toBeUndefined();

      handleAgentEvent(state, { ...retry, seq: 4 });
      await loadChatHistory(state);
      expect(retryLabel()).toBe(retry.data.message);
      handleChatGatewayEvent(state, {
        runId: "run-live",
        sessionKey: "main",
        state: "final",
        message: { role: "assistant", content: "Finished" },
      });
      expect(state.chatRunId).toBeNull();
      expect(retryLabel()).toBeUndefined();
    },
  );
});
