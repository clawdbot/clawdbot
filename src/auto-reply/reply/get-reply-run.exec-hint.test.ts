import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import {
  buildExecOverridePromptHint,
  resolvePromptSessionContextForSystemEvent,
  resolvePromptSilentReplyConversationType,
} from "./get-reply-run.js";
import { buildGetReplyCtx, buildGetReplyGroupCtx } from "./get-reply.test-fixtures.js";

describe("buildExecOverridePromptHint", () => {
  it("returns undefined when exec state is fully inherited and elevated is off", () => {
    expect(
      buildExecOverridePromptHint({
        elevatedLevel: "off",
      }),
    ).toBeUndefined();
  });

  it("includes current exec defaults and warns against stale denial assumptions", () => {
    const result = buildExecOverridePromptHint({
      execOverrides: {
        host: "gateway",
        security: "full",
        ask: "always",
        node: "worker-1",
      },
      elevatedLevel: "off",
    });

    expect(result).toContain(
      "Current session exec defaults: host=gateway security=full ask=always node=worker-1.",
    );
    expect(result).toContain("Current elevated level: off.");
    expect(result).toContain("Do not assume a prior denial still applies");
  });

  it("still reports elevated state when exec overrides are inherited", () => {
    const result = buildExecOverridePromptHint({
      elevatedLevel: "full",
    });

    expect(result).toContain(
      "Current session exec defaults: inherited from configured agent/global defaults.",
    );
    expect(result).toContain("Current elevated level: full.");
  });

  it("warns when auto-approved full access is unavailable", () => {
    const result = buildExecOverridePromptHint({
      elevatedLevel: "full",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "runtime",
    });

    expect(result).toContain("Current elevated level: full.");
    expect(result).toContain(
      "Auto-approved /elevated full is unavailable here (runtime). Do not ask the user to switch to /elevated full.",
    );
  });
});

describe("resolvePromptSilentReplyConversationType", () => {
  it("treats direct and dm chat types as direct prompt policy context", () => {
    expect(
      resolvePromptSilentReplyConversationType({
        ctx: buildGetReplyCtx({
          ChatType: "dm",
          SessionKey: "agent:main:main",
        }),
      }),
    ).toBe("direct");
  });

  it("treats group and channel chat types as group prompt policy context", () => {
    expect(
      resolvePromptSilentReplyConversationType({
        ctx: buildGetReplyGroupCtx({
          ChatType: "channel",
        }),
      }),
    ).toBe("group");
  });

  it("does not override a native cross-session target policy with the source chat type", () => {
    expect(
      resolvePromptSilentReplyConversationType({
        ctx: buildGetReplyGroupCtx({
          CommandSource: "native",
          SessionKey: "agent:main:telegram:group:source",
          CommandTargetSessionKey: "agent:main:telegram:direct:target",
          ChatType: "group",
        }),
      }),
    ).toBeUndefined();
  });

  it("uses the inbound session key when session context was rewritten to the target", () => {
    expect(
      resolvePromptSilentReplyConversationType({
        ctx: buildGetReplyGroupCtx({
          CommandSource: "native",
          SessionKey: "agent:main:telegram:direct:target",
          CommandTargetSessionKey: "agent:main:telegram:direct:target",
          ChatType: "group",
        }),
        inboundSessionKey: "agent:main:telegram:group:source",
      }),
    ).toBeUndefined();
  });
});

describe("resolvePromptSessionContextForSystemEvent", () => {
  it("rebuilds missing system-event chat metadata from the persisted session entry", () => {
    const sessionCtx = {
      Body: "wake up",
      Provider: "cron-event",
      Surface: "cron-event",
    } as TemplateContext;
    const sessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      chatType: "channel",
      channel: "discord",
      groupId: "guild-1",
      groupChannel: "#ops",
      space: "Ops Guild",
      origin: {
        provider: "discord",
        surface: "discord",
        chatType: "channel",
        to: "channel-1",
        accountId: "acct-1",
        threadId: "thread-1",
      },
      lastChannel: "discord",
      lastTo: "channel-1",
      lastAccountId: "acct-1",
      lastThreadId: "thread-1",
    } satisfies SessionEntry;

    const result = resolvePromptSessionContextForSystemEvent({
      sessionCtx,
      sessionEntry,
      ctx: { Provider: "cron-event" },
    });

    expect(result).not.toBe(sessionCtx);
    expect(result).toMatchObject({
      Provider: "discord",
      Surface: "discord",
      ChatType: "channel",
      GroupChannel: "#ops",
      GroupSpace: "Ops Guild",
      OriginatingChannel: "discord",
      OriginatingTo: "channel-1",
      AccountId: "acct-1",
      MessageThreadId: "thread-1",
    });
  });

  it("keeps normal user turns on their live chat metadata", () => {
    const sessionCtx = buildGetReplyGroupCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
    }) as TemplateContext;
    const result = resolvePromptSessionContextForSystemEvent({
      sessionCtx,
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 1,
        chatType: "direct",
        channel: "telegram",
      },
      ctx: { Provider: "discord" },
    });

    expect(result).toBe(sessionCtx);
  });

  it("does not overwrite explicit system-event chat metadata", () => {
    const sessionCtx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      OriginatingChannel: "discord",
    } as TemplateContext;
    const result = resolvePromptSessionContextForSystemEvent({
      sessionCtx,
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 1,
        chatType: "channel",
        channel: "discord",
        groupChannel: "#ops",
      },
      ctx: { Provider: "heartbeat" },
    });

    expect(result).toBe(sessionCtx);
  });
});
