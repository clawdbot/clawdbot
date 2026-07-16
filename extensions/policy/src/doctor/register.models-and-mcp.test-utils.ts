// Imported by register.test.ts to keep its mocked suite in one Vitest module graph.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runDoctorLintChecks, type OpenClawConfig } from "openclaw/plugin-sdk/health";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPolicyEvidence } from "../policy-state.js";
import {
  workspaceDir,
  cfgWithPolicy,
  ctx,
  repairCtx,
  registerChecks,
  runPolicyChecks,
  runPolicyDoctorLint,
  runPolicyRepairCheck,
  describe0BeforeEach0,
  describe0AfterEach1,
} from "./register.test-harness.js";

const scanPolicyMcpServers = (cfg: object) =>
  collectPolicyEvidence(cfg as Record<string, unknown>).mcpServers;
const scanPolicyIngress = (cfg: object) =>
  collectPolicyEvidence(cfg as Record<string, unknown>).ingress ?? [];

describe("registerPolicyDoctorChecks", () => {
  beforeEach(describe0BeforeEach0);

  afterEach(describe0AfterEach1);

  it("repairs required agent workspace deny tool findings", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      agents: {
        list: [
          {
            id: "reviewer",
            tools: { deny: ["exec"] },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          reviewer: {
            agentIds: ["reviewer"],
            agents: { workspace: { denyTools: ["exec", "write", "edit"] } },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck(
      "policy/agents-tool-not-denied",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("repaired");
    expect(result.changes).toEqual([
      "Added edit to agents.list[0].tools.deny for policy conformance.",
      "Added write to agents.list[0].tools.deny for policy conformance.",
    ]);
    expect(result.remainingFindings).toEqual([]);
    expect(result.config.agents?.list?.[0]).toMatchObject({
      id: "reviewer",
      tools: { deny: ["exec", "edit", "write"] },
    });
  });

  it("skips scoped required deny repairs that would mutate root tools deny", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      tools: { deny: ["exec"] },
      agents: {
        list: [{ id: "reviewer" }],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          reviewer: {
            agentIds: ["reviewer"],
            tools: { denyTools: ["exec", "write"] },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck(
      "policy/tools-required-deny-missing",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("policy automatic repair had no config changes to apply");
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped scoped deny repair for write. The finding reports inherited root tools.deny, so changing it would affect more than the scoped policy target.",
    ]);
    expect(result.config.tools?.deny).toEqual(["exec"]);
    expect(result.config.agents?.list?.[0]).toEqual({ id: "reviewer" });
    expect(result.remainingFindings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-required-deny-missing",
        ocPath: "oc://openclaw.config/tools/deny",
        requirement: "oc://policy.jsonc/scopes/reviewer/tools/denyTools",
      }),
    ]);
  });

  it("skips scoped data-handling repairs that would mutate shared config", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      logging: { redactSensitive: "off" },
      agents: {
        list: [{ id: "reviewer" }],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          reviewer: {
            agentIds: ["reviewer"],
            dataHandling: {
              sensitiveLogging: { requireRedaction: true },
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck(
      "policy/data-handling-redaction-disabled",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("policy automatic repair had no config changes to apply");
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped scoped data-handling repair. The finding reports shared logging config, so changing it would affect more than the scoped policy target.",
    ]);
    expect(result.config.logging?.redactSensitive).toBe("off");
    expect(result.remainingFindings).toEqual([
      expect.objectContaining({
        checkId: "policy/data-handling-redaction-disabled",
        requirement:
          "oc://policy.jsonc/scopes/reviewer/dataHandling/sensitiveLogging/requireRedaction",
      }),
    ]);
  });

  it("does not register repair for non-previewable policy findings", () => {
    const check = registerChecks().find(
      (entry) => entry.id === "policy/gateway-http-url-fetch-unrestricted",
    );

    expect("repair" in (check ?? {})).toBe(false);
  });

  it("does not report denied providers for disabled channels", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: false } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          channels: {
            denyRules: [
              {
                id: "no-telegram",
                when: { provider: "telegram" },
                reason: "Telegram is not approved for this workspace.",
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await expect(runPolicyChecks(ctx(configPath, cfg))).resolves.toMatchObject({
      findings: [],
    });
  });

  it("does not run policy checks for empty category namespaces", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: true } },
      mcp: { servers: { untrusted: { command: "uvx", args: ["untrusted-mcp"] } } },
      models: { providers: { openrouter: {} } },
      browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: {}, mcp: {}, models: {}, network: {}, tools: {} }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports invalid requireMetadata policy entries", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["risk", "unsupported"] } }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()), {
      checks: registerChecks(),
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        severity: "error",
        path: "policy.jsonc",
        target: "oc://policy.jsonc/tools/requireMetadata/#1",
      }),
    ]);
  });

  it("reports blank requireMetadata policy entries", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["risk", " "] } }),
      "utf-8",
    );

    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()), {
      checks: registerChecks(),
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        severity: "error",
        path: "policy.jsonc",
        target: "oc://policy.jsonc/tools/requireMetadata/#1",
      }),
    ]);
  });

  it("reports invalid requireMetadata entries against a configured policy path", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "workspace.policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["unsupported"] } }),
      "utf-8",
    );

    const result = await runDoctorLintChecks(
      ctx(configPath, cfgWithPolicy({ path: "workspace.policy.jsonc" })),
      {
        checks: registerChecks(),
      },
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        path: "workspace.policy.jsonc",
        target: "oc://workspace.policy.jsonc/tools/requireMetadata/#0",
      }),
    ]);
  });

  it("reports governed tools missing risk and sensitivity metadata", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["risk", "sensitivity", "owner"] } }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()), {
      checks: registerChecks(),
    });

    expect(result.findings).toHaveLength(3);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-missing-risk-level",
          severity: "error",
          path: "TOOLS.md",
          ocPath: "oc://TOOLS.md/tools/deploy",
        }),
        expect.objectContaining({
          checkId: "policy/tools-missing-sensitivity-token",
          severity: "error",
          path: "TOOLS.md",
          ocPath: "oc://TOOLS.md/tools/deploy",
        }),
        expect.objectContaining({
          checkId: "policy/tools-missing-owner",
          severity: "error",
          path: "TOOLS.md",
          ocPath: "oc://TOOLS.md/tools/deploy",
        }),
      ]),
    );
  });

  it("reports governed bullet tools missing required metadata", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["risk", "sensitivity", "owner"] } }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n- deploy: deploys\n", "utf-8");

    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()), {
      checks: registerChecks(),
    });

    expect(result.findings).toHaveLength(3);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-missing-risk-level",
          path: "TOOLS.md",
          ocPath: "oc://TOOLS.md/tools/deploy",
        }),
        expect.objectContaining({
          checkId: "policy/tools-missing-sensitivity-token",
          path: "TOOLS.md",
          ocPath: "oc://TOOLS.md/tools/deploy",
        }),
        expect.objectContaining({
          checkId: "policy/tools-missing-owner",
          path: "TOOLS.md",
          ocPath: "oc://TOOLS.md/tools/deploy",
        }),
      ]),
    );
  });

  it("accepts governed tool metadata declared on following lines", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["risk", "sensitivity", "owner"] } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      [
        "## Tools",
        "",
        "### deploy",
        "risk: critical",
        "sensitivity: restricted",
        "owner: ops",
        "IRREVERSIBLE_EXTERNAL",
        "",
        "### inspect",
        "risk: low",
        "sensitivity: public",
        "owner: support",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()), {
      checks: registerChecks(),
    });
    const evidence = await collectPolicyEvidence(
      {},
      {
        toolsRaw: await fs.readFile(join(workspaceDir, "TOOLS.md"), "utf-8"),
      },
    );

    expect(result.findings).toEqual([]);
    expect(evidence.tools).toEqual([
      {
        id: "deploy",
        source: "oc://TOOLS.md/tools/deploy",
        line: 3,
        risk: "critical",
        sensitivity: "restricted",
        owner: "ops",
        capabilities: ["IRREVERSIBLE_EXTERNAL"],
      },
      {
        id: "inspect",
        source: "oc://TOOLS.md/tools/inspect",
        line: 9,
        risk: "low",
        sensitivity: "public",
        owner: "support",
      },
    ]);
  });

  it("reports unknown governed tool risk metadata", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["risk"] } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:critcal\n",
      "utf-8",
    );

    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()), {
      checks: registerChecks(),
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-unknown-risk-level",
        severity: "error",
        path: "TOOLS.md",
        ocPath: "oc://TOOLS.md/tools/deploy",
      }),
    ]);
  });

  it("reports model providers denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: "openrouter/openai/gpt-5.5",
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { deny: ["openrouter"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-denied-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/models/providers/openrouter",
        requirement: "oc://policy.jsonc/models/providers/deny",
      }),
      expect.objectContaining({
        checkId: "policy/models-denied-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/agents/defaults/model",
        requirement: "oc://policy.jsonc/models/providers/deny",
      }),
    ]);
  });

  it("compares canonical model provider refs for deny policy checks", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      models: {
        providers: {
          "aws-bedrock": {},
        },
      },
      agents: {
        defaults: {
          model: "OpenRouter/openai/gpt-5.5",
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { deny: ["openrouter", "amazon-bedrock"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-denied-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/agents/defaults/model",
        requirement: "oc://policy.jsonc/models/providers/deny",
      }),
    ]);
  });

  it("compares canonical model provider refs for allow policy checks", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      models: {
        providers: {
          "aws-bedrock": {},
        },
      },
      agents: {
        defaults: {
          model: "OpenRouter/openai/gpt-5.5",
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { allow: ["openrouter", "amazon-bedrock"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-unapproved-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/models/providers/aws-bedrock",
        requirement: "oc://policy.jsonc/models/providers/allow",
      }),
    ]);
  });

  it("reports model refs outside the policy allowlist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["anthropic/claude-sonnet-4.7"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { allow: ["openai"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-unapproved-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/agents/defaults/model/fallbacks/#0",
        requirement: "oc://policy.jsonc/models/providers/allow",
      }),
    ]);
  });

  it("reports model allowlist keys outside the policy allowlist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          models: {
            "openrouter/*": {},
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { allow: ["openai"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-unapproved-provider",
        severity: "error",
        ocPath: 'oc://openclaw.config/agents/defaults/models/"openrouter/*"',
        requirement: "oc://policy.jsonc/models/providers/allow",
      }),
    ]);
  });

  it("reports per-agent model allowlist keys outside the policy allowlist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [
          {
            id: "research",
            models: {
              "openrouter/*": {},
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { allow: ["openai"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-unapproved-provider",
        severity: "error",
        ocPath: 'oc://openclaw.config/agents/list/#0/models/"openrouter/*"',
        requirement: "oc://policy.jsonc/models/providers/allow",
      }),
    ]);
  });

  it("reports configured model providers outside the policy allowlist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      models: {
        providers: {
          anthropic: {},
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { allow: ["openai"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-unapproved-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/models/providers/anthropic",
        requirement: "oc://policy.jsonc/models/providers/allow",
      }),
    ]);
  });

  it("reports non-default agent model refs outside the policy allowlist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          imageModel: "openai/gpt-5.5",
          subagents: {
            model: "anthropic/claude-sonnet-4.7",
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { allow: ["openai"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-unapproved-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/agents/defaults/subagents/model",
        requirement: "oc://policy.jsonc/models/providers/allow",
      }),
    ]);
  });

  it("reports per-agent model refs outside the policy allowlist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [
          {
            id: "research",
            model: { primary: "openrouter/openai/gpt-5.5" },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { deny: ["openrouter"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/models-denied-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/agents/list/#0/model/primary",
        requirement: "oc://policy.jsonc/models/providers/deny",
      }),
    ]);
  });

  it("does not enable tool metadata checks from a model-only policy block", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: {
          providers: { allow: ["openai"] },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    const result = await runPolicyDoctorLint(
      ctx(configPath, cfgWithPolicy({ enabled: undefined })),
    );

    expect(result.findings).toEqual([]);
  });

  it("reports MCP servers denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      mcp: {
        servers: {
          untrusted: {
            command: "uvx",
            args: ["untrusted-mcp"],
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        mcp: {
          servers: { deny: ["untrusted"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/mcp-denied-server",
        severity: "error",
        ocPath: "oc://openclaw.config/mcp/servers/untrusted",
        requirement: "oc://policy.jsonc/mcp/servers/deny",
      }),
    ]);
  });

  it("preserves MCP server casing for deny rules", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      mcp: {
        servers: {
          DocsServer: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-fetch"],
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        mcp: {
          servers: { deny: ["DocsServer"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/mcp-denied-server",
        severity: "error",
        ocPath: "oc://openclaw.config/mcp/servers/DocsServer",
        requirement: "oc://policy.jsonc/mcp/servers/deny",
      }),
    ]);
  });

  it("reports MCP servers outside the policy allowlist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      mcp: {
        servers: {
          docs: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-fetch"],
          },
          remote: {
            url: "https://example.com/mcp",
            transport: "streamable-http",
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        mcp: {
          servers: { allow: ["docs"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/mcp-unapproved-server",
        severity: "error",
        ocPath: "oc://openclaw.config/mcp/servers/remote",
        requirement: "oc://policy.jsonc/mcp/servers/allow",
      }),
    ]);
  });

  it("preserves MCP server casing for allowlists", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      mcp: {
        servers: {
          DocsServer: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-fetch"],
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        mcp: {
          servers: { allow: ["DocsServer"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("redacts MCP server URLs in policy evidence", () => {
    const [server] = scanPolicyMcpServers({
      mcp: {
        servers: {
          remote: {
            url: "https://user:pass@example.com/mcp?token=secret",
            transport: "streamable-http",
          },
        },
      },
    });

    expect(server).toEqual(
      expect.objectContaining({
        id: "remote",
        url: "https://example.com",
      }),
    );
  });

  it("quotes MCP server ids with whitespace in policy evidence paths", () => {
    const [server] = scanPolicyMcpServers({
      mcp: {
        servers: {
          "Outlook Graph": {
            command: "npx",
          },
        },
      },
    });

    expect(server).toEqual(
      expect.objectContaining({
        id: "Outlook Graph",
        source: 'oc://openclaw.config/mcp/servers/"Outlook Graph"',
      }),
    );
  });

  it("does not enable model checks from an MCP-only policy block", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ enabled: undefined }),
      models: {
        providers: {
          openrouter: {},
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        mcp: {
          servers: { allow: ["docs"] },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports ingress channel access conformance findings", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "main" },
      channels: {
        telegram: {
          dmPolicy: "open",
          groupPolicy: "open",
          requireMention: true,
          groups: {
            ops: { requireMention: false },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        ingress: {
          session: { requireDmScope: "per-channel-peer" },
          channels: {
            allowDmPolicies: ["pairing", "allowlist", "disabled"],
            denyOpenGroups: true,
            requireMentionInGroups: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toHaveLength(4);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-dm-scope-unapproved",
          severity: "error",
          ocPath: "oc://openclaw.config/session/dmScope",
          requirement: "oc://policy.jsonc/ingress/session/requireDmScope",
        }),
        expect.objectContaining({
          checkId: "policy/ingress-dm-policy-unapproved",
          severity: "error",
          ocPath: "oc://openclaw.config/channels/telegram/dmPolicy",
          requirement: "oc://policy.jsonc/ingress/channels/allowDmPolicies",
        }),
        expect.objectContaining({
          checkId: "policy/ingress-open-groups-denied",
          severity: "error",
          ocPath: "oc://openclaw.config/channels/telegram/groupPolicy",
          requirement: "oc://policy.jsonc/ingress/channels/denyOpenGroups",
        }),
        expect.objectContaining({
          checkId: "policy/ingress-group-mention-required",
          severity: "error",
          ocPath: "oc://openclaw.config/channels/telegram/groups/ops/requireMention",
          requirement: "oc://policy.jsonc/ingress/channels/requireMentionInGroups",
        }),
      ]),
    );
  });

  it("normalizes mixed-case session DM scope before checking ingress policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "Per-Channel-Peer" },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        ingress: {
          session: { requireDmScope: "per-channel-peer" },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-dm-scope-unapproved",
        }),
      ]),
    );
  });

  it("applies channel-scoped ingress claims to matching channel posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "main" },
      channels: {
        telegram: {
          enabled: true,
          provider: "telegram",
          dmPolicy: "open",
          groupPolicy: "open",
          requireMention: false,
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        ingress: {
          session: { requireDmScope: "per-channel-peer" },
        },
        scopes: {
          telegramIngress: {
            channelIds: ["telegram"],
            ingress: {
              channels: {
                allowDmPolicies: ["pairing"],
                denyOpenGroups: true,
                requireMentionInGroups: true,
              },
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-dm-scope-unapproved",
          requirement: "oc://policy.jsonc/ingress/session/requireDmScope",
        }),
        expect.objectContaining({
          checkId: "policy/ingress-dm-policy-unapproved",
          requirement: "oc://policy.jsonc/scopes/telegramIngress/ingress/channels/allowDmPolicies",
        }),
        expect.objectContaining({
          checkId: "policy/ingress-open-groups-denied",
          requirement: "oc://policy.jsonc/scopes/telegramIngress/ingress/channels/denyOpenGroups",
        }),
        expect.objectContaining({
          checkId: "policy/ingress-group-mention-required",
          requirement:
            "oc://policy.jsonc/scopes/telegramIngress/ingress/channels/requireMentionInGroups",
        }),
      ]),
    );
  });

  it("does not apply channel-scoped ingress claims from invalid scopes", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: {
        telegram: {
          dmPolicy: "open",
          groupPolicy: "open",
          requireMention: false,
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          telegramIngress: {
            channelIds: ["telegram"],
            agents: {},
            ingress: {
              channels: {
                allowDmPolicies: ["pairing"],
                denyOpenGroups: true,
                requireMentionInGroups: true,
              },
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/scopes/telegramIngress",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/ingress-dm-policy-unapproved" }),
        expect.objectContaining({ checkId: "policy/ingress-open-groups-denied" }),
        expect.objectContaining({ checkId: "policy/ingress-group-mention-required" }),
      ]),
    );
  });

  it("does not treat wildcard groupPolicy as channel ingress posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: {
        telegram: {
          enabled: true,
          provider: "telegram",
          groupPolicy: "open",
          requireMention: false,
          groups: {
            "*": {
              groupPolicy: "disabled",
              requireMention: false,
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        ingress: {
          channels: {
            denyOpenGroups: true,
            requireMentionInGroups: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.ingress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "channelGroupPolicy",
          source: "oc://openclaw.config/channels/telegram/groupPolicy",
          value: "open",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/ingress-open-groups-denied" }),
        expect.objectContaining({ checkId: "policy/ingress-group-mention-required" }),
      ]),
    );
  });

  it("honors wildcard mention ingress for channel posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: {
        telegram: {
          enabled: true,
          provider: "telegram",
          groupPolicy: "allowlist",
          requireMention: false,
          groups: {
            "*": { requireMention: true },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        ingress: {
          channels: {
            requireMentionInGroups: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.ingress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "channelRequireMention",
          source: 'oc://openclaw.config/channels/telegram/groups/"*"/requireMention',
          value: true,
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/ingress-group-mention-required" }),
      ]),
    );
  });

  it("honors strict channel group policy defaults", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: {
        signal: {
          enabled: true,
          provider: "signal",
          dmPolicy: "pairing",
          requireMention: true,
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        ingress: {
          channels: {
            denyOpenGroups: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.ingress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "signal",
          explicit: false,
          kind: "channelGroupPolicy",
          source: "oc://openclaw.config/channels/signal/groupPolicy",
          value: "allowlist",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/ingress-open-groups-denied" }),
      ]),
    );
  });

  it("treats disabled nested DM config as disabled ingress", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: {
        slack: {
          dmPolicy: "open",
          dm: { enabled: false },
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        ingress: {
          channels: {
            allowDmPolicies: ["disabled"],
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.ingress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "slack",
          kind: "channelDmPolicy",
          source: "oc://openclaw.config/channels/slack/dm/enabled",
          value: "disabled",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/ingress-dm-policy-unapproved" }),
      ]),
    );
  });

  it("ignores disabled channel and account ingress posture", () => {
    const cfg = {
      channels: {
        telegram: {
          enabled: false,
          dmPolicy: "open",
          groupPolicy: "open",
          requireMention: false,
        },
        slack: {
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          accounts: {
            disabled: {
              enabled: false,
              dmPolicy: "open",
              groupPolicy: "open",
              requireMention: false,
            },
          },
        },
      },
    };

    const evidence = scanPolicyIngress(cfg);

    expect(evidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "telegram" }),
        expect.objectContaining({ accountId: "disabled" }),
      ]),
    );
  });

  it("records nested ingress mention overrides", () => {
    const cfg = {
      channels: {
        discord: {
          guilds: {
            ops: {
              channels: {
                releases: { requireMention: false },
              },
            },
          },
        },
        msteams: {
          teams: {
            engineering: {
              channels: {
                general: { requireMention: false },
              },
            },
          },
        },
        matrix: {
          rooms: {
            standup: { requireMention: false },
          },
        },
        telegram: {
          groups: {
            ops: {
              topics: {
                incidents: { requireMention: false },
              },
            },
          },
        },
      },
    };

    expect(scanPolicyIngress(cfg)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source:
            "oc://openclaw.config/channels/discord/guilds/ops/channels/releases/requireMention",
          value: false,
        }),
        expect.objectContaining({
          source:
            "oc://openclaw.config/channels/msteams/teams/engineering/channels/general/requireMention",
          value: false,
        }),
        expect.objectContaining({
          source: "oc://openclaw.config/channels/matrix/rooms/standup/requireMention",
          value: false,
        }),
        expect.objectContaining({
          source:
            "oc://openclaw.config/channels/telegram/groups/ops/topics/incidents/requireMention",
          value: false,
        }),
      ]),
    );
  });

  it("uses effective ingress defaults when policy governs omitted fields", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        qqbot: {},
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        ingress: {
          session: { requireDmScope: "per-channel-peer" },
          channels: {
            allowDmPolicies: ["pairing", "allowlist", "disabled"],
            denyOpenGroups: true,
            requireMentionInGroups: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/ingress-open-groups-denied",
        ocPath: "oc://openclaw.config/channels/qqbot/groupPolicy",
      }),
    ]);
  });

  it("infers allowlist group posture from configured groups", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          groups: {
            ops: {},
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        ingress: {
          channels: {
            allowDmPolicies: ["pairing"],
            denyOpenGroups: true,
            requireMentionInGroups: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.ingress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "channelGroupPolicy",
          source: "oc://openclaw.config/channels/telegram/groups",
          value: "allowlist",
        }),
        expect.objectContaining({
          kind: "channelRequireMention",
          source: "oc://openclaw.config/channels/telegram/requireMention",
          value: true,
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("does not infer allowlist posture from Slack channel entries", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        slack: {
          dmPolicy: "pairing",
          channels: {
            releases: { requireMention: true },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        ingress: {
          channels: {
            denyOpenGroups: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.ingress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "slack",
          kind: "channelGroupPolicy",
          source: "oc://openclaw.config/channels/slack/groupPolicy",
          value: "open",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-open-groups-denied",
          ocPath: "oc://openclaw.config/channels/slack/groupPolicy",
        }),
      ]),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
