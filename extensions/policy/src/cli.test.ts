// Policy tests cover cli plugin behavior.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Command } from "commander";
import { clearConfigCache } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPolicyCli } from "./cli.js";
import { createPolicyAttestation, policyDocumentHash } from "./policy-state.js";

let workspaceDir: string;

type PolicyCheckCliOptions = {
  readonly severityMin?: string;
};

type PolicyWatchCliOptions = {
  readonly intervalMs?: string;
};

type PolicyCompareCliOptions = {
  readonly baseline: string;
  readonly policy?: string;
};

async function runPolicyCli(args: readonly string[]) {
  const output: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = new Command().name("openclaw");
    registerPolicyCli(program);
    await program.parseAsync(["policy", ...args], { from: "user" });
    const lastOutput = output.at(-1) ?? "";
    const parsed = /^[{[]/.test(lastOutput.trimStart()) ? JSON.parse(lastOutput) : {};
    return { exitCode: process.exitCode ?? 0, parsed, output };
  } finally {
    process.exitCode = previousExitCode;
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

async function runPolicyCheckJson(options: PolicyCheckCliOptions = {}) {
  return runPolicyCli([
    "check",
    "--json",
    ...(options.severityMin === undefined ? [] : ["--severity-min", options.severityMin]),
  ]);
}

async function runPolicyWatchJson(options: PolicyWatchCliOptions = {}) {
  return runPolicyCli([
    "watch",
    "--json",
    "--once",
    ...(options.intervalMs === undefined ? [] : ["--interval-ms", options.intervalMs]),
  ]);
}

function workspacePath(value: string): string {
  return isAbsolute(value) ? value : join(workspaceDir, value);
}

async function runPolicyCompareJson(options: PolicyCompareCliOptions) {
  return runPolicyCli([
    "compare",
    "--json",
    "--baseline",
    workspacePath(options.baseline),
    ...(options.policy === undefined ? [] : ["--policy", workspacePath(options.policy)]),
  ]);
}

describe("policy commands", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-cli-"));
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspaceDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearConfigCache();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("checks policy rules and emits an attestation", async () => {
    const policy = {
      channels: {
        denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
      },
    };
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(0);
    const policyHash = policyDocumentHash(policy);
    const evidence = {
      channels: [],
      mcpServers: [],
      modelProviders: [],
      modelRefs: [],
      network: [],
    };
    const attestation = createPolicyAttestation({
      ok: true,
      checkedAt: parsed.attestation.checkedAt,
      policyPath: "policy.jsonc",
      policyHash,
      evidence,
      findings: [],
    });
    expect(typeof parsed.attestation.checkedAt).toBe("string");
    expect(parsed).toMatchObject({
      ok: true,
      attestation,
      evidence,
      findings: [],
    });
  });

  it("reports policy findings in policy check output", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        channels: {
          denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
        },
      }),
      "utf-8",
    );
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      evidence: {
        channels: [],
        mcpServers: [],
        modelProviders: [],
        modelRefs: [],
        network: [],
      },
      findings: [],
    });
  });

  it("reports malformed policy rules in policy check output", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [{ when: {} }] } }),
      "utf-8",
    );
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      ok: false,
      findings: [
        {
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/channels/denyRules/#0",
        },
      ],
    });
  });

  it("reports malformed policy containers in policy check output", async () => {
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify({ tools: [] }), "utf-8");
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      ok: false,
      findings: [
        {
          checkId: "policy/policy-jsonc-invalid",
          target: "oc://policy.jsonc/tools",
        },
      ],
    });
  });

  it("reports unparseable policy files in policy check output", async () => {
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), "{ channels: ", "utf-8");
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      ok: false,
      findings: [
        {
          checkId: "policy/policy-jsonc-invalid",
          severity: "error",
          target: "oc://policy.jsonc",
        },
      ],
    });
  });

  it("links policy findings to evidence and policy requirement refs", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        plugins: {
          entries: {
            policy: { enabled: true, config: { enabled: true } },
          },
        },
        channels: { telegram: { enabled: true } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        channels: {
          denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
        },
      }),
      "utf-8",
    );
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      evidence: {
        channels: [
          {
            id: "telegram",
            source: "oc://openclaw.config/channels/telegram",
          },
        ],
      },
      findings: [
        {
          checkId: "policy/channels-denied-provider",
          ocPath: "oc://openclaw.config/channels/telegram",
          target: "oc://openclaw.config/channels/telegram",
          requirement: "oc://policy.jsonc/channels/denyRules/#0",
          policy: {
            fixRecommendation: {
              fixClass: "automatic",
              policyPath: ["channels", "denyRules"],
              configTargets: ["channels"],
              summary: "Disable product-managed channels matching the denied provider.",
            },
          },
        },
      ],
    });
    const attestedFinding = { ...parsed.findings[0] };
    expect(attestedFinding.policy).toBeDefined();
    delete attestedFinding.policy;
    const attestedOutput = createPolicyAttestation({
      ok: false,
      checkedAt: parsed.attestation.checkedAt,
      policyPath: "policy.jsonc",
      policyHash: parsed.attestation.policy.hash,
      evidence: parsed.evidence,
      findings: [attestedFinding],
    });
    const reportedOutput = createPolicyAttestation({
      ok: false,
      checkedAt: parsed.attestation.checkedAt,
      policyPath: "policy.jsonc",
      policyHash: parsed.attestation.policy.hash,
      evidence: parsed.evidence,
      findings: parsed.findings,
    });
    expect(parsed.attestation.findingsHash).toBe(attestedOutput.findingsHash);
    expect(parsed.attestation.findingsHash).not.toBe(reportedOutput.findingsHash);
  });

  it("attests underlying policy findings when the accepted attestation is stale", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        plugins: {
          entries: {
            policy: {
              enabled: true,
              config: { enabled: true, expectedAttestationHash: "sha256:not-current" },
            },
          },
        },
        channels: { telegram: { enabled: true } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        channels: {
          denyRules: [{ id: "no-telegram", when: { provider: "telegram" } }],
        },
      }),
      "utf-8",
    );
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual([
      expect.objectContaining({ checkId: "policy/attestation-hash-mismatch" }),
    ]);
    const emptyOutput = createPolicyAttestation({
      ok: false,
      checkedAt: parsed.attestation.checkedAt,
      policyPath: "policy.jsonc",
      policyHash: parsed.attestation.policy.hash,
      evidence: parsed.evidence,
      findings: [],
    });
    expect(parsed.attestation.findingsHash).not.toBe(emptyOutput.findingsHash);
    expect(parsed.attestation.attestationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("reports stale accepted attestations in policy watch", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        plugins: {
          entries: {
            policy: {
              enabled: true,
              config: { enabled: true, expectedAttestationHash: "sha256:not-current" },
            },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ channels: { denyRules: [] } }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyWatchJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      status: "stale",
      expectedAttestationHash: "sha256:not-current",
      findings: [
        {
          checkId: "policy/attestation-hash-mismatch",
        },
      ],
    });
  });

  it("rejects partial policy watch intervals before evaluating policy", async () => {
    const { exitCode, output } = await runPolicyWatchJson({ intervalMs: "500ms" });

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain("--interval-ms must be an integer >= 250.");
  });

  it("rejects sub-floor policy watch intervals before evaluating policy", async () => {
    const { exitCode, output } = await runPolicyWatchJson({ intervalMs: "249" });

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain("--interval-ms must be an integer >= 250.");
  });

  it("reports findings instead of stale when policy watch has no attestation to compare", async () => {
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), "{ channels: ", "utf-8");

    const { exitCode, parsed } = await runPolicyWatchJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      status: "findings",
      findings: [
        {
          checkId: "policy/policy-jsonc-invalid",
        },
      ],
    });
  });

  it("reports findings before stale when accepted attestation exists", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        plugins: {
          entries: {
            policy: {
              enabled: true,
              config: { enabled: true, expectedAttestationHash: "sha256:not-current" },
            },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), "{ channels: ", "utf-8");

    const { exitCode, parsed } = await runPolicyWatchJson();

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      status: "findings",
      expectedAttestationHash: "sha256:not-current",
      findings: [
        {
          checkId: "policy/policy-jsonc-invalid",
        },
      ],
    });
  });

  it("rejects invalid severity thresholds", async () => {
    const { exitCode, output } = await runPolicyCheckJson({ severityMin: "warnng" });

    expect(exitCode).toBe(2);
    expect(output).toEqual([
      "Invalid --severity-min value. Expected one of: info, warning, error.\n",
    ]);
  });

  it("fails closed when the OpenClaw config is invalid", async () => {
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(configPath, "{", "utf-8");
    const { exitCode, parsed } = await runPolicyCheckJson();

    expect(exitCode).toBe(1);
    expect(parsed.attestation).toBeUndefined();
    expect(parsed.findings).toEqual([
      expect.objectContaining({ checkId: "policy/config-invalid", severity: "error" }),
    ]);
  });

  it("checks policy file conformance with metadata-backed global rules", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        channels: { denyRules: [{ when: { provider: "telegram" } }] },
        mcp: { servers: { allow: ["docs", "audit"], deny: ["untrusted"] } },
        models: { providers: { allow: ["openai", "anthropic"], deny: ["openrouter"] } },
        network: { privateNetwork: { allow: false } },
        ingress: { session: { requireDmScope: "per-peer" } },
        gateway: {
          exposure: { allowNonLoopbackBind: false },
          auth: { requireAuth: true },
          http: { denyEndpoints: ["responses"] },
        },
        tools: { requireMetadata: ["risk"] },
        secrets: { requireManagedProviders: true, denySources: ["env"] },
        auth: { profiles: { allowModes: ["oauth", "token"], requireMetadata: ["provider"] } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        channels: { denyRules: [{ when: { provider: "telegram" } }] },
        mcp: { servers: { allow: ["docs"], deny: ["untrusted", "shadow"] } },
        models: { providers: { allow: ["openai"], deny: ["openrouter", "local"] } },
        network: { privateNetwork: { allow: false } },
        ingress: { session: { requireDmScope: "per-channel-peer" } },
        gateway: {
          exposure: { allowNonLoopbackBind: false },
          auth: { requireAuth: true },
          http: { denyEndpoints: ["responses", "chatCompletions"] },
        },
        tools: { requireMetadata: ["risk", "owner"] },
        secrets: { requireManagedProviders: true, denySources: ["env", "file"] },
        auth: { profiles: { allowModes: ["oauth"], requireMetadata: ["provider", "mode"] } },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      baselinePath: "baseline.policy.jsonc",
      policyPath: "policy.jsonc",
      findings: [],
    });
    expect(parsed.rulesChecked).toBeGreaterThan(10);
  });

  it("accepts exec approval allowlist conformance entries with argPattern", async () => {
    const policy = {
      execApprovals: {
        agents: {
          allowAutoAllowSkills: false,
          allowlist: {
            expected: ["status", { pattern: "calendar-cli", argPattern: "^sync\\b" }],
          },
        },
      },
    };
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify(policy),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      findings: [],
    });
  });

  it("rejects unsupported exec approval allowlist requirement keys in policy compare", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
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
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        execApprovals: {
          agents: {
            allowlist: {
              expected: [{ pattern: "deploy", argPattern: "^--prod$" }],
            },
          },
        },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      ok: false,
      rulesChecked: 0,
    });
    expect(parsed.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-conformance-invalid",
          target: "oc://baseline.policy.jsonc/execApprovals/agents/allowlist/expected/#0",
        }),
      ]),
    );
  });

  it("reports missing and weaker policy file conformance rules", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        channels: { denyRules: [{ when: { provider: "telegram" } }] },
        network: { privateNetwork: { allow: false } },
        gateway: { auth: { requireAuth: true } },
        secrets: { denySources: ["env"] },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "candidate.policy.jsonc"),
      JSON.stringify({
        channels: { denyRules: [{ when: { provider: "Telegram" } }] },
        network: { privateNetwork: { allow: true } },
        secrets: { denySources: [] },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
      policy: "candidate.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-conformance-weaker",
          requirement: "oc://baseline.policy.jsonc/channels/denyRules",
        }),
        expect.objectContaining({
          checkId: "policy/policy-conformance-weaker",
          requirement: "oc://baseline.policy.jsonc/network/privateNetwork/allow",
        }),
        expect.objectContaining({
          checkId: "policy/policy-conformance-missing",
          requirement: "oc://baseline.policy.jsonc/gateway/auth/requireAuth",
        }),
        expect.objectContaining({
          checkId: "policy/policy-conformance-weaker",
          requirement: "oc://baseline.policy.jsonc/secrets/denySources",
        }),
      ]),
    );
  });

  it("returns JSON findings for malformed policy compare files", async () => {
    await fs.writeFile(join(workspaceDir, "baseline.policy.jsonc"), "{", "utf-8");
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify({}), "utf-8");

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      ok: false,
      rulesChecked: 0,
      findings: [
        {
          checkId: "policy/policy-conformance-invalid",
          target: "oc://baseline.policy.jsonc",
        },
      ],
    });
  });

  it("returns JSON findings for missing policy compare files", async () => {
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify({}), "utf-8");

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "missing.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed).toMatchObject({
      ok: false,
      rulesChecked: 0,
      findings: [
        {
          checkId: "policy/policy-conformance-invalid",
          target: "oc://missing.policy.jsonc",
        },
      ],
    });
  });

  it("does not require candidate keys for baseline rules that impose no restriction", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        channels: { denyRules: [] },
        gateway: { auth: { requireAuth: false } },
        mcp: { servers: { allow: [] } },
      }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify({}), "utf-8");

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      findings: [],
    });
  });

  it("rejects malformed baseline policy rules during policy file conformance", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        channels: { denyRules: [{ when: {} }] },
      }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify({}), "utf-8");

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-conformance-invalid",
        target: "oc://baseline.policy.jsonc/channels/denyRules",
      }),
    ]);
  });

  it("rejects malformed policy containers during policy file conformance", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        network: { privateNetwork: "bad" },
        tools: "bad",
      }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify({}), "utf-8");

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-conformance-invalid",
          target: "oc://baseline.policy.jsonc/tools",
        }),
      ]),
    );
  });

  it("rejects scoped policy rules that do not have a valid supported selector", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        scopes: {
          missingSelector: {
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
          wrongSelector: {
            channelIds: ["telegram"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify({}), "utf-8");

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-conformance-invalid",
          target: "oc://baseline.policy.jsonc/scopes/missingSelector/tools/exec/allowHosts",
        }),
        expect.objectContaining({
          checkId: "policy/policy-conformance-invalid",
          target: "oc://baseline.policy.jsonc/scopes/wrongSelector/tools/exec/allowHosts",
        }),
      ]),
    );
  });

  it("rejects unsupported enum values during policy file conformance", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        auth: { profiles: { allowModes: ["password"] } },
        gateway: { http: { denyEndpoints: ["bogus"] } },
        tools: { requireMetadata: ["custom"] },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        auth: { profiles: { allowModes: ["password"] } },
        gateway: { http: { denyEndpoints: ["bogus"] } },
        tools: { requireMetadata: ["custom"] },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-conformance-invalid",
          target: "oc://baseline.policy.jsonc/auth/profiles/allowModes",
        }),
        expect.objectContaining({
          checkId: "policy/policy-conformance-invalid",
          target: "oc://baseline.policy.jsonc/gateway/http/denyEndpoints",
        }),
        expect.objectContaining({
          checkId: "policy/policy-conformance-invalid",
          target: "oc://baseline.policy.jsonc/tools/requireMetadata",
        }),
      ]),
    );
  });

  it("normalizes model provider casing during policy file conformance", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        models: { providers: { allow: ["OpenAI"], deny: ["OpenRouter"] } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        models: { providers: { allow: ["openai"], deny: ["openrouter"] } },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(0);
    expect(parsed.findings).toEqual([]);
  });

  it("rejects gateway HTTP endpoint ids with invalid casing during policy file conformance", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        gateway: { http: { denyEndpoints: ["chatCompletions"] } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        gateway: { http: { denyEndpoints: ["chatcompletions"] } },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy/policy-conformance-invalid",
          target: "oc://policy.jsonc/gateway/http/denyEndpoints/#0",
        }),
      ]),
    );
  });

  it("resolves the default compare policy path from the configured agent workspace", async () => {
    const agentWorkspace = join(workspaceDir, "agent-workspace");
    await fs.mkdir(agentWorkspace, { recursive: true });
    const configPath = join(workspaceDir, "openclaw.jsonc");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: { defaults: { workspace: agentWorkspace } },
        plugins: {
          entries: {
            policy: { enabled: true, config: { enabled: true, path: "policy.jsonc" } },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        network: { privateNetwork: { allow: false } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(agentWorkspace, "policy.jsonc"),
      JSON.stringify({
        network: { privateNetwork: { allow: false } },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: join(workspaceDir, "baseline.policy.jsonc"),
    });

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      policyPath: "policy.jsonc",
      findings: [],
    });
  });

  it("allows a top-level candidate rule to satisfy a scoped baseline rule", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
          telegram: {
            channelIds: ["telegram"],
            ingress: { channels: { requireMentionInGroups: true } },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { exec: { allowHosts: ["sandbox"] } },
        ingress: { channels: { requireMentionInGroups: true } },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(0);
    expect(parsed.findings).toEqual([]);
  });

  it("rejects a weaker scoped candidate override even when top-level policy satisfies baseline", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { exec: { allowHosts: ["sandbox"] } },
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox", "node"] } },
          },
        },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-conformance-invalid",
        requirement: "oc://policy.jsonc/scopes/release/tools/exec/allowHosts",
        target: "oc://policy.jsonc/scopes/release/tools/exec/allowHosts",
      }),
    ]);
  });

  it("accepts stricter later scoped candidate overlays during policy compare", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          team: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox", "node"] } },
          },
          lockdown: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(0);
    expect(parsed.findings).toEqual([]);
  });

  it("rejects duplicate scoped candidates when any matching scoped value is weaker", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
        },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        scopes: {
          release: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox"] } },
          },
          relaxed: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox", "node"] } },
          },
        },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-conformance-invalid",
        requirement: "oc://policy.jsonc/scopes/relaxed/tools/exec/allowHosts",
        target: "oc://policy.jsonc/scopes/relaxed/tools/exec/allowHosts",
      }),
    ]);
  });

  it("rejects a weaker scoped candidate override for a global baseline rule", async () => {
    await fs.writeFile(
      join(workspaceDir, "baseline.policy.jsonc"),
      JSON.stringify({
        tools: { exec: { allowHosts: ["sandbox"] } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { exec: { allowHosts: ["sandbox"] } },
        scopes: {
          relaxed: {
            agentIds: ["main"],
            tools: { exec: { allowHosts: ["sandbox", "node"] } },
          },
        },
      }),
      "utf-8",
    );

    const { exitCode, parsed } = await runPolicyCompareJson({
      baseline: "baseline.policy.jsonc",
    });

    expect(exitCode).toBe(1);
    expect(parsed.findings).toEqual([
      expect.objectContaining({
        checkId: "policy/policy-conformance-invalid",
        requirement: "oc://policy.jsonc/scopes/relaxed/tools/exec/allowHosts",
        target: "oc://policy.jsonc/scopes/relaxed/tools/exec/allowHosts",
      }),
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
