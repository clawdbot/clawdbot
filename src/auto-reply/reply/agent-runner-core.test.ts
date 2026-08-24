import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import {
  resolveAdmittedRunSessionFile,
  resolveReplyRunDeliveryContext,
} from "./agent-runner-core.js";

describe("resolveAdmittedRunSessionFile", () => {
  it("uses the scoped session key when one is available", () => {
    expect(
      resolveAdmittedRunSessionFile({
        agentId: "main",
        sessionId: "session",
        sessionFile: "legacy-target",
        sessionKey: " agent:main:session ",
        storePath: "/tmp/sessions.json",
      }),
    ).toBe("agent:main:session");
  });

  it("preserves the admitted fallback when a persisted run has no session key", () => {
    expect(
      resolveAdmittedRunSessionFile({
        agentId: "main",
        sessionId: "session",
        sessionFile: "legacy-target",
        storePath: "/tmp/sessions.json",
      }),
    ).toBe("legacy-target");
  });
});

function makeTelegramTopicEntry(to = "telegram:12345"): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    delivery: {
      kind: "external",
      context: {
        channel: "telegram",
        to,
        accountId: "work",
        threadId: "99",
      },
      route: {
        channel: "telegram",
        accountId: "work",
        target: { to, chatType: "direct" },
        thread: { id: "99", kind: "topic", source: "turn" },
      },
      origin: {
        provider: "telegram",
        to,
        accountId: "work",
        threadId: "99",
      },
    },
  };
}

function resolveTopicContext(entry: SessionEntry) {
  return resolveReplyRunDeliveryContext({
    cfg: {},
    sessionCtx: {
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:12345",
      AccountId: "work",
      SessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
    } as TemplateContext,
    sessionEntry: entry,
    sessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
  });
}

describe("resolveReplyRunDeliveryContext", () => {
  it("keeps the persisted transport topic id distinct from scoped session identity", () => {
    expect(resolveTopicContext(makeTelegramTopicEntry())).toEqual({
      channel: "telegram",
      to: "telegram:12345",
      accountId: "work",
      threadId: "99",
    });
  });

  it("does not inherit a persisted topic from a different delivery target", () => {
    expect(resolveTopicContext(makeTelegramTopicEntry("telegram:67890"))).toEqual({
      channel: "telegram",
      to: "telegram:12345",
      accountId: "work",
      threadId: "12345:99",
    });
  });
});
