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
import { clearHealthChecksForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
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
    clearHealthChecksForTest();
    resetPolicyDoctorChecksForTest();
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-doctor-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    clearHealthChecksForTest();
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
      "policy/gateway-non-loopback-bind",
      "policy/gateway-auth-disabled",
      "policy/gateway-rate-limit-missing",
      "policy/gateway-control-ui-insecure",
      "policy/gateway-tailscale-funnel",
      "policy/gateway-remote-enabled",
      "policy/gateway-http-endpoint-enabled",
      "policy/gateway-http-url-fetch-unrestricted",
      "policy/agents-workspace-access-denied",
      "policy/agents-tool-not-denied",
      "policy/tools-profile-unapproved",
      "policy/tools-fs-workspace-only-required",
      "policy/tools-exec-security-unapproved",
      "policy/tools-exec-ask-unapproved",
      "policy/tools-exec-host-unapproved",
      "policy/tools-elevated-enabled",
      "policy/tools-required-deny-missing",
      "policy/secrets-unmanaged-provider",
      "policy/secrets-denied-provider-source",
      "policy/secrets-insecure-provider",
      "policy/auth-profile-invalid-metadata",
      "policy/auth-profile-unapproved-mode",
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
    ["tools profiles array", { tools: { profiles: [] } }, "oc://policy.jsonc/tools/profiles"],

    [
      "tools profiles allow string",
      { tools: { profiles: { allow: "coding" } } },
      "oc://policy.jsonc/tools/profiles/allow",
    ],
    [
      "tools profiles allow invalid",
      { tools: { profiles: { allow: ["mesaging"] } } },
      "oc://policy.jsonc/tools/profiles/allow/#0",
    ],
    [
      "tools exec allowSecurity invalid",
      { tools: { exec: { allowSecurity: ["deny", "sudo"] } } },
      "oc://policy.jsonc/tools/exec/allowSecurity/#1",
    ],
    [
      "tools fs requireWorkspaceOnly string",
      { tools: { fs: { requireWorkspaceOnly: "true" } } },
      "oc://policy.jsonc/tools/fs/requireWorkspaceOnly",
    ],
    [
      "tools elevated allow string",
      { tools: { elevated: { allow: "false" } } },
      "oc://policy.jsonc/tools/elevated/allow",
    ],
    [
      "tools denyTools blank entry",
      { tools: { denyTools: ["exec", " "] } },
      "oc://policy.jsonc/tools/denyTools/#1",
    ],
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
    ["models providers array", { models: { providers: [] } }, "oc://policy.jsonc/models/providers"],
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
    ["gateway array", { gateway: [] }, "oc://policy.jsonc/gateway"],
    ["gateway auth array", { gateway: { auth: [] } }, "oc://policy.jsonc/gateway/auth"],
    [
      "gateway requireAuth string",
      { gateway: { auth: { requireAuth: "true" } } },
      "oc://policy.jsonc/gateway/auth/requireAuth",
    ],
    [
      "gateway requireExplicitRateLimit string",
      { gateway: { auth: { requireExplicitRateLimit: "true" } } },
      "oc://policy.jsonc/gateway/auth/requireExplicitRateLimit",
    ],
    [
      "gateway denyEndpoints string",
      { gateway: { http: { denyEndpoints: "responses" } } },
      "oc://policy.jsonc/gateway/http/denyEndpoints",
    ],
    [
      "gateway denyEndpoints blank entry",
      { gateway: { http: { denyEndpoints: ["responses", " "] } } },
      "oc://policy.jsonc/gateway/http/denyEndpoints/#1",
    ],
    [
      "gateway denyEndpoints unknown entry",
      { gateway: { http: { denyEndpoints: ["responses", "completions"] } } },
      "oc://policy.jsonc/gateway/http/denyEndpoints/#1",
    ],
    [
      "gateway requireUrlAllowlists string",
      { gateway: { http: { requireUrlAllowlists: "true" } } },
      "oc://policy.jsonc/gateway/http/requireUrlAllowlists",
    ],
    ["agents array", { agents: [] }, "oc://policy.jsonc/agents"],
    ["agents workspace array", { agents: { workspace: [] } }, "oc://policy.jsonc/agents/workspace"],
    [
      "agents workspace allowedAccess string",
      { agents: { workspace: { allowedAccess: "ro" } } },
      "oc://policy.jsonc/agents/workspace/allowedAccess",
    ],
    [
      "agents workspace allowedAccess invalid",
      { agents: { workspace: { allowedAccess: ["none", "host"] } } },
      "oc://policy.jsonc/agents/workspace/allowedAccess/#1",
    ],
    [
      "agents workspace denyTools string",
      { agents: { workspace: { denyTools: "exec" } } },
      "oc://policy.jsonc/agents/workspace/denyTools",
    ],
    [
      "agents workspace denyTools unsupported",
      { agents: { workspace: { denyTools: ["exec", "browser"] } } },
      "oc://policy.jsonc/agents/workspace/denyTools/#1",
    ],
    ["secrets array", { secrets: [] }, "oc://policy.jsonc/secrets"],
    ["auth array", { auth: [] }, "oc://policy.jsonc/auth"],
    ["auth profiles array", { auth: { profiles: [] } }, "oc://policy.jsonc/auth/profiles"],
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
      evidence: collectPolicyEvidence(
        {},
        {
          includeGatewayExposure: false,
          includeAgentWorkspace: false,
          includeToolPosture: false,
          includeSecrets: false,
          includeAuthProfiles: false,
        },
      ),
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
      evidence: collectPolicyEvidence(
        {},
        {
          includeGatewayExposure: false,
          includeAgentWorkspace: false,
          includeToolPosture: false,
          includeSecrets: false,
          includeAuthProfiles: false,
        },
      ),
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

  it("does not include unrelated secret or auth evidence in channel-only attestations", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const policy = { channels: { denyRules: [] } };
    const policyHash = policyDocumentHash(policy);
    const acceptedAttestationHash = createPolicyAttestation({
      ok: true,
      checkedAt: "2026-05-10T20:00:00.000Z",
      policyPath: "policy.jsonc",
      policyHash,
      evidence: collectPolicyEvidence(
        {
          secrets: {
            providers: {
              vault: { source: "env" },
            },
          },
          auth: {
            profiles: {
              github: { provider: "github", mode: "token" },
            },
          },
        },
        {
          includeGatewayExposure: false,
          includeAgentWorkspace: false,
          includeToolPosture: false,
          includeSecrets: false,
          includeAuthProfiles: false,
        },
      ),
      findings: [],
    }).attestationHash;
    const cfg = {
      ...cfgWithPolicy({ expectedAttestationHash: acceptedAttestationHash }),
      secrets: {
        providers: {
          changed: { source: "exec", command: "vault" },
        },
      },
      auth: {
        profiles: {
          changed: { provider: "github", mode: "oauth" },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>, {
      includeGatewayExposure: false,
      includeAgentWorkspace: false,
      includeToolPosture: false,
      includeSecrets: false,
      includeAuthProfiles: false,
    });
    expect(evidence).not.toHaveProperty("gatewayExposure");
    expect(evidence).not.toHaveProperty("agentWorkspace");
    expect(evidence).not.toHaveProperty("secrets");
    expect(evidence).not.toHaveProperty("authProfiles");
  });

  it("includes global and per-agent alsoAllow in tool posture attestations", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const policy = { tools: { profiles: { allow: ["messaging"] } } };
    const baselineConfig = {
      tools: { profile: "messaging" },
      agents: {
        list: [
          {
            id: "reviewer",
            tools: { profile: "messaging" },
          },
        ],
      },
    };
    const acceptedAttestationHash = createPolicyAttestation({
      ok: true,
      checkedAt: "2026-05-10T20:00:00.000Z",
      policyPath: "policy.jsonc",
      policyHash: policyDocumentHash(policy),
      evidence: collectPolicyEvidence(baselineConfig),
      findings: [],
    }).attestationHash;
    const cfg = {
      ...cfgWithPolicy({ expectedAttestationHash: acceptedAttestationHash }),
      tools: { profile: "messaging", alsoAllow: ["exec"] },
      agents: {
        list: [
          {
            id: "reviewer",
            tools: { profile: "messaging", alsoAllow: ["write"] },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-alsoAllow",
          kind: "alsoAllow",
          entries: ["exec"],
          source: "oc://openclaw.config/tools/alsoAllow",
        }),
        expect.objectContaining({
          id: "reviewer-alsoAllow",
          kind: "alsoAllow",
          entries: ["write"],
          source: "oc://openclaw.config/agents/list/#0/tools/alsoAllow",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/attestation-hash-mismatch",
        }),
      ]),
    );
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

  it("reports secret provider conformance findings without leaking secret values", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      secrets: {
        providers: {
          vault: { source: "file", path: ".secrets.json", allowInsecurePath: true },
          command: { source: "exec", command: "vault", args: ["read", "openai/api-key"] },
        },
      },
      models: {
        providers: {
          anthropic: { apiKey: { source: "env", provider: "missing", id: "ANTHROPIC_API_KEY" } },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        secrets: {
          requireManagedProviders: true,
          denySources: ["exec"],
          allowInsecureProviders: false,
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(JSON.stringify(evidence)).not.toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(result.findings)).not.toContain("ANTHROPIC_API_KEY");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          severity: "error",
          ocPath: "oc://openclaw.config/models/providers/anthropic/apiKey",
          requirement: "oc://policy.jsonc/secrets/requireManagedProviders",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          severity: "error",
          ocPath: "oc://openclaw.config/secrets/providers/command",
          requirement: "oc://policy.jsonc/secrets/denySources",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-insecure-provider",
          severity: "error",
          ocPath: "oc://openclaw.config/secrets/providers/vault",
          requirement: "oc://policy.jsonc/secrets/allowInsecureProviders",
        }),
      ]),
    );
    expect(result.findings).toHaveLength(3);
  });

  it("checks managed providers for structured provider request SecretRefs", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const baseCfg = cfgWithPolicy();
    const cfg = {
      ...baseCfg,
      models: {
        providers: {
          openai: {
            request: {
              auth: {
                mode: "authorization-bearer",
                token: { source: "exec", provider: "rogue", id: "openai/bearer-token" },
              },
              tls: {
                passphrase: { source: "exec", provider: "rogue", id: "tls/passphrase" },
              },
            },
          },
          "z.ai": {
            headers: {
              Authorization: { source: "exec", provider: "rogue", id: "zai/authorization" },
            },
          },
        },
      },
      tools: {
        media: {
          models: [
            {
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: { source: "exec", provider: "rogue", id: "media/shared-token" },
                },
                tls: {
                  key: { source: "exec", provider: "rogue", id: "media/tls/key" },
                },
              },
            },
          ],
          audio: {
            request: {
              auth: {
                mode: "authorization-bearer",
                token: { source: "exec", provider: "rogue", id: "media/audio-token" },
              },
            },
          },
          image: {
            models: [
              {
                request: {
                  auth: {
                    mode: "authorization-bearer",
                    token: { source: "exec", provider: "rogue", id: "media/image-token" },
                  },
                },
              },
            ],
          },
        },
      },
      plugins: {
        ...baseCfg.plugins,
        entries: {
          ...baseCfg.plugins?.entries,
          acpx: {
            config: {
              mcpServers: {
                github: {
                  env: {
                    GITHUB_TOKEN: { source: "exec", provider: "rogue", id: "github/token" },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        secrets: {
          requireManagedProviders: true,
          denySources: ["exec"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.secrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/models/providers/openai/request/auth/token",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/models/providers/openai/request/tls/passphrase",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: 'oc://openclaw.config/models/providers/"z.ai"/headers/Authorization',
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source:
            "oc://openclaw.config/plugins/entries/acpx/config/mcpServers/github/env/GITHUB_TOKEN",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/tools/media/models/#0/request/auth/token",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/tools/media/models/#0/request/tls/key",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/tools/media/audio/request/auth/token",
        }),
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "exec",
          refProvider: "rogue",
          source: "oc://openclaw.config/tools/media/image/models/#0/request/auth/token",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/models/providers/openai/request/auth/token",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          ocPath: "oc://openclaw.config/models/providers/openai/request/auth/token",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/models/providers/openai/request/tls/passphrase",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          ocPath: "oc://openclaw.config/models/providers/openai/request/tls/passphrase",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: 'oc://openclaw.config/models/providers/"z.ai"/headers/Authorization',
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          ocPath:
            "oc://openclaw.config/plugins/entries/acpx/config/mcpServers/github/env/GITHUB_TOKEN",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/tools/media/models/#0/request/auth/token",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          ocPath: "oc://openclaw.config/tools/media/audio/request/auth/token",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/tools/media/image/models/#0/request/auth/token",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/tools/media/models/#0/request/tls/key",
        }),
      ]),
    );
  });

  it("honors configured secret default providers when checking managed providers", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      secrets: {
        defaults: {
          env: "vault",
        },
        providers: {
          vault: { source: "env" },
        },
      },
      models: {
        providers: {
          openai: { apiKey: "$OPENAI_API_KEY" },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        secrets: {
          requireManagedProviders: true,
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.secrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "input",
          provenance: "secretRef",
          refSource: "env",
          refProvider: "vault",
          source: "oc://openclaw.config/models/providers/openai/apiKey",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("reports SecretRefs that use a managed provider alias with the wrong source", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      secrets: {
        providers: {
          vault: { source: "file", path: ".secrets.json" },
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: { source: "env", provider: "vault", id: "OPENAI_API_KEY" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        secrets: {
          requireManagedProviders: true,
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/secrets-unmanaged-provider",
        severity: "error",
        ocPath: "oc://openclaw.config/models/providers/openai/apiKey",
        requirement: "oc://policy.jsonc/secrets/requireManagedProviders",
      }),
    ]);
  });

  it("does not treat raw MCP env values as SecretRefs", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      mcp: {
        servers: {
          "corp.github": {
            env: {
              APP_ID: "$GITHUB_APP_ID",
              GITHUB_TOKEN: "$GITHUB_TOKEN",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        secrets: {
          requireManagedProviders: true,
          denySources: ["env"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.secrets).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("checks configured channel encryptKey SecretRefs", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: {
        feishu: {
          encryptKey: { source: "exec", provider: "rogue", id: "feishu/encrypt-key" },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        secrets: {
          requireManagedProviders: true,
          denySources: ["exec"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/channels/feishu/encryptKey",
        }),
        expect.objectContaining({
          checkId: "policy/secrets-denied-provider-source",
          ocPath: "oc://openclaw.config/channels/feishu/encryptKey",
        }),
      ]),
    );
  });

  it("reports agent workspace posture denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["write", "edit"],
      },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "rw" },
        },
        list: [
          {
            id: "reviewer",
            sandbox: { workspaceAccess: "ro" },
            tools: { deny: ["group:fs", "group:runtime"] },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        agents: {
          workspace: {
            allowedAccess: ["none", "ro"],
            denyTools: ["exec", "process", "write", "edit", "apply_patch"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.agentWorkspace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agents-defaults-workspace-access",
          kind: "workspaceAccess",
          value: "rw",
          sandboxMode: "all",
          sandboxEnabled: true,
          source: "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
        }),
        expect.objectContaining({
          id: "reviewer-tool-apply_patch",
          kind: "toolDeny",
          tool: "apply_patch",
          denied: true,
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/agents-workspace-access-denied",
          severity: "error",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/agents-tool-not-denied",
          severity: "error",
          ocPath: "oc://openclaw.config/tools/deny",
          requirement: "oc://policy.jsonc/agents/workspace/denyTools",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/agents-tool-not-denied",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/deny",
        }),
      ]),
    );
  });

  it("accepts sandbox-scoped tool denies for read-only agent workspace policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        sandbox: { tools: { deny: ["group:runtime", "group:fs"] } },
      },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "ro" },
        },
        list: [
          {
            id: "locked",
            sandbox: { workspaceAccess: "none" },
            tools: { sandbox: { tools: { deny: ["group:runtime", "group:fs"] } } },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        agents: {
          workspace: {
            allowedAccess: ["none", "ro"],
            denyTools: ["exec", "process", "write", "edit", "apply_patch"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.agentWorkspace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agents-defaults-tool-exec",
          denied: true,
          source: "oc://openclaw.config/tools/sandbox/tools/deny",
        }),
        expect.objectContaining({
          id: "locked-tool-apply_patch",
          denied: true,
          source: "oc://openclaw.config/agents/list/#0/tools/sandbox/tools/deny",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("accepts runtime tool deny globs for agent workspace policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["e*"],
      },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "ro" },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        agents: {
          workspace: {
            allowedAccess: ["ro"],
            denyTools: ["exec"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports sandbox tool deny overrides outside policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        sandbox: { tools: { deny: ["exec"] } },
      },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "ro" },
        },
        list: [
          {
            id: "locked",
            sandbox: { workspaceAccess: "none" },
            tools: { sandbox: { tools: { deny: ["group:fs"] } } },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        agents: {
          workspace: {
            allowedAccess: ["none", "ro"],
            denyTools: ["exec"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/agents-tool-not-denied",
        message: "agent 'locked' does not deny required tool 'exec'.",
        ocPath: "oc://openclaw.config/agents/list/#0/tools/deny",
        requirement: "oc://policy.jsonc/agents/workspace/denyTools",
      }),
    ]);
  });

  it("accepts read-only agent workspace policy with group denies", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["group:runtime", "group:fs"],
      },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "ro" },
        },
        list: [
          {
            id: "locked",
            sandbox: { workspaceAccess: "none" },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        agents: {
          workspace: {
            allowedAccess: ["none", "ro"],
            denyTools: ["exec", "process", "write", "edit", "apply_patch"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports read-only workspace policy when sandbox mode skips the main session", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        sandbox: { tools: { deny: ["exec"] } },
      },
      agents: {
        defaults: {
          sandbox: { mode: "non-main", workspaceAccess: "ro" },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        agents: {
          workspace: {
            allowedAccess: ["ro"],
            denyTools: ["exec"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/agents-workspace-access-denied",
          message: "agents.defaults sandbox mode 'non-main' is not allowed by policy.",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/mode",
          requirement: "oc://policy.jsonc/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/agents-tool-not-denied",
          message: "agents.defaults does not deny required tool 'exec'.",
          ocPath: "oc://openclaw.config/tools/deny",
          requirement: "oc://policy.jsonc/agents/workspace/denyTools",
        }),
      ]),
    );
  });

  it("reports read-only workspace policy when sandbox mode is disabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["group:runtime", "group:fs"],
      },
      agents: {
        defaults: {
          sandbox: { workspaceAccess: "ro" },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        agents: {
          workspace: {
            allowedAccess: ["none", "ro"],
            denyTools: ["exec", "process", "write", "edit", "apply_patch"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/agents-workspace-access-denied",
        message: "agents.defaults sandbox mode 'off' is not allowed by policy.",
        ocPath: "oc://openclaw.config/agents/defaults/sandbox/mode",
        requirement: "oc://policy.jsonc/agents/workspace/allowedAccess",
      }),
    ]);
  });

  it("reports tool posture denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        profile: "coding",
        deny: ["write"],
        exec: { security: "full", ask: "off", host: "gateway" },
        fs: { workspaceOnly: false },
        elevated: { enabled: true, allowFrom: { whatsapp: ["+15550000001", 15550000002] } },
      },
      agents: {
        list: [
          {
            id: "reviewer",
            tools: {
              profile: "messaging",
              deny: ["group:runtime", "group:fs"],
              exec: { security: "deny", ask: "always", host: "sandbox" },
              fs: { workspaceOnly: true },
              elevated: { enabled: false },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          profiles: { allow: ["messaging", "minimal"] },
          fs: { requireWorkspaceOnly: true },
          exec: {
            allowSecurity: ["deny", "allowlist"],
            requireAsk: ["always"],
            allowHosts: ["sandbox"],
          },
          elevated: { allow: false },
          denyTools: ["exec", "write", "edit", "apply_patch"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-profile",
          kind: "profile",
          value: "coding",
          source: "oc://openclaw.config/tools/profile",
        }),
        expect.objectContaining({
          id: "reviewer-exec-security",
          kind: "execSecurity",
          value: "deny",
          source: "oc://openclaw.config/agents/list/#0/tools/exec/security",
        }),
        expect.objectContaining({
          id: "tools-elevated-allow-from-whatsapp",
          kind: "elevatedAllowFrom",
          entries: ["+15550000001", "15550000002"],
          source: "oc://openclaw.config/tools/elevated/allowFrom/whatsapp",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-profile-unapproved",
          severity: "error",
          ocPath: "oc://openclaw.config/tools/profile",
          requirement: "oc://policy.jsonc/tools/profiles/allow",
        }),
        expect.objectContaining({
          checkId: "policy/tools-fs-workspace-only-required",
          ocPath: "oc://openclaw.config/tools/fs/workspaceOnly",
          requirement: "oc://policy.jsonc/tools/fs/requireWorkspaceOnly",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-security-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/security",
          requirement: "oc://policy.jsonc/tools/exec/allowSecurity",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-ask-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/ask",
          requirement: "oc://policy.jsonc/tools/exec/requireAsk",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/host",
          requirement: "oc://policy.jsonc/tools/exec/allowHosts",
        }),
        expect.objectContaining({
          checkId: "policy/tools-elevated-enabled",
          ocPath: "oc://openclaw.config/tools/elevated/enabled",
          requirement: "oc://policy.jsonc/tools/elevated/allow",
        }),
        expect.objectContaining({
          checkId: "policy/tools-required-deny-missing",
          ocPath: "oc://openclaw.config/tools/deny",
          requirement: "oc://policy.jsonc/tools/denyTools",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-required-deny-missing",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/deny",
        }),
      ]),
    );
  });

  it("accepts configured tool posture that matches policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        profile: "messaging",
        deny: ["group:runtime", "group:fs"],
        exec: { security: "deny", ask: "always", host: "sandbox" },
        fs: { workspaceOnly: true },
        elevated: { enabled: false },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          profiles: { allow: ["messaging", "minimal"] },
          fs: { requireWorkspaceOnly: true },
          exec: {
            allowSecurity: ["deny"],
            requireAsk: ["always"],
            allowHosts: ["sandbox"],
          },
          elevated: { allow: false },
          denyTools: ["exec", "write", "edit", "apply_patch"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("uses config-level exec defaults and normalizes required deny aliases", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["exec", "apply_patch"],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: {
            allowSecurity: ["deny"],
            requireAsk: ["always"],
            allowHosts: ["auto"],
          },
          denyTools: ["bash", "apply-patch"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-exec-security-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/security",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-ask-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/ask",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-required-deny-missing",
        }),
      ]),
    );
  });

  it("accepts omitted exec defaults and individual denies for required deny groups", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["exec", "process", "code_execution", "read", "write", "edit", "apply_patch"],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: {
            allowSecurity: ["full"],
            requireAsk: ["off"],
            allowHosts: ["auto"],
          },
          denyTools: ["group:runtime", "group:fs"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("accepts wildcard tool denies for required tool posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["web_*"],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          denyTools: ["web_search"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("accepts canonical tool groups for required tool denies", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        deny: ["group:openclaw"],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          denyTools: ["message"],
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-deny",
          kind: "deny",
          entries: ["group:openclaw"],
          source: "oc://openclaw.config/tools/deny",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("treats globally disabled elevated mode as disabling per-agent elevated posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        elevated: { enabled: false },
      },
      agents: {
        list: [
          {
            id: "reviewer",
            tools: {
              elevated: { enabled: true },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          elevated: { allow: false },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reviewer-elevated-enabled",
          kind: "elevatedEnabled",
          value: false,
          source: "oc://openclaw.config/tools/elevated/enabled",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("treats omitted tool profile as full posture for profile allow policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = cfgWithPolicy();
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          profiles: { allow: ["messaging"] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-profile-unapproved",
        ocPath: "oc://openclaw.config/tools/profile",
        requirement: "oc://policy.jsonc/tools/profiles/allow",
      }),
    ]);
  });

  it("uses deny as the omitted exec security default for explicit sandbox host", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        exec: { host: "sandbox" },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: {
            allowSecurity: ["deny"],
            allowHosts: ["sandbox"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-exec-security",
          kind: "execSecurity",
          value: "deny",
          source: "oc://openclaw.config/tools/exec/security",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("uses deny as the omitted exec security default for auto host when sandbox can apply", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: { mode: "all" },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: {
            allowSecurity: ["deny"],
            allowHosts: ["auto"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-exec-security",
          kind: "execSecurity",
          value: "deny",
          source: "oc://openclaw.config/tools/exec/security",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("keeps omitted auto-host exec security full when sandbox is non-main only", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: { mode: "non-main" },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: {
            allowSecurity: ["deny"],
            allowHosts: ["auto"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.toolPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tools-exec-security",
          kind: "execSecurity",
          value: "full",
          source: "oc://openclaw.config/tools/exec/security",
        }),
      ]),
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-exec-security-unapproved",
        ocPath: "oc://openclaw.config/tools/exec/security",
        requirement: "oc://policy.jsonc/tools/exec/allowSecurity",
      }),
    ]);
  });

  it("reports gateway exposure settings denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        bind: "lan",
        auth: { mode: "none" },
        controlUi: {
          allowInsecureAuth: true,
          dangerouslyDisableDeviceAuth: true,
          dangerouslyAllowHostHeaderOriginFallback: true,
        },
        tailscale: { mode: "funnel" },
        mode: "remote",
        http: {
          endpoints: {
            chatCompletions: {
              enabled: true,
              images: { allowUrl: true },
            },
            responses: {
              enabled: true,
              files: { allowUrl: true },
              images: { allowUrl: true, urlAllowlist: ["images.example.test"] },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
            allowTailscaleFunnel: false,
          },
          auth: {
            requireAuth: true,
            requireExplicitRateLimit: true,
          },
          controlUi: {
            allowInsecure: false,
          },
          remote: {
            allow: false,
          },
          http: {
            denyEndpoints: ["chatCompletions", "responses"],
            requireUrlAllowlists: true,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/gateway-non-loopback-bind",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/bind",
          requirement: "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-auth-disabled",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/auth/mode",
          requirement: "oc://policy.jsonc/gateway/auth/requireAuth",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-rate-limit-missing",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/auth/rateLimit",
          requirement: "oc://policy.jsonc/gateway/auth/requireExplicitRateLimit",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-control-ui-insecure",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/controlUi/allowInsecureAuth",
          requirement: "oc://policy.jsonc/gateway/controlUi/allowInsecure",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-tailscale-funnel",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/tailscale/mode",
          requirement: "oc://policy.jsonc/gateway/exposure/allowTailscaleFunnel",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-remote-enabled",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/mode",
          requirement: "oc://policy.jsonc/gateway/remote/allow",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-endpoint-enabled",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/chatCompletions/enabled",
          requirement: "oc://policy.jsonc/gateway/http/denyEndpoints",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/chatCompletions/images/allowUrl",
          requirement: "oc://policy.jsonc/gateway/http/requireUrlAllowlists",
        }),
      ]),
    );
    expect(result.findings).toHaveLength(12);
  });

  it("reports omitted gateway bind when non-loopback exposure is denied", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {},
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-non-loopback-bind",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/bind",
        requirement: "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind",
      }),
    ]);
  });

  it("does not report omitted gateway bind when Tailscale forces loopback", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        tailscale: { mode: "serve" },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports preserved Tailscale Funnel routes when policy denies Funnel exposure", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        tailscale: { mode: "serve", preserveFunnel: true },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowTailscaleFunnel: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-tailscale-funnel",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/tailscale/preserveFunnel",
        requirement: "oc://policy.jsonc/gateway/exposure/allowTailscaleFunnel",
      }),
    ]);
  });

  it("reports missing gateway rate limits when gateway config is omitted", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          auth: {
            requireExplicitRateLimit: true,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-rate-limit-missing",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/auth/rateLimit",
        requirement: "oc://policy.jsonc/gateway/auth/requireExplicitRateLimit",
      }),
    ]);
  });

  it("does not report inactive custom bind hosts", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        bind: "loopback",
        customBindHost: "0.0.0.0",
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("does not report loopback custom bind hosts", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        bind: "custom",
        customBindHost: "127.0.0.1",
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports valid non-loopback custom bind hosts", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        bind: "custom",
        customBindHost: "192.168.1.20",
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-non-loopback-bind",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/customBindHost",
        requirement: "oc://policy.jsonc/gateway/exposure/allowNonLoopbackBind",
      }),
    ]);
  });

  it("does not report blank custom bind config as active non-loopback exposure", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        bind: "custom",
        customBindHost: "   ",
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          exposure: {
            allowNonLoopbackBind: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it.each(["localhost", "::1", "192.168.001.20"])(
    "does not report invalid custom bind host %s as active non-loopback exposure",
    async (customBindHost) => {
      const configPath = join(workspaceDir, "openclaw.jsonc");
      const cfg = {
        ...cfgWithPolicy(),
        gateway: {
          bind: "custom",
          customBindHost,
        },
      } as unknown as OpenClawConfig;
      await fs.writeFile(configPath, "{}", "utf-8");
      await fs.writeFile(
        join(workspaceDir, "policy.jsonc"),
        JSON.stringify({
          gateway: {
            exposure: {
              allowNonLoopbackBind: false,
            },
          },
        }),
        "utf-8",
      );

      registerPolicyDoctorChecks();
      const result = await runDoctorLintChecks(ctx(configPath, cfg));

      expect(result.findings).toEqual([]);
    },
  );

  it("reports configured gateway remote URLs when remote mode is active", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://remote.example.test:18789",
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          remote: {
            allow: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/gateway-remote-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/mode",
        requirement: "oc://policy.jsonc/gateway/remote/allow",
      }),
      expect.objectContaining({
        checkId: "policy/gateway-remote-enabled",
        severity: "error",
        ocPath: "oc://openclaw.config/gateway/remote/url",
        requirement: "oc://policy.jsonc/gateway/remote/allow",
      }),
    ]);
  });

  it("does not report inert remote config outside remote mode", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        remote: {
          enabled: true,
          url: "wss://remote.example.test:18789",
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          remote: {
            allow: false,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports default Responses URL fetching without allowlists", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        http: {
          endpoints: {
            responses: {
              enabled: true,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          http: {
            requireUrlAllowlists: true,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/files/allowUrl",
          requirement: "oc://policy.jsonc/gateway/http/requireUrlAllowlists",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          severity: "error",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/images/allowUrl",
          requirement: "oc://policy.jsonc/gateway/http/requireUrlAllowlists",
        }),
      ]),
    );
    expect(result.findings).toHaveLength(2);
  });

  it("reports wildcard Responses URL allowlists as unrestricted", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        http: {
          endpoints: {
            responses: {
              enabled: true,
              files: { urlAllowlist: ["*"] },
              images: { urlAllowlist: ["*."] },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          http: {
            requireUrlAllowlists: true,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/files/allowUrl",
        }),
        expect.objectContaining({
          checkId: "policy/gateway-http-url-fetch-unrestricted",
          ocPath: "oc://openclaw.config/gateway/http/endpoints/responses/images/allowUrl",
        }),
      ]),
    );
    expect(result.findings).toHaveLength(2);
  });

  it("does not report Responses URL fetching when it is disabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      gateway: {
        http: {
          endpoints: {
            responses: {
              enabled: true,
              files: { allowUrl: false },
              images: { allowUrl: false },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: {
          http: {
            requireUrlAllowlists: true,
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports auth profiles missing required metadata or using unapproved modes", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      auth: {
        profiles: {
          missingMode: { provider: "github" },
          oauth: { provider: "github", mode: "oauth" },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        auth: {
          profiles: { requireMetadata: ["provider", "mode"], allowModes: ["api_key", "token"] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/auth-profile-invalid-metadata",
        severity: "error",
        ocPath: "oc://openclaw.config/auth/profiles/missingMode",
        requirement: "oc://policy.jsonc/auth/profiles/requireMetadata",
      }),
      expect.objectContaining({
        checkId: "policy/auth-profile-unapproved-mode",
        severity: "error",
        ocPath: "oc://openclaw.config/auth/profiles/oauth",
        requirement: "oc://policy.jsonc/auth/profiles/allowModes",
      }),
    ]);
  });

  it("reports malformed secrets policy values before applying secrets checks", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        secrets: {
          requireManagedProviders: "yes",
          denySources: "exec",
          allowInsecureProviders: "false",
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/secrets/requireManagedProviders",
        }),
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/secrets/denySources",
        }),
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/secrets/allowInsecureProviders",
        }),
      ]),
    );
  });

  it("keeps secret conformance checks active when auth policy shape is invalid", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      models: {
        providers: {
          openai: {
            apiKey: { source: "exec", provider: "rogue", id: "openai/api-key" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        secrets: {
          requireManagedProviders: true,
        },
        auth: {
          profiles: {
            allowModes: "token",
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/secrets-unmanaged-provider",
          ocPath: "oc://openclaw.config/models/providers/openai/apiKey",
        }),
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/auth/profiles/allowModes",
        }),
      ]),
    );
  });

  it("reports blank secrets deny source policy entries", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ secrets: { denySources: ["exec", " "] } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        target: "oc://policy.jsonc/secrets/denySources/#1",
      }),
    ]);
  });

  it("reports malformed auth profile policy values", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        auth: {
          profiles: {
            requireMetadata: ["provider", ""],
            allowModes: ["api_key", "unsupported"],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/auth/profiles/requireMetadata/#1",
        }),
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/auth/profiles/allowModes/#1",
        }),
      ]),
    );
  });

  it("reports non-array auth mode allowlists", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ auth: { profiles: { allowModes: "token" } } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        target: "oc://policy.jsonc/auth/profiles/allowModes",
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
