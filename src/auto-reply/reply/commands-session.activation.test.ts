// Tests owner gating for group activation session changes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

const persistSessionEntryMock = vi.hoisted(() => vi.fn(async () => true));
const persistenceConflictReply = vi.hoisted(() => ({
  shouldContinue: false,
  reply: { text: "retry session command" },
}));

vi.mock("./commands-session-store.js", () => ({
  persistSessionEntry: persistSessionEntryMock,
  sessionEntryPersistenceConflictReply: () => persistenceConflictReply,
}));

function buildActivationParams(
  overrides: {
    commandBody?: string;
    isAuthorizedSender?: boolean;
    senderIsOwner?: boolean;
  } = {},
): HandleCommandsParams {
  const commandBody = overrides.commandBody ?? "/activation always";
  return {
    cfg: { commands: { text: true } },
    ctx: {
      CommandSource: "text",
      CommandAuthorized: overrides.isAuthorizedSender ?? true,
      CommandBody: commandBody,
      Surface: "telegram",
      Provider: "telegram",
    },
    command: {
      commandBodyNormalized: commandBody,
      rawBodyNormalized: commandBody,
      isAuthorizedSender: overrides.isAuthorizedSender ?? true,
      senderIsOwner: overrides.senderIsOwner ?? true,
      senderId: "group-member",
      channel: "telegram",
      channelId: "telegram",
      surface: "telegram",
      ownerList: ["owner"],
      from: "group-member",
      to: "bot",
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "telegram:group:main",
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: 1,
      channel: "telegram",
      chatType: "group",
      groupActivation: "mention",
    },
    sessionStore: {},
    workspaceDir: "/tmp/workspace",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.5",
    contextTokens: 0,
    isGroup: true,
  } as unknown as HandleCommandsParams;
}

describe("handleActivationCommand", () => {
  beforeEach(() => {
    persistSessionEntryMock.mockClear();
    persistSessionEntryMock.mockResolvedValue(true);
  });

  it("rejects authorized non-owner senders without changing group activation", async () => {
    const { handleActivationCommand } = await import("./commands-session.js");
    const params = buildActivationParams({ senderIsOwner: false });

    const result = await handleActivationCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(params.sessionEntry?.groupActivation).toBe("mention");
    expect(params.sessionEntry?.groupActivationNeedsSystemIntro).toBeUndefined();
    expect(persistSessionEntryMock).not.toHaveBeenCalled();
  });

  it("allows owners to change group activation", async () => {
    const { handleActivationCommand } = await import("./commands-session.js");
    const params = buildActivationParams();

    const result = await handleActivationCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚙️ Group activation set to always." },
    });
    expect(params.sessionEntry?.groupActivation).toBe("always");
    expect(params.sessionEntry?.groupActivationNeedsSystemIntro).toBe(true);
    expect(persistSessionEntryMock).toHaveBeenCalledWith({
      ...params,
      touchedFields: ["groupActivation", "groupActivationNeedsSystemIntro"],
    });
  });

  it("reports a concurrent session change instead of acknowledging persistence", async () => {
    const { handleActivationCommand } = await import("./commands-session.js");
    const params = buildActivationParams();
    persistSessionEntryMock.mockResolvedValueOnce(false);

    await expect(handleActivationCommand(params, true)).resolves.toEqual(persistenceConflictReply);
  });
});
