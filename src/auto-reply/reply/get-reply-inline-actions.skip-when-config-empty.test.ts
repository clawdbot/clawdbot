import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillCommandSpec } from "../../agents/skills.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { stripInlineStatus } from "./reply-inline.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const { buildStatusReplyMock, createOpenClawToolsMock, getChannelPluginMock, handleCommandsMock } =
  vi.hoisted(() => ({
    buildStatusReplyMock: vi.fn(),
    createOpenClawToolsMock: vi.fn(),
    getChannelPluginMock: vi.fn(),
    handleCommandsMock: vi.fn(),
  }));

type HandleInlineActionsInput = Parameters<
  typeof import("./get-reply-inline-actions.js").handleInlineActions
>[0];

vi.mock("./commands.runtime.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
  buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
}));

vi.mock("../../agents/openclaw-tools.runtime.js", () => ({
  createOpenClawTools: (...args: unknown[]) => createOpenClawToolsMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
  getLoadedChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
  listChannelPlugins: () => [],
  normalizeChannelId: (value?: string) => value?.trim().toLowerCase() || null,
}));

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

const createHandleInlineActionsInput = (params: {
  ctx: ReturnType<typeof buildTestCtx>;
  typing: TypingController;
  cleanedBody: string;
  command?: Partial<HandleInlineActionsInput["command"]>;
  overrides?: Partial<Omit<HandleInlineActionsInput, "ctx" | "sessionCtx" | "typing" | "command">>;
}): HandleInlineActionsInput => {
  const baseCommand: HandleInlineActionsInput["command"] = {
    surface: "whatsapp",
    channel: "whatsapp",
    channelId: "whatsapp",
    ownerList: [],
    senderIsOwner: false,
    isAuthorizedSender: false,
    senderId: undefined,
    abortKey: "whatsapp:+999",
    rawBodyNormalized: params.cleanedBody,
    commandBodyNormalized: params.cleanedBody,
    from: "whatsapp:+999",
    to: "whatsapp:+999",
  };
  return {
    ctx: params.ctx,
    sessionCtx: params.ctx as unknown as TemplateContext,
    cfg: {},
    agentId: "main",
    sessionKey: "s:main",
    workspaceDir: "/tmp",
    isGroup: false,
    typing: params.typing,
    allowTextCommands: false,
    inlineStatusRequested: false,
    command: {
      ...baseCommand,
      ...params.command,
    },
    directives: clearInlineDirectives(params.cleanedBody),
    cleanedBody: params.cleanedBody,
    elevatedEnabled: false,
    elevatedAllowed: false,
    elevatedFailures: [],
    defaultActivation: () => "always",
    resolvedThinkLevel: undefined,
    resolvedVerboseLevel: undefined,
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    resolveDefaultThinkingLevel: async () => "off",
    provider: "openai",
    model: "gpt-4o-mini",
    contextTokens: 0,
    abortedLastRun: false,
    sessionScope: "per-sender",
    ...params.overrides,
  };
};

async function expectInlineActionSkipped(params: {
  ctx: ReturnType<typeof buildTestCtx>;
  typing: TypingController;
  cleanedBody: string;
  command?: Partial<HandleInlineActionsInput["command"]>;
  overrides?: Partial<Omit<HandleInlineActionsInput, "ctx" | "sessionCtx" | "typing" | "command">>;
}) {
  const result = await handleInlineActions(createHandleInlineActionsInput(params));
  expect(result).toEqual({ kind: "reply", reply: undefined });
  expect(params.typing.cleanup).toHaveBeenCalled();
  expect(handleCommandsMock).not.toHaveBeenCalled();
}

async function runInlineStatusAction(storePath?: string) {
  const typing = createTypingController();
  const ctx = buildTestCtx({
    Body: "/status",
    CommandBody: "/status",
  });
  const result = await handleInlineActions(
    createHandleInlineActionsInput({
      ctx,
      typing,
      cleanedBody: stripInlineStatus("/status").cleaned,
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: "/status",
        commandBodyNormalized: "/status",
      },
      overrides: {
        allowTextCommands: true,
        inlineStatusRequested: true,
        ...(storePath ? { storePath } : {}),
      },
    }),
  );

  return { result, typing };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function mockObjectArg(mock: ReturnType<typeof vi.fn>, label: string, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  expect(call).toBeDefined();
  if (!call) {
    throw new Error(`expected ${label} mock call ${callIndex}`);
  }
  return requireRecord(call[argIndex], `${label} argument ${argIndex}`);
}

function mockCallArgs(mock: ReturnType<typeof vi.fn>, label: string, callIndex = 0): unknown[] {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  expect(call).toBeDefined();
  if (!call) {
    throw new Error(`expected ${label} mock call ${callIndex}`);
  }
  return call;
}

describe("handleInlineActions", () => {
  beforeEach(() => {
    handleCommandsMock.mockReset();
    handleCommandsMock.mockResolvedValue({ shouldContinue: true, reply: undefined });
    getChannelPluginMock.mockReset();
    createOpenClawToolsMock.mockReset();
    buildStatusReplyMock.mockReset();
    buildStatusReplyMock.mockResolvedValue({ text: "status" });
    createOpenClawToolsMock.mockReturnValue([]);
    getChannelPluginMock.mockImplementation((channelId?: string) =>
      channelId === "whatsapp"
        ? { commands: { skipWhenConfigEmpty: true } }
        : channelId === "discord"
          ? { mentions: { stripPatterns: () => ["<@!?\\d+>"] } }
          : undefined,
    );
  });

  it("skips whatsapp replies when config is empty and From !== To", async () => {
    const typing = createTypingController();

    const ctx = buildTestCtx({
      From: "whatsapp:+999",
      To: "whatsapp:+123",
      Body: "hi",
    });
    await expectInlineActionSkipped({
      ctx,
      typing,
      cleanedBody: "hi",
      command: { to: "whatsapp:+123" },
    });
  });

  it("forwards agentDir into handleCommands", async () => {
    const typing = createTypingController();

    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "done" } });

    const ctx = buildTestCtx({
      Body: "/status",
      CommandBody: "/status",
    });
    const agentDir = "/tmp/inline-agent";

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "/status",
        command: {
          isAuthorizedSender: true,
          senderId: "sender-1",
          abortKey: "sender-1",
        },
        overrides: {
          cfg: { commands: { text: true } },
          agentDir,
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "done" } });
    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
    expect(mockObjectArg(handleCommandsMock, "handleCommands").agentDir).toBe(agentDir);
  });

  it("prefers the target session entry when routing inline commands into handleCommands", async () => {
    const typing = createTypingController();

    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "done" } });

    const ctx = buildTestCtx({
      Body: "/status",
      CommandBody: "/status",
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "/status",
        command: {
          isAuthorizedSender: true,
          rawBodyNormalized: "/status",
          commandBodyNormalized: "/status",
        },
        overrides: {
          allowTextCommands: true,
          cfg: { commands: { text: true } },
          sessionEntry: {
            sessionId: "wrapper-session",
            updatedAt: Date.now(),
          } as SessionEntry,
          sessionStore: {
            "s:main": {
              sessionId: "target-session",
              updatedAt: Date.now(),
            } as SessionEntry,
          },
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "done" } });
    const commandArgs = mockObjectArg(handleCommandsMock, "handleCommands");
    expect(requireRecord(commandArgs.sessionEntry, "sessionEntry").sessionId).toBe(
      "target-session",
    );
  });

  it("does not run command handlers after replying to an inline status-only turn", async () => {
    const { result, typing } = await runInlineStatusAction();

    expect(result).toEqual({ kind: "reply", reply: undefined });
    expect(buildStatusReplyMock).toHaveBeenCalledTimes(1);
    expect(mockObjectArg(buildStatusReplyMock, "buildStatusReply").storePath).toBeUndefined();
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalled();
  });

  it("preserves storePath when routing inline status through the shared status builder", async () => {
    const { result } = await runInlineStatusAction("/tmp/inline-status-store.json");

    expect(result).toEqual({ kind: "reply", reply: undefined });
    expect(mockObjectArg(buildStatusReplyMock, "buildStatusReply").storePath).toBe(
      "/tmp/inline-status-store.json",
    );
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("prefers the target session entry when routing inline status through the shared status builder", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/status",
      CommandBody: "/status",
      ParentSessionKey: "ctx-parent",
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: stripInlineStatus("/status").cleaned,
        command: {
          isAuthorizedSender: true,
          rawBodyNormalized: "/status",
          commandBodyNormalized: "/status",
        },
        overrides: {
          allowTextCommands: true,
          inlineStatusRequested: true,
          sessionEntry: {
            sessionId: "wrapper-session",
            updatedAt: Date.now(),
            parentSessionKey: "wrapper-parent",
          } as SessionEntry,
          sessionStore: {
            "s:main": {
              sessionId: "target-session",
              updatedAt: Date.now(),
              parentSessionKey: "target-parent",
            } as SessionEntry,
          },
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: undefined });
    const statusArgs = mockObjectArg(buildStatusReplyMock, "buildStatusReply");
    const statusSessionEntry = requireRecord(statusArgs.sessionEntry, "status sessionEntry");
    expect(statusSessionEntry.sessionId).toBe("target-session");
    expect(statusSessionEntry.parentSessionKey).toBe("target-parent");
    expect(statusArgs.parentSessionKey).toBe("target-parent");
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("does not continue into the agent after a mention-wrapped inline status-only turn", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "<@123> /status",
      CommandBody: "<@123> /status",
      Provider: "discord",
      Surface: "discord",
      ChatType: "channel",
      WasMentioned: true,
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "<@123>",
        command: {
          surface: "discord",
          channel: "discord",
          channelId: "discord",
          isAuthorizedSender: true,
          rawBodyNormalized: "<@123> /status",
          commandBodyNormalized: "<@123> /status",
        },
        overrides: {
          allowTextCommands: true,
          inlineStatusRequested: true,
          isGroup: true,
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: undefined });
    expect(buildStatusReplyMock).toHaveBeenCalledTimes(1);
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalled();
  });

  it("continues into the agent when mention-wrapped inline status leaves real text", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "<@123> /status what's next?",
      CommandBody: "<@123> /status what's next?",
      Provider: "discord",
      Surface: "discord",
      ChatType: "channel",
      WasMentioned: true,
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "<@123> what's next?",
        command: {
          surface: "discord",
          channel: "discord",
          channelId: "discord",
          isAuthorizedSender: true,
          rawBodyNormalized: "<@123> /status what's next?",
          commandBodyNormalized: "<@123> /status what's next?",
        },
        overrides: {
          allowTextCommands: true,
          inlineStatusRequested: true,
          isGroup: true,
        },
      }),
    );

    expect(result).toEqual({
      kind: "continue",
      directives: clearInlineDirectives("<@123> what's next?"),
      abortedLastRun: false,
    });
    expect(buildStatusReplyMock).toHaveBeenCalledTimes(1);
    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
  });

  it("skips stale queued messages that are at or before the /stop cutoff", async () => {
    const typing = createTypingController();
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      abortCutoffMessageSid: "42",
      abortedLastRun: true,
    };
    const sessionStore = { "s:main": sessionEntry };
    const ctx = buildTestCtx({
      Body: "old queued message",
      CommandBody: "old queued message",
      MessageSid: "41",
    });

    await expectInlineActionSkipped({
      ctx,
      typing,
      cleanedBody: "old queued message",
      command: {
        rawBodyNormalized: "old queued message",
        commandBodyNormalized: "old queued message",
      },
      overrides: {
        sessionEntry,
        sessionStore,
      },
    });
  });

  it("clears /stop cutoff when a newer message arrives", async () => {
    const typing = createTypingController();
    const sessionEntry: SessionEntry = {
      sessionId: "session-2",
      updatedAt: Date.now(),
      abortCutoffMessageSid: "42",
      abortedLastRun: true,
    };
    const sessionStore = { "s:main": sessionEntry };
    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "ok" } });
    const ctx = buildTestCtx({
      Body: "new message",
      CommandBody: "new message",
      MessageSid: "43",
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "new message",
        command: {
          rawBodyNormalized: "new message",
          commandBodyNormalized: "new message",
        },
        overrides: {
          sessionEntry,
          sessionStore,
        },
      }),
    );

    expect(result).toEqual({
      kind: "continue",
      directives: clearInlineDirectives("new message"),
      abortedLastRun: false,
    });
    expect(sessionStore["s:main"]?.abortCutoffMessageSid).toBeUndefined();
    expect(sessionStore["s:main"]?.abortCutoffTimestamp).toBeUndefined();
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("prefers the target session entry for inline /stop cutoff checks", async () => {
    const typing = createTypingController();
    const wrapperSessionEntry: SessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      abortCutoffMessageSid: "40",
      abortedLastRun: true,
    };
    const targetSessionEntry: SessionEntry = {
      sessionId: "target-session",
      updatedAt: Date.now(),
      abortCutoffMessageSid: "42",
      abortedLastRun: true,
    };
    const ctx = buildTestCtx({
      Body: "old queued message",
      CommandBody: "old queued message",
      MessageSid: "41",
    });

    await expectInlineActionSkipped({
      ctx,
      typing,
      cleanedBody: "old queued message",
      command: {
        rawBodyNormalized: "old queued message",
        commandBodyNormalized: "old queued message",
      },
      overrides: {
        sessionEntry: wrapperSessionEntry,
        sessionStore: {
          "s:main": targetSessionEntry,
        },
      },
    });
  });

  it("rewrites Claude bundle markdown commands into a native agent prompt", async () => {
    const typing = createTypingController();
    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "done" } });
    const ctx = buildTestCtx({
      Body: "/office_hours build me a deployment plan",
      CommandBody: "/office_hours build me a deployment plan",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "office_hours",
        skillName: "office-hours",
        description: "Office hours",
        promptTemplate: "Act as an engineering advisor.\n\nFocus on:\n$ARGUMENTS",
        sourceFilePath: "/tmp/plugin/commands/office-hours.md",
      },
    ];

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "/office_hours build me a deployment plan",
        command: {
          isAuthorizedSender: true,
          rawBodyNormalized: "/office_hours build me a deployment plan",
          commandBodyNormalized: "/office_hours build me a deployment plan",
        },
        overrides: {
          allowTextCommands: true,
          cfg: { commands: { text: true } },
          skillCommands,
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "done" } });
    expect(ctx.Body).toBe(
      "Act as an engineering advisor.\n\nFocus on:\nbuild me a deployment plan",
    );
    const commandArgs = mockObjectArg(handleCommandsMock, "handleCommands");
    expect(requireRecord(commandArgs.ctx, "handleCommands ctx").Body).toBe(
      "Act as an engineering advisor.\n\nFocus on:\nbuild me a deployment plan",
    );
  });

  it("passes requesterAgentIdOverride into inline tool runtimes", async () => {
    const typing = createTypingController();
    const toolExecute = vi.fn(async () => ({ text: "spawned" }));
    createOpenClawToolsMock.mockReturnValue([
      {
        name: "sessions_spawn",
        execute: toolExecute,
      },
    ]);

    const ctx = buildTestCtx({
      Body: "/spawn_subagent investigate",
      CommandBody: "/spawn_subagent investigate",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "spawn_subagent",
        skillName: "spawn-subagent",
        description: "Spawn a subagent",
        dispatch: {
          kind: "tool",
          toolName: "sessions_spawn",
          argMode: "raw",
        },
        sourceFilePath: "/tmp/plugin/commands/spawn-subagent.md",
      },
    ];

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "/spawn_subagent investigate",
        command: {
          isAuthorizedSender: true,
          senderId: "sender-1",
          senderIsOwner: true,
          abortKey: "sender-1",
          rawBodyNormalized: "/spawn_subagent investigate",
          commandBodyNormalized: "/spawn_subagent investigate",
        },
        overrides: {
          cfg: { commands: { text: true } },
          agentId: "named-worker",
          allowTextCommands: true,
          skillCommands,
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "✅ Done." } });
    expect(
      mockObjectArg(createOpenClawToolsMock, "createOpenClawTools").requesterAgentIdOverride,
    ).toBe("named-worker");
    expect(toolExecute).toHaveBeenCalled();
  });

  it("passes senderIsOwner into inline tool runtimes before owner-only filtering", async () => {
    const typing = createTypingController();
    const toolExecute = vi.fn(async () => ({ text: "updated" }));
    createOpenClawToolsMock.mockReturnValue([
      {
        name: "message",
        execute: toolExecute,
      },
    ]);

    const ctx = buildTestCtx({
      Body: "/set_profile display name",
      CommandBody: "/set_profile display name",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "set_profile",
        skillName: "matrix-profile",
        description: "Set Matrix profile",
        dispatch: {
          kind: "tool",
          toolName: "message",
          argMode: "raw",
        },
        sourceFilePath: "/tmp/plugin/commands/set-profile.md",
      },
    ];

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "/set_profile display name",
        command: {
          isAuthorizedSender: true,
          senderId: "sender-1",
          senderIsOwner: true,
          abortKey: "sender-1",
          rawBodyNormalized: "/set_profile display name",
          commandBodyNormalized: "/set_profile display name",
        },
        overrides: {
          cfg: { commands: { text: true } },
          allowTextCommands: true,
          skillCommands,
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "✅ Done." } });
    expect(mockObjectArg(createOpenClawToolsMock, "createOpenClawTools").senderIsOwner).toBe(true);
    const toolCall = mockCallArgs(toolExecute, "toolExecute");
    expect(toolCall?.[0]).toMatch(/^cmd_/);
    expect(toolCall?.[1]).toEqual({
      command: "display name",
      commandName: "set_profile",
      skillName: "matrix-profile",
    });
    expect(toolCall?.[2]).toBeUndefined();
  });

  it("honors construction-time before-tool-call blocks for inline tool dispatch", async () => {
    const typing = createTypingController();
    const abortController = new AbortController();
    const toolExecute = vi.fn(async () => ({
      content: [{ type: "text", text: "denied by policy" }],
      details: {
        status: "blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "denied by policy",
      },
    }));
    createOpenClawToolsMock.mockReturnValue([
      {
        name: "message",
        execute: toolExecute,
      },
    ]);

    const ctx = buildTestCtx({
      Body: "/set_profile display name",
      CommandBody: "/set_profile display name",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "set_profile",
        skillName: "matrix-profile",
        description: "Set Matrix profile",
        dispatch: {
          kind: "tool",
          toolName: "message",
          argMode: "raw",
        },
        sourceFilePath: "/tmp/plugin/commands/set-profile.md",
      },
    ];

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "/set_profile display name",
        command: {
          isAuthorizedSender: true,
          senderId: "sender-1",
          senderIsOwner: true,
          abortKey: "sender-1",
          rawBodyNormalized: "/set_profile display name",
          commandBodyNormalized: "/set_profile display name",
        },
        overrides: {
          cfg: {
            commands: { text: true },
            tools: {
              loopDetection: {
                enabled: true,
              },
            },
          },
          agentId: "main",
          allowTextCommands: true,
          opts: { abortSignal: abortController.signal },
          skillCommands,
          sessionEntry: {
            sessionId: "wrapper-session",
            updatedAt: 0,
          },
          sessionStore: {
            "s:main": {
              sessionId: "target-session",
              updatedAt: 0,
            },
          },
        },
      }),
    );

    expect(result).toEqual({
      kind: "reply",
      reply: { text: "❌ Tool call blocked: denied by policy" },
    });
    const toolsArgs = mockObjectArg(createOpenClawToolsMock, "createOpenClawTools");
    expect(toolsArgs.sessionId).toBe("target-session");
    expect(toolsArgs.currentChannelId).toBe("whatsapp");
    const blockedToolCall = mockCallArgs(toolExecute, "toolExecute");
    expect(blockedToolCall?.[0]).toMatch(/^cmd_/);
    expect(blockedToolCall?.[1]).toEqual({
      command: "display name",
      commandName: "set_profile",
      skillName: "matrix-profile",
    });
    expect(blockedToolCall?.[2]).toBe(abortController.signal);
    expect(typing.cleanup).toHaveBeenCalled();
  });
});
