import { describe, expect, it } from "vitest";
import { __testing } from "./monitor.js";

describe("zalo group policy access", () => {
  it("blocks all group messages when policy is disabled", () => {
    const decision = __testing.evaluateZaloGroupAccess({
      providerConfigPresent: true,
      configuredGroupPolicy: "disabled",
      defaultGroupPolicy: "open",
      groupAllowFrom: ["zalo:123"],
      senderId: "123",
    });
    expect(decision).toMatchObject({
      allowed: false,
      groupPolicy: "disabled",
      reason: "disabled",
    });
  });

  it("blocks group messages on allowlist policy with empty allowlist", () => {
    const decision = __testing.evaluateZaloGroupAccess({
      providerConfigPresent: true,
      configuredGroupPolicy: "allowlist",
      defaultGroupPolicy: "open",
      groupAllowFrom: [],
      senderId: "attacker",
    });
    expect(decision).toMatchObject({
      allowed: false,
      groupPolicy: "allowlist",
      reason: "empty_allowlist",
    });
  });

  it("blocks sender not in group allowlist", () => {
    const decision = __testing.evaluateZaloGroupAccess({
      providerConfigPresent: true,
      configuredGroupPolicy: "allowlist",
      defaultGroupPolicy: "open",
      groupAllowFrom: ["zalo:victim-user-001"],
      senderId: "attacker-user-999",
    });
    expect(decision).toMatchObject({
      allowed: false,
      groupPolicy: "allowlist",
      reason: "sender_not_allowlisted",
    });
  });

  it("allows sender in group allowlist", () => {
    const decision = __testing.evaluateZaloGroupAccess({
      providerConfigPresent: true,
      configuredGroupPolicy: "allowlist",
      defaultGroupPolicy: "open",
      groupAllowFrom: ["zl:12345"],
      senderId: "12345",
    });
    expect(decision).toMatchObject({
      allowed: true,
      groupPolicy: "allowlist",
      reason: "allowed",
    });
  });

  it("allows any sender with wildcard allowlist", () => {
    const decision = __testing.evaluateZaloGroupAccess({
      providerConfigPresent: true,
      configuredGroupPolicy: "allowlist",
      defaultGroupPolicy: "open",
      groupAllowFrom: ["*"],
      senderId: "random-user",
    });
    expect(decision).toMatchObject({
      allowed: true,
      groupPolicy: "allowlist",
      reason: "allowed",
    });
  });

  it("allows all group senders on open policy", () => {
    const decision = __testing.evaluateZaloGroupAccess({
      providerConfigPresent: true,
      configuredGroupPolicy: "open",
      defaultGroupPolicy: "allowlist",
      groupAllowFrom: [],
      senderId: "attacker-user-999",
    });
    expect(decision).toMatchObject({
      allowed: true,
      groupPolicy: "open",
      reason: "allowed",
    });
  });
});
