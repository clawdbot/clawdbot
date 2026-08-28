import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Tests inline action skipping when channel config does not define actions.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SkillCommandSpec } from "../../skills/types.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { stripInlineStatus } from "./reply-inline.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const {
  buildStatusReplyMock,
  createOpenClawToolsMock,
  getChannelPluginMock,
  handleCommandsMock,
  listSkillCommandsForWorkspaceMock,
} = vi.hoisted(() => ({
  buildStatusReplyMock: vi.fn(),
  createOpenClawToolsMock: vi.fn(),
  getChannelPluginMock: vi.fn(),
  handleCommandsMock: vi.fn(),
  listSkillCommandsForWorkspaceMock: vi.fn(),
}));

type HandleInlineActionsInput = Parameters<
  typeof import("./get-reply-inline-actions.js").handleInlineActions
>[0];

const skillToolDispatchDependencies: NonNullable<
  HandleInlineActionsInput["skillToolDispatchDependencies"]
> = {
  createOpenClawTools: createOpenClawToolsMock,
};

vi.mock("./commands.runtime.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
  buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
}));

vi.mock("../../skills/discovery/chat-commands.runtime.js", () => ({
  listSkillCommandsForWorkspace: (...args: unknown[]) => listSkillCommandsForWorkspaceMock(...args),
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

async function writeSessionStore(
  storeTemplate: string,
  agentId: string,
  entries: Record<string, unknown>,
) {
  const storePath = storeTemplate.replaceAll("{agentId}", agentId);
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ agentId, sessionKey, storePath }, entry as SessionEntry);
  }
}

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
    skillToolDispatchDependencies,
    ...params.overrides,
  };
};

function runTestInlineActions(params: Parameters<typeof createHandleInlineActionsInput>[0]) {
  return handleInlineActions(createHandleInlineActionsInput(params));
}

async function expectInlineActionSkipped(params: {
  ctx: ReturnType<typeof buildTestCtx>;
  typing: TypingController;
  cleanedBody: string;
  command?: Partial<HandleInlineActionsInput["command"]>;
  overrides?: Partial<Omit<HandleInlineActionsInput, "ctx" | "sessionCtx" | "typing" | "command">>;
}) {
  const result = await runTestInlineActions(params);
  expect(result).toEqual({ kind: "reply", reply: undefined });
  expect(params.typing.cleanup).toHaveBeenCalledTimes(1);
  expect(handleCommandsMock).not.toHaveBeenCalled();
}

async function runInlineStatusAction(storePath?: string) {
  const typing = createTypingController();
  const ctx = buildTestCtx({
    Body: "/status",
    CommandBody: "/status",
  });
  const result = await runTestInlineActions({
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
  });

  return { result, typing };
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function mockObjectArg(mock: ReturnType<typeof vi.fn>, label: string, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected ${label} mock call ${callIndex}`);
  }
  return requireRecord(call[argIndex], `${label} argument ${argIndex}`);
}

function mockCallArgs(mock: ReturnType<typeof vi.fn>, label: string, callIndex = 0): unknown[] {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected ${label} mock call ${callIndex}`);
  }
  return call;
}

function mockToolDispatchedSkillCommand() {
  const toolExecute = vi.fn(async () => ({ text: "sent" }));
  createOpenClawToolsMock.mockReturnValue([
    {
      name: "send_status",
      execute: toolExecute,
    },
  ]);
  listSkillCommandsForWorkspaceMock.mockReturnValue([
    {
      name: "send_status",
      skillName: "send-status",
      description: "Send status",
      dispatch: {
        kind: "tool",
        toolName: "send_status",
        argMode: "raw",
      },
    },
  ] satisfies SkillCommandSpec[]);
  return toolExecute;
}

function officeHoursSkillCommands(): SkillCommandSpec[] {
  return [
    {
      name: "office_hours",
      skillName: "office-hours",
      description: "Office hours",
      promptTemplate: "Act as an engineering advisor.\n\nFocus on:\n$ARGUMENTS",
      sourceFilePath: "/tmp/plugin/commands/office-hours.md",
    },
  ];
}

function officeHoursInlineSkillCommands(): SkillCommandSpec[] {
  return [
    {
      name: "office_hours",
      skillName: "office-hours",
      description: "Office hours",
      modelVisible: true,
      skillFile: "/tmp/skills/office-hours/SKILL.md",
    },
  ];
}

function expandedOfficeHoursRequest(body: string): string {
  return [
    "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:",
    "- office-hours",
    "",
    "User request:",
    body,
  ].join("\n");
}

describe("handleInlineActions", () => {
  beforeEach(() => {
    handleCommandsMock.mockReset();
    handleCommandsMock.mockResolvedValue({ shouldContinue: true, reply: undefined });
    listSkillCommandsForWorkspaceMock.mockReset();
    listSkillCommandsForWorkspaceMock.mockReturnValue([]);
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

  it("notifies session metadata changes before continuing after a command", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/goal build the thing",
      CommandBody: "/goal build the thing",
    });
    const onSessionMetadataChanges = vi.fn();
    handleCommandsMock.mockImplementationOnce(async (params) => {
      markCommandSessionMetadataChanged(params);
      return { shouldContinue: true };
    });

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "/goal build the thing",
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: "/goal build the thing",
        commandBodyNormalized: "/goal build the thing",
      },
      overrides: {
        allowTextCommands: true,
        opts: {
          onSessionMetadataChanges,
        } as unknown as HandleInlineActionsInput["opts"],
      },
    });

    expect(result.kind).toBe("continue");
    expect(onSessionMetadataChanges).toHaveBeenCalledWith([
      { sessionKey: "s:main", agentId: "main", reason: "command-metadata" },
    ]);
  });

  it("propagates an explicit steer queue override into the prepared-turn result", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/steer use the monochrome version",
      CommandBody: "/steer use the monochrome version",
    });
    handleCommandsMock.mockImplementationOnce(async (params) => {
      params.command.rawBodyNormalized = "use the monochrome version";
      params.command.commandBodyNormalized = "use the monochrome version";
      params.ctx.agentText = "use the monochrome version";
      return { shouldContinue: true, queueModeOverride: "steer" };
    });

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "/steer use the monochrome version",
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: "/steer use the monochrome version",
        commandBodyNormalized: "/steer use the monochrome version",
      },
      overrides: {
        allowTextCommands: true,
        cfg: { commands: { text: true } },
      },
    });

    expect(result).toMatchObject({
      kind: "continue",
      cleanedBody: "use the monochrome version",
      queueModeOverride: "steer",
    });
  });

  it("delivers a continuing mixed directive ack as a status block without losing metadata", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "keep going",
      CommandBody: "keep going",
    });
    const onBlockReply = vi.fn(async () => {});
    const directiveAck = setReplyPayloadMetadata(
      { text: "Model set to openai/gpt-5.5 for this session." },
      { assistantMessageIndex: 7 },
    );

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "keep going",
      overrides: {
        directiveAck,
        opts: { onBlockReply } as HandleInlineActionsInput["opts"],
      },
    });

    expect(result.kind).toBe("continue");
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const delivered = mockCallArgs(onBlockReply, "onBlockReply")[0];
    expect(delivered).toEqual({
      text: "Model set to openai/gpt-5.5 for this session.",
      isStatusNotice: true,
    });
    expect(getReplyPayloadMetadata(delivered as object)).toEqual({
      assistantMessageIndex: 7,
      deliverDespiteSourceReplySuppression: true,
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

    const result = await runTestInlineActions({
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
    });

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

    const result = await runTestInlineActions({
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
    });

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
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
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

    const result = await runTestInlineActions({
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
    });

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

    const result = await runTestInlineActions({
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
    });

    expect(result).toEqual({ kind: "reply", reply: undefined });
    expect(buildStatusReplyMock).toHaveBeenCalledTimes(1);
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
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

    const result = await runTestInlineActions({
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
    });

    expect(result).toEqual({
      kind: "continue",
      directives: clearInlineDirectives("<@123> what's next?"),
      abortedLastRun: false,
      cleanedBody: "<@123> what's next?",
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

  it("skips stale queued /skill messages before loading or dispatching skills", async () => {
    const typing = createTypingController();
    const toolExecute = mockToolDispatchedSkillCommand();
    const sessionEntry: SessionEntry = {
      sessionId: "session-skill",
      updatedAt: Date.now(),
      abortCutoffMessageSid: "42",
      abortedLastRun: true,
    };
    const sessionStore = { "s:main": sessionEntry };
    const ctx = buildTestCtx({
      Body: "/skill send_status now",
      CommandBody: "/skill send_status now",
      MessageSid: "41",
    });

    await expectInlineActionSkipped({
      ctx,
      typing,
      cleanedBody: "/skill send_status now",
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: "/skill send_status now",
        commandBodyNormalized: "/skill send_status now",
      },
      overrides: {
        allowTextCommands: true,
        cfg: { commands: { text: true } },
        sessionEntry,
        sessionStore,
        skillCommands: [],
      },
    });

    expect(listSkillCommandsForWorkspaceMock).not.toHaveBeenCalled();
    expect(createOpenClawToolsMock).not.toHaveBeenCalled();
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it("skips empty-config /skill tool dispatch before loading skills", async () => {
    const typing = createTypingController();
    const toolExecute = mockToolDispatchedSkillCommand();
    const ctx = buildTestCtx({
      From: "whatsapp:+999",
      To: "whatsapp:+123",
      Body: "/skill send_status now",
      CommandBody: "/skill send_status now",
    });

    await expectInlineActionSkipped({
      ctx,
      typing,
      cleanedBody: "/skill send_status now",
      command: {
        isAuthorizedSender: true,
        to: "whatsapp:+123",
        rawBodyNormalized: "/skill send_status now",
        commandBodyNormalized: "/skill send_status now",
      },
      overrides: {
        allowTextCommands: true,
        skillCommands: [],
      },
    });

    expect(listSkillCommandsForWorkspaceMock).not.toHaveBeenCalled();
    expect(createOpenClawToolsMock).not.toHaveBeenCalled();
    expect(toolExecute).not.toHaveBeenCalled();
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

    const result = await runTestInlineActions({
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
    });

    expect(result).toEqual({
      kind: "continue",
      directives: clearInlineDirectives("new message"),
      abortedLastRun: false,
      cleanedBody: "new message",
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
    const skillCommands = officeHoursSkillCommands();

    const result = await runTestInlineActions({
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
    });

    expect(result).toEqual({ kind: "reply", reply: { text: "done" } });
    expect(ctx.Body).toBe(
      "Act as an engineering advisor.\n\nFocus on:\nbuild me a deployment plan",
    );
    const commandArgs = mockObjectArg(handleCommandsMock, "handleCommands");
    expect(requireRecord(commandArgs.ctx, "handleCommands ctx").Body).toBe(
      "Act as an engineering advisor.\n\nFocus on:\nbuild me a deployment plan",
    );
  });

  it("keeps literal $ patterns in bundle command arguments", async () => {
    const typing = createTypingController();
    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "done" } });
    const ctx = buildTestCtx({
      Body: "/office_hours price $$ and $& here",
      CommandBody: "/office_hours price $$ and $& here",
    });
    const skillCommands = officeHoursSkillCommands();

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "/office_hours price $$ and $& here",
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: "/office_hours price $$ and $& here",
        commandBodyNormalized: "/office_hours price $$ and $& here",
      },
      overrides: {
        allowTextCommands: true,
        cfg: { commands: { text: true } },
        skillCommands,
      },
    });

    expect(result).toEqual({ kind: "reply", reply: { text: "done" } });
    expect(ctx.Body).toBe("Act as an engineering advisor.\n\nFocus on:\nprice $$ and $& here");
    const commandArgs = mockObjectArg(handleCommandsMock, "handleCommands");
    expect(requireRecord(commandArgs.ctx, "handleCommands ctx").Body).toBe(
      "Act as an engineering advisor.\n\nFocus on:\nprice $$ and $& here",
    );
  });

  it("resolves every eligible explicit skill reference in one message", async () => {
    const typing = createTypingController();
    const body = "Compare $office_hours with $release_notes for this rollout";
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      Provider: "webchat",
      Surface: "webchat",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "office_hours",
        skillName: "office-hours",
        description: "Engineering office hours",
        modelVisible: true,
        skillFile: "/tmp/skills/office-hours/SKILL.md",
      },
      {
        name: "release_notes",
        skillName: "release-notes",
        description: "Draft release notes",
        modelVisible: true,
        skillFile: "/tmp/skills/release-notes/SKILL.md",
      },
    ];

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: body,
        command: {
          isAuthorizedSender: true,
          rawBodyNormalized: body,
          commandBodyNormalized: body,
        },
        overrides: {
          allowTextCommands: true,
          cfg: { commands: { text: true } },
          skillCommands,
        },
      }),
    );

    expect(result).toMatchObject({
      kind: "continue",
      explicitSkillSelections: [
        { name: "office_hours", path: "/tmp/skills/office-hours/SKILL.md" },
        { name: "release_notes", path: "/tmp/skills/release-notes/SKILL.md" },
      ],
    });
    if (result.kind !== "continue") {
      throw new Error("expected inline skill references to continue to the model");
    }
    expect(result.cleanedBody).toContain("- office-hours");
    expect(result.cleanedBody).toContain("- release-notes");
    expect(result.cleanedBody).toContain(body);
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("preserves slash commands inside an explicitly referenced skill payload", async () => {
    const typing = createTypingController();
    const body = "$office_hours compare /help and /commands with /status";
    const cleanedBody = stripInlineStatus(body).cleaned;
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      Provider: "webchat",
      Surface: "webchat",
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody,
        command: {
          isAuthorizedSender: true,
          rawBodyNormalized: body,
          commandBodyNormalized: body,
        },
        overrides: {
          allowTextCommands: true,
          inlineStatusRequested: true,
          cfg: { commands: { text: true } },
          skillCommands: officeHoursInlineSkillCommands(),
        },
      }),
    );

    const expected = expandedOfficeHoursRequest(body);
    expect(result).toMatchObject({ kind: "continue", cleanedBody: expected });
    expect(ctx.Body).toBe(expected);
    expect(buildStatusReplyMock).not.toHaveBeenCalled();
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("keeps unauthorized explicit skill references as plain text", async () => {
    const typing = createTypingController();
    const body = "Please use $office_hours to build me a deployment plan";
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      Provider: "webchat",
      Surface: "webchat",
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: body,
        command: {
          isAuthorizedSender: false,
          rawBodyNormalized: body,
          commandBodyNormalized: body,
        },
        overrides: {
          allowTextCommands: true,
          cfg: { commands: { text: true } },
          skillCommands: officeHoursInlineSkillCommands(),
        },
      }),
    );

    expect(result).toMatchObject({ kind: "continue", cleanedBody: body });
    expect(ctx.Body).toBe(body);
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it.each(["Review /tmp/foo before continuing", "/tmp/foo should stay a path"])(
    "does not load workspace skills for a bare path in %j",
    async (body) => {
      const typing = createTypingController();
      const ctx = buildTestCtx({ Body: body, CommandBody: body });

      const result = await runTestInlineActions({
        ctx,
        typing,
        cleanedBody: body,
        command: {
          isAuthorizedSender: true,
          rawBodyNormalized: body,
          commandBodyNormalized: body,
        },
        overrides: {
          allowTextCommands: true,
          cfg: { commands: { text: true } },
          skillCommands: [],
        },
      });

      expect(result).toMatchObject({ kind: "continue", cleanedBody: body });
      expect(listSkillCommandsForWorkspaceMock).not.toHaveBeenCalled();
    },
  );

  it("loads workspace skills when /skill gets an empty preloaded command list", async () => {
    const typing = createTypingController();
    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "done" } });
    const ctx = buildTestCtx({
      Body: "/skill office_hours build me a deployment plan",
      CommandBody: "/skill office_hours build me a deployment plan",
    });
    const skillCommands = officeHoursSkillCommands();
    listSkillCommandsForWorkspaceMock.mockReturnValue(skillCommands);

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "/skill office_hours build me a deployment plan",
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: "/skill office_hours build me a deployment plan",
        commandBodyNormalized: "/skill office_hours build me a deployment plan",
      },
      overrides: {
        allowTextCommands: true,
        cfg: { commands: { text: true } },
        skillCommands: [],
      },
    });

    expect(result).toEqual({ kind: "reply", reply: { text: "done" } });
    expect(listSkillCommandsForWorkspaceMock).toHaveBeenCalledOnce();
    expect(ctx.Body).toBe(
      "Act as an engineering advisor.\n\nFocus on:\nbuild me a deployment plan",
    );
    const commandArgs = mockObjectArg(handleCommandsMock, "handleCommands");
    expect(commandArgs.skillCommands).toEqual(skillCommands);
  });

  it.each([
    {
      channelBody: "/skill wait-what explain the previous reply",
      normalizedBody: "/skill wait-what explain the previous reply",
      expectedRequest: "/skill wait-what explain the previous reply",
    },
    {
      channelBody: "/wait_what explain the previous reply",
      normalizedBody: "/wait_what explain the previous reply",
      expectedRequest: "/wait_what explain the previous reply",
    },
    {
      channelBody: "/skill@openclaw: wait-what explain the previous reply",
      normalizedBody: "/skill wait-what explain the previous reply",
      expectedRequest: "/skill wait-what explain the previous reply",
      botUsername: "openclaw",
    },
    {
      channelBody: "/wait_what@openclaw explain the previous reply",
      normalizedBody: "/wait_what explain the previous reply",
      expectedRequest: "/wait_what explain the previous reply",
      botUsername: "openclaw",
    },
    {
      channelBody: "/skill wait-what explain /help",
      normalizedBody: "/skill wait-what explain /help",
      expectedRequest: "/skill wait-what explain /help",
    },
    {
      channelBody: "/skill wait-what explain /status",
      normalizedBody: "/skill wait-what explain /status",
      cleanedBody: "/skill wait-what explain",
      expectedRequest: "/skill wait-what explain /status",
      inlineStatusRequested: true,
    },
    {
      channelBody: "/skill@OpenClaw: wait-what first line\nsecond line\n\n  indented third",
      normalizedBody: "/skill wait-what first line\nsecond line\n\n  indented third",
      expectedRequest: "/skill wait-what first line\nsecond line\n\n  indented third",
      botUsername: "openclaw",
    },
    {
      channelBody: "/wait_what@openclaw first line\nsecond line",
      normalizedBody: "/wait_what first line\nsecond line",
      expectedRequest: "/wait_what first line\nsecond line",
      botUsername: "openclaw",
    },
    {
      channelBody: "/skill@otherbot: wait-what explain",
      normalizedBody: "/skill@otherbot wait-what explain",
      botUsername: "openclaw",
      foreignBot: true,
    },
    {
      channelBody: "/wait_what@otherbot explain",
      normalizedBody: "/wait_what@otherbot explain",
      botUsername: "openclaw",
      foreignBot: true,
    },
  ])("resolves channel skill request $channelBody", async (testCase) => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: testCase.channelBody,
      CommandBody: testCase.normalizedBody,
      BotUsername: testCase.botUsername,
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "wait_what",
        skillName: "wait-what",
        description: "Explain the previous reply clearly",
        modelVisible: false,
        skillFile: "/tmp/skills/wait-what/SKILL.md",
      },
    ];

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: testCase.cleanedBody ?? testCase.channelBody,
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: testCase.normalizedBody,
        commandBodyNormalized: testCase.normalizedBody,
      },
      overrides: {
        allowTextCommands: true,
        cfg: { commands: { text: true } },
        skillCommands,
        inlineStatusRequested: testCase.inlineStatusRequested === true,
      },
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error("expected hidden skill invocation to continue to the model");
    }
    if (testCase.foreignBot) {
      expect(result.cleanedBody).toBe(testCase.channelBody);
      expect(ctx.Body).toBe(testCase.channelBody);
      expect(result.explicitSkillSelections).toBeUndefined();
      return;
    }
    expect(result.cleanedBody).toBe(
      [
        "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:",
        "- wait-what (SKILL.md: /tmp/skills/wait-what/SKILL.md)",
        "",
        "User request:",
        testCase.expectedRequest,
      ].join("\n"),
    );
    expect(ctx.Body).toBe(result.cleanedBody);
    expect(result.explicitSkillSelections).toEqual([
      { name: "wait_what", path: "/tmp/skills/wait-what/SKILL.md" },
    ]);
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(buildStatusReplyMock).not.toHaveBeenCalled();
  });

  it("preserves exact channel prompt bytes while expanding $ skill references", async () => {
    const typing = createTypingController();
    const original = "Review this plan with $office_hours and $release_notes.";
    const ctx = buildTestCtx({
      Body: original,
      CommandBody: original,
      Provider: "webchat",
      Surface: "webchat",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "office_hours",
        skillName: "office-hours",
        description: "Engineering office hours",
      },
      {
        name: "release_notes",
        skillName: "release-notes",
        description: "Draft release notes",
      },
    ];

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: original,
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: original,
        commandBodyNormalized: original,
      },
      overrides: {
        allowTextCommands: true,
        cfg: { commands: { text: true } },
        skillCommands,
      },
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error("expected referenced skills to continue to the model");
    }
    expect(result.cleanedBody).toBe(
      [
        "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:",
        "- office-hours",
        "- release-notes",
        "",
        "User request:",
        original,
      ].join("\n"),
    );
    expect(ctx.Body).toBe(result.cleanedBody);
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("returns a visible error instead of silently dropping excess skill references", async () => {
    const typing = createTypingController();
    const skillCommands: SkillCommandSpec[] = Array.from({ length: 9 }, (_, index) => ({
      name: `skill_${index + 1}`,
      skillName: `skill-${index + 1}`,
      description: `Skill ${index + 1}`,
    }));
    const original = skillCommands.map((skill) => `$${skill.name}`).join(" ");
    const ctx = buildTestCtx({
      Body: original,
      CommandBody: original,
      Provider: "webchat",
      Surface: "webchat",
    });

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: original,
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: original,
        commandBodyNormalized: original,
      },
      overrides: {
        allowTextCommands: true,
        cfg: { commands: { text: true } },
        skillCommands,
      },
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: "Too many skill references. Use at most 8 skills in one message." },
    });
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("resolves authorized $ skill references on message channels", async () => {
    const typing = createTypingController();
    const original = "Review with $office_hours.";
    const ctx = buildTestCtx({ Body: original, CommandBody: original });

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: original,
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: original,
        commandBodyNormalized: original,
      },
      overrides: {
        allowTextCommands: true,
        cfg: { commands: { text: true } },
        skillCommands: [
          {
            name: "office_hours",
            skillName: "office-hours",
            description: "Engineering office hours",
            modelVisible: false,
            skillFile: "/tmp/skills/office-hours/SKILL.md",
          },
        ],
      },
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error("expected referenced skill to continue to the model");
    }
    expect(result.cleanedBody).toBe(
      [
        "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:",
        "- office-hours (SKILL.md: /tmp/skills/office-hours/SKILL.md)",
        "",
        "User request:",
        original,
      ].join("\n"),
    );
    expect(ctx.Body).toBe(result.cleanedBody);
    expect(result.explicitSkillSelections).toEqual([
      { name: "office_hours", path: "/tmp/skills/office-hours/SKILL.md" },
    ]);
  });

  it("returns a visible error for an explicitly referenced allowlist-hidden skill", async () => {
    const typing = createTypingController();
    const original = "Review with $office_hours.";
    const ctx = buildTestCtx({ Body: original, CommandBody: original });
    listSkillCommandsForWorkspaceMock.mockImplementation(
      (params: { includeAllowlistHidden?: boolean }) =>
        params.includeAllowlistHidden
          ? [
              {
                name: "office_hours",
                skillName: "office-hours",
                description: "Engineering office hours",
                skillFile: "/tmp/skills/office-hours/SKILL.md",
              },
            ]
          : [],
    );

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: original,
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: original,
        commandBodyNormalized: original,
      },
      overrides: {
        allowTextCommands: true,
        cfg: { commands: { text: true } },
        skillCommands: [],
        skillFilter: ["another-skill"],
      },
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: 'Skill "office-hours" is not available for this agent. Update the skill allowlist or choose an allowed skill.',
      },
    });
    expect(typing.cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    {
      channelBody: "/office_hours@openclaw review this",
      normalizedBody: "/office_hours review this",
    },
    {
      channelBody: "/skill@openclaw: office-hours review this",
      normalizedBody: "/skill office-hours review this",
    },
  ])("returns a visible error for allowlist-hidden $channelBody", async (testCase) => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: testCase.channelBody,
      CommandBody: testCase.normalizedBody,
      BotUsername: "openclaw",
    });
    listSkillCommandsForWorkspaceMock.mockImplementation(
      (params: { includeAllowlistHidden?: boolean }) =>
        params.includeAllowlistHidden
          ? [
              {
                name: "office_hours",
                skillName: "office-hours",
                description: "Engineering office hours",
                skillFile: "/tmp/skills/office-hours/SKILL.md",
              },
            ]
          : [],
    );

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: testCase.channelBody,
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: testCase.normalizedBody,
        commandBodyNormalized: testCase.normalizedBody,
      },
      overrides: {
        allowTextCommands: true,
        cfg: { commands: { text: true } },
        skillCommands: [],
        skillFilter: ["another-skill"],
      },
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: 'Skill "office-hours" is not available for this agent. Update the skill allowlist or choose an allowed skill.',
      },
    });
    expect(typing.cleanup).toHaveBeenCalledOnce();
  });

  it("keeps hidden skill references literal when text commands are disabled", async () => {
    const typing = createTypingController();
    const original = "Review with $office_hours.";
    const ctx = buildTestCtx({ Body: original, CommandBody: original });

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: original,
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: original,
        commandBodyNormalized: original,
      },
      overrides: {
        allowTextCommands: false,
        cfg: { commands: { text: false } },
        skillCommands: [],
        skillFilter: ["another-skill"],
      },
    });

    expect(result).toMatchObject({ kind: "continue", cleanedBody: original });
    expect(listSkillCommandsForWorkspaceMock).not.toHaveBeenCalled();
  });

  it("reloads preloaded skill commands when final exec overrides are present", async () => {
    const typing = createTypingController();
    handleCommandsMock.mockResolvedValue({ shouldContinue: false, reply: { text: "done" } });
    const ctx = buildTestCtx({ Body: "/office_hours help", CommandBody: "/office_hours help" });
    const skillCommands = officeHoursSkillCommands();
    listSkillCommandsForWorkspaceMock.mockReturnValue(skillCommands);

    await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "/office_hours help",
      command: {
        isAuthorizedSender: true,
        rawBodyNormalized: "/office_hours help",
        commandBodyNormalized: "/office_hours help",
      },
      overrides: {
        allowTextCommands: true,
        cfg: { commands: { text: true } },
        execOverrides: { security: "deny" },
        skillCommands,
      },
    });

    expect(listSkillCommandsForWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ execOverrides: { security: "deny" } }),
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

    const result = await runTestInlineActions({
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
    });

    expect(result).toEqual({ kind: "reply", reply: { text: "✅ Done." } });
    expect(
      mockObjectArg(createOpenClawToolsMock, "createOpenClawTools").requesterAgentIdOverride,
    ).toBe("named-worker");
    expect(toolExecute).toHaveBeenCalledTimes(1);
  });

  it("passes sender identity into inline tool runtimes", async () => {
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
      NativeChannelId: "oc_native_chat",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "set_profile",
        skillName: "matrix-profile",
        description: "Set Matrix profile",
        skillSource: "workspace",
        dispatch: {
          kind: "tool",
          toolName: "message",
          argMode: "raw",
        },
        sourceFilePath: "/tmp/plugin/commands/set-profile.md",
      },
    ];

    const result = await runTestInlineActions({
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
    });

    expect(result).toEqual({ kind: "reply", reply: { text: "✅ Done." } });
    const toolsArgs = mockObjectArg(createOpenClawToolsMock, "createOpenClawTools");
    expect(toolsArgs.senderIsOwner).toBe(true);
    expect(toolsArgs.nativeChannelId).toBe("oc_native_chat");
    expect(toolsArgs.beforeToolCallHookContext).toMatchObject({
      cwd: "/tmp",
      workspaceDir: "/tmp",
      skillCommand: {
        commandName: "set_profile",
        skillName: "matrix-profile",
        skillSource: "workspace",
        toolName: "message",
      },
    });
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

    const result = await runTestInlineActions({
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
    });

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
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not execute inline tool dispatch targets denied by tool policy", async () => {
    const typing = createTypingController();
    const toolExecute = vi.fn(async () => ({ content: "sent" }));
    createOpenClawToolsMock.mockReturnValue([
      {
        name: "message",
        execute: toolExecute,
      },
    ]);

    const ctx = buildTestCtx({
      Body: "/send_status hello",
      CommandBody: "/send_status hello",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "send_status",
        skillName: "send-status",
        description: "Send a status update",
        dispatch: {
          kind: "tool",
          toolName: "message",
          argMode: "raw",
        },
        sourceFilePath: "/tmp/plugin/commands/send-status.md",
      },
    ];

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "/send_status hello",
      command: {
        isAuthorizedSender: true,
        senderId: "sender-1",
        senderIsOwner: true,
        abortKey: "sender-1",
        rawBodyNormalized: "/send_status hello",
        commandBodyNormalized: "/send_status hello",
      },
      overrides: {
        cfg: { commands: { text: true }, tools: { deny: ["message"] } },
        allowTextCommands: true,
        skillCommands,
      },
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: "❌ Tool not available: message" },
    });
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it("does not execute inline tool dispatch targets outside tool allowlists", async () => {
    const typing = createTypingController();
    const messageExecute = vi.fn(async () => ({ content: "sent" }));
    const sessionsExecute = vi.fn(async () => ({ content: "listed" }));
    createOpenClawToolsMock.mockReturnValue([
      {
        name: "message",
        execute: messageExecute,
      },
      {
        name: "sessions_list",
        execute: sessionsExecute,
      },
    ]);

    const ctx = buildTestCtx({
      Body: "/send_status hello",
      CommandBody: "/send_status hello",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "send_status",
        skillName: "send-status",
        description: "Send a status update",
        dispatch: {
          kind: "tool",
          toolName: "message",
          argMode: "raw",
        },
        sourceFilePath: "/tmp/plugin/commands/send-status.md",
      },
    ];

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "/send_status hello",
      command: {
        isAuthorizedSender: true,
        senderId: "sender-1",
        senderIsOwner: true,
        abortKey: "sender-1",
        rawBodyNormalized: "/send_status hello",
        commandBodyNormalized: "/send_status hello",
      },
      overrides: {
        cfg: { commands: { text: true }, tools: { allow: ["sessions_list"] } },
        allowTextCommands: true,
        skillCommands,
      },
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: "❌ Tool not available: message" },
    });
    expect(messageExecute).not.toHaveBeenCalled();
    expect(sessionsExecute).not.toHaveBeenCalled();
  });

  it("applies sender-specific tool policy to inline tool dispatch", async () => {
    const typing = createTypingController();
    const toolExecute = vi.fn(async () => ({ content: "sent" }));
    createOpenClawToolsMock.mockReturnValue([
      {
        name: "message",
        execute: toolExecute,
      },
    ]);

    const ctx = buildTestCtx({
      Body: "/send_status hello",
      CommandBody: "/send_status hello",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "send_status",
        skillName: "send-status",
        description: "Send a status update",
        dispatch: {
          kind: "tool",
          toolName: "message",
          argMode: "raw",
        },
        sourceFilePath: "/tmp/plugin/commands/send-status.md",
      },
    ];

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "/send_status hello",
      command: {
        isAuthorizedSender: true,
        senderId: "sender-1",
        senderIsOwner: true,
        abortKey: "sender-1",
        rawBodyNormalized: "/send_status hello",
        commandBodyNormalized: "/send_status hello",
      },
      overrides: {
        cfg: {
          commands: { text: true },
          tools: { toolsBySender: { "id:sender-1": { deny: ["message"] } } },
        },
        allowTextCommands: true,
        skillCommands,
      },
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: "❌ Tool not available: message" },
    });
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it("does not expose owner-only tools to authorized non-owner skill dispatch", async () => {
    const typing = createTypingController();
    const toolExecute = vi.fn(async () => ({ content: "sent" }));
    createOpenClawToolsMock.mockReturnValue([
      {
        name: "conversations_send",
        execute: toolExecute,
      },
    ]);

    const ctx = buildTestCtx({
      Body: "/send_conversation hello",
      CommandBody: "/send_conversation hello",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "send_conversation",
        skillName: "send-conversation",
        description: "Send a conversation message",
        dispatch: {
          kind: "tool",
          toolName: "conversations_send",
          argMode: "raw",
        },
        sourceFilePath: "/tmp/plugin/commands/send-conversation.md",
      },
    ];

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "/send_conversation hello",
      command: {
        isAuthorizedSender: true,
        senderId: "allowed-user",
        senderIsOwner: false,
        abortKey: "allowed-user",
        rawBodyNormalized: "/send_conversation hello",
        commandBodyNormalized: "/send_conversation hello",
      },
      overrides: {
        cfg: { commands: { text: true } },
        allowTextCommands: true,
        skillCommands,
      },
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: "❌ Tool not available: conversations_send" },
    });
    const toolsArgs = mockObjectArg(createOpenClawToolsMock, "createOpenClawTools");
    expect(toolsArgs.senderIsOwner).toBe(false);
    expect(toolExecute).not.toHaveBeenCalled();
  });

  it("applies subagent policy to ACP envelope inline dispatch sessions", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inline-acp-policy-"));
    try {
      const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
      await writeSessionStore(storeTemplate, "main", {
        "agent:main:acp:leaf": {
          sessionId: "session-acp-leaf",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:subagent:parent",
          spawnDepth: 2,
          subagentRole: "leaf",
          subagentControlScope: "none",
        },
      });

      const typing = createTypingController();
      const toolExecute = vi.fn(async () => ({ content: "spawned" }));
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

      const result = await runTestInlineActions({
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
          cfg: {
            commands: { text: true },
            session: { store: storeTemplate },
            agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
          },
          sessionKey: "agent:main:acp:leaf",
          allowTextCommands: true,
          skillCommands,
        },
      });

      expect(result).toEqual({
        kind: "reply",
        reply: { text: "❌ Tool not available: sessions_spawn" },
      });
      expect(toolExecute).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes sandboxed runtime state into inline tool construction", async () => {
    const typing = createTypingController();
    const toolExecute = vi.fn(async () => ({ content: "listed" }));
    createOpenClawToolsMock.mockReturnValue([
      {
        name: "sessions_list",
        execute: toolExecute,
      },
    ]);

    const ctx = buildTestCtx({
      Body: "/list_sessions now",
      CommandBody: "/list_sessions now",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        name: "list_sessions",
        skillName: "list-sessions",
        description: "List sessions",
        dispatch: {
          kind: "tool",
          toolName: "sessions_list",
          argMode: "raw",
        },
        sourceFilePath: "/tmp/plugin/commands/list-sessions.md",
      },
    ];

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "/list_sessions now",
      command: {
        isAuthorizedSender: true,
        senderId: "sender-1",
        senderIsOwner: true,
        abortKey: "sender-1",
        rawBodyNormalized: "/list_sessions now",
        commandBodyNormalized: "/list_sessions now",
      },
      overrides: {
        cfg: {
          commands: { text: true },
          agents: { defaults: { sandbox: { mode: "all" } } },
        },
        sessionKey: "agent:main:thread",
        allowTextCommands: true,
        skillCommands,
      },
    });

    expect(result).toEqual({ kind: "reply", reply: { text: "listed" } });
    expect(createOpenClawToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxed: true,
      }),
    );
    expect(toolExecute).toHaveBeenCalled();
  });

  it("marks command-handler terminal replies with deliverDespiteSourceReplySuppression so they are not dropped under message_tool_only delivery (#87107)", async () => {
    const typing = createTypingController();
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "⚙️ Compacted (76k → 934 tokens)" },
    });

    const ctx = buildTestCtx({
      Body: "/compact",
      CommandBody: "/compact",
    });

    const result = await runTestInlineActions({
      ctx,
      typing,
      cleanedBody: "/compact",
      command: {
        isAuthorizedSender: true,
        senderId: "sender-1",
        senderIsOwner: true,
        abortKey: "sender-1",
        rawBodyNormalized: "/compact",
        commandBodyNormalized: "/compact",
      },
      overrides: {
        cfg: { commands: { text: true } },
        allowTextCommands: true,
      },
    });

    expect(result.kind).toBe("reply");
    if (result.kind !== "reply") {
      throw new Error("expected reply");
    }
    expect(result.reply).toEqual({ text: "⚙️ Compacted (76k → 934 tokens)" });
    // Reply must carry deliverDespiteSourceReplySuppression so dispatch-from-config
    // does not silently `continue` past it when sourceReplyDeliveryMode is
    // "message_tool_only" (Feishu group / WebChat default).
    expect(
      getReplyPayloadMetadata(result.reply as object)?.deliverDespiteSourceReplySuppression,
    ).toBe(true);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
