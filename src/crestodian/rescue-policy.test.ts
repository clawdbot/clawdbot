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
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      throw new Error("expected rescue to be denied");
    }
    expect(decision.reason).toBe("sandbox-active");
  });

  it("keeps auto rescue closed outside YOLO host posture", () => {
    const decision = decide({
      tools: { exec: { security: "allowlist", ask: "on-miss" } },
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      throw new Error("expected rescue to be denied");
    }
    expect(decision.reason).toBe("disabled");
  });

  it("requires owner identity and direct messages by default", () => {
    const notOwnerDecision = decide({}, { senderIsOwner: false });
    expect(notOwnerDecision.allowed).toBe(false);
    if (notOwnerDecision.allowed) {
      throw new Error("expected non-owner rescue to be denied");
    }
    expect(notOwnerDecision.reason).toBe("not-owner");

    const notDirectMessageDecision = decide({}, { isDirectMessage: false });
    expect(notDirectMessageDecision.allowed).toBe(false);
    if (notDirectMessageDecision.allowed) {
      throw new Error("expected non-DM rescue to be denied");
    }
    expect(notDirectMessageDecision.reason).toBe("not-direct-message");
  });

  it("allows explicit group rescue when ownerDmOnly is disabled", () => {
    expect(
      decide({ crestodian: { rescue: { ownerDmOnly: false } } }, { isDirectMessage: false })
        .allowed,
    ).toBe(true);
  });
});
