// Policy tests cover policy state plugin behavior.
import { describe, expect, it } from "vitest";
import { scanPolicySandboxPosture } from "./policy-state-sandbox.js";
import { scanPolicyToolPosture } from "./policy-state-tool-posture.js";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  policyDocumentHash,
} from "./policy-state.js";

const scanPolicyChannels = (cfg: Record<string, unknown>) => collectPolicyEvidence(cfg).channels;

async function scanPolicyTools(raw: string) {
  const evidence = await collectPolicyEvidence({}, { toolsRaw: raw });
  return evidence.tools ?? [];
}

const scanPolicyExecApprovals = (raw: string) =>
  collectPolicyEvidence({}, { execApprovalsRaw: raw }).execApprovals ?? [];

describe("configured agent scanning", () => {
  const keyedConfig = {
    tools: { elevated: { enabled: true } },
    agents: {
      defaults: { sandbox: { mode: "off" } },
      entries: {
        guest: {
          models: { "openai/gpt-5.6-luna": {} },
          sandbox: { mode: "all", workspaceAccess: "none" },
          tools: { deny: ["exec"], elevated: { enabled: false } },
        },
      },
    },
  };

  it("uses agents.entries across policy evidence", () => {
    const evidence = collectPolicyEvidence(keyedConfig);
    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "mode",
          scope: "agent",
          agentId: "guest",
          value: "all",
          source: "oc://openclaw.config/agents/entries/guest/sandbox/mode",
        }),
      ]),
    );
    expect(
      evidence.toolPosture?.filter((entry) => entry.scope === "agent" && entry.agentId === "guest"),
    ).not.toHaveLength(0);
    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "agent",
          agentId: "guest",
          source: "oc://openclaw.config/agents/entries/guest/tools/elevated/enabled",
          value: false,
        }),
      ]),
    );
    expect(evidence.agentWorkspace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "agent",
          agentId: "guest",
          source: "oc://openclaw.config/agents/entries/guest/sandbox/workspaceAccess",
          value: "none",
        }),
      ]),
    );
    expect(evidence.modelRefs).toContainEqual({
      ref: "openai/gpt-5.6-luna",
      provider: "openai",
      model: "gpt-5.6-luna",
      source: 'oc://openclaw.config/agents/entries/guest/models/"openai/gpt-5.6-luna"',
    });
  });

  it("still uses legacy agents.list across policy evidence", () => {
    const evidence = collectPolicyEvidence({
      agents: {
        defaults: { sandbox: { mode: "off" } },
        list: [
          {
            id: "legacy",
            models: { "openai/gpt-5.6-luna": {} },
            sandbox: { mode: "all" },
          },
        ],
      },
    });
    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "mode",
          scope: "agent",
          agentId: "legacy",
          value: "all",
          source: "oc://openclaw.config/agents/list/#0/sandbox/mode",
        }),
      ]),
    );
    expect(evidence.modelRefs).toContainEqual(
      expect.objectContaining({
        ref: "openai/gpt-5.6-luna",
        source: 'oc://openclaw.config/agents/list/#0/models/"openai/gpt-5.6-luna"',
      }),
    );
  });

  it("does not fall back to stale agents.list when entries owns the roster", () => {
    const evidence = collectPolicyEvidence({
      agents: {
        entries: {},
        list: [{ id: "legacy", sandbox: { mode: "all" } }],
      },
    });
    expect(evidence.sandboxPosture).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: "legacy" })]),
    );
  });

  it("keeps attestations stable across keyed entry order", () => {
    const first = {
      alpha: { models: { "openai/gpt-5.6-luna": {} } },
      omega: { models: { "openai/gpt-5.6-luna": {} } },
    };
    const attestationHash = (entries: Record<string, unknown>) =>
      createPolicyAttestation({
        ok: true,
        checkedAt: new Date(0).toISOString(),
        policyPath: "policy.jsonc",
        policyHash: policyDocumentHash({}),
        evidence: collectPolicyEvidence({ agents: { entries } }),
        findings: [],
      }).attestationHash;

    expect(attestationHash(first)).toBe(
      attestationHash({ omega: first.omega, alpha: first.alpha }),
    );
  });

  it("escapes entry keys that are not bare identifiers", () => {
    const evidence = scanPolicySandboxPosture({
      agents: {
        defaults: { sandbox: { mode: "off" } },
        entries: { "team/qa": { sandbox: { mode: "all" } } },
      },
    });
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "mode",
          agentId: "team/qa",
          source: 'oc://openclaw.config/agents/entries/"team/qa"/sandbox/mode',
        }),
      ]),
    );
  });
});

describe("scanPolicySandboxPosture", () => {
  it("keeps explicit Podman identity while exposing shared container settings", () => {
    const evidence = scanPolicySandboxPosture({
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "Podman",
            docker: {
              network: "bridge",
              seccompProfile: "custom-seccomp.json",
              binds: ["/host/data:/data:ro"],
            },
          },
        },
      },
    });

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "backend", value: "podman" }),
        expect.objectContaining({
          kind: "containerNetwork",
          networkSurface: "docker",
          value: "bridge",
        }),
        expect.objectContaining({
          kind: "containerSecurityProfile",
          profile: "seccomp",
          value: "custom-seccomp.json",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bindSurface: "docker",
          bind: "/host/data:/data:ro",
        }),
      ]),
    );
  });
});

describe("scanPolicyToolPosture", () => {
  it("derives exec posture from normalized agent entries", () => {
    const evidence = scanPolicyToolPosture({
      agents: {
        entries: { reviewer: { tools: { exec: { mode: "ask" } } } },
      },
    });

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reviewer-exec-security",
          kind: "execSecurity",
          value: "allowlist",
          source: "oc://openclaw.config/agents/entries/reviewer/tools/exec/mode",
          explicit: true,
        }),
        expect.objectContaining({
          id: "reviewer-exec-ask",
          kind: "execAsk",
          value: "on-miss",
          source: "oc://openclaw.config/agents/entries/reviewer/tools/exec/mode",
          explicit: true,
        }),
      ]),
    );
  });

  it("merges legacy agent fields with an inherited exec mode", () => {
    const evidence = scanPolicyToolPosture({
      tools: { exec: { mode: "auto" } },
      agents: {
        list: [{ id: "reviewer", tools: { exec: { ask: "always" } } }],
      },
    });

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reviewer-exec-security",
          kind: "execSecurity",
          value: "allowlist",
          source: "oc://openclaw.config/tools/exec/mode",
        }),
        expect.objectContaining({
          id: "reviewer-exec-ask",
          kind: "execAsk",
          value: "always",
          source: "oc://openclaw.config/agents/list/#0/tools/exec/ask",
        }),
      ]),
    );
  });
});

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
        source: "oc://AGENTS.md/tools/deploy-tool",
        line: 2,
        risk: "critical",
        sensitivity: "restricted",
        owner: "ops",
        capabilities: ["IRREVERSIBLE_EXTERNAL"],
      },
      {
        id: "inspect",
        source: "oc://AGENTS.md/tools/inspect",
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
        source: "oc://AGENTS.md/tools/deploy",
        line: 2,
        risk: "critical",
        owner: "ops",
      },
    ]);
  });

  it("ignores local-note examples inside fenced blocks", async () => {
    await expect(
      scanPolicyTools(
        [
          "## Tools",
          "```markdown",
          "- SSH: home-server -> 192.168.1.100",
          "### Cameras",
          "```",
        ].join("\n"),
      ),
    ).resolves.toEqual([]);
  });

  it("ignores the complete local-notes subsection", async () => {
    await expect(
      scanPolicyTools(
        ["## Tools", "### Local notes", "- SSH: prod-host", "### deploy risk: high"].join("\n"),
      ),
    ).resolves.toEqual([expect.objectContaining({ id: "deploy", risk: "high" })]);
  });

  it("parses a tool literally named tools after local notes", async () => {
    await expect(
      scanPolicyTools(
        [
          "## Tools",
          "### Local notes",
          "- SSH: prod-host",
          "### tools risk: high sensitivity: restricted owner: ops",
        ].join("\n"),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "tools",
        risk: "high",
        sensitivity: "restricted",
        owner: "ops",
      }),
    ]);
  });

  it("ignores deeper Tools sections outside the governed H1/H2 contract", async () => {
    await expect(
      scanPolicyTools(
        [
          "## Build",
          "### Tools",
          "- npm: risk: high owner: ops",
          "## Tools",
          "### deploy risk: low owner: release",
        ].join("\n"),
      ),
    ).resolves.toEqual([expect.objectContaining({ id: "deploy", risk: "low", owner: "release" })]);
  });

  it("does not carry metadata across repeated Tools section boundaries", async () => {
    const evidence = await scanPolicyTools(
      [
        "## Tools",
        "### deploy risk: high",
        "## Tools",
        "owner: ops",
        "### inspect risk: low owner: support",
      ].join("\n"),
    );
    expect(evidence).toEqual([
      expect.objectContaining({ id: "deploy", risk: "high" }),
      expect.objectContaining({ id: "inspect", owner: "support" }),
    ]);
    expect(evidence[0]).not.toHaveProperty("owner");
  });

  it("keeps longer fences open across shorter delimiter runs", async () => {
    await expect(
      scanPolicyTools(["## Tools", "````markdown", "```", "- SSH: home-server", "````"].join("\n")),
    ).resolves.toEqual([]);
  });

  it("scans a migrated legacy Tools section after its document heading", async () => {
    await expect(
      scanPolicyTools(
        [
          "## Tools",
          "### Local notes (migrated from TOOLS.md)",
          "# TOOLS.md",
          "## Tools",
          "### deploy risk: high sensitivity: restricted owner: ops",
        ].join("\n"),
      ),
    ).resolves.toEqual([expect.objectContaining({ id: "deploy", risk: "high", owner: "ops" })]);
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
