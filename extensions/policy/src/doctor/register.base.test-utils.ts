// Imported by register.test.ts to keep its mocked suite in one Vitest module graph.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  listHealthChecks,
  type HealthCheck,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/health";
import { clearHealthChecksForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  policyDocumentHash,
} from "../policy-state.js";
import { evaluatePolicy, registerPolicyDoctorChecks } from "./register.js";
import {
  workspaceDir,
  cfgWithPolicy,
  ctx,
  repairCtx,
  runPolicyChecks,
  runDeniedChannelRepair,
  runPolicyRepairCheck,
  describe0BeforeEach0,
  describe0AfterEach1,
} from "./register.test-harness.js";

describe("registerPolicyDoctorChecks", () => {
  beforeEach(describe0BeforeEach0);

  afterEach(describe0AfterEach1);

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

  it("registers the complete policy health check set once per registry", () => {
    const checks: HealthCheck[] = [];
    const host = {
      registerHealthCheck(check: HealthCheck) {
        checks.push(check);
      },
    };
    registerPolicyDoctorChecks(host);
    registerPolicyDoctorChecks(host);
    const expectedIds = [
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
      "policy/routing-bindings-required",
      "policy/routing-binding-channel-unconfigured",
      "policy/routing-agent-mismatch",
      "policy/routing-match-kind-mismatch",
      "policy/gateway-non-loopback-bind",
      "policy/gateway-auth-disabled",
      "policy/gateway-rate-limit-missing",
      "policy/gateway-control-ui-insecure",
      "policy/gateway-tailscale-funnel",
      "policy/gateway-remote-enabled",
      "policy/gateway-http-endpoint-enabled",
      "policy/gateway-http-url-fetch-unrestricted",
      "policy/gateway-node-command-denied",
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
      "policy/exec-approvals-missing",
      "policy/exec-approvals-invalid",
      "policy/exec-approvals-default-security-unapproved",
      "policy/exec-approvals-agent-security-unapproved",
      "policy/exec-approvals-auto-allow-skills-enabled",
      "policy/exec-approvals-allowlist-missing",
      "policy/exec-approvals-allowlist-unexpected",
      "policy/tools-missing-risk-level",
      "policy/tools-unknown-risk-level",
      "policy/tools-missing-sensitivity-token",
      "policy/tools-missing-owner",
      "policy/tools-unknown-sensitivity-token",
    ];
    expect(checks.map((check) => check.id)).toEqual(expectedIds);

    registerPolicyDoctorChecks();
    registerPolicyDoctorChecks();
    expect(listHealthChecks().map((check) => check.id)).toEqual(expectedIds);

    clearHealthChecksForTest();
    registerPolicyDoctorChecks();
    expect(listHealthChecks().map((check) => check.id)).toEqual(expectedIds);
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
    ["gateway nodes array", { gateway: { nodes: [] } }, "oc://policy.jsonc/gateway/nodes"],
    [
      "gateway nodes denyCommands string",
      { gateway: { nodes: { denyCommands: "system.run" } } },
      "oc://policy.jsonc/gateway/nodes/denyCommands",
    ],
    [
      "gateway nodes denyCommands blank entry",
      { gateway: { nodes: { denyCommands: ["system.run", " "] } } },
      "oc://policy.jsonc/gateway/nodes/denyCommands/#1",
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

    const evaluation = await evaluatePolicy(ctx(configPath, cfg));
    expect(evaluation.findings[0]).not.toHaveProperty("fixRecommendation");
    expect(evaluation.attestedFindings[0]).not.toHaveProperty("fixRecommendation");
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

  it("dry-runs automatic policy narrowing repairs without mutating config", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      tools: { elevated: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { elevated: { allow: false } } }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck("policy/tools-elevated-enabled", {
      ...repairCtx(configPath, cfg),
      dryRun: true,
    });

    expect(result.status).toBe("repaired");
    expect(result.changes).toEqual(["Set tools.elevated.enabled=false for policy conformance."]);
    expect(result.config.tools?.elevated?.enabled).toBe(false);
    expect(cfg.tools?.elevated?.enabled).toBe(true);
  });

  it("does not repair automatic policy narrowing config without workspace repair opt-in", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      tools: { elevated: { enabled: true } },
    } as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { elevated: { allow: false } } }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck(
      "policy/tools-elevated-enabled",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("workspace repairs are disabled");
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped policy config repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace policy config.",
    ]);
    expect(result.config.tools?.elevated?.enabled).toBe(true);
  });

  it("does not over-apply scoped elevated policy findings globally", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      agents: {
        list: [
          {
            id: "reviewer",
            tools: { elevated: { enabled: true } },
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
            tools: { elevated: { allow: false } },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck(
      "policy/tools-elevated-enabled",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("policy automatic repair had no config changes to apply");
    expect(result.config).not.toHaveProperty("tools.elevated.enabled");
    expect(result.config.agents?.list?.[0]).toMatchObject({
      id: "reviewer",
      tools: { elevated: { enabled: true } },
    });
  });

  it("skips scoped elevated repairs that inherit shared global tools config", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      tools: { elevated: { enabled: true } },
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
            tools: { elevated: { allow: false } },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck(
      "policy/tools-elevated-enabled",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("policy automatic repair had no config changes to apply");
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped scoped tools repair. Scoped elevated-tools policy findings are detect-only because automatic repair cannot safely choose between shared and agent-local config targets.",
    ]);
    expect(result.config.tools?.elevated?.enabled).toBe(true);
  });

  it("repairs automatic policy narrowing config findings", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      tools: { elevated: { enabled: true } },
      gateway: {
        mode: "remote",
        remote: { url: "wss://remote.example.test:18789" },
        controlUi: {
          dangerouslyAllowHostHeaderOriginFallback: true,
        },
      },
      diagnostics: { otel: { enabled: true, captureContent: true } },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { elevated: { allow: false } },
        gateway: {
          controlUi: { allowInsecure: false },
          remote: { allow: false },
        },
        dataHandling: {
          sensitiveLogging: { requireRedaction: true },
          telemetry: { denyContentCapture: true },
        },
      }),
      "utf-8",
    );

    const elevated = await runPolicyRepairCheck(
      "policy/tools-elevated-enabled",
      repairCtx(configPath, cfg),
    );
    const controlUi = await runPolicyRepairCheck(
      "policy/gateway-control-ui-insecure",
      repairCtx(configPath, elevated.config),
    );
    const remote = await runPolicyRepairCheck(
      "policy/gateway-remote-enabled",
      repairCtx(configPath, controlUi.config),
    );
    const telemetry = await runPolicyRepairCheck(
      "policy/data-handling-telemetry-content-capture",
      repairCtx(configPath, remote.config),
    );

    expect([
      ...elevated.changes,
      ...controlUi.changes,
      ...remote.changes,
      ...telemetry.changes,
    ]).toEqual([
      "Set tools.elevated.enabled=false for policy conformance.",
      "Set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=false for policy conformance.",
      "Set gateway.mode=local for policy conformance.",
      "Set diagnostics.otel.captureContent=false for policy conformance.",
    ]);
    expect(telemetry.remainingFindings).toEqual([]);
    expect(telemetry.config).toMatchObject({
      tools: { elevated: { enabled: false } },
      gateway: {
        mode: "local",
        remote: {},
        controlUi: {
          dangerouslyAllowHostHeaderOriginFallback: false,
        },
      },
      diagnostics: { otel: { captureContent: false } },
    });
  });

  it("repairs denied gateway HTTP endpoint findings", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      gateway: {
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
          http: {
            denyEndpoints: ["chatCompletions", "responses"],
            requireUrlAllowlists: true,
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck(
      "policy/gateway-http-endpoint-enabled",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("repaired");
    expect(result.changes).toEqual([
      "Set gateway.http.endpoints.chatCompletions.enabled=false for policy conformance.",
      "Set gateway.http.endpoints.responses.enabled=false for policy conformance.",
    ]);
    expect(result.remainingFindings).toEqual([]);
    expect(result.config.gateway?.http?.endpoints).toMatchObject({
      chatCompletions: {
        enabled: false,
        images: { allowUrl: true },
      },
      responses: {
        enabled: false,
        files: { allowUrl: true },
        images: { allowUrl: true, urlAllowlist: ["images.example.test"] },
      },
    });
  });

  it("previews review-required gateway bind repair without mutating config", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      gateway: { bind: "lan" },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ gateway: { exposure: { allowNonLoopbackBind: false } } }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck(
      "policy/gateway-non-loopback-bind",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("policy repair requires review before changing config");
    expect(result.changes).toEqual([
      "Review required: set gateway.bind=loopback for policy conformance.",
    ]);
    expect(result.warnings).toEqual([
      "Review required: set gateway.bind=loopback for policy conformance.",
    ]);
    expect(result.effects).toEqual([
      {
        kind: "config",
        action: "would-set-after-review",
        target: "gateway.bind=loopback",
        dryRunSafe: true,
      },
    ]);
    expect(result.config.gateway?.bind).toBe("lan");
    expect(result.remainingFindings).toHaveLength(1);
  });

  it("previews review-required custom gateway bind repair without mutating config", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      gateway: { bind: "custom", customBindHost: "10.0.0.4" },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ gateway: { exposure: { allowNonLoopbackBind: false } } }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck(
      "policy/gateway-non-loopback-bind",
      repairCtx(configPath, cfg),
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        ocPath: "oc://openclaw.config/gateway/customBindHost",
      }),
    ]);
    expect(result.status).toBe("skipped");
    expect(result.changes).toEqual([
      "Review required: set gateway.bind=loopback for policy conformance.",
    ]);
    expect(result.warnings).toEqual([
      "Review required: set gateway.bind=loopback for policy conformance.",
    ]);
    expect(result.effects).toEqual([
      {
        kind: "config",
        action: "would-set-after-review",
        target: "gateway.bind=loopback",
        dryRunSafe: true,
      },
    ]);
    expect(result.config.gateway).toMatchObject({
      bind: "custom",
      customBindHost: "10.0.0.4",
    });
    expect(result.remainingFindings).toHaveLength(1);
  });

  it("previews review-required gateway node command repairs without mutating config", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      gateway: { nodes: { commands: { deny: ["mcp.help"] } } },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ gateway: { nodes: { denyCommands: ["mcp.help", "system.run"] } } }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck(
      "policy/gateway-node-command-denied",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("policy repair requires review before changing config");
    expect(result.changes).toEqual([
      "Review required: add system.run to gateway.nodes.commands.deny for policy conformance.",
    ]);
    expect(result.warnings).toEqual([
      "Review required: add system.run to gateway.nodes.commands.deny for policy conformance.",
    ]);
    expect(result.effects).toEqual([
      {
        kind: "config",
        action: "would-append-after-review",
        target: "gateway.nodes.commands.deny += system.run",
        dryRunSafe: true,
      },
    ]);
    expect(result.config.gateway?.nodes?.commands?.deny).toEqual(["mcp.help"]);
    expect(result.remainingFindings).toHaveLength(1);
  });

  it("repairs automatic channel ingress narrowing findings", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      channels: {
        telegram: {
          groupPolicy: "open",
          requireMention: false,
          groups: {
            ops: {
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
          channels: {
            denyOpenGroups: true,
            requireMentionInGroups: true,
          },
        },
      }),
      "utf-8",
    );

    const openGroups = await runPolicyRepairCheck(
      "policy/ingress-open-groups-denied",
      repairCtx(configPath, cfg),
    );
    const mentions = await runPolicyRepairCheck(
      "policy/ingress-group-mention-required",
      repairCtx(configPath, openGroups.config),
    );

    expect([...openGroups.changes, ...mentions.changes]).toEqual([
      "Set channels.telegram.groupPolicy=allowlist for policy conformance.",
      "Set channels.telegram.groups.ops.topics.incidents.requireMention=true for policy conformance.",
      "Set channels.telegram.requireMention=true for policy conformance.",
    ]);
    expect(mentions.remainingFindings).toEqual([]);
    expect(mentions.config).toMatchObject({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          requireMention: true,
          groups: {
            ops: {
              topics: {
                incidents: { requireMention: true },
              },
            },
          },
        },
      },
    });
  });

  it("repairs quoted channel ingress paths without splitting slash segments", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      channels: {
        "team/sebby": {
          requireMention: false,
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

    const result = await runPolicyRepairCheck(
      "policy/ingress-group-mention-required",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("repaired");
    expect(result.findings).toEqual([
      expect.objectContaining({
        ocPath: 'oc://openclaw.config/channels/"team/sebby"/requireMention',
      }),
    ]);
    expect(result.changes).toEqual([
      "Set channels.team/sebby.requireMention=true for policy conformance.",
    ]);
    expect(result.remainingFindings).toEqual([]);
    expect(result.config.channels?.["team/sebby"]).toEqual({ requireMention: true });
    expect(result.config.channels).not.toHaveProperty('"team');
  });

  it("skips scoped channel ingress repairs that would mutate inherited defaults", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      channels: {
        defaults: { groupPolicy: "open" },
        telegram: {},
      },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          telegram: {
            channelIds: ["telegram"],
            ingress: {
              channels: {
                denyOpenGroups: true,
              },
            },
          },
        },
      }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck(
      "policy/ingress-open-groups-denied",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("policy automatic repair had no config changes to apply");
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped scoped channel ingress repair for channels.defaults.groupPolicy. The finding reports inherited channels.defaults config, so changing it would affect more than the scoped channel target.",
    ]);
    expect(result.config.channels?.defaults).toEqual({ groupPolicy: "open" });
    expect(result.config.channels?.telegram).toEqual({});
    expect(result.remainingFindings).toEqual([
      expect.objectContaining({
        checkId: "policy/ingress-open-groups-denied",
        ocPath: "oc://openclaw.config/channels/defaults/groupPolicy",
        requirement: "oc://policy.jsonc/scopes/telegram/ingress/channels/denyOpenGroups",
      }),
    ]);
  });

  it("does not repair channel ingress config without workspace repair opt-in", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      channels: { telegram: { groupPolicy: "open" } },
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

    const result = await runPolicyRepairCheck(
      "policy/ingress-open-groups-denied",
      repairCtx(configPath, cfg),
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("workspace repairs are disabled");
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped policy config repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace policy config.",
    ]);
    expect(result.config.channels?.telegram).toEqual({ groupPolicy: "open" });
  });

  it("dry-runs required tool deny repairs without mutating config", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy({ workspaceRepairs: true }),
      tools: { deny: ["read"] },
    } as unknown as OpenClawConfig;
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { denyTools: ["exec", "write"] } }),
      "utf-8",
    );

    const result = await runPolicyRepairCheck("policy/tools-required-deny-missing", {
      ...repairCtx(configPath, cfg),
      dryRun: true,
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/tools-required-deny-missing",
          message: "global tools config does not deny required tool 'exec'.",
          ocPath: "oc://openclaw.config/tools/deny",
        }),
        expect.objectContaining({
          checkId: "policy/tools-required-deny-missing",
          message: "global tools config does not deny required tool 'write'.",
          ocPath: "oc://openclaw.config/tools/deny",
        }),
      ]),
    );
    expect(result.status).toBe("repaired");
    expect(result.changes).toEqual([
      "Added exec to tools.deny for policy conformance.",
      "Added write to tools.deny for policy conformance.",
    ]);
    expect(result.config.tools?.deny).toEqual(["read", "exec", "write"]);
    expect(cfg.tools?.deny).toEqual(["read"]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
