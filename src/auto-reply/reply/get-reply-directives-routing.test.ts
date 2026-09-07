import { describe, expect, it, vi } from "vitest";
import { resolveReplyDirectiveRouting } from "./get-reply-directives-routing.js";
import { buildTestCtx } from "./test-ctx.js";

const renderedMentionPattern = "<@BOT> \\(Bek \\(Ops\\)\\)";

// Model the plugin-owned exact substitution fact at the loaded-plugin seam;
// routing must not import Slack internals.
vi.mock("../../channels/plugins/registry-loaded.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/registry-loaded.js")>()),
  getLoadedChannelPluginById: (id: string) =>
    id === "slack"
      ? { mentions: { stripPatterns: () => [renderedMentionPattern, "<@[^>\\s]+>"] } }
      : undefined,
}));

describe("sender-owned directive projection", () => {
  it.each([
    {
      name: "selects an inline shortcut after a rendered group mention",
      rawText: "<@BOT> (Bek (Ops)) Please /help continue",
      commandText: "Please /help continue",
      expected: "<@BOT> (Bek (Ops)) Please continue",
      chatType: "channel" as const,
      isGroup: true,
    },
    {
      name: "selects an inline shortcut when the rendered mention trails the text",
      rawText: "Please /help continue <@BOT> (Bek (Ops))",
      commandText: "Please /help continue",
      expected: "Please continue <@BOT> (Bek (Ops))",
      chatType: "channel" as const,
      isGroup: true,
    },
    {
      name: "selects an inline shortcut on a later line after a rendered mention",
      rawText: "<@BOT> (Bek (Ops)) Please summarize\n/help",
      commandText: "Please summarize /help",
      expected: "<@BOT> (Bek (Ops)) Please summarize\n",
      chatType: "channel" as const,
      isGroup: true,
    },
    {
      name: "selects an inline shortcut after mention rendering in a direct message",
      rawText: "<@BOT> (Bek (Ops)) Please /help continue",
      commandText: "Please /help continue",
      expected: "<@BOT> (Bek (Ops)) Please continue",
      chatType: "direct" as const,
      isGroup: false,
    },
    {
      name: "keeps attachment context after a multiline sender shortcut",
      rawText: "<@BOT> (Bek (Ops)) Please /help\ncontinue\n[slack attachment unavailable]",
      commandSourceText: "<@BOT> (Bek (Ops)) Please /help\ncontinue",
      commandText: "Please /help continue",
      expected: "<@BOT> (Bek (Ops)) Please\ncontinue\n[slack attachment unavailable]",
      chatType: "channel" as const,
      isGroup: true,
    },
  ])("$name", ({ rawText, commandSourceText, commandText, expected, chatType, isGroup }) => {
    const preparedSource = commandSourceText ?? rawText;
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      ChatType: chatType,
      CommandBody: commandText,
      RawBody: rawText,
      BodyForAgent: rawText,
      CommandAuthorized: true,
      ChannelContext: { chat: { commandSourceText: preparedSource } },
    });
    const result = resolveReplyDirectiveRouting({
      commandText: ctx.commandText,
      agentText: ctx.agentText,
      modelAliases: [],
      canInterpretTextDirectives: true,
      isAuthorizedSender: true,
      isGroup,
      wasMentioned: true,
      ctx,
      cfg: { commands: { text: true } },
      agentId: "main",
      resetTriggered: false,
    });
    expect(result.inlineCommand).toBe("/help");
    expect(result.cleanedBody).toBe(expected);
  });

  it("rejects prepared channel metadata that does not reconstruct the command body", () => {
    const agentText = "[Forwarded message]\nPlease /help continue";
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      ChatType: "channel",
      CommandBody: "Please /help continue",
      RawBody: "unrelated sender text",
      BodyForAgent: agentText,
      CommandAuthorized: true,
      ChannelContext: {
        chat: { commandSourceText: "<@BOT> (Bek (Ops)) different /help text" },
      },
    });
    const result = resolveReplyDirectiveRouting({
      commandText: ctx.commandText,
      agentText: ctx.agentText,
      modelAliases: [],
      canInterpretTextDirectives: true,
      isAuthorizedSender: true,
      isGroup: true,
      wasMentioned: true,
      ctx,
      cfg: { commands: { text: true } },
      agentId: "main",
      resetTriggered: false,
    });
    expect(result.inlineCommand).toBeUndefined();
    expect(result.cleanedBody).toBe(agentText);
  });

  it.each([
    {
      name: "preserves forwarded status text beside an ordinary caption",
      commandText: "Please summarize",
      rawText: "Please summarize",
      agentText: "Please summarize\n[Forwarded message]\n/status marker",
      expected: "Please summarize\n[Forwarded message]\n/status marker",
      inlineStatus: false,
    },
    {
      name: "removes sender status while preserving forwarded status",
      commandText: "Please /status summarize",
      rawText: "Please /status summarize",
      agentText: "Please /status summarize\n[Forwarded message]\n/status marker",
      expected: "Please summarize\n[Forwarded message]\n/status marker",
      inlineStatus: true,
    },
    {
      name: "preserves forwarded session directives beside a caption",
      commandText: "Please summarize",
      rawText: "Please summarize",
      agentText: "Please summarize\n[Forwarded message]\n/think high\n  code()",
      expected: "Please summarize\n[Forwarded message]\n/think high\n  code()",
      inlineStatus: false,
    },
    {
      name: "keeps an empty sender projection distinct from forwarded content",
      commandText: "",
      rawText: "",
      agentText: "[Forwarded message]\n/status marker",
      expected: "[Forwarded message]\n/status marker",
      inlineStatus: false,
    },
    {
      name: "strips repeated sender status without changing remaining whitespace",
      commandText: "Please /status summarize /status\n  code()",
      rawText: "Please /status summarize /status\n  code()",
      agentText: "Please /status summarize /status\n  code()",
      expected: "Please summarize\n  code()",
      inlineStatus: true,
    },
    {
      name: "keeps flat history opaque to command cleanup",
      commandText: "hello",
      rawText: "hello",
      agentText:
        "[Chat messages since your last reply - for context]\nOther: /think high\n[Current message - respond to this]\nOwner: hello /status",
      expected:
        "[Chat messages since your last reply - for context]\nOther: /think high\n[Current message - respond to this]\nOwner: hello /status",
      inlineStatus: false,
    },
    {
      name: "does not resurrect a consumed reset body",
      commandText: "new session",
      rawText: "new session",
      agentText: "",
      expected: "",
      inlineStatus: false,
      resetTriggered: true,
    },
    {
      name: "keeps normalized command tails",
      commandText: "/status",
      rawText: "/status:\n/think high\n  code()",
      agentText: "/status:\n/think high\n  code()",
      expected: "/think high\n  code()",
      inlineStatus: false,
    },
    {
      name: "keeps tails after leading blanks",
      commandText: "/status",
      rawText: "\n\n/status:\n/think high\n  code()",
      agentText: "\n\n/status:\n/think high\n  code()",
      expected: "/think high\n  code()",
      inlineStatus: false,
    },
  ])("$name", ({ commandText, rawText, agentText, expected, inlineStatus, resetTriggered }) => {
    const ctx = buildTestCtx({
      CommandBody: commandText,
      RawBody: rawText,
      BodyForAgent: agentText,
      CommandAuthorized: true,
    });
    const result = resolveReplyDirectiveRouting({
      commandText: ctx.commandText,
      agentText: ctx.agentText,
      modelAliases: [],
      canInterpretTextDirectives: true,
      isAuthorizedSender: true,
      isGroup: false,
      wasMentioned: false,
      ctx,
      cfg: { commands: { text: true } },
      agentId: "main",
      resetTriggered: resetTriggered === true,
    });
    expect(result.cleanedBody).toBe(expected);
    expect(result.hasInlineStatus).toBe(inlineStatus);
    expect(result.directives.hasThinkDirective).toBe(false);
  });
});
