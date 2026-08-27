// Tests session /update command gates and detached update start.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { HandleCommandsParams } from "./commands-types.js";

const mocks = vi.hoisted(() => ({
  clearRestartSentinel: vi.fn(async () => undefined),
  isUpdateEnabled: vi.fn(() => true),
  extractDeliveryInfo: vi.fn(() => ({
    deliveryContext: {
      channel: "telegram",
      to: "telegram:123",
      accountId: "default",
    },
    threadId: "thread-1",
  })),
  formatDoctorNonInteractiveHint: vi.fn(
    () =>
      "Recommended follow-up: run openclaw doctor --non-interactive in a terminal or approvals-capable OpenClaw surface.",
  ),
  writeRestartSentinel: vi.fn(async (_payload: RestartSentinelPayload) => undefined),
  spawnDetachedChatUpdate: vi.fn(() => ({ ok: true as const, pid: 4242 })),
}));

vi.mock("../../config/commands.flags.js", () => ({
  isRestartEnabled: vi.fn(() => true),
  isUpdateEnabled: mocks.isUpdateEnabled,
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: mocks.extractDeliveryInfo,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn(),
  normalizeChannelId: (value?: string | null) => value?.trim().toLowerCase() ?? null,
}));

vi.mock("../../channels/plugins/conversation-bindings.js", () => ({
  setChannelConversationBindingIdleTimeoutBySessionKey: vi.fn(),
  setChannelConversationBindingMaxAgeBySessionKey: vi.fn(),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: vi.fn(),
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    clearRestartSentinel: mocks.clearRestartSentinel,
    formatDoctorNonInteractiveHint: mocks.formatDoctorNonInteractiveHint,
    writeRestartSentinel: mocks.writeRestartSentinel,
  };
});

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: vi.fn(),
  triggerOpenClawRestart: vi.fn(),
}));

vi.mock("./commands-update-spawn.js", () => ({
  spawnDetachedChatUpdate: mocks.spawnDetachedChatUpdate,
}));

const { handleUpdateCommand } = await import("./commands-session.js");

function updateCommandParams(overrides?: Partial<HandleCommandsParams>): HandleCommandsParams {
  return {
    ctx: {},
    cfg: {},
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "user-1",
      rawBodyNormalized: "/update",
      commandBodyNormalized: "/update",
      from: "telegram:123",
      to: "bot",
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:telegram:direct:123:thread:thread-1",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
    ...overrides,
  } as HandleCommandsParams;
}

describe("handleUpdateCommand", () => {
  beforeEach(() => {
    mocks.isUpdateEnabled.mockReset();
    mocks.isUpdateEnabled.mockReturnValue(true);
    mocks.clearRestartSentinel.mockClear();
    mocks.extractDeliveryInfo.mockClear();
    mocks.writeRestartSentinel.mockClear();
    mocks.spawnDetachedChatUpdate.mockReset();
    mocks.spawnDetachedChatUpdate.mockReturnValue({ ok: true, pid: 4242 });
  });

  it("ignores unauthorized senders", async () => {
    const result = await handleUpdateCommand(
      updateCommandParams({
        command: {
          ...updateCommandParams().command,
          isAuthorizedSender: false,
          senderIsOwner: false,
        },
      }),
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
    expect(mocks.writeRestartSentinel).not.toHaveBeenCalled();
    expect(mocks.spawnDetachedChatUpdate).not.toHaveBeenCalled();
  });

  it("rejects authorized non-owner update commands", async () => {
    const result = await handleUpdateCommand(
      updateCommandParams({
        command: {
          ...updateCommandParams().command,
          senderIsOwner: false,
          isAuthorizedSender: true,
        },
      }),
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
    expect(mocks.writeRestartSentinel).not.toHaveBeenCalled();
    expect(mocks.spawnDetachedChatUpdate).not.toHaveBeenCalled();
  });

  it("does not update when commands.update is disabled", async () => {
    mocks.isUpdateEnabled.mockReturnValue(false);

    const result = await handleUpdateCommand(updateCommandParams(), true);

    expect(result?.reply?.text).toContain("commands.update=false");
    expect(mocks.spawnDetachedChatUpdate).not.toHaveBeenCalled();
  });

  it("starts a detached update and does not throw", async () => {
    const result = await handleUpdateCommand(updateCommandParams(), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Updating OpenClaw");
    expect(mocks.writeRestartSentinel).toHaveBeenCalledOnce();
    const payload = mocks.writeRestartSentinel.mock.calls[0]?.[0];
    expect(payload?.message).toBe("/update");
    expect(payload?.stats).toEqual({
      mode: "gateway.update",
      reason: "/update",
    });
    expect(mocks.spawnDetachedChatUpdate).toHaveBeenCalledTimes(1);
  });

  it("clears the sentinel when the detached update fails to start", async () => {
    mocks.spawnDetachedChatUpdate.mockReturnValueOnce({
      ok: false,
      detail: "spawn ENOENT",
    });

    const result = await handleUpdateCommand(updateCommandParams(), true);

    expect(result?.reply?.text).toContain("Update failed to start");
    expect(mocks.clearRestartSentinel).toHaveBeenCalledOnce();
  });
});
