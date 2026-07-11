// Doctor core checks tests cover core doctor checks and repair hints.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillStatusEntry } from "../skills/discovery/status.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  CORE_HEALTH_CHECKS,
  createCoreHealthChecks,
  resetCoreHealthChecksForTest,
  type CoreHealthCheckDeps,
} from "./doctor-core-checks.js";
import { clearHealthChecksForTest } from "./health-check-registry.js";
import type { HealthCheck, HealthFinding, HealthRepairEffect } from "./health-checks.js";

const mocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn(async () => []),
  detectExtraGatewayServiceIssues: vi.fn(async (): Promise<readonly { label: string }[]> => []),
  extraGatewayServiceToHealthFinding: vi.fn(
    (service: { label: string }): HealthFinding => ({
      checkId: "core/doctor/gateway-services/extra",
      severity: "warning",
      message: service.label,
    }),
  ),
  extraGatewayServiceToRepairEffects: vi.fn((): readonly HealthRepairEffect[] => []),
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../commands/doctor-gateway-services.js", () => ({
  detectExtraGatewayServiceIssues: mocks.detectExtraGatewayServiceIssues,
  extraGatewayServiceToHealthFinding: mocks.extraGatewayServiceToHealthFinding,
  extraGatewayServiceToRepairEffects: mocks.extraGatewayServiceToRepairEffects,
}));

const runtime = { log() {}, error() {}, exit() {} };

function createSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    name: "missing-tool",
    description: "Missing tool",
    source: "workspace",
    bundled: false,
    filePath: "/tmp/openclaw-test-workspace/skills/missing-tool/SKILL.md",
    baseDir: "/tmp/openclaw-test-workspace/skills/missing-tool",
    skillKey: "missing-tool",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: false,
    platformIncompatible: false,
    modelVisible: false,
    userInvocable: true,
    commandVisible: false,
    requirements: {
      bins: ["openclaw-test-missing-skill-bin"],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: ["openclaw-test-missing-skill-bin"],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

function createDeps(overrides: Partial<CoreHealthCheckDeps> = {}): CoreHealthCheckDeps {
  return {
    async detectUnavailableSkills(): Promise<readonly SkillStatusEntry[]> {
      return [];
    },
    async collectSecurityWarnings(): Promise<readonly string[]> {
      return [];
    },
    async collectWorkspaceSuggestionNotes(): Promise<readonly string[]> {
      return [];
    },
    async collectRuntimeToolSchemaFindings() {
      return [];
    },
    async collectProviderCatalogProjectionFindings() {
      return [];
    },
    async collectLocalAudioAccelerationFindings() {
      return [];
    },
    async collectGatewayHealthFindings() {
      return [];
    },
    async collectGatewayDaemonFindings() {
      return [];
    },
    ...overrides,
  };
}

function getCheck(checks: readonly HealthCheck[], id: string): HealthCheck {
  const check = checks.find((entry) => entry.id === id);
  if (!check) {
    throw new Error(`Missing health check ${id}`);
  }
  return check;
}

describe("CORE_HEALTH_CHECKS", () => {
  let tmp: string | undefined;
  let hooksModelCatalogCase: {
    calls: unknown[][];
  };

  beforeAll(async () => {
    clearHealthChecksForTest();
    resetCoreHealthChecksForTest();
    mocks.loadModelCatalog.mockClear();
    mocks.loadModelCatalog.mockResolvedValue([]);
    const cfg: OpenClawConfig = {
      hooks: {
        gmail: {
          model: "openai/gpt-5.5",
        },
      },
    };
    const check = getCheck(createCoreHealthChecks(createDeps()), "core/doctor/hooks-model");

    await check.detect({
      mode: "lint" as const,
      runtime,
      cfg,
    });

    hooksModelCatalogCase = {
      calls: [...mocks.loadModelCatalog.mock.calls],
    };
    clearHealthChecksForTest();
    resetCoreHealthChecksForTest();
  });

  beforeEach(() => {
    mocks.loadModelCatalog.mockClear();
    mocks.loadModelCatalog.mockResolvedValue([]);
    mocks.detectExtraGatewayServiceIssues.mockClear();
    mocks.detectExtraGatewayServiceIssues.mockResolvedValue([]);
    mocks.extraGatewayServiceToHealthFinding.mockClear();
    mocks.extraGatewayServiceToRepairEffects.mockClear();
    tmp = undefined;
  });

  afterEach(async () => {
    if (tmp) {
      await fs.rm(tmp, { force: true, recursive: true });
    }
  });

  it("does not include placeholder health registry entries", () => {
    expect(
      CORE_HEALTH_CHECKS.some((check) =>
        check.description.endsWith("represented in the health registry."),
      ),
    ).toBe(false);
  });

  it("reports local STT auto-selection diagnostics", async () => {
    const finding: HealthFinding = {
      checkId: "core/doctor/local-audio-acceleration",
      severity: "info",
      message:
        "Local STT auto-selection: whisper-cli (capable=metal, observed=unknown); build capability is not runtime observation.",
    };
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          async collectLocalAudioAccelerationFindings() {
            return [finding];
          },
        }),
      ),
      "core/doctor/local-audio-acceleration",
    );

    await expect(check.detect({ mode: "lint", runtime, cfg: {} })).resolves.toEqual([finding]);
  });

  it("warns when autonomous Skill Workshop capture is enabled but policy hides its tool", async () => {
    const check = getCheck(
      createCoreHealthChecks(createDeps()),
      "core/doctor/skill-workshop-tool-policy",
    );

    const findings = await check.detect({
      mode: "doctor",
      runtime,
      cfg: {
        skills: { workshop: { autonomous: { enabled: true } } },
        tools: { profile: "messaging" },
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/skill-workshop-tool-policy",
        severity: "warning",
        message: 'tools.profile: "messaging" does not include "skill_workshop".',
        path: "tools.profile",
        fixHint: 'Add tools.alsoAllow: ["skill_workshop"].',
      }),
    ]);
  });

  it("does not warn when autonomous Skill Workshop capture is disabled", async () => {
    const check = getCheck(
      createCoreHealthChecks(createDeps()),
      "core/doctor/skill-workshop-tool-policy",
    );

    await expect(
      check.detect({
        mode: "doctor",
        runtime,
        cfg: { tools: { profile: "messaging" } },
      }),
    ).resolves.toEqual([]);
  });

  it("threads deep mode into structured extra gateway service detection", async () => {
    const check = getCheck(
      createCoreHealthChecks(createDeps()),
      "core/doctor/gateway-services/extra",
    );
    mocks.detectExtraGatewayServiceIssues.mockResolvedValueOnce([
      {
        label: "custom-gateway.service",
      },
    ]);

    const ctx = {
      mode: "lint" as const,
      runtime,
      cfg: {},
      deep: true,
    };

    await check.detect(ctx);

    expect(mocks.detectExtraGatewayServiceIssues).toHaveBeenCalledWith({ deep: true });
    expect(mocks.extraGatewayServiceToHealthFinding).toHaveBeenCalledWith(
      {
        label: "custom-gateway.service",
      },
      0,
      [{ label: "custom-gateway.service" }],
    );
  });

  it("threads deep mode into structured extra gateway service repair previews", async () => {
    const check = getCheck(
      createCoreHealthChecks(createDeps()),
      "core/doctor/gateway-services/extra",
    );
    mocks.detectExtraGatewayServiceIssues.mockResolvedValueOnce([
      {
        label: "legacy-gateway.service",
      },
    ]);
    mocks.extraGatewayServiceToRepairEffects.mockReturnValueOnce([
      {
        kind: "service",
        action: "would-remove-legacy-gateway-service",
        target: "legacy-gateway.service",
        dryRunSafe: false,
      },
    ]);

    const ctx = {
      mode: "fix" as const,
      runtime,
      cfg: {},
      deep: true,
      dryRun: true,
    };

    const result = await check.repair?.(ctx, []);

    expect(mocks.detectExtraGatewayServiceIssues).toHaveBeenCalledWith({ deep: true });
    expect(result?.effects).toContainEqual(
      expect.objectContaining({
        target: "legacy-gateway.service",
      }),
    );
  });

  it("exposes gateway health findings as an opt-in structured check", async () => {
    const findings: HealthFinding[] = [
      {
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: "Gateway is not reachable.",
      },
    ];
    const collectGatewayHealthFindings = vi.fn(async () => findings);
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          collectGatewayHealthFindings,
        }),
      ),
      "core/doctor/gateway-health",
    );
    const ctx = {
      mode: "lint" as const,
      runtime,
      cfg: { gateway: { mode: "local" as const } },
    };

    await expect(check.detect(ctx)).resolves.toBe(findings);

    expect(collectGatewayHealthFindings).toHaveBeenCalledWith(ctx);
    expect((check as { defaultEnabled?: boolean }).defaultEnabled).toBe(false);
  });

  it("exposes gateway daemon findings as an opt-in structured check", async () => {
    const findings: HealthFinding[] = [
      {
        checkId: "core/doctor/gateway-daemon",
        severity: "warning",
        message: "Gateway service is not installed.",
      },
    ];
    const collectGatewayDaemonFindings = vi.fn(async () => findings);
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          collectGatewayDaemonFindings,
        }),
      ),
      "core/doctor/gateway-daemon",
    );
    const ctx = {
      mode: "lint" as const,
      runtime,
      cfg: { gateway: { mode: "local" as const } },
    };

    await expect(check.detect(ctx)).resolves.toBe(findings);

    expect(collectGatewayDaemonFindings).toHaveBeenCalledWith(ctx);
    expect((check as { defaultEnabled?: boolean }).defaultEnabled).toBe(false);
  });

  it("converts unavailable skills into repair-capable health findings", async () => {
    const unavailableSkill = createSkill();
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: "/tmp/openclaw-test-workspace",
          skills: ["missing-tool"],
        },
      },
    };
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          async detectUnavailableSkills(): Promise<readonly SkillStatusEntry[]> {
            return [unavailableSkill];
          },
        }),
      ),
      "core/doctor/skills-readiness",
    );

    expect(check).toMatchObject({ defaultEnabled: false });
    expect(check["repair"]).toBeTypeOf("function");

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg,
      cwd: "/tmp/openclaw-test-workspace",
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/skills-readiness",
        severity: "warning",
        path: "skills.entries.missing-tool.enabled",
      }),
    );
    await expect(
      check.detect(
        {
          mode: "fix",
          runtime,
          cfg,
          cwd: "/tmp/openclaw-test-workspace",
        },
        { paths: ["skills.entries.other-tool.enabled"] },
      ),
    ).resolves.toEqual([]);
    await expect(
      check.detect(
        {
          mode: "fix",
          runtime,
          cfg,
          cwd: "/tmp/openclaw-test-workspace",
        },
        { paths: ["skills.entries.missing-tool.enabled"] },
      ),
    ).resolves.toContainEqual(
      expect.objectContaining({
        path: "skills.entries.missing-tool.enabled",
      }),
    );

    const repaired = await check.repair?.(
      {
        mode: "fix",
        runtime,
        cfg,
        cwd: "/tmp/openclaw-test-workspace",
      },
      findings,
    );
    expect(repaired?.config?.skills?.entries?.["missing-tool"]).toEqual({ enabled: false });
    expect(repaired?.changes).toContain("Disabled unavailable skill missing-tool.");
    expect(repaired?.effects).toContainEqual(
      expect.objectContaining({
        kind: "config",
        action: "disable-skill",
        target: "skills.entries.missing-tool.enabled",
      }),
    );
  });

  it("converts security doctor warnings into health findings", async () => {
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          async collectSecurityWarnings(): Promise<readonly string[]> {
            return [
              '- CRITICAL: Gateway bound to "lan" (0.0.0.0) without authentication.',
              '- WARNING: Gateway bound to "lan" (0.0.0.0).',
            ];
          },
        }),
      ),
      "core/doctor/security",
    );

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        gateway: {
          bind: "lan",
          auth: {
            mode: "none",
          },
        },
      },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/security",
        severity: "error",
        message: expect.stringContaining("Gateway bound"),
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/security",
        severity: "warning",
        message: expect.stringContaining("Gateway bound"),
      }),
    );
  });

  it("reports disabled Codex plugin routes as core health findings", async () => {
    const check = getCheck(
      createCoreHealthChecks(createDeps()),
      "core/doctor/codex-session-routes",
    );

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "gpt-5.5",
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(findings).toStrictEqual([
      expect.objectContaining({
        checkId: "core/doctor/codex-session-routes",
        severity: "warning",
        path: "agents.defaults.model.primary",
        target: "openai/gpt-5.5",
        requirement: "Codex plugin enabled for routes that use the Codex runtime.",
        fixHint:
          "Run `openclaw doctor --fix`: it enables plugins.entries.codex, or set the affected OpenAI models to an OpenClaw runtime policy.",
      }),
    ]);
    expect(findings[0]?.message).toContain("Codex plugin is disabled by config");
  });

  it("uses the read-only model catalog for hooks.gmail.model checks", async () => {
    const cfg: OpenClawConfig = {
      hooks: {
        gmail: {
          model: "openai/gpt-5.5",
        },
      },
    };
    expect(hooksModelCatalogCase.calls).toContainEqual([{ config: cfg, readOnly: true }]);
  });

  it("skips gateway auth warning when SecretRef-managed token resolves in lint checks", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");
    await withEnvAsync({ OPENCLAW_TEST_GATEWAY_TOKEN: "resolved-test-token" }, async () => {
      const findings = await check?.detect({
        mode: "lint",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_TEST_GATEWAY_TOKEN",
              },
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        },
        cwd: tmp,
      });

      expect(findings).toEqual([]);
    });
  });

  it("reports unresolved SecretRefs even when OPENCLAW_GATEWAY_TOKEN is set", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "fallback-token",
        OPENCLAW_MISSING_GATEWAY_REF_TOKEN: undefined,
      },
      async () => {
        const findings = await check?.detect({
          mode: "lint",
          runtime: { log() {}, error() {}, exit() {} },
          cfg: {
            gateway: {
              mode: "local",
              auth: {
                mode: "token",
                token: {
                  source: "env",
                  provider: "default",
                  id: "OPENCLAW_MISSING_GATEWAY_REF_TOKEN",
                },
              },
            },
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
          },
          cwd: tmp,
        });

        expect(findings).toContainEqual(
          expect.objectContaining({
            checkId: "core/doctor/gateway-auth",
            message: expect.stringContaining("Gateway token SecretRef could not be resolved:"),
          }),
        );
      },
    );
  });

  it("does not execute or warn for valid exec SecretRefs during default gateway auth lint checks", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-exec-ref-"));
    const markerPath = join(tmp, "exec-ran");
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");

    const findings = await check?.detect({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg: {
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: {
              source: "exec",
              provider: "default",
              id: "value",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: "/bin/sh",
              args: ["-c", `cat >/dev/null; printf executed > ${JSON.stringify(markerPath)}`],
              jsonOnly: false,
              allowInsecurePath: true,
            },
          },
        },
      },
      cwd: tmp,
    });

    expect(findings).toEqual([]);
    await expect(fs.readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes exec SecretRefs when gateway auth lint explicitly allows exec checks", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-exec-ref-"));
    const markerPath = join(tmp, "exec-ran");
    const resolverPath = join(tmp, "resolve-token.cjs");
    await fs.writeFile(
      resolverPath,
      [
        "const fs = require('node:fs');",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync(process.argv[2], 'executed');",
        "  process.stdout.write('resolved-token');",
        "});",
      ].join("\n"),
      "utf8",
    );
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");

    const findings = await check?.detect({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg: {
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: {
              source: "exec",
              provider: "default",
              id: "value",
            },
          },
        },
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
              args: [resolverPath, markerPath],
              jsonOnly: false,
              allowInsecurePath: true,
              allowSymlinkCommand: true,
            },
          },
        },
      },
      cwd: tmp,
      allowExecSecretRefs: true,
    });

    expect(findings).toEqual([]);
    await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("executed");
  });

  it("reports exec SecretRef failures when gateway auth lint explicitly allows exec checks", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-exec-ref-"));
    const resolverPath = join(tmp, "fail-token.cjs");
    await fs.writeFile(
      resolverPath,
      ["process.stdin.resume();", "process.stdin.on('end', () => process.exit(12));"].join("\n"),
      "utf8",
    );
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");

    const findings = await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "fallback-token" }, async () => {
      return await check?.detect({
        mode: "lint",
        runtime: { log() {}, error() {}, exit() {} },
        cfg: {
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: {
                source: "exec",
                provider: "default",
                id: "value",
              },
            },
          },
          secrets: {
            providers: {
              default: {
                source: "exec",
                command: process.execPath,
                args: [resolverPath],
                jsonOnly: false,
                allowInsecurePath: true,
                allowSymlinkCommand: true,
              },
            },
          },
        },
        allowExecSecretRefs: true,
      });
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/gateway-auth",
        severity: "warning",
        message: expect.stringContaining("Gateway token SecretRef could not be resolved:"),
        fixHint:
          "Run `openclaw doctor --allow-exec` to verify exec SecretRefs during doctor, or `openclaw secrets audit --allow-exec` to audit all exec SecretRefs.",
      }),
    );
  });

  it("converts workspace suggestions into info findings", async () => {
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          async collectWorkspaceSuggestionNotes(): Promise<readonly string[]> {
            return [
              [
                "- Tip: back up the workspace in a private git repo (GitHub or GitLab).",
                "- Keep ~/.openclaw out of git; it contains credentials and session history.",
              ].join("\n"),
              "Memory system not found in workspace.",
            ];
          },
        }),
      ),
      "core/doctor/workspace-suggestions",
    );

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        agents: {
          defaults: {
            workspace: "/tmp/openclaw-test-workspace",
          },
        },
      },
      cwd: "/tmp/openclaw-test-workspace",
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/workspace-suggestions",
        severity: "info",
        message: "Tip: back up the workspace in a private git repo (GitHub or GitLab).",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/workspace-suggestions",
        severity: "info",
        message: "Memory system not found in workspace.",
      }),
    );
  });

  it("reports active runtime tool schema projection findings", async () => {
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          async collectRuntimeToolSchemaFindings(): Promise<readonly HealthFinding[]> {
            return [
              {
                checkId: "core/doctor/runtime-tool-schemas",
                severity: "error",
                message:
                  "Tool fuzzplugin_move_angles from plugin fuzzplugin has an unsupported input schema for runtime projection.",
                path: "plugins.entries.fuzzplugin",
                target: "fuzzplugin_move_angles",
                requirement: 'fuzzplugin_move_angles.parameters.type must be "object"',
              },
            ];
          },
        }),
      ),
      "core/doctor/runtime-tool-schemas",
    );

    await expect(
      check.detect({
        mode: "doctor",
        runtime,
        cfg: {},
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/runtime-tool-schemas",
        severity: "error",
        target: "fuzzplugin_move_angles",
      }),
    );
  });

  it("reports active provider catalog projection findings", async () => {
    const check = getCheck(
      createCoreHealthChecks(
        createDeps({
          async collectProviderCatalogProjectionFindings(): Promise<readonly HealthFinding[]> {
            return [
              {
                checkId: "core/doctor/provider-catalog-projection",
                severity: "error",
                message:
                  "Provider catalog mockplugin cannot be projected into the unified text model catalog.",
                path: "plugins.entries.mockplugin",
                target: "mockplugin",
                requirement: "mockplugin provider catalog entry read failed",
              },
            ];
          },
        }),
      ),
      "core/doctor/provider-catalog-projection",
    );

    await expect(
      check.detect({
        mode: "doctor",
        runtime,
        cfg: {},
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        target: "mockplugin",
      }),
    );
  });

  it("registers stale session locks as a legacy-owned structured check", async () => {
    const check = getCheck(createCoreHealthChecks(createDeps()), "core/doctor/session-locks");

    if (typeof check.repair !== "function") {
      throw new Error("expected session lock check repair");
    }
    await expect(
      check.repair(
        {
          mode: "fix",
          runtime,
          cfg: {},
          cwd: "/tmp/openclaw-test-workspace",
        },
        [],
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "legacy doctor session lock contribution owns cleanup",
      }),
    );
  });
});

describe("core/doctor/bootstrap-size", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp !== undefined) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("honors the per-agent bootstrapMaxChars override in health findings", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-bootstrap-"));
    // This size fits the global default but exceeds the default agent's effective budget.
    await fs.writeFile(join(tmp, "AGENTS.md"), "a".repeat(15_000), "utf-8");

    const check = getCheck(CORE_HEALTH_CHECKS, "core/doctor/bootstrap-size");
    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        agents: {
          defaults: {
            workspace: tmp,
            bootstrapMaxChars: 20_000,
          },
          list: [{ id: "custom-agent", default: true, bootstrapMaxChars: 10_000 }],
        },
      },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/bootstrap-size",
        severity: "warning",
        message: expect.stringContaining("AGENTS.md"),
        fixHint: expect.stringContaining("agents.list[].bootstrapMaxChars"),
      }),
    );
  });
});
