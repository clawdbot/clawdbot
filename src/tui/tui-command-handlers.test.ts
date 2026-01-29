import { describe, expect, it, vi } from "vitest";

import { createCommandHandlers } from "./tui-command-handlers.js";

describe("tui command handlers", () => {
  it("forwards unknown slash commands to the gateway", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "r1" });
    const addUser = vi.fn();
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const setActivityStatus = vi.fn();

    const { handleCommand } = createCommandHandlers({
      client: { sendChat } as never,
      chatLog: { addUser, addSystem } as never,
      tui: { requestRender } as never,
      opts: {},
      state: {
        currentSessionKey: "agent:main:main",
        activeChatRunId: null,
        sessionInfo: {},
      } as never,
      deliverDefault: false,
      openOverlay: vi.fn(),
      closeOverlay: vi.fn(),
      refreshSessionInfo: vi.fn(),
      loadHistory: vi.fn(),
      setSession: vi.fn(),
      refreshAgents: vi.fn(),
      abortActive: vi.fn(),
      setActivityStatus,
      formatSessionKey: vi.fn(),
    });

    await handleCommand("/context");

    expect(addSystem).not.toHaveBeenCalled();
    expect(addUser).toHaveBeenCalledWith("/context");
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "/context",
      }),
    );
    expect(requestRender).toHaveBeenCalled();
  });

  it("normalizes /reasoning streaming to stream", async () => {
    const patchSession = vi.fn().mockResolvedValue(undefined);
    const addUser = vi.fn();
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);

    const { handleCommand } = createCommandHandlers({
      client: { patchSession } as never,
      chatLog: { addUser, addSystem } as never,
      tui: { requestRender } as never,
      opts: {},
      state: {
        currentSessionKey: "agent:main:main",
        activeChatRunId: null,
        sessionInfo: {},
      } as never,
      deliverDefault: false,
      openOverlay: vi.fn(),
      closeOverlay: vi.fn(),
      refreshSessionInfo,
      loadHistory: vi.fn(),
      setSession: vi.fn(),
      refreshAgents: vi.fn(),
      abortActive: vi.fn(),
      setActivityStatus: vi.fn(),
      formatSessionKey: vi.fn(),
    });

    await handleCommand("/reasoning streaming");

    expect(patchSession).toHaveBeenCalledWith({
      key: "agent:main:main",
      reasoningLevel: "stream",
    });
    expect(addSystem).toHaveBeenCalledWith("reasoning set to stream");
    expect(refreshSessionInfo).toHaveBeenCalled();
  });
});
