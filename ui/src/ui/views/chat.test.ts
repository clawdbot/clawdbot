/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../ui-types.ts";
import { cleanupChatModuleState, renderChat, type ChatProps } from "./chat.ts";

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "agent:main:main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: true,
    showToolCalls: true,
    loading: false,
    sending: false,
    canAbort: true,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: "Working...",
    streamStartedAt: 1,
    draft: "",
    queue: [],
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key: "agent:main:main", kind: "direct", status: "running", updatedAt: null }],
    },
    focusMode: false,
    assistantName: "Test Agent",
    assistantAvatar: null,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onAbort: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    agentsList: { agents: [{ id: "main", name: "Main" }], defaultId: "main" },
    currentAgentId: "main",
    onAgentChange: () => undefined,
    ...overrides,
  };
}

function renderQueue(queue: ChatQueueItem[], onQueueSteer = vi.fn()) {
  const container = document.createElement("div");
  render(
    renderChat(
      createProps({
        queue,
        onQueueSteer,
      }),
    ),
    container,
  );
  return { container, onQueueSteer };
}

describe("chat view queue steering", () => {
  afterEach(() => {
    cleanupChatModuleState();
  });

  it("renders Steer only for queued messages during an active run", () => {
    const { container, onQueueSteer } = renderQueue([
      { id: "queued-1", text: "tighten the plan", createdAt: 1 },
      { id: "steered-1", text: "already sent", createdAt: 2, kind: "steered" },
      { id: "local-1", text: "/status", createdAt: 3, localCommandName: "status" },
    ]);

    const steerButtons = container.querySelectorAll<HTMLButtonElement>(".chat-queue__steer");
    expect(steerButtons).toHaveLength(1);
    expect(steerButtons[0].textContent?.trim()).toBe("Steer");
    expect(container.querySelector(".chat-queue__badge")?.textContent?.trim()).toBe("Steered");

    steerButtons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onQueueSteer).toHaveBeenCalledWith("queued-1");
  });

  it("hides queued-message Steer when no run is active", () => {
    const { container } = renderQueue(
      [{ id: "queued-1", text: "tighten the plan", createdAt: 1 }],
      vi.fn(),
    );
    render(
      renderChat(
        createProps({
          canAbort: false,
          stream: null,
          queue: [{ id: "queued-1", text: "tighten the plan", createdAt: 1 }],
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-queue__steer")).toBeNull();
  });
});
