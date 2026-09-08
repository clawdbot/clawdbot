// Conversation facts stay separate from execution identity and current sender context.
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { TemplateContext } from "../templating.js";
import { buildGroupIntro } from "./groups.js";
import { buildInboundMetaSystemPrompt, buildInboundUserContextPrefix } from "./inbound-meta.js";
import { prepareReplyConversation } from "./prompt-session-context.js";

const stored: SessionEntry = {
  sessionId: "conversation",
  updatedAt: 1,
  chatType: "channel",
  groupId: "C123",
  subject: "Operations",
  groupChannel: "#ops",
  space: "workspace",
  groupActivation: "always",
  delivery: normalizeSessionDeliveryState({
    context: { channel: "slack", to: "C123", accountId: "work", threadId: "42" },
    origin: { provider: "slack", surface: "slack", chatType: "channel" },
  }),
};
const current: TemplateContext = {
  InternalTurnSource: "exec",
  OriginatingChannel: "slack",
  OriginatingTo: "channel:C123",
  AccountId: "work",
  MessageThreadId: 42,
  ChatType: "channel",
};

function metadata(ctx: TemplateContext) {
  const text = buildInboundMetaSystemPrompt(ctx, {});
  const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  if (!json) {
    throw new Error("missing rendered inbound metadata");
  }
  return JSON.parse(json) as Record<string, unknown>;
}

describe("prepared reply conversation", () => {
  it.each([
    {
      name: "matching heartbeat",
      input: { ...current, InternalTurnSource: "heartbeat" },
      inherits: true,
    },
    { name: "matching cron", input: { ...current, InternalTurnSource: "cron" }, inherits: true },
    { name: "matching exec", input: current, inherits: true },
    { name: "no current route", input: { InternalTurnSource: "exec" }, inherits: true },
    {
      name: "different channel",
      input: { ...current, OriginatingChannel: "discord" },
      inherits: false,
    },
    { name: "different target", input: { ...current, OriginatingTo: "C999" }, inherits: false },
    { name: "different account", input: { ...current, AccountId: "personal" }, inherits: false },
    { name: "missing account", input: { ...current, AccountId: undefined }, inherits: false },
    { name: "different thread", input: { ...current, MessageThreadId: 43 }, inherits: false },
    { name: "missing thread", input: { ...current, MessageThreadId: undefined }, inherits: false },
    {
      name: "missing destination",
      input: { ...current, OriginatingTo: undefined },
      inherits: false,
    },
  ] satisfies Array<{ name: string; input: TemplateContext; inherits: boolean }>)(
    "$name shares room context and activation only for its own conversation",
    ({ input, inherits }) => {
      const conversation = prepareReplyConversation({ ctx: input, sessionEntry: stored });
      const rendered = buildInboundUserContextPrefix(conversation.fields);
      expect(rendered.includes('"group_subject":"Operations"')).toBe(inherits);
      expect(rendered.includes('"group_channel":"#ops"')).toBe(inherits);
      expect(
        buildGroupIntro({ activation: conversation.activation, defaultActivation: "mention" }),
      ).toContain(inherits ? "Activation: always-on" : "Activation: trigger-only");
      expect(metadata(conversation.fields)).toMatchObject({
        channel: input.OriginatingChannel ?? "slack",
        chat_type: "channel",
      });
    },
  );

  it("keeps current room text and sender/execution facts on the current context", () => {
    const input = {
      ...current,
      GroupSubject: "Live operations",
      GroupChannel: "#live",
      GroupSpace: "live workspace",
      Body: "current event",
      SenderId: "current-sender",
      WasMentioned: false,
      CommandAuthorized: false,
      SessionKey: "isolated-execution",
    };
    const conversation = prepareReplyConversation({ ctx: input, sessionEntry: stored });
    const prompt = { ...input, ...conversation.fields };
    const rendered = buildInboundUserContextPrefix(prompt);
    expect(rendered).toContain('"group_subject":"Live operations"');
    expect(rendered).not.toContain('"group_subject":"Operations"');
    expect(prompt).toMatchObject({
      Body: "current event",
      SenderId: "current-sender",
      WasMentioned: false,
      CommandAuthorized: false,
      SessionKey: "isolated-execution",
    });
    expect(conversation.fields).not.toHaveProperty("SessionKey");
    expect(conversation.fields).not.toHaveProperty("SenderId");
  });

  it("leaves ordinary user context unchanged despite a different stored room", () => {
    const input: TemplateContext = {
      Provider: "discord",
      Surface: "webchat",
      ChatType: "direct",
      OriginatingChannel: "discord",
      OriginatingTo: "user:current",
      AccountId: "personal",
    };
    const conversation = prepareReplyConversation({ ctx: input, sessionEntry: stored });
    expect(metadata(conversation.fields)).toMatchObject({
      channel: "discord",
      provider: "discord",
      surface: "webchat",
      chat_type: "direct",
    });
    expect(buildInboundUserContextPrefix(conversation.fields)).not.toContain("Operations");
  });
});
