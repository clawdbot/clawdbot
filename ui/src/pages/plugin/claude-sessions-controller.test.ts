import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  getClaudeSessionsState,
  loadClaudeSessions,
  loadClaudeTranscript,
  stopClaudeSessionsPolling,
} from "./claude-sessions-controller.ts";
import { getCodexSessionsState } from "./codex-sessions-controller.ts";

describe("Claude sessions controller", () => {
  it("maps shared catalog requests to Anthropic methods without sharing Codex state", async () => {
    const host = {};
    const request = vi.fn().mockResolvedValue({
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local Claude",
          kind: "gateway",
          connected: true,
          sessions: [],
        },
      ],
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const state = getClaudeSessionsState(host);

    await loadClaudeSessions(state, client);

    expect(request).toHaveBeenCalledWith("anthropic.sessions.list", { limitPerHost: 40 });
    expect(state.hosts[0]?.label).toBe("Local Claude");
    expect(getCodexSessionsState(host)).not.toBe(state);
    stopClaudeSessionsPolling(host);
  });

  it("maps paginated transcript requests and restores chronological order", async () => {
    const host = {};
    const request = vi.fn().mockResolvedValue({
      hostId: "gateway:local",
      label: "Local Claude",
      threadId: "thread-1",
      items: [
        { type: "agentMessage", text: "answer" },
        { type: "userMessage", text: "question" },
      ],
      nextCursor: "older",
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const state = getClaudeSessionsState(host);

    await loadClaudeTranscript(state, client, "gateway:local", "thread-1");

    expect(request).toHaveBeenCalledWith("anthropic.sessions.read", {
      hostId: "gateway:local",
      threadId: "thread-1",
      limit: 20,
    });
    expect(state.transcriptItems.map((item) => item.text)).toEqual(["question", "answer"]);
    expect(state.transcriptNextCursor).toBe("older");
    stopClaudeSessionsPolling(host);
  });
});
