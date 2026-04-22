import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { resolveConversationLabel } from "./conversation-label.js";

describe("resolveConversationLabel", () => {
  it.each([
    {
      name: "prefers ConversationLabel when present",
      ctx: { ConversationLabel: "Pinned Label", ChatType: "group" },
      expected: "Pinned Label",
    },
    {
      name: "prefers ThreadLabel over derived chat labels",
      ctx: {
        ThreadLabel: "Thread Alpha",
        ChatType: "group",
        GroupSubject: "Ops",
        From: "demo-channel:group:42",
      },
      expected: "Thread Alpha",
    },
    {
      name: "uses SenderName for direct chats when available",
      ctx: { ChatType: "direct", SenderName: "Ada", From: "demo-channel:99" },
      expected: "Ada",
    },
    {
      name: "falls back to From for direct chats when SenderName is missing",
      ctx: { ChatType: "direct", From: "demo-channel:99" },
      expected: "demo-channel:99",
    },
    {
      name: "derives numeric-id group labels",
      ctx: { ChatType: "group", GroupSubject: "Ops", From: "demo-channel:group:42" },
      expected: "Ops id:42",
    },
    {
      name: "does not append ids for #rooms/channels",
      ctx: {
        ChatType: "channel",
        GroupSubject: "#general",
        From: "slack:channel:C123",
      },
      expected: "#general",
    },
    {
      name: "does not append ids when the base already contains the id",
      ctx: {
        ChatType: "group",
        GroupSubject: "Family id:room-123@example",
        From: "demo-channel:group:room-123@example",
      },
      expected: "Family id:room-123@example",
    },
    {
      name: "appends opaque address-like ids when a subject exists",
      ctx: {
        ChatType: "group",
        GroupSubject: "Family",
        From: "demo-channel:group:room-123@example",
      },
      expected: "Family id:room-123@example",
    },
  ] satisfies Array<{ name: string; ctx: MsgContext; expected: string }>)(
    "$name",
    ({ ctx, expected }) => {
      expect(resolveConversationLabel(ctx)).toBe(expected);
    },
  );
});
