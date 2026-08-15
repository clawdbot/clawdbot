import { describe, expect, it } from "vitest";
import type { PolicyRoutingRules } from "../policy-routing.js";
import { collectPolicyEvidence } from "../policy-state.js";
import { routingFindings } from "./routing-findings.js";

const secretPeer = "+15555550123";
const baseRules: PolicyRoutingRules = {
  requireBindings: true,
  requireConfiguredChannels: true,
  probes: [
    {
      id: "private-dm",
      route: { channel: "imessage", peer: { kind: "direct", id: secretPeer } },
      expect: { agentId: "private", matchedBy: ["binding.peer"] },
    },
  ],
};

function evaluate(cfg: Record<string, unknown>, rules: PolicyRoutingRules = baseRules) {
  const policy = { routing: rules };
  const evidence = collectPolicyEvidence(cfg, { routing: rules });
  return {
    evidence,
    findings: routingFindings(policy, "policy.jsonc", "policy.jsonc", evidence),
  };
}

describe("routing policy findings", () => {
  it("accepts a configured peer binding and emits redacted evidence", () => {
    const result = evaluate({
      agents: { list: [{ id: "main", default: true }, { id: "private" }] },
      channels: { imessage: { enabled: false } },
      bindings: [
        {
          agentId: "private",
          match: { channel: "imessage", peer: { kind: "direct", id: secretPeer } },
        },
      ],
    });

    expect(result.findings).toEqual([]);
    expect(result.evidence.routing?.probes).toEqual([
      expect.objectContaining({
        id: "private-dm",
        agentId: "private",
        matchedBy: "binding.peer",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(secretPeer);
  });

  it("detects empty bindings and default-agent fallthrough", () => {
    const result = evaluate({
      agents: { list: [{ id: "main", default: true }, { id: "private" }] },
      channels: { imessage: {} },
      bindings: [],
    });

    expect(result.findings.map((finding) => finding.checkId)).toEqual([
      "policy/routing-bindings-required",
      "policy/routing-agent-mismatch",
      "policy/routing-match-kind-mismatch",
    ]);
  });

  it("detects a retired binding channel even when another channel is configured", () => {
    const result = evaluate({
      agents: { list: [{ id: "main", default: true }, { id: "private" }] },
      channels: { imessage: {} },
      bindings: [{ agentId: "private", match: { channel: "bluebubbles" } }],
    });

    expect(result.findings.map((finding) => finding.checkId)).toContain(
      "policy/routing-binding-channel-unconfigured",
    );
    expect(result.findings[0]?.message).toContain("bluebubbles");
  });

  it("does not count ACP bindings as channel route bindings", () => {
    const result = evaluate({
      agents: { list: [{ id: "main", default: true }] },
      channels: { imessage: {} },
      bindings: [{ type: "acp", agentId: "main", match: { channel: "imessage" } }],
    });

    expect(result.findings.map((finding) => finding.checkId)).toContain(
      "policy/routing-bindings-required",
    );
  });
});
