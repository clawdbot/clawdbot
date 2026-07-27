import { describe, expect, it } from "vitest";
import {
  assertAgentSessionOwnerPairs,
  validateAgentSessionOwnerPair,
  validateOutboundDeliverySessionOwnership,
} from "./session-owner.js";

describe("outbound agent session ownership", () => {
  it("accepts normalized matching owners", () => {
    expect(
      validateAgentSessionOwnerPair({
        ownerLabel: "send",
        agentId: " Support ",
        sessionKey: " AGENT:SUPPORT:main ",
      }),
    ).toEqual({ ok: true, value: undefined });
  });

  it("accepts legacy and missing session keys", () => {
    expect(
      validateAgentSessionOwnerPair({
        ownerLabel: "send",
        agentId: "support",
        sessionKey: "legacy-session",
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(validateAgentSessionOwnerPair({ ownerLabel: "send", agentId: "support" })).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it.each(["agent::broken", "agent:main"])(
    "rejects malformed agent-scoped key %s without an explicit owner",
    (sessionKey) => {
      const result = validateAgentSessionOwnerPair({ ownerLabel: "send", sessionKey });

      expect(result).toMatchObject({
        ok: false,
        error: { reason: "malformed_session_key", sessionKey },
      });
    },
  );

  it("rejects a paired owner mismatch", () => {
    expect(
      validateAgentSessionOwnerPair({
        ownerLabel: "send",
        agentId: "alpha",
        sessionKey: "agent:beta:main",
      }),
    ).toEqual({
      ok: false,
      error: {
        reason: "owner_mismatch",
        agentId: "alpha",
        sessionAgentId: "beta",
        message: 'send agentId "alpha" does not match session key agent "beta"',
      },
    });
  });

  it("accepts same-owner control and transcript keys while ignoring policyKey", () => {
    expect(
      validateOutboundDeliverySessionOwnership({
        ownerLabel: "delivery",
        session: {
          agentId: "controller",
          key: "agent:controller:main",
          policyKey: "agent:policy-owner:main",
        },
        mirror: {
          agentId: "controller",
          sessionKey: "agent:controller:channel:ops",
        },
      }),
    ).toEqual({ ok: true, value: undefined });
  });

  it("rejects different owners across one operation when the mirror owner is derived", () => {
    expect(
      validateOutboundDeliverySessionOwnership({
        ownerLabel: "delivery",
        session: {
          agentId: "controller",
          key: "agent:controller:main",
          policyKey: "agent:policy-owner:main",
        },
        mirror: {
          sessionKey: "agent:transcript:channel:ops",
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        reason: "owner_mismatch",
        agentId: "controller",
        sessionAgentId: "transcript",
        message:
          'delivery mirror session key agent "transcript" does not match operation agent "controller"',
      },
    });
  });

  it("throws the ownership error at side-effect boundaries", () => {
    expect(() =>
      assertAgentSessionOwnerPairs([
        {
          ownerLabel: "delivery",
          agentId: "alpha",
          sessionKey: "agent:beta:main",
        },
      ]),
    ).toThrow('delivery agentId "alpha" does not match session key agent "beta"');
  });
});
