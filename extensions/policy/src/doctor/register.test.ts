// Policy tests cover register plugin behavior.
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
  scanPolicyIngress,
  scanPolicyMcpServers,
} from "../policy-state.js";
import {
  POLICY_RULE_METADATA,
  isPolicyValueAtLeastAsStrict,
  registerPolicyDoctorChecks,
  resetPolicyDoctorChecksForTest,
  type PolicyRuleMetadata,
} from "./register.js";

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

  it("describes strictness for agent-scoped policy fields", () => {
    expect(
      (POLICY_RULE_METADATA as readonly PolicyRuleMetadata[])
        .filter(
          (rule) =>
            rule.scopeSelectors?.includes("agentIds") ||
            rule.scopeSelectors?.includes("channelIds"),
        )
        .map((rule) => {
          const description: {
            path: string;
            strictness: PolicyRuleMetadata["strictness"];
            selectors: PolicyRuleMetadata["scopeSelectors"];
            emptyList?: PolicyRuleMetadata["emptyList"];
          } = {
            path: rule.policyPath.join("."),
            strictness: rule.strictness,
            selectors: rule.scopeSelectors,
          };
          if (rule.emptyList !== undefined) {
            description.emptyList = rule.emptyList;
          }
          return description;
        }),
    ).toEqual([
      {
        path: "agents.workspace.allowedAccess",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "agents.workspace.denyTools",
        strictness: "denylist-superset",
        selectors: ["agentIds"],
      },
      {
        path: "tools.profiles.allow",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "tools.fs.requireWorkspaceOnly",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "tools.exec.allowSecurity",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "tools.exec.requireAsk",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "tools.exec.allowHosts",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      { path: "tools.elevated.allow", strictness: "requires-false", selectors: ["agentIds"] },
      {
        path: "tools.alsoAllow.expected",
        strictness: "exact-list",
        emptyList: "meaningful",
        selectors: ["agentIds"],
      },
      { path: "tools.denyTools", strictness: "denylist-superset", selectors: ["agentIds"] },
      {
        path: "sandbox.requireMode",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.allowBackends",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyHostNetwork",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyContainerNamespaceJoin",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.requireReadOnlyMounts",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyContainerRuntimeSocketMounts",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyUnconfinedProfiles",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.browser.requireCdpSourceRange",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "ingress.channels.allowDmPolicies",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["channelIds"],
      },
      {
        path: "ingress.channels.denyOpenGroups",
        strictness: "requires-true",
        selectors: ["channelIds"],
      },
      {
        path: "ingress.channels.requireMentionInGroups",
        strictness: "requires-true",
        selectors: ["channelIds"],
      },
      {
        path: "dataHandling.memory.denySessionTranscriptIndexing",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
    ]);
  });

  it("compares policy values through strictness metadata", () => {
    const allowHosts = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "tools.exec.allowHosts",
    );
    const denyTools = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "tools.denyTools",
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

    expect(allowHosts).toBeDefined();
    expect(denyTools).toBeDefined();
    expect(fsWorkspaceOnly).toBeDefined();
    expect(denyHostNetwork).toBeDefined();
    expect(alsoAllow).toBeDefined();
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, ["sandbox"], ["sandbox", "node"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, ["sandbox", "node"], ["sandbox"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, [], ["sandbox"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, ["sandbox"], [])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["exec", "write"], ["exec"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["write"], ["exec"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["group:runtime"], ["exec"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["exec"], ["group:runtime"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(denyHostNetwork!, true, true)).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyHostNetwork!, false, true)).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(fsWorkspaceOnly!, true, true)).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(fsWorkspaceOnly!, false, true)).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(alsoAllow!, ["read"], ["read"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(alsoAllow!, [], ["read"])).toBe(false);
  });

  it("allows scoped overrides that are stricter than top-level policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { exec: { allowHosts: ["sandbox", "node"] } },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ checkId: "policy/policy-jsonc-invalid" })]),
    );
  });

  it("allows scoped allowlists when an empty top-level allowlist is disabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { exec: { allowHosts: [] } },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ checkId: "policy/policy-jsonc-invalid" })]),
    );
  });

  it("allows scoped denyTools groups that cover top-level required denies", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { denyTools: ["exec"] },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: { denyTools: ["group:runtime"] },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ checkId: "policy/policy-jsonc-invalid" })]),
    );
  });

  it("allows scoped sandbox container requirements that match top-level policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: { containers: { denyHostNetwork: true } },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            sandbox: { containers: { denyHostNetwork: true } },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ checkId: "policy/policy-jsonc-invalid" })]),
    );
  });

  it("rejects scoped sandbox container policies weaker than top-level requirements", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: { containers: { denyHostNetwork: true } },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            sandbox: { containers: { denyHostNetwork: false } },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/scopes/sebby/sandbox/containers/denyHostNetwork",
        }),
      ]),
    );
  });

  it("rejects scoped overrides that are weaker than top-level policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { exec: { allowHosts: ["sandbox"] } },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: { exec: { allowHosts: ["sandbox", "node"] } },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/scopes/sebby/tools/exec/allowHosts",
        }),
      ]),
    );
  });

  it("allows overlapping scoped fields when later scopes are stricter", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          team: {
            agentIds: ["sebby"],
            tools: { exec: { allowHosts: ["sandbox", "node"] } },
          },
          lockdown: {
            agentIds: ["sebby"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ checkId: "policy/policy-jsonc-invalid" })]),
    );
  });

  it("rejects overlapping scoped fields when later scopes are weaker", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          lockdown: {
            agentIds: ["sebby"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
          team: {
            agentIds: ["sebby"],
            tools: { exec: { allowHosts: ["sandbox", "node"] } },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/scopes/team/tools/exec/allowHosts",
        }),
      ]),
    );
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
      "policy/ingress-dm-policy-unapproved",
      "policy/ingress-dm-scope-unapproved",
      "policy/ingress-open-groups-denied",
      "policy/ingress-group-mention-required",
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
      "policy/tools-also-allow-missing",
      "policy/tools-also-allow-unexpected",
      "policy/tools-required-deny-missing",
      "policy/sandbox-mode-unapproved",
      "policy/sandbox-backend-unapproved",
      "policy/sandbox-container-posture-unobservable",
      "policy/sandbox-container-host-network-denied",
      "policy/sandbox-container-namespace-join-denied",
      "policy/sandbox-container-mount-mode-required",
      "policy/sandbox-container-runtime-socket-mount",
      "policy/sandbox-container-unconfined-profile",
      "policy/sandbox-browser-cdp-source-range-missing",
      "policy/data-handling-redaction-disabled",
      "policy/data-handling-telemetry-content-capture",
      "policy/data-handling-session-retention-not-enforced",
      "policy/data-handling-session-transcript-memory-enabled",
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
      "tools alsoAllow array",
      { tools: { alsoAllow: ["read"] } },
      "oc://policy.jsonc/tools/alsoAllow",
    ],
    [
      "tools denyTools blank entry",
      { tools: { denyTools: ["exec", " "] } },
      "oc://policy.jsonc/tools/denyTools/#1",
    ],
    ["scopes array", { scopes: [] }, "oc://policy.jsonc/scopes"],
    [
      "scopes unsupported section for agentIds selector",
      { scopes: { sebby: { agentIds: ["sebby"], channels: {} } } },
      "oc://policy.jsonc/scopes/sebby/channels",
    ],
    ["scopes named scope array", { scopes: { coding: [] } }, "oc://policy.jsonc/scopes/coding"],
    [
      "scopes agent missing agentIds",
      { scopes: { coding: { tools: { exec: { allowHosts: ["sandbox"] } } } } },
      "oc://policy.jsonc/scopes/coding",
    ],
    [
      "scopes agent empty agentIds",
      { scopes: { coding: { agentIds: [] } } },
      "oc://policy.jsonc/scopes/coding/agentIds",
    ],
    [
      "scopes agent duplicate normalized agentIds",
      { scopes: { coding: { agentIds: ["Sebby", "sebby"] } } },
      "oc://policy.jsonc/scopes/coding/agentIds/#1",
    ],
    [
      "scopes agent workspace invalid access",
      {
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            agents: { workspace: { allowedAccess: ["readonly"] } },
          },
        },
      },
      "oc://policy.jsonc/scopes/sebby/agents/workspace/allowedAccess/#0",
    ],
    [
      "scopes agent tools exec allowHosts invalid",
      {
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: { exec: { allowHosts: ["shell"] } },
          },
        },
      },
      "oc://policy.jsonc/scopes/sebby/tools/exec/allowHosts/#0",
    ],
    [
      "scopes agent tools unsupported top-level key",
      {
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: { requireMetadata: ["owner"] },
          },
        },
      },
      "oc://policy.jsonc/scopes/sebby/tools/requireMetadata",
    ],
    [
      "scopes agent tools unsupported nested key",
      {
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: { exec: { requireMetadata: ["owner"] } },
          },
        },
      },
      "oc://policy.jsonc/scopes/sebby/tools/exec/requireMetadata",
    ],
    [
      "scopes agent tools alsoAllow expected invalid",
      {
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: { alsoAllow: { expected: ["read", ""] } },
          },
        },
      },
      "oc://policy.jsonc/scopes/sebby/tools/alsoAllow/expected/#1",
    ],
    [
      "scopes agent tools alsoAllow array",
      {
        scopes: {
          sebby: { agentIds: ["sebby"], tools: { alsoAllow: ["read"] } },
        },
      },
      "oc://policy.jsonc/scopes/sebby/tools/alsoAllow",
    ],
    [
      "scopes agent quoted segment tools invalid",
      {
        scopes: {
          "team/sebby": { agentIds: ["team/sebby"], tools: { exec: { allowHosts: ["shell"] } } },
        },
      },
      'oc://policy.jsonc/scopes/"team/sebby"/tools/exec/allowHosts/#0',
    ],
    [
      "scopes agent sandbox unsupported container key",
      {
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            sandbox: { containers: { denyNetwork: true } },
          },
        },
      },
      "oc://policy.jsonc/scopes/sebby/sandbox/containers/denyNetwork",
    ],
    [
      "scopes agent unsupported section",
      {
        scopes: {
          sebby: { agentIds: ["sebby"], ingress: { allow: true } },
        },
      },
      "oc://policy.jsonc/scopes/sebby/ingress",
    ],
    [
      "scopes channel ingress allowDmPolicies invalid",
      {
        scopes: {
          telegramIngress: {
            channelIds: ["telegram"],
            ingress: { channels: { allowDmPolicies: ["public"] } },
          },
        },
      },
      "oc://policy.jsonc/scopes/telegramIngress/ingress/channels/allowDmPolicies/#0",
    ],
    [
      "scopes channel ingress session unsupported",
      {
        scopes: {
          telegramIngress: {
            channelIds: ["telegram"],
            ingress: { session: { requireDmScope: "per-channel-peer" } },
          },
        },
      },
      "oc://policy.jsonc/scopes/telegramIngress/ingress/session",
    ],
    ["channels array", { channels: [] }, "oc://policy.jsonc/channels"],
    ["ingress array", { ingress: [] }, "oc://policy.jsonc/ingress"],
    ["ingress session array", { ingress: { session: [] } }, "oc://policy.jsonc/ingress/session"],
    [
      "ingress requireDmScope invalid",
      { ingress: { session: { requireDmScope: "shared" } } },
      "oc://policy.jsonc/ingress/session/requireDmScope",
    ],
    [
      "ingress allowDmPolicies string",
      { ingress: { channels: { allowDmPolicies: "pairing" } } },
      "oc://policy.jsonc/ingress/channels/allowDmPolicies",
    ],
    [
      "ingress allowDmPolicies invalid",
      { ingress: { channels: { allowDmPolicies: ["pairing", "public"] } } },
      "oc://policy.jsonc/ingress/channels/allowDmPolicies/#1",
    ],
    [
      "ingress denyOpenGroups string",
      { ingress: { channels: { denyOpenGroups: "true" } } },
      "oc://policy.jsonc/ingress/channels/denyOpenGroups",
    ],
    [
      "ingress requireMentionInGroups string",
      { ingress: { channels: { requireMentionInGroups: "true" } } },
      "oc://policy.jsonc/ingress/channels/requireMentionInGroups",
    ],
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
    [
      "sandbox unsupported key",
      { sandbox: { requireModes: ["all"] } },
      "oc://policy.jsonc/sandbox/requireModes",
    ],
    [
      "sandbox containers unsupported key",
      { sandbox: { containers: { denyNetwork: true } } },
      "oc://policy.jsonc/sandbox/containers/denyNetwork",
    ],
    [
      "sandbox browser unsupported key",
      { sandbox: { browser: { cdpSourceRange: true } } },
      "oc://policy.jsonc/sandbox/browser/cdpSourceRange",
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

  it("rejects unsupported policy keys across policy namespaces", async () => {
    const cases: readonly {
      readonly label: string;
      readonly policy: unknown;
      readonly target: string;
    }[] = [
      { label: "top-level", policy: { channel: {} }, target: "oc://policy.jsonc/channel" },
      {
        label: "tools top-level",
        policy: { tools: { execPolicy: { allowHosts: ["sandbox"] } } },
        target: "oc://policy.jsonc/tools/execPolicy",
      },
      {
        label: "tools settings",
        policy: { tools: { settings: {} } },
        target: "oc://policy.jsonc/tools/settings",
      },
      {
        label: "tools entries",
        policy: { tools: { entries: [] } },
        target: "oc://policy.jsonc/tools/entries",
      },
      {
        label: "tools profile",
        policy: { tools: { profiles: { deny: ["full"] } } },
        target: "oc://policy.jsonc/tools/profiles/deny",
      },
      {
        label: "tools exec",
        policy: { tools: { exec: { allowShells: ["bash"] } } },
        target: "oc://policy.jsonc/tools/exec/allowShells",
      },
      {
        label: "tools fs",
        policy: { tools: { fs: { allowOutsideWorkspace: true } } },
        target: "oc://policy.jsonc/tools/fs/allowOutsideWorkspace",
      },
      {
        label: "tools alsoAllow",
        policy: { tools: { alsoAllow: { denied: ["exec"] } } },
        target: "oc://policy.jsonc/tools/alsoAllow/denied",
      },
      {
        label: "channels",
        policy: { channels: { allowRules: [] } },
        target: "oc://policy.jsonc/channels/allowRules",
      },
      {
        label: "channel deny rule",
        policy: { channels: { denyRules: [{ when: { provider: "telegram" }, action: "deny" }] } },
        target: "oc://policy.jsonc/channels/denyRules/#0/action",
      },
      {
        label: "channel deny selector",
        policy: {
          channels: { denyRules: [{ when: { provider: "telegram", channel: "stable" } }] },
        },
        target: "oc://policy.jsonc/channels/denyRules/#0/when/channel",
      },
      {
        label: "ingress top-level",
        policy: { ingress: { directMessages: {} } },
        target: "oc://policy.jsonc/ingress/directMessages",
      },
      {
        label: "ingress session",
        policy: { ingress: { session: { requiredScope: "per-channel-peer" } } },
        target: "oc://policy.jsonc/ingress/session/requiredScope",
      },
      {
        label: "ingress channels",
        policy: { ingress: { channels: { allowOpenGroups: false } } },
        target: "oc://policy.jsonc/ingress/channels/allowOpenGroups",
      },
      { label: "mcp", policy: { mcp: { clients: {} } }, target: "oc://policy.jsonc/mcp/clients" },
      {
        label: "mcp servers",
        policy: { mcp: { servers: { require: ["docs"] } } },
        target: "oc://policy.jsonc/mcp/servers/require",
      },
      {
        label: "models",
        policy: { models: { modelRefs: {} } },
        target: "oc://policy.jsonc/models/modelRefs",
      },
      {
        label: "models providers",
        policy: { models: { providers: { require: ["openai"] } } },
        target: "oc://policy.jsonc/models/providers/require",
      },
      {
        label: "network",
        policy: { network: { publicNetwork: {} } },
        target: "oc://policy.jsonc/network/publicNetwork",
      },
      {
        label: "network privateNetwork",
        policy: { network: { privateNetwork: { deny: true } } },
        target: "oc://policy.jsonc/network/privateNetwork/deny",
      },
      {
        label: "gateway top-level",
        policy: { gateway: { bind: { allowNonLoopback: false } } },
        target: "oc://policy.jsonc/gateway/bind",
      },
      {
        label: "gateway exposure",
        policy: { gateway: { exposure: { allowPublicBind: false } } },
        target: "oc://policy.jsonc/gateway/exposure/allowPublicBind",
      },
      {
        label: "gateway auth",
        policy: { gateway: { auth: { allowDisabled: false } } },
        target: "oc://policy.jsonc/gateway/auth/allowDisabled",
      },
      {
        label: "agents",
        policy: { agents: { tools: {} } },
        target: "oc://policy.jsonc/agents/tools",
      },
      {
        label: "agents workspace",
        policy: { agents: { workspace: { requireReadOnly: true } } },
        target: "oc://policy.jsonc/agents/workspace/requireReadOnly",
      },
      {
        label: "dataHandling",
        policy: { dataHandling: { logs: { requireRedaction: true } } },
        target: "oc://policy.jsonc/dataHandling/logs",
      },
      {
        label: "dataHandling nested",
        policy: { dataHandling: { telemetry: { allowCaptureContent: false } } },
        target: "oc://policy.jsonc/dataHandling/telemetry/allowCaptureContent",
      },
      {
        label: "secrets",
        policy: { secrets: { requireVault: true } },
        target: "oc://policy.jsonc/secrets/requireVault",
      },
      {
        label: "auth",
        policy: { auth: { providers: {} } },
        target: "oc://policy.jsonc/auth/providers",
      },
      {
        label: "auth profiles",
        policy: { auth: { profiles: { requireProvider: true } } },
        target: "oc://policy.jsonc/auth/profiles/requireProvider",
      },
    ];

    for (const testCase of cases) {
      const configPath = join(workspaceDir, `${testCase.label.replaceAll(" ", "-")}.jsonc`);
      await fs.writeFile(configPath, "{}", "utf-8");
      await fs.writeFile(
        join(workspaceDir, "policy.jsonc"),
        JSON.stringify(testCase.policy),
        "utf-8",
      );
      clearHealthChecksForTest();
      resetPolicyDoctorChecksForTest();

      const result = await runPolicyChecks(ctx(configPath, cfgWithPolicy()));

      expect(result.findings, testCase.label).toEqual([
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          severity: "error",
          path: "policy.jsonc",
          target: testCase.target,
        }),
      ]);
    }
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
          includeIngress: false,
          includeGatewayExposure: false,
          includeAgentWorkspace: false,
          includeDataHandling: false,
          includeToolPosture: false,
          includeSandboxPosture: false,
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
          includeIngress: false,
          includeGatewayExposure: false,
          includeAgentWorkspace: false,
          includeDataHandling: false,
          includeToolPosture: false,
          includeSandboxPosture: false,
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
          includeIngress: false,
          includeGatewayExposure: false,
          includeAgentWorkspace: false,
          includeDataHandling: false,
          includeToolPosture: false,
          includeSandboxPosture: false,
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
      includeIngress: false,
      includeGatewayExposure: false,
      includeAgentWorkspace: false,
      includeDataHandling: false,
      includeToolPosture: false,
      includeSandboxPosture: false,
      includeSecrets: false,
      includeAuthProfiles: false,
    });
    expect(evidence).not.toHaveProperty("ingress");
    expect(evidence).not.toHaveProperty("gatewayExposure");
    expect(evidence).not.toHaveProperty("agentWorkspace");
    expect(evidence).not.toHaveProperty("dataHandling");
    expect(evidence).not.toHaveProperty("sandboxPosture");
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

  it("ignores nested groupPolicy when channel ingress is disabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          groupPolicy: "disabled",
          groups: {
            ops: {
              groupPolicy: "open",
              requireMention: false,
            },
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

    expect(result.findings).toEqual([]);
  });

  it("does not let nested groupPolicy re-enable disabled channel ingress", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          groupPolicy: "disabled",
          groups: {
            ops: {
              topics: {
                incidents: { groupPolicy: "open", requireMention: false },
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

    expect(result.findings).toEqual([]);
  });

  it("does not treat disabled parent groupPolicy as nested runtime enforcement", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          requireMention: true,
          groups: {
            ops: {
              groupPolicy: "disabled",
              topics: {
                incidents: { requireMention: false },
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

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-group-mention-required",
          ocPath:
            "oc://openclaw.config/channels/telegram/groups/ops/topics/incidents/requireMention",
        }),
      ]),
    );
  });

  it("does not require mention gates when group ingress is disabled", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          groupPolicy: "disabled",
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

    expect(result.findings).toEqual([]);
  });

  it("does not require mention gates when group ingress is disabled by channel defaults", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        defaults: { groupPolicy: "disabled" },
        telegram: {
          dmPolicy: "pairing",
          requireMention: false,
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

    expect(result.findings).toEqual([]);
  });

  it("accepts wildcard group mention defaults as channel mention posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          groups: {
            "*": { requireMention: true },
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
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "channelRequireMention",
          source: 'oc://openclaw.config/channels/telegram/groups/"*"/requireMention',
          value: true,
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("records only supported inherited channel defaults in ingress posture", () => {
    const cfg = {
      channels: {
        defaults: {
          dmPolicy: "open",
          groupPolicy: "open",
          requireMention: false,
        },
        telegram: {},
        slack: {
          accounts: {
            work: {},
          },
        },
      },
    };

    expect(scanPolicyIngress(cfg)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "telegram", kind: "channelGroupPolicy", value: "open" }),
        expect.objectContaining({
          accountId: "work",
          kind: "channelDmPolicy",
          value: "pairing",
        }),
        expect.objectContaining({
          accountId: "work",
          kind: "channelRequireMention",
          value: true,
        }),
      ]),
    );
  });

  it("uses Feishu open-group mention defaults", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: {
        feishu: {
          groupPolicy: "open",
        },
      },
    } as unknown as OpenClawConfig;
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

    const result = await runPolicyDoctorLint(ctx(configPath, cfg));
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "feishu",
          kind: "channelRequireMention",
          value: false,
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-group-mention-required",
          ocPath: "oc://openclaw.config/channels/feishu/requireMention",
        }),
      ]),
    );
  });

  it.each([
    ["clickclack", { baseUrl: "https://app.clickclack.chat", workspace: "wsp_1", token: "ccb" }],
    ["feishu", { appId: "cli_a", appSecret: "secret" }],
    ["irc", { host: "irc.example.com", nick: "claw" }],
    ["line", { channelAccessToken: "line-token" }],
    ["mattermost", { baseUrl: "https://mattermost.example.com", botToken: "mm-token" }],
    ["nextcloud-talk", { baseUrl: "https://nextcloud.example.com", botSecret: "nc-secret" }],
    ["qqbot", { appId: "qqbot-app", clientSecret: "qqbot-secret" }],
    ["synology-chat", { token: "synology-token" }],
    ["tlon", { ship: "zod" }],
    ["twitch", { username: "openclaw" }],
  ])("evaluates %s implicit default account posture with named accounts", async (channel, root) => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        [channel]: {
          ...root,
          dmPolicy: "open",
          groupPolicy: "allowlist",
          requireMention: true,
          accounts: {
            work: {
              dmPolicy: "allowlist",
              groupPolicy: "allowlist",
              requireMention: true,
            },
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

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-dm-policy-unapproved",
          ocPath: `oc://openclaw.config/channels/${channel}/dmPolicy`,
        }),
      ]),
    );
  });

  it("does not evaluate channels with only disabled named accounts", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        slack: {
          accounts: {
            work: {
              enabled: false,
              dmPolicy: "open",
              groupPolicy: "open",
              requireMention: false,
            },
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
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(result.findings).toEqual([]);
    expect(evidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "slack",
          kind: "channelDmPolicy",
        }),
      ]),
    );
  });

  it("does not evaluate channel root defaults as a named account", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        slack: {
          accounts: {
            work: {
              dmPolicy: "allowlist",
              groupPolicy: "allowlist",
              requireMention: true,
            },
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
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(result.findings).toEqual([]);
    expect(evidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "slack",
          accountId: undefined,
          kind: "channelDmPolicy",
        }),
      ]),
    );
  });

  it("evaluates implicit default account posture with named accounts", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        discord: {
          token: "root-token",
          dmPolicy: "open",
          groupPolicy: "allowlist",
          requireMention: true,
          accounts: {
            work: {
              dmPolicy: "allowlist",
              groupPolicy: "allowlist",
              requireMention: true,
            },
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

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-dm-policy-unapproved",
          ocPath: "oc://openclaw.config/channels/discord/dmPolicy",
        }),
      ]),
    );
  });

  it("does not inherit Telegram root groups into multi-account named accounts", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          groups: {
            ops: {
              groupPolicy: "open",
              requireMention: false,
            },
          },
          accounts: {
            work: {
              botToken: "work-token",
              dmPolicy: "allowlist",
              groupPolicy: "allowlist",
              requireMention: true,
            },
            personal: {
              botToken: "personal-token",
              dmPolicy: "allowlist",
              groupPolicy: "allowlist",
              requireMention: true,
            },
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
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(evidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "work",
          groupId: "ops",
          kind: "channelRequireMention",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("lets Telegram account groups override root group inheritance", () => {
    const cfg = {
      channels: {
        telegram: {
          groups: {
            ops: {
              groupPolicy: "open",
              requireMention: false,
            },
          },
          accounts: {
            work: {
              groups: {},
            },
          },
        },
      },
    };

    const evidence = scanPolicyIngress(cfg);

    expect(evidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "work",
          groupId: "ops",
          kind: "channelRequireMention",
        }),
      ]),
    );
  });

  it("records inherited root group overrides for multi-account ingress", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        slack: {
          botToken: "root-token",
          dmPolicy: "pairing",
          groupPolicy: "disabled",
          groups: {
            ops: {
              groupPolicy: "open",
              requireMention: false,
            },
          },
          accounts: {
            work: {
              dmPolicy: "allowlist",
            },
            personal: {
              dmPolicy: "allowlist",
            },
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
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "work",
          groupId: "ops",
          kind: "channelRequireMention",
          source: "oc://openclaw.config/channels/slack/groups/ops/requireMention",
          value: false,
        }),
        expect.objectContaining({
          accountId: "personal",
          groupId: "ops",
          kind: "channelRequireMention",
          source: "oc://openclaw.config/channels/slack/groups/ops/requireMention",
          value: false,
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("evaluates Telegram implicit default account posture with named accounts", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        telegram: {
          botToken: "root-token",
          dmPolicy: "open",
          groupPolicy: "allowlist",
          requireMention: true,
          accounts: {
            work: {
              dmPolicy: "allowlist",
              groupPolicy: "allowlist",
              requireMention: true,
            },
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

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/ingress-dm-policy-unapproved",
          ocPath: "oc://openclaw.config/channels/telegram/dmPolicy",
        }),
      ]),
    );
  });

  it("accepts inherited account ingress posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: { dmScope: "per-channel-peer" },
      channels: {
        slack: {
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          requireMention: true,
          accounts: {
            work: {},
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
    const evidence = scanPolicyIngress(cfg as unknown as Record<string, unknown>);

    expect(result.findings).toEqual([]);
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack-work-dm-policy",
          kind: "channelDmPolicy",
          source: "oc://openclaw.config/channels/slack/dmPolicy",
          value: "allowlist",
        }),
      ]),
    );
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

  it("reports global and agent-scoped workspace claims independently", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "ro" },
        },
        list: [
          { id: "sebby", sandbox: { mode: "all", workspaceAccess: "rw" } },
          { id: "buddy", sandbox: { mode: "all", workspaceAccess: "ro" } },
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
          },
        },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            agents: {
              workspace: {
                allowedAccess: ["none"],
              },
            },
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
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/agents-workspace-access-denied",
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/sebby/agents/workspace/allowedAccess",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/list/#1/sandbox/workspaceAccess",
        }),
      ]),
    );
  });

  it("allows purpose-named agent scopes to target multiple agents", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [
          { id: "sebby", sandbox: { mode: "all", workspaceAccess: "rw" } },
          { id: "buddy", sandbox: { mode: "all", workspaceAccess: "rw" } },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          "workspace-lockdown": {
            agentIds: ["sebby", "buddy"],
            agents: {
              workspace: {
                allowedAccess: ["ro"],
              },
            },
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
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/workspace-lockdown/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/list/#1/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/workspace-lockdown/agents/workspace/allowedAccess",
        }),
      ]),
    );
  });

  it("allows overlapping agent scopes when they govern different fields", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [
          {
            id: "sebby",
            sandbox: { mode: "all", workspaceAccess: "rw" },
            tools: { exec: { host: "node" } },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          "workspace-lockdown": {
            agentIds: ["sebby"],
            agents: {
              workspace: {
                allowedAccess: ["ro"],
              },
            },
          },
          "exec-posture": {
            agentIds: ["sebby"],
            tools: {
              exec: { allowHosts: ["sandbox"] },
            },
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
          requirement: "oc://policy.jsonc/scopes/workspace-lockdown/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          requirement: "oc://policy.jsonc/scopes/exec-posture/tools/exec/allowHosts",
        }),
      ]),
    );
  });

  it("rejects overlapping agent scopes that govern the same field", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          "coding-posture": {
            agentIds: ["Sebby"],
            tools: {
              exec: { allowHosts: ["sandbox"] },
            },
          },
          "strict-exec": {
            agentIds: ["sebby"],
            tools: {
              exec: { allowHosts: ["gateway"] },
            },
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        target: "oc://policy.jsonc/scopes/strict-exec/tools/exec/allowHosts",
      }),
    ]);
  });

  it("does not apply agent-scoped workspace claims to other agents", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [
          { id: "sebby", sandbox: { mode: "all", workspaceAccess: "ro" } },
          { id: "buddy", sandbox: { mode: "all", workspaceAccess: "rw" } },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            agents: {
              workspace: {
                allowedAccess: ["ro"],
              },
            },
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("matches agent-scoped claims against normalized agent ids", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [
          {
            id: "Sebby",
            sandbox: { mode: "all", workspaceAccess: "rw" },
            tools: { exec: { host: "node" } },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            agents: {
              workspace: {
                allowedAccess: ["ro"],
              },
            },
            tools: {
              exec: { allowHosts: ["sandbox"] },
            },
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
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/sebby/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/exec/host",
          requirement: "oc://policy.jsonc/scopes/sebby/tools/exec/allowHosts",
        }),
      ]),
    );
  });

  it("applies main agent-scoped claims to implicit default agent posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: { exec: { host: "node" } },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "rw" },
        },
        list: [
          {
            id: "support",
            sandbox: { mode: "all", workspaceAccess: "ro" },
            tools: { exec: { host: "sandbox" } },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          main: {
            agentIds: ["main"],
            agents: {
              workspace: {
                allowedAccess: ["ro"],
              },
            },
            tools: {
              exec: { allowHosts: ["sandbox"] },
            },
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
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/main/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/host",
          requirement: "oc://policy.jsonc/scopes/main/tools/exec/allowHosts",
        }),
      ]),
    );
  });

  it("applies non-main agent-scoped claims to inherited default posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: { exec: { host: "node" } },
      agents: {
        defaults: {
          sandbox: { mode: "all", workspaceAccess: "rw" },
        },
        list: [
          {
            id: "support",
            sandbox: { mode: "all", workspaceAccess: "ro" },
            tools: { exec: { host: "sandbox" } },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          "release-lockdown": {
            agentIds: ["release-agent"],
            agents: {
              workspace: {
                allowedAccess: ["ro"],
              },
            },
            tools: {
              exec: { allowHosts: ["sandbox"] },
            },
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
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
          requirement: "oc://policy.jsonc/scopes/release-lockdown/agents/workspace/allowedAccess",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/tools/exec/host",
          requirement: "oc://policy.jsonc/scopes/release-lockdown/tools/exec/allowHosts",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/workspaceAccess",
        }),
      ]),
    );
  });

  it("reports sandbox posture denied by policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "off",
            backend: "docker",
            docker: {
              network: "host",
              binds: [
                "/var/run/docker.sock:/var/run/docker.sock:rw",
                "/data:/data:rw",
                "/run/containerd/containerd.sock:/containerd.sock:ro",
                "/var/run/podman/podman.sock:/podman.sock:ro",
              ],
              seccompProfile: "unconfined",
            },
            browser: { enabled: true },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          requireMode: ["all", "non-main"],
          allowBackends: ["ssh"],
          containers: {
            denyHostNetwork: true,
            denyContainerNamespaceJoin: true,
            requireReadOnlyMounts: true,
            denyContainerRuntimeSocketMounts: true,
            denyUnconfinedProfiles: true,
          },
          browser: { requireCdpSourceRange: true },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings.map((finding) => finding.checkId)).toEqual([
      "policy/sandbox-mode-unapproved",
      "policy/sandbox-backend-unapproved",
      "policy/sandbox-container-host-network-denied",
      "policy/sandbox-container-mount-mode-required",
      "policy/sandbox-container-mount-mode-required",
      "policy/sandbox-container-runtime-socket-mount",
      "policy/sandbox-container-runtime-socket-mount",
      "policy/sandbox-container-runtime-socket-mount",
      "policy/sandbox-container-unconfined-profile",
      "policy/sandbox-browser-cdp-source-range-missing",
    ]);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-mode-unapproved",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/mode",
          requirement: "oc://policy.jsonc/sandbox/requireMode",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-runtime-socket-mount",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
          requirement: "oc://policy.jsonc/sandbox/containers/denyContainerRuntimeSocketMounts",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-runtime-socket-mount",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#2",
          requirement: "oc://policy.jsonc/sandbox/containers/denyContainerRuntimeSocketMounts",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-runtime-socket-mount",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#3",
          requirement: "oc://policy.jsonc/sandbox/containers/denyContainerRuntimeSocketMounts",
        }),
      ]),
    );
  });

  it("keeps read-only Windows binds with drive-letter destinations compliant", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            docker: {
              binds: ["C:\\Users\\foo:C:\\container:ro"],
              network: "none",
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          containers: {
            requireReadOnlyMounts: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-container-mount-mode-required",
        }),
      ]),
    );
  });

  it("applies sandbox bind policy to browser-specific binds", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            docker: {
              network: "none",
              binds: ["/safe:/safe:ro"],
            },
            browser: {
              enabled: true,
              cdpSourceRange: "172.21.0.1/32",
              network: "host",
              binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          requireMode: ["all"],
          allowBackends: ["docker"],
          containers: {
            denyHostNetwork: true,
            requireReadOnlyMounts: true,
            denyContainerRuntimeSocketMounts: true,
          },
          browser: { requireCdpSourceRange: true },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "containerMount",
          bindSurface: "browser",
          source: "oc://openclaw.config/agents/defaults/sandbox/browser/binds/#0",
        }),
        expect.objectContaining({
          kind: "containerNetwork",
          value: "host",
          source: "oc://openclaw.config/agents/defaults/sandbox/browser/network",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-container-host-network-denied",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/browser/network",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-mount-mode-required",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/browser/binds/#0",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-runtime-socket-mount",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/browser/binds/#0",
        }),
      ]),
    );
  });

  it("does not require read-only mounts when the policy disables the rule", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            docker: {
              binds: ["/safe:/safe:ro"],
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          containers: {
            requireReadOnlyMounts: false,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/sandbox-container-mount-mode-required" }),
      ]),
    );
  });

  it("ignores agent-local Docker and browser posture under shared sandbox scope", async () => {
    const cfg = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            scope: "shared",
            docker: {
              network: "none",
              binds: ["/shared:/shared:ro"],
            },
            browser: {
              enabled: true,
              cdpSourceRange: "172.21.0.1/32",
              binds: ["/browser-shared:/browser-shared:ro"],
            },
          },
        },
        list: [
          {
            id: "runner",
            sandbox: {
              docker: {
                network: "host",
                binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
              },
              browser: {
                cdpSourceRange: "",
                binds: ["/unsafe-browser:/unsafe-browser:rw"],
              },
            },
          },
        ],
      },
    };

    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);
    const runnerEvidence = (evidence.sandboxPosture ?? []).filter(
      (entry) => entry.agentId === "runner",
    );

    expect(runnerEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "containerNetwork",
          value: "none",
          source: "oc://openclaw.config/agents/defaults/sandbox/docker/network",
        }),
        expect.objectContaining({
          kind: "browserCdpSourceRange",
          value: "172.21.0.1/32",
          source: "oc://openclaw.config/agents/defaults/sandbox/browser/cdpSourceRange",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/shared:/shared:ro",
          source: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/browser-shared:/browser-shared:ro",
          source: "oc://openclaw.config/agents/defaults/sandbox/browser/binds/#0",
        }),
      ]),
    );
    expect(runnerEvidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bind: "/var/run/docker.sock:/var/run/docker.sock:rw" }),
        expect.objectContaining({ bind: "/unsafe-browser:/unsafe-browser:rw" }),
        expect.objectContaining({
          kind: "containerNetwork",
          value: "host",
        }),
      ]),
    );
  });

  it("treats blank agent browser CDP source range as an explicit clear", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            browser: { enabled: true, cdpSourceRange: "172.21.0.1/32" },
          },
        },
        list: [
          {
            id: "runner",
            sandbox: {
              browser: { cdpSourceRange: "" },
            },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          browser: { requireCdpSourceRange: true },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-browser-cdp-source-range-missing",
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/browser/cdpSourceRange",
        }),
      ]),
    );
  });

  it("reports enabled container posture rules that the backend cannot observe", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "openshell",
            docker: {
              network: "host",
              binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
              seccompProfile: "unconfined",
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          allowBackends: ["openshell"],
          containers: {
            denyHostNetwork: true,
            denyContainerRuntimeSocketMounts: true,
            denyUnconfinedProfiles: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "backend",
          value: "openshell",
        }),
      ]),
    );
    expect(evidence.sandboxPosture).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "containerNetwork" }),
        expect.objectContaining({ kind: "containerMount" }),
        expect.objectContaining({ kind: "containerSecurityProfile" }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-container-posture-unobservable",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/backend",
          requirement: "oc://policy.jsonc/sandbox/containers/denyHostNetwork",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-posture-unobservable",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/backend",
          requirement: "oc://policy.jsonc/sandbox/containers/denyContainerRuntimeSocketMounts",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-posture-unobservable",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/backend",
          requirement: "oc://policy.jsonc/sandbox/containers/denyUnconfinedProfiles",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/sandbox-container-host-network-denied" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-runtime-socket-mount" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-unconfined-profile" }),
      ]),
    );
  });

  it("evaluates inherited container mounts for browser containers on non-Docker backends", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "openshell",
            docker: {
              binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
            },
            browser: {
              enabled: true,
              cdpSourceRange: "172.21.0.1/32",
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          allowBackends: ["openshell"],
          containers: {
            requireReadOnlyMounts: true,
            denyContainerRuntimeSocketMounts: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "containerMount",
          bindSurface: "browser",
          bind: "/var/run/docker.sock:/var/run/docker.sock:rw",
          source: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-container-mount-mode-required",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-container-runtime-socket-mount",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/docker/binds/#0",
        }),
      ]),
    );
  });

  it("normalizes mixed-case Docker backend before collecting container posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "Docker",
            docker: {
              network: "host",
              binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
              seccompProfile: "unconfined",
            },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          allowBackends: ["docker"],
          containers: {
            denyHostNetwork: true,
            denyContainerRuntimeSocketMounts: true,
            denyUnconfinedProfiles: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "backend", value: "docker" }),
        expect.objectContaining({ kind: "containerNetwork", value: "host" }),
        expect.objectContaining({ kind: "containerMount" }),
        expect.objectContaining({
          kind: "containerSecurityProfile",
          profile: "seccomp",
          value: "unconfined",
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "policy/sandbox-container-host-network-denied" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-runtime-socket-mount" }),
        expect.objectContaining({ checkId: "policy/sandbox-container-unconfined-profile" }),
      ]),
    );
  });

  it("uses explicit agent sandbox scope before inherited legacy perSession", async () => {
    const cfg = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            perSession: false,
            docker: {
              network: "none",
            },
          },
        },
        list: [
          {
            id: "runner",
            sandbox: {
              scope: "agent",
              docker: {
                network: "host",
                binds: ["/var/run/docker.sock:/var/run/docker.sock:rw"],
              },
              browser: {
                enabled: true,
                cdpSourceRange: "172.21.0.1/32",
                binds: ["/browser:/browser:rw"],
              },
            },
          },
        ],
      },
    };

    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);
    const runnerEvidence = (evidence.sandboxPosture ?? []).filter(
      (entry) => entry.agentId === "runner",
    );

    expect(runnerEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "containerNetwork",
          value: "host",
          source: "oc://openclaw.config/agents/list/#0/sandbox/docker/network",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/var/run/docker.sock:/var/run/docker.sock:rw",
          source: "oc://openclaw.config/agents/list/#0/sandbox/docker/binds/#0",
        }),
        expect.objectContaining({
          kind: "containerMount",
          bind: "/browser:/browser:rw",
          source: "oc://openclaw.config/agents/list/#0/sandbox/browser/binds/#0",
        }),
      ]),
    );
  });

  it("accepts configured sandbox posture that matches policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            docker: {
              network: "none",
              binds: ["/data:/data:ro"],
              seccompProfile: "runtime/default",
            },
            browser: { enabled: true, cdpSourceRange: "172.21.0.1/32" },
          },
        },
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          requireMode: ["all", "non-main"],
          allowBackends: ["docker"],
          containers: {
            denyHostNetwork: true,
            denyContainerNamespaceJoin: true,
            requireReadOnlyMounts: true,
            denyContainerRuntimeSocketMounts: true,
            denyUnconfinedProfiles: true,
          },
          browser: { requireCdpSourceRange: true },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("applies agent-scoped sandbox claims only to matching agents", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [
          { id: "Sebby", sandbox: { mode: "off", backend: "ssh" } },
          { id: "buddy", sandbox: { mode: "all", backend: "docker" } },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        sandbox: {
          requireMode: ["all"],
        },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            sandbox: {
              allowBackends: ["docker"],
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
          checkId: "policy/sandbox-mode-unapproved",
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/mode",
          requirement: "oc://policy.jsonc/sandbox/requireMode",
        }),
        expect.objectContaining({
          checkId: "policy/sandbox-backend-unapproved",
          ocPath: "oc://openclaw.config/agents/list/#0/sandbox/backend",
          requirement: "oc://policy.jsonc/scopes/sebby/sandbox/allowBackends",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/list/#1/sandbox/backend",
          requirement: "oc://policy.jsonc/scopes/sebby/sandbox/allowBackends",
        }),
      ]),
    );
  });

  it("does not apply sandbox overlays from invalid scoped policy", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [{ id: "sebby", sandbox: { mode: "off" } }],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            channels: { allow: ["discord"] },
            sandbox: {
              requireMode: ["all"],
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
          target: "oc://policy.jsonc/scopes/sebby/channels",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-mode-unapproved",
          requirement: "oc://policy.jsonc/scopes/sebby/sandbox/requireMode",
        }),
      ]),
    );
  });

  it("reports scoped container posture rules that a non-Docker agent group cannot observe", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            docker: {
              network: "none",
              binds: ["/workspace:/workspace:rw"],
            },
          },
        },
        list: [
          {
            id: "release-agent",
            sandbox: { mode: "all", backend: "openshell" },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          release: {
            agentIds: ["release-agent"],
            sandbox: {
              containers: { requireReadOnlyMounts: true },
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/sandbox-container-posture-unobservable",
        ocPath: "oc://openclaw.config/agents/list/#0/sandbox/backend",
        requirement: "oc://policy.jsonc/scopes/release/sandbox/containers/requireReadOnlyMounts",
      }),
    ]);
  });

  it("allows scoped non-Docker agent groups when container posture rules are off", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            docker: {
              network: "none",
              binds: ["/workspace:/workspace:rw"],
            },
          },
        },
        list: [
          {
            id: "release-agent",
            sandbox: { mode: "all", backend: "openshell" },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          release: {
            agentIds: ["release-agent"],
            sandbox: {
              containers: { requireReadOnlyMounts: false },
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("does not fall back to default browser posture for scoped browser-disabled agents", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "docker",
            browser: { enabled: true, network: "host" },
          },
        },
        list: [
          {
            id: "release-agent",
            sandbox: { browser: { enabled: false } },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          release: {
            agentIds: ["release-agent"],
            sandbox: {
              containers: { denyHostNetwork: true },
              browser: { requireCdpSourceRange: true },
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.sandboxPosture).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "release-agent",
          kind: "browserCdpSourceRange",
          value: false,
        }),
        expect.objectContaining({
          kind: "containerNetwork",
          networkSurface: "browser",
          value: "host",
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("applies main-scoped sandbox claims to defaults when unrelated agents exist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          sandbox: { mode: "off" },
        },
        list: [
          {
            id: "worker",
            sandbox: { mode: "all" },
          },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          mainSandbox: {
            agentIds: ["main"],
            sandbox: { requireMode: ["all"] },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/sandbox-mode-unapproved",
          ocPath: "oc://openclaw.config/agents/defaults/sandbox/mode",
          requirement: "oc://policy.jsonc/scopes/mainSandbox/sandbox/requireMode",
        }),
      ]),
    );
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

  it("reports global and agent-scoped tool claims independently", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: {
        exec: { host: "sandbox" },
      },
      agents: {
        list: [
          { id: "sebby", tools: { exec: { host: "node" } } },
          { id: "buddy", tools: { exec: { host: "sandbox" } } },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          exec: { allowHosts: ["sandbox", "gateway"] },
        },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: {
              exec: { allowHosts: ["gateway"] },
            },
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
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/exec/host",
          requirement: "oc://policy.jsonc/tools/exec/allowHosts",
        }),
        expect.objectContaining({
          checkId: "policy/tools-exec-host-unapproved",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/exec/host",
          requirement: "oc://policy.jsonc/scopes/sebby/tools/exec/allowHosts",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ocPath: "oc://openclaw.config/agents/list/#1/tools/exec/host",
        }),
      ]),
    );
  });

  it("does not apply agent-scoped tool claims to other agents", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        list: [
          { id: "sebby", tools: { exec: { host: "sandbox" } } },
          { id: "buddy", tools: { exec: { host: "node" } } },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: {
              exec: { allowHosts: ["sandbox"] },
            },
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports global and agent-scoped alsoAllow drift", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: { alsoAllow: ["read", "cron"] },
      agents: {
        list: [
          { id: "sebby", tools: { alsoAllow: ["read", "gateway"] } },
          { id: "buddy", tools: { alsoAllow: ["read"] } },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          alsoAllow: { expected: ["read", "message"] },
        },
        scopes: {
          sebby: {
            agentIds: ["sebby"],
            tools: {
              alsoAllow: { expected: ["read", "message"] },
            },
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
          checkId: "policy/tools-also-allow-missing",
          ocPath: "oc://openclaw.config/tools/alsoAllow",
          requirement: "oc://policy.jsonc/tools/alsoAllow/expected",
        }),
        expect.objectContaining({
          checkId: "policy/tools-also-allow-unexpected",
          ocPath: "oc://openclaw.config/tools/alsoAllow",
          requirement: "oc://policy.jsonc/tools/alsoAllow/expected",
        }),
        expect.objectContaining({
          checkId: "policy/tools-also-allow-missing",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/alsoAllow",
          requirement: "oc://policy.jsonc/scopes/sebby/tools/alsoAllow/expected",
        }),
        expect.objectContaining({
          checkId: "policy/tools-also-allow-unexpected",
          ocPath: "oc://openclaw.config/agents/list/#0/tools/alsoAllow",
          requirement: "oc://policy.jsonc/scopes/sebby/tools/alsoAllow/expected",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requirement: "oc://policy.jsonc/scopes/sebby/tools/alsoAllow/expected",
          ocPath: "oc://openclaw.config/agents/list/#1/tools/alsoAllow",
        }),
      ]),
    );
  });

  it("reports unexpected alsoAllow entries when policy expects none", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: { alsoAllow: ["read"] },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: {
          alsoAllow: { expected: [] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/tools-also-allow-unexpected",
        ocPath: "oc://openclaw.config/tools/alsoAllow",
        requirement: "oc://policy.jsonc/tools/alsoAllow/expected",
      }),
    ]);
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

  it("reports data-handling conformance findings from config posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      logging: { redactSensitive: "off" },
      diagnostics: { otel: { enabled: true, captureContent: { enabled: true, toolInputs: true } } },
      session: { maintenance: { mode: "warn" } },
      memory: { backend: "qmd", qmd: { sessions: { enabled: true } } },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        dataHandling: {
          sensitiveLogging: { requireRedaction: true },
          telemetry: { denyContentCapture: true },
          retention: { requireSessionMaintenance: true },
          memory: { denySessionTranscriptIndexing: true },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.dataHandling).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "sensitiveLoggingRedaction",
          source: "oc://openclaw.config/logging/redactSensitive",
          value: false,
        }),
        expect.objectContaining({
          kind: "telemetryContentCapture",
          source: "oc://openclaw.config/diagnostics/otel/captureContent",
          value: true,
        }),
        expect.objectContaining({
          kind: "sessionRetentionMode",
          source: "oc://openclaw.config/session/maintenance/mode",
          value: "warn",
        }),
        expect.objectContaining({
          kind: "memorySessionTranscriptIndexing",
          source: "oc://openclaw.config/memory/qmd/sessions/enabled",
          value: true,
        }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/data-handling-redaction-disabled",
          ocPath: "oc://openclaw.config/logging/redactSensitive",
          requirement: "oc://policy.jsonc/dataHandling/sensitiveLogging/requireRedaction",
        }),
        expect.objectContaining({
          checkId: "policy/data-handling-telemetry-content-capture",
          ocPath: "oc://openclaw.config/diagnostics/otel/captureContent",
          requirement: "oc://policy.jsonc/dataHandling/telemetry/denyContentCapture",
        }),
        expect.objectContaining({
          checkId: "policy/data-handling-session-retention-not-enforced",
          ocPath: "oc://openclaw.config/session/maintenance/mode",
          requirement: "oc://policy.jsonc/dataHandling/retention/requireSessionMaintenance",
        }),
        expect.objectContaining({
          checkId: "policy/data-handling-session-transcript-memory-enabled",
          ocPath: "oc://openclaw.config/memory/qmd/sessions/enabled",
          requirement: "oc://policy.jsonc/dataHandling/memory/denySessionTranscriptIndexing",
        }),
      ]),
    );
  });

  it("treats omitted session maintenance mode as enforce for retention conformance", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      session: {},
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        dataHandling: {
          retention: { requireSessionMaintenance: true },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));
    const evidence = collectPolicyEvidence(cfg as unknown as Record<string, unknown>);

    expect(evidence.dataHandling).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "sessionRetentionMode",
          source: "oc://openclaw.config/session/maintenance/mode",
          value: "enforce",
          explicit: false,
        }),
      ]),
    );
    expect(result.findings).toEqual([]);
  });

  it("does not treat disabled telemetry capture subkeys as content capture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      diagnostics: { otel: { captureContent: { toolInputs: true } } },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ dataHandling: { telemetry: { denyContentCapture: true } } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("does not report inert telemetry capture config", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      diagnostics: {
        enabled: false,
        otel: { enabled: true, captureContent: true },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ dataHandling: { telemetry: { denyContentCapture: true } } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports OTEL log body content capture without trace export", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      diagnostics: {
        otel: { enabled: true, traces: false, logs: true, captureContent: true },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ dataHandling: { telemetry: { denyContentCapture: true } } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/data-handling-telemetry-content-capture",
        ocPath: "oc://openclaw.config/diagnostics/otel/captureContent",
      }),
    ]);
  });

  it("does not treat trace-only content capture subkeys as log body capture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      diagnostics: {
        otel: {
          enabled: true,
          traces: false,
          logs: true,
          captureContent: { enabled: true, toolInputs: true },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ dataHandling: { telemetry: { denyContentCapture: true } } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("supports agent-scoped session transcript memory conformance", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          memorySearch: { experimental: { sessionMemory: true }, sources: ["memory", "sessions"] },
        },
        list: [
          { id: "sebby" },
          { id: "buddy", memorySearch: { experimental: { sessionMemory: false } } },
        ],
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["sebby"],
            dataHandling: { memory: { denySessionTranscriptIndexing: true } },
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/data-handling-session-transcript-memory-enabled",
        ocPath: "oc://openclaw.config/agents/defaults/memorySearch/experimental/sessionMemory",
        requirement:
          "oc://policy.jsonc/scopes/restricted/dataHandling/memory/denySessionTranscriptIndexing",
      }),
    ]);
  });

  it("applies agent-scoped data-handling memory claims to inherited default posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      agents: {
        defaults: {
          memorySearch: { experimental: { sessionMemory: true }, sources: ["sessions"] },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["release"],
            dataHandling: { memory: { denySessionTranscriptIndexing: true } },
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/data-handling-session-transcript-memory-enabled",
        ocPath: "oc://openclaw.config/agents/defaults/memorySearch/experimental/sessionMemory",
        requirement:
          "oc://policy.jsonc/scopes/restricted/dataHandling/memory/denySessionTranscriptIndexing",
      }),
    ]);
  });

  it("does not report inert memory transcript indexing config", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      memory: { qmd: { sessions: { enabled: true } } },
      agents: {
        defaults: {
          memorySearch: {
            enabled: false,
            experimental: { sessionMemory: true },
            sources: ["sessions"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        dataHandling: { memory: { denySessionTranscriptIndexing: true } },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfg));

    expect(result.findings).toEqual([]);
  });

  it("reports malformed data-handling policy sections", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        dataHandling: {
          sensitiveLogging: true,
          memory: [],
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
          target: "oc://policy.jsonc/dataHandling/sensitiveLogging",
        }),
        expect.objectContaining({
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/dataHandling/memory",
        }),
      ]),
    );
  });

  it("rejects scoped data-handling rules that cannot be agent-scoped", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["sebby"],
            dataHandling: { telemetry: { denyContentCapture: true } },
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        target: "oc://policy.jsonc/scopes/restricted/dataHandling/telemetry",
      }),
    ]);
  });

  it("rejects malformed scoped data-handling memory rules", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["sebby"],
            dataHandling: { memory: { denySessionTranscriptIndexing: "true" } },
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-jsonc-invalid",
        target:
          "oc://policy.jsonc/scopes/restricted/dataHandling/memory/denySessionTranscriptIndexing",
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
