// Policy doctor strictness helper tests.
import { describe, expect, it } from "vitest";
import { POLICY_RULE_METADATA } from "./metadata.js";
import { isPolicyValueAtLeastAsStrict } from "./strictness.js";

describe("policy doctor strictness", () => {
  it("compares policy values through strictness metadata", () => {
    const allowHosts = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "tools.exec.allowHosts",
    );
    const denyTools = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "tools.denyTools",
    );
    const denyNodeCommands = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "gateway.nodes.denyCommands",
    );
    const fsWorkspaceOnly = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "tools.fs.requireWorkspaceOnly",
    );
    const denyHostNetwork = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "sandbox.containers.denyHostNetwork",
    );
    const alsoAllow = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "tools.alsoAllow.expected",
    );
    const routingProbes = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "routing.probes",
    );

    expect(allowHosts).toBeDefined();
    expect(denyTools).toBeDefined();
    expect(denyNodeCommands).toBeDefined();
    expect(fsWorkspaceOnly).toBeDefined();
    expect(denyHostNetwork).toBeDefined();
    expect(alsoAllow).toBeDefined();
    expect(routingProbes).toBeDefined();
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, ["sandbox"], ["sandbox", "node"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, ["sandbox", "node"], ["sandbox"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, [], ["sandbox"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, ["sandbox"], [])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["exec", "write"], ["exec"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["write"], ["exec"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["group:runtime"], ["exec"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["exec"], ["group:runtime"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(denyNodeCommands!, ["system.run"], ["system.run"])).toBe(
      true,
    );
    expect(isPolicyValueAtLeastAsStrict(denyNodeCommands!, [], ["system.run"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(denyNodeCommands!, ["system.Run"], ["system.run"])).toBe(
      false,
    );
    expect(isPolicyValueAtLeastAsStrict(denyHostNetwork!, true, true)).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyHostNetwork!, false, true)).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(fsWorkspaceOnly!, true, true)).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(fsWorkspaceOnly!, false, true)).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(alsoAllow!, ["read"], ["read"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(alsoAllow!, [], ["read"])).toBe(false);
    const baselineProbe = {
      id: "family-dm",
      route: { channel: "imessage", peer: { kind: "direct", id: "private" } },
      expect: { agentId: "family", matchedBy: ["binding.peer", "binding.account"] },
    };
    expect(
      isPolicyValueAtLeastAsStrict(
        routingProbes!,
        [{ ...baselineProbe, expect: { ...baselineProbe.expect, matchedBy: ["binding.peer"] } }],
        [baselineProbe],
      ),
    ).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(routingProbes!, [], [baselineProbe])).toBe(false);
    expect(
      isPolicyValueAtLeastAsStrict(
        routingProbes!,
        [{ ...baselineProbe, expect: { ...baselineProbe.expect, matchedBy: [] } }],
        [baselineProbe],
      ),
    ).toBe(false);
    expect(
      isPolicyValueAtLeastAsStrict(
        routingProbes!,
        [{ ...baselineProbe, expect: { ...baselineProbe.expect, agentId: "Family" } }],
        [baselineProbe],
      ),
    ).toBe(true);
    expect(
      isPolicyValueAtLeastAsStrict(
        routingProbes!,
        [{ ...baselineProbe, expect: { ...baselineProbe.expect, agentId: "main" } }],
        [baselineProbe],
      ),
    ).toBe(false);
    const scopedBaselineProbe = {
      ...baselineProbe,
      route: {
        channel: "imessage",
        peer: { kind: "direct", id: "private" },
        parentPeer: { kind: "group", id: "family-thread" },
        guildId: "home",
        teamId: "family",
      },
    };
    expect(
      isPolicyValueAtLeastAsStrict(
        routingProbes!,
        [
          {
            ...scopedBaselineProbe,
            route: {
              channel: " IMESSAGE ",
              accountId: " DEFAULT ",
              peer: { kind: "direct", id: " private " },
              parentPeer: { kind: "group", id: " family-thread " },
              guildId: " home ",
              teamId: " family ",
            },
          },
        ],
        [scopedBaselineProbe],
      ),
    ).toBe(true);
    expect(
      isPolicyValueAtLeastAsStrict(
        routingProbes!,
        [{ ...baselineProbe, route: { ...baselineProbe.route, accountId: "*" } }],
        [baselineProbe],
      ),
    ).toBe(true);
    expect(
      isPolicyValueAtLeastAsStrict(
        routingProbes!,
        [
          {
            ...scopedBaselineProbe,
            route: { ...scopedBaselineProbe.route, guildId: "other" },
          },
        ],
        [scopedBaselineProbe],
      ),
    ).toBe(false);
  });
});
