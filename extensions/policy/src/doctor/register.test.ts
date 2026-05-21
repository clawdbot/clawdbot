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

  it("does not run channel checks for an empty category namespace", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: {} }),
      "utf-8",
    );

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
