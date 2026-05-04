import { describe, expect, it } from "vitest";
import {
  COMMAND,
  COMMAND_KILL,
  resolveHandledPrefix,
  resolveRequesterSessionKey,
  resolveSubagentsAction,
  stopWithText,
} from "./commands-subagents-dispatch.js";
import type { HandleCommandsParams } from "./commands-types.js";

function buildParams(
  commandBody: string,
  ctxOverrides?: Record<string, unknown>,
): HandleCommandsParams {
  const normalized = commandBody.trim();
  const ctx = {
    Provider: "whatsapp",
    Surface: "whatsapp",
    CommandSource: "text",
    SessionKey: "agent:main:main",
    ...ctxOverrides,
  };
  const surface = ctx.Surface ?? "whatsapp";
  const sessionKey = ctx.SessionKey ?? "agent:main:main";
  const provider = ctx.Provider ?? "whatsapp";

  return {
    cfg: {},
    ctx,
    command: {
      commandBodyNormalized: normalized,
      rawBodyNormalized: normalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: surface,
      channelId: surface,
      surface,
      ownerList: [],
      from: "test-user",
      to: "test-bot",
    },
    directives: {} as HandleCommandsParams["directives"],
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey,
    workspaceDir: "/tmp/openclaw-commands-subagents",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider,
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("subagents command dispatch", () => {
  it("prefers native command target session keys", () => {
    const params = buildParams("/subagents list", {
      CommandSource: "native",
      CommandTargetSessionKey: "agent:main:main",
      SessionKey: "agent:main:slack:slash:u1",
    });
    expect(resolveRequesterSessionKey(params)).toBe("agent:main:main");
  });

  it("falls back to the current session for text commands", () => {
    const params = buildParams("/subagents list", {
      CommandSource: "text",
      SessionKey: "agent:main:whatsapp:direct:u1",
      CommandTargetSessionKey: "agent:main:main",
    });
    expect(resolveRequesterSessionKey(params)).toBe("agent:main:whatsapp:direct:u1");
  });

  it("maps slash aliases to the right handled prefix", () => {
    expect(resolveHandledPrefix("/subagents list")).toBe(COMMAND);
    expect(resolveHandledPrefix("/kill 1")).toBe(COMMAND_KILL);
    expect(resolveHandledPrefix("/steer 1 continue")).toBeNull();
    expect(resolveHandledPrefix("/unknown")).toBeNull();
  });

  it("maps prefixes and args to subagent actions", () => {
    const listTokens = ["list"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND, restTokens: listTokens })).toBe("list");
    expect(listTokens).toEqual([]);

    const killTokens = ["1"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND_KILL, restTokens: killTokens })).toBe(
      "kill",
    );
    expect(killTokens).toEqual(["1"]);

    const steerTokens = ["steer", "1", "continue"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND, restTokens: steerTokens })).toBe(
      "steer",
    );
    expect(steerTokens).toEqual(["1", "continue"]);
  });

  it("returns null for invalid /subagents actions", () => {
    const restTokens = ["foo"];
    expect(resolveSubagentsAction({ handledPrefix: COMMAND, restTokens })).toBeNull();
    expect(restTokens).toEqual(["foo"]);
  });

  it("builds stop replies", () => {
    expect(stopWithText("hello")).toEqual({
      shouldContinue: false,
      reply: { text: "hello" },
    });
  });
});
