// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { activeHistory, createState } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";

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
});
