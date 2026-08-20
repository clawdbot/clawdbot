import { describe, expect, it } from "vitest";
import { resolveAgentRunToolAllowlist } from "./agent-run-tool-allowlist.js";

describe("resolveAgentRunToolAllowlist", () => {
  it("preserves either independent cap when it is the only one", () => {
    expect(resolveAgentRunToolAllowlist({ restoredCronToolsAllow: ["read"] })).toEqual(["read"]);
    expect(resolveAgentRunToolAllowlist({ sessionHandoffToolsAllow: ["write"] })).toEqual([
      "write",
    ]);
  });

  it("intersects a restored Cron cap with the exact source handoff surface", () => {
    expect(
      resolveAgentRunToolAllowlist({
        restoredCronToolsAllow: ["read", "write", "message"],
        sessionHandoffToolsAllow: ["read", "apply_patch"],
      }),
    ).toEqual(["read"]);
  });

  it("preserves the concrete handoff surface for a default Cron wildcard", () => {
    expect(
      resolveAgentRunToolAllowlist({
        restoredCronToolsAllow: ["*"],
        sessionHandoffToolsAllow: ["read", "write", "apply_patch"],
      }),
    ).toEqual(["read", "write", "apply_patch"]);
  });

  it("preserves an explicit deny-all Cron cap", () => {
    expect(
      resolveAgentRunToolAllowlist({
        restoredCronToolsAllow: [],
        sessionHandoffToolsAllow: ["read", "exec"],
      }),
    ).toEqual([]);
  });
});
