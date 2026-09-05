// Verifies message-action target parameter mapping and legacy destination
// rejection across target modes.
import { describe, expect, it } from "vitest";
import { applyTargetToParams, CHANNEL_TARGET_DESCRIPTION } from "./channel-target.js";

describe("applyTargetToParams", () => {
  it.each([
    {
      params: {
        action: "send",
        args: { target: "  channel:C1  " } as Record<string, unknown>,
      },
      field: "to",
      expected: "channel:C1",
    },
    {
      params: {
        action: "channel-info",
        args: { target: "  C123  " } as Record<string, unknown>,
      },
      field: "channelId",
      expected: "C123",
    },
  ])("maps trimmed target into configured field for %j", ({ params, field, expected }) => {
    applyTargetToParams(params);
    expect(params.args[field]).toBe(expected);
  });

  it("throws on legacy destination fields when the action has canonical target support", () => {
    expect(() =>
      applyTargetToParams({
        action: "send",
        args: {
          target: "channel:C1",
          to: "legacy",
        },
      }),
    ).toThrow("Use `target` instead of `to`/`channelId`.");
  });

  it.each([
    {
      params: {
        action: "broadcast",
        args: {
          to: "legacy",
        },
      },
      expectedMessage: "Use `target` for actions that accept a destination.",
    },
    {
      params: {
        action: "broadcast",
        args: {
          target: "channel:C1",
        },
      },
      expectedMessage: "Action broadcast does not accept a target.",
    },
  ])("throws on invalid no-target action destination for %j", ({ params, expectedMessage }) => {
    expect(() => applyTargetToParams(params)).toThrow(expectedMessage);
  });

  it("does nothing when target is blank", () => {
    const params = {
      action: "send",
      args: { target: "   " } as Record<string, unknown>,
    };

    applyTargetToParams(params);

    expect(params.args).toEqual({ target: "   " });
  });
});

// The shared description feeds CLI `--target` help and agent tool schemas; the
// iMessage send guard rejects bare numeric handles with these forms, so the
// discovery wording has to keep naming them or the guard reads as confusing.
describe("CHANNEL_TARGET_DESCRIPTION", () => {
  it("names the iMessage chat, E.164, and SMS short-code forms the send guard enforces", () => {
    expect(CHANNEL_TARGET_DESCRIPTION).toContain("chat_id:<rowid>");
    expect(CHANNEL_TARGET_DESCRIPTION).toContain("+E.164");
    expect(CHANNEL_TARGET_DESCRIPTION).toContain("sms:<short-code>");
  });
});
