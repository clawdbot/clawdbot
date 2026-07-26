// Imported by register.test.ts to keep its mocked suite in one Vitest module graph.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runDoctorLintChecks, type OpenClawConfig } from "openclaw/plugin-sdk/health";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPolicyEvidence } from "../policy-state.js";
import { registerPolicyDoctorChecks } from "./register.js";
import {
  workspaceDir,
  cfgWithPolicy,
  ctx,
  registerChecks,
  runPolicyDoctorLint,
  describe0BeforeEach0,
  describe0AfterEach1,
} from "./register.test-harness.js";

describe("registerPolicyDoctorChecks", () => {
  beforeEach(describe0BeforeEach0);

  afterEach(describe0AfterEach1);

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
      diagnostics: { otel: { enabled: true, captureContent: true } },
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
          source: "oc://openclaw.invariant/logging/redaction",
          value: true,
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

  it("does not treat disabled telemetry capture as content capture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      diagnostics: { otel: { captureContent: false } },
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

  it("supports agent-scoped session transcript memory conformance", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      memory: {
        search: { rememberAcrossConversations: true, sources: ["memory", "sessions"] },
      },
      agents: {
        defaults: {},
        entries: {
          sebby: {},
          buddy: { memory: { search: { rememberAcrossConversations: false } } },
        },
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
        ocPath: "oc://openclaw.config/memory/search/rememberAcrossConversations",
        requirement:
          "oc://policy.jsonc/scopes/restricted/dataHandling/memory/denySessionTranscriptIndexing",
      }),
    ]);
  });

  it("applies agent-scoped data-handling memory claims to inherited default posture", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      memory: {
        search: { rememberAcrossConversations: true, sources: ["sessions"] },
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
        ocPath: "oc://openclaw.config/memory/search/rememberAcrossConversations",
        requirement:
          "oc://policy.jsonc/scopes/restricted/dataHandling/memory/denySessionTranscriptIndexing",
      }),
    ]);
  });

  it("does not report inert memory transcript indexing config", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const cfg = {
      ...cfgWithPolicy(),
      memory: {
        qmd: { sessions: { enabled: true } },
        search: {
          enabled: false,
          rememberAcrossConversations: true,
          sources: ["sessions"],
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

  it("reports exec approvals file conformance findings", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        execApprovals: {
          requireFile: true,
          defaults: { allowSecurity: ["deny"] },
          agents: {
            allowSecurity: ["allowlist"],
            allowlist: { expected: ["deploy", "doctor"] },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        socket: { path: "/tmp/openclaw.sock", token: "secret-token" },
        defaults: { security: "full" },
        agents: {
          sebby: {
            security: "full",
            allowlist: [{ pattern: "deploy", commandText: "deploy --prod" }],
          },
          buddy: {
            security: "allowlist",
            allowlist: [{ pattern: "status" }],
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
          checkId: "policy/exec-approvals-default-security-unapproved",
          ocPath: "oc://exec-approvals.json/defaults",
          requirement: "oc://policy.jsonc/execApprovals/defaults/allowSecurity",
        }),
        expect.objectContaining({
          checkId: "policy/exec-approvals-agent-security-unapproved",
          ocPath: "oc://exec-approvals.json/agents/sebby",
          requirement: "oc://policy.jsonc/execApprovals/agents/allowSecurity",
        }),
        expect.objectContaining({
          checkId: "policy/exec-approvals-allowlist-missing",
          target: "oc://exec-approvals.json",
          requirement: "oc://policy.jsonc/execApprovals/agents/allowlist/expected",
        }),
        expect.objectContaining({
          checkId: "policy/exec-approvals-allowlist-unexpected",
          ocPath: "oc://exec-approvals.json/agents/buddy/allowlist/#0",
          requirement: "oc://policy.jsonc/execApprovals/agents/allowlist/expected",
        }),
      ]),
    );
    expect(JSON.stringify(result.findings)).not.toContain("secret-token");
    expect(JSON.stringify(result.findings)).not.toContain("deploy --prod");
  });

  it("compares exec approval allowlist entries with argPattern", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        execApprovals: {
          agents: {
            allowlist: { expected: [{ pattern: "deploy", argPattern: "^--prod$" }] },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        agents: { main: { allowlist: [{ pattern: "deploy" }] } },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/exec-approvals-allowlist-missing",
        message:
          "exec approvals allowlist is missing expected pattern 'deploy argPattern=^--prod$'.",
        target: "oc://exec-approvals.json",
      }),
      expect.objectContaining({
        checkId: "policy/exec-approvals-allowlist-unexpected",
        message: "exec approvals allowlist has unexpected pattern 'deploy'.",
        ocPath: "oc://exec-approvals.json/agents/main/allowlist/#0",
      }),
    ]);
  });

  it("checks inherited default security for global exec approval agent rules", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ execApprovals: { agents: { allowSecurity: ["allowlist"] } } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, defaults: { security: "full" } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/exec-approvals-agent-security-unapproved",
        ocPath: "oc://exec-approvals.json/defaults",
        requirement: "oc://policy.jsonc/execApprovals/agents/allowSecurity",
      }),
    ]);
  });

  it("reports inherited autoAllowSkills when policy requires manual exec allowlists", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ execApprovals: { agents: { allowAutoAllowSkills: false } } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, defaults: { autoAllowSkills: true } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/exec-approvals-auto-allow-skills-enabled",
        ocPath: "oc://exec-approvals.json/defaults",
        requirement: "oc://policy.jsonc/execApprovals/agents/allowAutoAllowSkills",
      }),
    ]);
  });

  it("uses wildcard security for global exec approval agents that only add allowlist entries", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ execApprovals: { agents: { allowSecurity: ["deny"] } } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        defaults: { security: "full" },
        agents: {
          "*": { security: "deny" },
          main: { allowlist: [{ pattern: "status" }] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([]);
  });

  it("checks default-inherited global exec approval agents when explicit agents exist", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ execApprovals: { agents: { allowSecurity: ["allowlist"] } } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        defaults: { security: "full" },
        agents: { main: { security: "allowlist" } },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/exec-approvals-agent-security-unapproved",
        ocPath: "oc://exec-approvals.json/defaults",
        requirement: "oc://policy.jsonc/execApprovals/agents/allowSecurity",
      }),
    ]);
  });

  it("applies scoped exec approvals only to selected agents", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["sebby"],
            execApprovals: {
              agents: {
                allowSecurity: ["allowlist"],
                allowlist: { expected: ["deploy", "doctor"] },
              },
            },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        defaults: { security: "deny" },
        agents: {
          sebby: {
            security: "full",
            allowlist: [{ pattern: "deploy" }, { pattern: "status" }],
          },
          buddy: {
            security: "full",
            allowlist: [{ pattern: "unrelated" }],
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
          checkId: "policy/exec-approvals-agent-security-unapproved",
          ocPath: "oc://exec-approvals.json/agents/sebby",
          requirement: "oc://policy.jsonc/scopes/restricted/execApprovals/agents/allowSecurity",
        }),
        expect.objectContaining({
          checkId: "policy/exec-approvals-allowlist-missing",
          requirement:
            "oc://policy.jsonc/scopes/restricted/execApprovals/agents/allowlist/expected",
        }),
        expect.objectContaining({
          checkId: "policy/exec-approvals-allowlist-unexpected",
          ocPath: "oc://exec-approvals.json/agents/sebby/allowlist/#1",
          requirement:
            "oc://policy.jsonc/scopes/restricted/execApprovals/agents/allowlist/expected",
        }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ocPath: expect.stringContaining("agents/buddy") }),
      ]),
    );
  });

  it("does not inherit wildcard security when exact agent security is malformed", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["sebby"],
            execApprovals: { agents: { allowSecurity: ["deny"] } },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        defaults: { security: "deny" },
        agents: {
          "*": { security: "full" },
          sebby: { security: "bogus" },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([]);
  });

  it("uses runtime defaults for malformed exec approval mode fields", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ execApprovals: { defaults: { allowSecurity: ["full"] } } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, defaults: { security: "bogus" } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([]);
  });

  it("requires exec approvals artifacts for scoped exec approval rules", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["sebby", "buddy"],
            execApprovals: {
              agents: { allowSecurity: ["allowlist"] },
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
        checkId: "policy/exec-approvals-missing",
        target: "oc://exec-approvals.json",
        requirement: "oc://policy.jsonc/scopes/restricted/execApprovals",
      }),
    ]);
  });

  it("rejects invalid exec approvals artifacts for scoped exec approval rules", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["sebby", "buddy"],
            execApprovals: {
              agents: { allowSecurity: ["allowlist"] },
            },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "exec-approvals.json"), "{", "utf-8");

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/exec-approvals-invalid",
        target: "oc://exec-approvals.json",
        requirement: "oc://policy.jsonc/scopes/restricted/execApprovals",
      }),
    ]);
  });

  it("does not require exec approvals artifacts for requireFile false alone", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ execApprovals: { requireFile: false } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([]);
  });

  it("applies wildcard exec approvals to scoped agents", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["sebby"],
            execApprovals: {
              agents: {
                allowSecurity: ["allowlist"],
                allowlist: { expected: ["deploy"] },
              },
            },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        defaults: { security: "deny" },
        agents: {
          "*": {
            security: "full",
            allowlist: [{ pattern: "status" }],
          },
          sebby: {
            allowlist: [{ pattern: "deploy" }],
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
          checkId: "policy/exec-approvals-agent-security-unapproved",
          ocPath: 'oc://exec-approvals.json/agents/"*"',
          requirement: "oc://policy.jsonc/scopes/restricted/execApprovals/agents/allowSecurity",
        }),
        expect.objectContaining({
          checkId: "policy/exec-approvals-allowlist-unexpected",
          ocPath: 'oc://exec-approvals.json/agents/"*"/allowlist/#0',
          requirement:
            "oc://policy.jsonc/scopes/restricted/execApprovals/agents/allowlist/expected",
        }),
      ]),
    );
  });

  it("applies wildcard autoAllowSkills posture to scoped exec approvals", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["sebby"],
            execApprovals: {
              agents: { allowAutoAllowSkills: false },
            },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        agents: {
          "*": { autoAllowSkills: true },
          buddy: { autoAllowSkills: true },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/exec-approvals-auto-allow-skills-enabled",
        ocPath: 'oc://exec-approvals.json/agents/"*"',
        requirement:
          "oc://policy.jsonc/scopes/restricted/execApprovals/agents/allowAutoAllowSkills",
      }),
    ]);
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ocPath: expect.stringContaining("agents/buddy") }),
      ]),
    );
  });

  it("applies inherited default autoAllowSkills posture to scoped exec approvals", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["sebby"],
            execApprovals: {
              agents: { allowAutoAllowSkills: false },
            },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        defaults: { autoAllowSkills: true },
        agents: {
          sebby: { allowlist: [{ pattern: "deploy" }] },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/exec-approvals-auto-allow-skills-enabled",
        ocPath: "oc://exec-approvals.json/defaults",
        requirement:
          "oc://policy.jsonc/scopes/restricted/execApprovals/agents/allowAutoAllowSkills",
      }),
    ]);
  });

  it("evaluates legacy default exec approvals for scoped main policies", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          restricted: {
            agentIds: ["main"],
            execApprovals: {
              agents: {
                allowSecurity: ["deny"],
                allowlist: { expected: ["legacy", "doctor"] },
              },
            },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        defaults: { security: "deny" },
        agents: {
          default: {
            security: "allowlist",
            allowlist: ["legacy", { pattern: "doctor" }],
          },
        },
      }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/exec-approvals-agent-security-unapproved",
        ocPath: "oc://exec-approvals.json/agents/default",
        target: "oc://exec-approvals.json/agents/default",
        requirement: "oc://policy.jsonc/scopes/restricted/execApprovals/agents/allowSecurity",
      }),
    ]);
  });

  it("uses OPENCLAW_HOME for the default exec approvals artifact path", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const openclawHome = join(workspaceDir, "home");
    const approvalsDir = join(openclawHome, ".openclaw");
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    await fs.mkdir(approvalsDir, { recursive: true });
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ execApprovals: { defaults: { allowSecurity: ["deny"] } } }),
      "utf-8",
    );
    await fs.writeFile(
      join(approvalsDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, defaults: { security: "full" } }),
      "utf-8",
    );

    process.env.OPENCLAW_HOME = openclawHome;
    try {
      registerPolicyDoctorChecks();
      const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

      expect(result.findings).toEqual([
        expect.objectContaining({
          checkId: "policy/exec-approvals-default-security-unapproved",
          ocPath: "oc://exec-approvals.json/defaults",
        }),
      ]);
    } finally {
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
    }
  });

  it("uses OPENCLAW_STATE_DIR for the exec approvals artifact path", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    const stateDir = join(workspaceDir, "state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ execApprovals: { defaults: { allowSecurity: ["deny"] } } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, defaults: { security: "deny" } }),
      "utf-8",
    );
    await fs.writeFile(
      join(stateDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, defaults: { security: "full" } }),
      "utf-8",
    );

    process.env.OPENCLAW_STATE_DIR = stateDir;

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/exec-approvals-default-security-unapproved",
        ocPath: "oc://exec-approvals.json/defaults",
      }),
    ]);
  });

  it("rejects unsupported exec approval allowlist requirement keys", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        execApprovals: {
          agents: {
            allowlist: {
              expected: [{ pattern: "deploy", argpattern: "^--prod$" }],
            },
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
          target: "oc://policy.jsonc/execApprovals/agents/allowlist/expected/#0",
        }),
      ]),
    );
  });

  it("targets the missing exec approvals artifact when required", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ execApprovals: { requireFile: true } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/exec-approvals-missing",
        target: "oc://exec-approvals.json",
        requirement: "oc://policy.jsonc/execApprovals/requireFile",
      }),
    ]);
  });

  it("rejects required versionless exec approvals artifacts", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    await fs.writeFile(configPath, "{}", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        execApprovals: { requireFile: true, defaults: { allowSecurity: ["deny"] } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "exec-approvals.json"),
      JSON.stringify({ defaults: { security: "deny" } }),
      "utf-8",
    );

    registerPolicyDoctorChecks();
    const result = await runDoctorLintChecks(ctx(configPath, cfgWithPolicy()));

    expect(result.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/exec-approvals-invalid",
        requirement: "oc://policy.jsonc/execApprovals",
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
