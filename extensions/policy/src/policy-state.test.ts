// Policy tests cover policy state plugin behavior.
import { describe, expect, it } from "vitest";
import { collectPolicyEvidence } from "./policy-state.js";

const scanPolicyChannels = (cfg: Record<string, unknown>) => collectPolicyEvidence(cfg).channels;

async function scanPolicyTools(raw: string) {
  const evidence = await collectPolicyEvidence({}, { toolsRaw: raw });
  return evidence.tools ?? [];
}

const scanPolicyExecApprovals = (raw: string) =>
  collectPolicyEvidence({}, { execApprovalsRaw: raw }).execApprovals ?? [];

describe("scanPolicyChannels", () => {
  it("ignores reserved channel config namespaces", () => {
    expect(
      scanPolicyChannels({
        channels: {
          defaults: {
            provider: "telegram",
          },
          modelByChannel: {
            telegram: "openai/gpt-5.5",
          },
          telegram: {
            enabled: true,
          },
        },
      }),
    ).toEqual([
      {
        enabled: true,
        id: "telegram",
        provider: "telegram",
        source: "oc://openclaw.config/channels/telegram",
      },
    ]);
  });

  it("does not treat channel arrays as channel config maps", () => {
    expect(
      scanPolicyChannels({
        channels: [{ enabled: true }],
      }),
    ).toEqual([]);
  });
});

describe("scanPolicyRouting", () => {
  it("is opt-in so existing evidence and attestations remain stable", () => {
    const cfg = { channels: { imessage: {} }, bindings: [] };
    expect(collectPolicyEvidence(cfg)).not.toHaveProperty("routing");
    expect(collectPolicyEvidence(cfg, { routing: {} })).toHaveProperty("routing");
  });
});

describe("scanPolicyTools", () => {
  it("scans documented bullet tool declarations", async () => {
    await expect(
      scanPolicyTools(
        [
          "## Tools",
          "- deploy_tool: risk: critical sensitivity: restricted owner: ops IRREVERSIBLE_EXTERNAL",
          "- inspect: risk: low",
          "  sensitivity: public",
          "  owner: support",
        ].join("\n"),
      ),
    ).resolves.toEqual([
      {
        id: "deploy-tool",
        source: "oc://TOOLS.md/tools/deploy-tool",
        line: 2,
        risk: "critical",
        sensitivity: "restricted",
        owner: "ops",
        capabilities: ["IRREVERSIBLE_EXTERNAL"],
      },
      {
        id: "inspect",
        source: "oc://TOOLS.md/tools/inspect",
        line: 3,
        risk: "low",
        sensitivity: "public",
        owner: "support",
      },
    ]);
  });

  it("does not treat indented metadata bullets as tool declarations", async () => {
    await expect(
      scanPolicyTools(["## Tools", "- deploy: risk: critical", "  - owner: ops"].join("\n")),
    ).resolves.toEqual([
      {
        id: "deploy",
        source: "oc://TOOLS.md/tools/deploy",
        line: 2,
        risk: "critical",
        owner: "ops",
      },
    ]);
  });
});

describe("scanPolicyExecApprovals", () => {
  it("scans redacted exec approvals posture and allowlist metadata", () => {
    const evidence = scanPolicyExecApprovals(
      JSON.stringify({
        version: 1,
        socket: { path: "/tmp/openclaw.sock", token: "secret-token" },
        defaults: { security: "full", ask: "off", askFallback: "full", autoAllowSkills: true },
        agents: {
          sebby: {
            security: "allowlist",
            ask: "on-miss",
            allowlist: [
              {
                pattern: "deploy",
                argPattern: "^--prod$",
                source: "allow-always",
                commandText: "deploy --prod",
                lastUsedCommand: "deploy --prod",
              },
              {
                pattern: "inspect",
                source: "free-form text that must not leak",
              },
            ],
          },
        },
      }),
    );

    expect(evidence).toEqual([
      expect.objectContaining({
        id: "defaults",
        kind: "defaults",
        security: "full",
        autoAllowSkills: true,
      }),
      expect.objectContaining({
        id: "agent:sebby",
        kind: "agent",
        agentId: "sebby",
        security: "allowlist",
        ask: "on-miss",
      }),
      expect.objectContaining({
        id: "agent:sebby:allowlist:0",
        kind: "allowlist",
        agentId: "sebby",
        pattern: "deploy",
        argPattern: "^--prod$",
        entrySource: "allow-always",
      }),
      expect.not.objectContaining({
        entrySource: "free-form text that must not leak",
      }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain("secret-token");
    expect(JSON.stringify(evidence)).not.toContain("deploy --prod");
    expect(JSON.stringify(evidence)).not.toContain("free-form text that must not leak");
  });

  it("omits malformed exec approval mode fields", () => {
    expect(
      scanPolicyExecApprovals(
        JSON.stringify({
          version: 1,
          defaults: { security: "bogus", ask: "bad", askFallback: "nope" },
          agents: {
            sebby: { security: "bogus", ask: "bad", askFallback: "nope" },
          },
        }),
      ),
    ).toEqual([
      expect.not.objectContaining({ security: expect.any(String) }),
      expect.not.objectContaining({ security: expect.any(String) }),
    ]);
  });

  it("normalizes legacy default agents and string allowlist entries", () => {
    expect(
      scanPolicyExecApprovals(
        JSON.stringify({
          version: 1,
          agents: {
            default: {
              security: "allowlist",
              allowlist: ["legacy", { pattern: "doctor" }],
            },
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        id: "defaults",
        kind: "defaults",
      }),
      expect.objectContaining({
        id: "agent:main",
        kind: "agent",
        agentId: "main",
        security: "allowlist",
        source: "oc://exec-approvals.json/agents/default",
      }),
      expect.objectContaining({
        id: "agent:main:allowlist:0",
        kind: "allowlist",
        agentId: "main",
        pattern: "legacy",
        source: "oc://exec-approvals.json/agents/default/allowlist/#0",
      }),
      expect.objectContaining({
        id: "agent:main:allowlist:1",
        kind: "allowlist",
        agentId: "main",
        pattern: "doctor",
        source: "oc://exec-approvals.json/agents/default/allowlist/#1",
      }),
    ]);
  });
});
