import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillStatusEntry } from "../skills/discovery/status.js";
import {
  CORE_HEALTH_CHECKS,
  createCoreHealthChecks,
  type CoreHealthCheckDeps,
  registerCoreHealthChecks,
  resetCoreHealthChecksForTest,
} from "./doctor-core-checks.js";
import { doctorHealthConversionRules } from "./doctor-health-conversion-plan.js";
import {
  clearHealthChecksForTest,
  listHealthChecks,
  registerHealthCheck,
} from "./health-check-registry.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const mocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn(async () => []),
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: mocks.loadModelCatalog,
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

describe("registerCoreHealthChecks", () => {
  let tmp: string | undefined;

  beforeEach(() => {
    clearHealthChecksForTest();
    resetCoreHealthChecksForTest();
    mocks.loadModelCatalog.mockClear();
    mocks.loadModelCatalog.mockResolvedValue([]);
    tmp = undefined;
  });

  afterEach(async () => {
    if (tmp) {
      await fs.rm(tmp, { force: true, recursive: true });
    }
  });

  it("registers the built-in health checks once", () => {
    registerCoreHealthChecks();
    registerCoreHealthChecks();

    expect(listHealthChecks().map((check) => check.id)).toEqual(
      CORE_HEALTH_CHECKS.map((check) => check.id),
    );
  });

  it("can retry after a duplicate registration failure is cleared", () => {
    registerHealthCheck({
      id: "core/doctor/gateway-config",
      kind: "core",
      description: "duplicate",
      async detect() {
        return [];
      },
    });

    expect(() => registerCoreHealthChecks()).toThrow("health check already registered");

    clearHealthChecksForTest();
    registerCoreHealthChecks();

    expect(listHealthChecks()).toHaveLength(CORE_HEALTH_CHECKS.length);
  });

  it("registers only implemented core health targets from the doctor conversion inventory", () => {
    registerCoreHealthChecks();

    const registeredIds = new Set(listHealthChecks().map((check) => check.id));
    const coreTargets = new Set<string>(
      doctorHealthConversionRules.flatMap((rule) =>
        rule.target.filter((target) => target.startsWith("core/doctor/")),
      ),
    );
    const plannedOnlyTargets = [
      "core/doctor/auth-profiles/keychain",
      "core/doctor/session-locks",
      "core/doctor/gateway-daemon",
    ];

    for (const id of CORE_HEALTH_CHECKS.map((check) => check.id)) {
      if (id === "core/doctor/browser-clawd-profile-residue") {
        continue;
      }
      expect(coreTargets.has(id)).toBe(true);
    }
    for (const id of plannedOnlyTargets) {
      expect(registeredIds.has(id)).toBe(false);
    }
    expect(
      CORE_HEALTH_CHECKS.some((check) =>
        check.description.endsWith("represented in the health registry."),
      ),
    ).toBe(false);
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

    expect(check.repair).toBeTypeOf("function");

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

  it("uses the read-only model catalog for hooks.gmail.model checks", async () => {
    const cfg: OpenClawConfig = {
      hooks: {
        gmail: {
          model: "openai/gpt-5.5",
        },
      },
    };
    const check = getCheck(createCoreHealthChecks(createDeps()), "core/doctor/hooks-model");

    await check.detect({
      mode: "lint",
      runtime,
      cfg,
    });

    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({ config: cfg, readOnly: true });
  });

  it("skips gateway auth warning when SecretRef-managed token resolves in lint checks", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");
    const previousToken = process.env.OPENCLAW_TEST_GATEWAY_TOKEN;
    process.env.OPENCLAW_TEST_GATEWAY_TOKEN = "resolved-test-token";
    try {
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
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_TEST_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_TEST_GATEWAY_TOKEN = previousToken;
      }
    }
  });

  it("reports unresolved SecretRefs even when OPENCLAW_GATEWAY_TOKEN is set", async () => {
    const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/gateway-auth");
    const previousFallbackToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    const previousRefToken = process.env.OPENCLAW_MISSING_GATEWAY_REF_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "fallback-token";
    delete process.env.OPENCLAW_MISSING_GATEWAY_REF_TOKEN;
    try {
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
    } finally {
      if (previousFallbackToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousFallbackToken;
      }
      if (previousRefToken === undefined) {
        delete process.env.OPENCLAW_MISSING_GATEWAY_REF_TOKEN;
      } else {
        process.env.OPENCLAW_MISSING_GATEWAY_REF_TOKEN = previousRefToken;
      }
    }
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
    const previousFallbackToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "fallback-token";

    let findings: readonly HealthFinding[] | undefined;
    try {
      findings = await check?.detect({
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
    } finally {
      if (previousFallbackToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousFallbackToken;
      }
    }

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
                  "Tool dofbot_move_angles from plugin dofbot has an unsupported input schema for runtime projection.",
                path: "plugins.entries.dofbot",
                target: "dofbot_move_angles",
                requirement: 'dofbot_move_angles.parameters.type must be "object"',
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
        target: "dofbot_move_angles",
      }),
    );
  });
});
