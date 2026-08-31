// Signal outbound session route tests cover target-grammar dispatch.
import { describe, expect, it } from "vitest";
import { resolveSignalOutboundTarget } from "./outbound-session.js";

describe("resolveSignalOutboundTarget", () => {
  it("keeps username targets intact instead of resolving them as phone numbers", () => {
    const expected = {
      peer: { kind: "direct", id: "username:alice.42" },
      chatType: "direct",
      from: "signal:username:alice.42",
      to: "signal:username:alice.42",
    };
    expect(resolveSignalOutboundTarget("username:alice.42")).toEqual(expected);
    expect(resolveSignalOutboundTarget("u:alice.42")).toEqual(expected);
    expect(resolveSignalOutboundTarget("signal:username:alice.42")).toEqual(expected);
    expect(resolveSignalOutboundTarget("signal:u:ALICE.42")).toEqual(expected);
  });

  it("still resolves group and phone targets", () => {
    expect(resolveSignalOutboundTarget("group:abc==")).toMatchObject({
      peer: { kind: "group", id: "abc==" },
      chatType: "group",
      to: "group:abc==",
    });
    expect(resolveSignalOutboundTarget("+15551234567")).toMatchObject({
      chatType: "direct",
      to: "signal:+15551234567",
    });
  });
});
