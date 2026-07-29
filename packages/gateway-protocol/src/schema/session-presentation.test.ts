import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionPresentationSchema } from "./session-presentation.js";
import { SessionRowSchema } from "./sessions-row.js";

describe("SessionPresentationSchema", () => {
  it("accepts client-ready presentation metadata through the canonical row schema", () => {
    const presentation = {
      title: "Telegram direct message",
      titleSource: "generated",
      subtitle: "Telegram · account main · agent main",
      family: "direct",
      agentId: "main",
      channel: "telegram",
      accountId: "main",
      peerKind: "direct",
      isMain: false,
      isBackground: false,
    };

    expect(Value.Check(SessionPresentationSchema, presentation)).toBe(true);
    expect(
      Value.Check(SessionRowSchema, {
        key: "agent:main:telegram:main:direct:peer",
        kind: "direct",
        presentation,
      }),
    ).toBe(true);
  });

  it("accepts future classification values but rejects peer identifiers", () => {
    expect(
      Value.Check(SessionPresentationSchema, {
        title: "Session",
        titleSource: "generated",
        family: "plugin-owned",
        peerKind: "topic",
        isMain: false,
        isBackground: false,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionPresentationSchema, {
        title: "Session",
        titleSource: "generated",
        family: "direct",
        peerId: "491234567890",
        isMain: false,
        isBackground: false,
      }),
    ).toBe(false);
  });
});
