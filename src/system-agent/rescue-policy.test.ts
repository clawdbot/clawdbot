// OpenClaw rescue policy tests cover eligibility and safety decisions.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSystemAgentRescuePolicy } from "./rescue-policy.js";

function decide(cfg: OpenClawConfig, overrides = {}) {
  return resolveSystemAgentRescuePolicy({
    cfg,
    senderIsOwner: true,
    isDirectMessage: true,
    ...overrides,
  });
}

describe("resolveSystemAgentRescuePolicy", () => {
  it("allows auto rescue for owner DMs in YOLO host posture with sandboxing off", () => {
    expect(decide({}).allowed).toBe(true);
  });

  it("hard-denies rescue when sandboxing is active", () => {
    const decision = decide({
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
      tools: { exec: { security: "allowlist", ask: "always" } },
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

  it("always limits rescue to owner direct messages", () => {
    expect(decide({}, { isDirectMessage: false }).allowed).toBe(false);
  });
});
