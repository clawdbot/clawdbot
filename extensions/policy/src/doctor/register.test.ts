import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDoctorLintChecks,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
  type HealthRepairContext,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/health";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  policyDocumentHash,
  scanPolicyMcpServers,
} from "../policy-state.js";
import { registerPolicyDoctorChecks, resetPolicyDoctorChecksForTest } from "./register.js";

let workspaceDir: string;

function cfgWithPolicy(settings: Record<string, unknown> = {}): OpenClawConfig {
  return {
    plugins: {
      entries: {
        policy: {
          enabled: true,
          config: { enabled: true, ...settings },
        },
      },
    },
  };
}

function ctx(configPath: string, cfg: OpenClawConfig = {}): HealthCheckContext {
  return {
    mode: "lint",
    runtime: {
      log() {},
      error() {},
      exit() {},
    },
    cfg,
    cwd: workspaceDir,
    configPath,
  };
}

function repairCtx(configPath: string, cfg: OpenClawConfig = {}): HealthRepairContext {
  return {
    ...ctx(configPath, cfg),
    mode: "fix",
  };
}

function registerChecks(): readonly HealthCheck[] {
  const checks: HealthCheck[] = [];
  registerPolicyDoctorChecks({
    registerHealthCheck(check) {
      checks.push(check);
    },
  });
  return checks;
}

async function runPolicyChecks(checkCtx: HealthCheckContext): Promise<{
  readonly findings: readonly HealthFinding[];
}> {
  const checks = registerChecks();
  const findings: HealthFinding[] = [];
  for (const check of checks) {
    findings.push(...(check.detect === undefined ? [] : await check.detect(checkCtx)));
  }
  return { findings };
}

async function runPolicyDoctorLint(checkCtx: HealthCheckContext) {
  return runDoctorLintChecks(checkCtx, { checks: registerChecks() });
}

async function runDeniedChannelRepair(repairCheckCtx: HealthRepairContext) {
  const check = registerChecks().find((entry) => entry.id === "policy/channels-denied-provider");
  if (check?.detect === undefined || check.repair === undefined) {
    throw new Error("policy channel repair check was not registered");
  }
  const findings = await check.detect(repairCheckCtx);
  const result = await check.repair(repairCheckCtx, findings);
  const config = result.config ?? repairCheckCtx.cfg;
  const remainingFindings = await check.detect({ ...repairCheckCtx, cfg: config });
  return { ...result, config, remainingFindings };
}

describe("registerPolicyDoctorChecks", () => {
  beforeEach(async () => {
    resetPolicyDoctorChecksForTest();
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-doctor-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    resetPolicyDoctorChecksForTest();
  });

  it("registers policy health checks once", () => {
    const checks = registerChecks();
    const duplicateChecks: HealthCheck[] = [];
    registerPolicyDoctorChecks({
      registerHealthCheck(check) {
        duplicateChecks.push(check);
      },
    });

    expect(checks.map((check) => check.id)).toEqual([
      "policy/policy-jsonc-missing",
      "policy/policy-jsonc-invalid",
      "policy/policy-hash-mismatch",
      "policy/attestation-hash-mismatch",
      "policy/channels-denied-provider",
      "policy/mcp-denied-server",
      "policy/mcp-unapproved-server",
      "policy/models-denied-provider",
      "policy/models-unapproved-provider",
      "policy/network-private-access-enabled",
      "policy/tools-missing-risk-level",
      "policy/tools-unknown-risk-level",
      "policy/tools-missing-sensitivity-token",
      "policy/tools-missing-owner",
      "policy/tools-unknown-sensitivity-token",
    ]);
    expect(duplicateChecks).toEqual([]);
  });

  it("reports a missing policy file when the Policy plugin is enabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-missing",
        severity: "warning",
        path: "policy.jsonc",
      }),
    ]);
  });

  it("does not report a missing policy file when policy is disabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy({ enabled: false })));

    expect(result.findings).toEqual([]);
  });

  it("reports invalid policy files as errors", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), "{ channels: ", "utf-8");

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        severity: "error",
        path: "policy.jsonc",
      }),
    ]);
  });

  it("reports malformed channel deny rules as policy errors", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [{ when: {} }] } }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        severity: "error",
        path: "policy.jsonc",
        target: "oc://policy.jsonc/channels/denyRules/#0",
      }),
    ]);
  });

  it("reports malformed channel deny rules against a configured policy path", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "workspace.policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [{ when: {} }] } }),
      "utf-8",
    );

    const result = await runPolicyChecks(
      ctx(configPath, cfgWithPolicy({ path: "workspace.policy.jsonc" })),
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        path: "workspace.policy.jsonc",
        target: "oc://workspace.policy.jsonc/channels/denyRules/#0",
      }),
    ]);
  });

  it.each([
    ["top-level array", [], "oc://policy.jsonc"],
    ["tools array", { tools: [] }, "oc://policy.jsonc/tools"],
    ["tools settings array", { tools: { settings: [] } }, "oc://policy.jsonc/tools/settings"],
    ["tools entries object", { tools: { entries: {} } }, "oc://policy.jsonc/tools/entries"],
    ["channels array", { channels: [] }, "oc://policy.jsonc/channels"],
    ["mcp array", { mcp: [] }, "oc://policy.jsonc/mcp"],
    ["mcp servers array", { mcp: { servers: [] } }, "oc://policy.jsonc/mcp/servers"],
    [
      "mcp servers allow string",
      { mcp: { servers: { allow: "docs" } } },
      "oc://policy.jsonc/mcp/servers/allow",
    ],
    [
      "mcp servers deny non-string entry",
      { mcp: { servers: { deny: ["docs", 1] } } },
      "oc://policy.jsonc/mcp/servers/deny/#1",
    ],
    ["models array", { models: [] }, "oc://policy.jsonc/models"],
    [
      "models providers array",
      { models: { providers: [] } },
      "oc://policy.jsonc/models/providers",
    ],
    [
      "models providers allow string",
      { models: { providers: { allow: "openai" } } },
      "oc://policy.jsonc/models/providers/allow",
    ],
    [
      "models providers deny blank entry",
      { models: { providers: { deny: ["openrouter", " "] } } },
      "oc://policy.jsonc/models/providers/deny/#1",
    ],
    ["network array", { network: [] }, "oc://policy.jsonc/network"],
    [
      "network privateNetwork boolean",
      { network: { privateNetwork: false } },
      "oc://policy.jsonc/network/privateNetwork",
    ],
    [
      "network privateNetwork allow string",
      { network: { privateNetwork: { allow: "false" } } },
      "oc://policy.jsonc/network/privateNetwork/allow",
    ],
  ])("reports malformed policy shape for %s", async (_label, policy, target) => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        severity: "error",
        path: "policy.jsonc",
        target,
      }),
    ]);
  });

  it("reports a policy hash mismatch when expectedHash is configured", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [] } }),
      "utf-8",
    );

    const result = await runPolicyChecks(
      ctx(configPath, cfgWithPolicy({ expectedHash: "sha256:not-the-policy" })),
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-hash-mismatch",
        severity: "error",
        path: "policy.jsonc",
      }),
    ]);
  });

  it("does not emit repairable channel findings when the policy hash is not accepted", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ expectedHash: "sha256:not-the-policy", workspaceRepairs: true }),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        channels: {
          denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings.map((finding) => finding.checkId)).toEqual([
      "policy/policy-hash-mismatch",
    ]);
  });

  it("accepts a policy file that matches the configured expectedHash", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const policy = { channels: { denyRules: [] } };
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");

    const result = await runPolicyChecks(
      ctx(configPath, cfgWithPolicy({ expectedHash: policyDocumentHash(policy) })),
    );

    expect(result.findings).toEqual([]);
  });

  it("reports an attestation mismatch when expectedAttestationHash is configured", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [] } }),
      "utf-8",
    );

    const result = await runPolicyChecks(
      ctx(configPath, cfgWithPolicy({ expectedAttestationHash: "sha256:not-current" })),
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/attestation-hash-mismatch",
        severity: "error",
        path: "policy attestation",
      }),
    ]);
  });

  it("reports policy validation errors before attestation drift", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [{ when: {} }] } }),
      "utf-8",
    );

    const result = await runPolicyChecks(
      ctx(configPath, cfgWithPolicy({ expectedAttestationHash: "sha256:not-current" })),
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        target: "oc://policy.jsonc/channels/denyRules/#0",
      }),
    ]);
  });

  it("does not emit repairable channel findings when the accepted attestation changed", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ expectedAttestationHash: "sha256:not-current", workspaceRepairs: true }),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        channels: {
          denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings.map((finding) => finding.checkId)).toEqual([
      "policy/attestation-hash-mismatch",
    ]);
  });

  it("accepts a policy check that matches the configured expectedAttestationHash", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const policy = { channels: { denyRules: [] } };
    const policyHash = policyDocumentHash(policy);
    const acceptedAttestationHash = createPolicyAttestation({
      ok: true,
      checkedAt: "2026-05-10T20:00:00.000Z",
      policyPath: "policy.jsonc",
      policyHash,
      evidence: collectPolicyEvidence({}),
      findings: [],
    }).attestationHash;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");

    const result = await runPolicyChecks(
      ctx(configPath, cfgWithPolicy({ expectedAttestationHash: acceptedAttestationHash })),
    );

    expect(result.findings).toEqual([]);
  });

  it("does not include unrelated TOOLS.md evidence in channel-only attestations", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const policy = { channels: { denyRules: [] } };
    const policyHash = policyDocumentHash(policy);
    const acceptedAttestationHash = createPolicyAttestation({
      ok: true,
      checkedAt: "2026-05-10T20:00:00.000Z",
      policyPath: "policy.jsonc",
      policyHash,
      evidence: collectPolicyEvidence({}),
      findings: [],
    }).attestationHash;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    const result = await runPolicyChecks(
      ctx(configPath, cfgWithPolicy({ expectedAttestationHash: acceptedAttestationHash })),
    );

    expect(result.findings).toEqual([]);
  });

  it("reports configured channels denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: true } },
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

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/channels-denied-provider",
        severity: "error",
        path: "openclaw config",
        ocPath: "oc://openclaw.config/channels/telegram",
        target: "oc://openclaw.config/channels/telegram",
        requirement: "oc://policy.jsonc/channels/denyRules/#0",
        fixHint: "Telegram is not approved for this workspace.",
      }),
    ]);
  });

  it("repairs denied enabled channels by disabling them when workspace repairs are enabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          channels: {
            denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await runDeniedChannelRepair(repairCtx(configPath, cfg));

    expect(result.changes).toEqual(["Disabled channels.telegram.enabled for policy conformance."]);
    expect(result.remainingFindings).toEqual([]);
    expect(result.config.channels?.telegram).toEqual({ enabled: false });
  });

  it("does not repair denied channels without workspace repair opt-in", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: false }),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          channels: {
            denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await runDeniedChannelRepair(repairCtx(configPath, cfg));

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped channel config repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.",
    ]);
    expect(result.config.channels?.telegram).toEqual({ enabled: true });
  });

  it("does not let policy.jsonc enable workspace repairs", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify(
        {
          workspaceRepairs: true,
          channels: {
            denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await runDeniedChannelRepair(repairCtx(configPath, cfg));

    expect(result.changes).toEqual([]);
    expect(result.warnings).toContain(
      "Skipped channel config repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.",
    );
    expect(result.config.channels?.telegram).toEqual({ enabled: true });
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

  it("normalizes model provider refs before deny policy comparison", async () => {
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
        ocPath: "oc://openclaw.config/models/providers/aws-bedrock",
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

  it("normalizes model provider refs before allow policy comparison", async () => {
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

    expect(result.findings).toEqual([]);
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

    const result = await runPolicyDoctorLint(ctx(configPath, cfgWithPolicy({ enabled: undefined })));

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

  it("reports private-network SSRF settings denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      browser: {
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
      },
      tools: {
        web: {
          fetch: {
            ssrfPolicy: {
              allowIpv6UniqueLocalRange: true,
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        network: {
          privateNetwork: { allow: false },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/network-private-access-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
        requirement: "oc://policy.jsonc/network/privateNetwork/allow",
      }),
      expect.objectContaining({
        checkId: "policy/network-private-access-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowIpv6UniqueLocalRange",
        requirement: "oc://policy.jsonc/network/privateNetwork/allow",
      }),
    ]);
  });

  it("allows private-network SSRF settings when policy permits them", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      browser: {
        ssrfPolicy: {
          allowPrivateNetwork: true,
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        network: {
          privateNetwork: { allow: true },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("does not enable model checks from a network-only policy block", async () => {
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
        network: {
          privateNetwork: { allow: false },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports unknown governed tool sensitivity metadata", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { requireMetadata: ["sensitivity"] } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:critical sensitivity:secret\n",
      "utf-8",
    );

    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()), {
      checks: registerChecks(),
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-unknown-sensitivity-token",
        severity: "error",
        path: "TOOLS.md",
        ocPath: "oc://TOOLS.md/tools/deploy",
      }),
    ]);
  });
});
