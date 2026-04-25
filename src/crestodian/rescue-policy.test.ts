import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCrestodianRescuePolicy } from "./rescue-policy.js";

function decide(cfg: OpenClawConfig, overrides = {}) {
  return resolveCrestodianRescuePolicy({
    cfg,
    senderIsOwner: true,
    isDirectMessage: true,
    ...overrides,
  });
}

describe("resolveCrestodianRescuePolicy", () => {
  it("allows auto rescue for owner DMs in YOLO host posture with sandboxing off", () => {
    expect(decide({}).allowed).toBe(true);
  });

  it("hard-denies rescue when sandboxing is active even if explicitly enabled", () => {
    const decision = decide({
      crestodian: { rescue: { enabled: true } },
      agents: { defaults: { sandbox: { mode: "all" } } },
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason: "sandbox-active",
    });
  });

  it("keeps auto rescue closed outside YOLO host posture", () => {
    const decision = decide({
      tools: { exec: { security: "allowlist", ask: "on-miss" } },
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason: "disabled",
    });
  });

  it("requires owner identity and direct messages by default", () => {
    expect(decide({}, { senderIsOwner: false })).toMatchObject({
      allowed: false,
      reason: "not-owner",
    });
    expect(decide({}, { isDirectMessage: false })).toMatchObject({
      allowed: false,
      reason: "not-direct-message",
    });
  });

  it("allows explicit group rescue when ownerDmOnly is disabled", () => {
    expect(
      decide({ crestodian: { rescue: { ownerDmOnly: false } } }, { isDirectMessage: false })
        .allowed,
    ).toBe(true);
  });
});
