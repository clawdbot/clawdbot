import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const runInstallPolicyMock = vi.fn();
const getGlobalHookRunnerMock = vi.fn();

vi.mock("../security/install-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/install-policy.js")>();
  return {
    ...actual,
    runInstallPolicy: (...args: unknown[]) => runInstallPolicyMock(...args),
  };
});

vi.mock("./hook-runner-global.js", () => ({
  getGlobalHookRunner: () => getGlobalHookRunnerMock(),
}));

const {
  evaluateSkillInstallPolicyRuntime,
  preflightPluginNpmInstallPolicyRuntime,
  scanBundleInstallSourceRuntime,
  scanFileInstallSourceRuntime,
  scanInstalledPackageDependencyTreeRuntime,
  scanPackageInstallSourceRuntime,
} = await import("./install-security-scan.runtime.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeTempDir(prefix = "openclaw-install-scan-") {
  return tempDirs.make(prefix);
}

async function addEscapingDependencyLink(rootDir: string) {
  const outsideRoot = makeTempDir("openclaw-install-outside-");
  const dependencyLink = path.join(rootDir, "node_modules", "outside-package");
  await fs.mkdir(path.dirname(dependencyLink), { recursive: true });
  await fs.symlink(outsideRoot, dependencyLink, "junction");
}

function expectOnlyOperatorPolicyRan() {
  expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
}

function expectedInstallPolicyNotice(params: {
  decision: "warn" | "block";
  findings?: string[];
  guidance?: string[];
  reason: string;
  targetName: string;
  targetType: "skill" | "plugin";
}): string {
  const lines = [
    params.decision === "warn" ? "Install requires approval" : "Install blocked by policy",
    "",
    `  ${params.targetType === "skill" ? "Skill" : "Plugin"}: ${params.targetName}`,
    `  Reason: ${params.reason}`,
  ];
  if (params.findings?.length) {
    lines.push("  Findings:", ...params.findings.map((finding) => `    • ${finding}`));
  }
  if (params.guidance?.length) {
    lines.push("", ...params.guidance);
  }
  return lines.join("\n");
}

beforeEach(() => {
  runInstallPolicyMock.mockReset();
  getGlobalHookRunnerMock.mockReset();
});

describe("install security scan official bypass", () => {
  it("bypasses plugin install friction for bundled OpenClaw sources", async () => {
    const sourceDir = makeTempDir();
    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "openclaw/kitchen-sink",
      sourceDir,
      source: { kind: "bundled", authority: "openclaw", mutable: false, network: false },
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("bypasses plugin install friction for official ClawHub sources", async () => {
    const sourceDir = makeTempDir();
    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "@openclaw/matrix",
      sourceDir,
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("bypasses skill install friction for bundled OpenClaw sources", async () => {
    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: {
        type: "openclaw-bundled",
        skillName: "peekaboo",
        installId: "node",
      },
      source: { kind: "bundled", authority: "openclaw", mutable: false, network: false },
      skillName: "peekaboo",
      sourceDir: "/tmp/openclaw-bundled-skill/peekaboo",
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("runs only operator policy for official immutable npm sources", async () => {
    const result = await preflightPluginNpmInstallPolicyRuntime({
      logger: {},
      packageName: "@openclaw/matrix",
      requestedSpecifier: "@openclaw/matrix@latest",
      source: { kind: "npm", authority: "official", mutable: false, network: true },
      sourcePath: "/tmp/openclaw-official-npm",
      sourcePathKind: "directory",
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("lets operator policy block official sources", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });

    const sourceDir = makeTempDir();
    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "@openclaw/matrix",
      sourceDir,
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expectOnlyOperatorPolicyRan();
  });

  it("rejects escaping dependency symlinks for official bundle sources", async () => {
    const sourceDir = makeTempDir();
    await addEscapingDependencyLink(sourceDir);

    await expect(
      scanBundleInstallSourceRuntime({
        logger: {},
        pluginId: "@openclaw/matrix",
        sourceDir,
        source: { kind: "clawhub", authority: "official", mutable: false, network: true },
      }),
    ).rejects.toThrow("node_modules symlink target outside install root");
    expect(runInstallPolicyMock).not.toHaveBeenCalled();
  });

  it("rejects escaping dependency symlinks for trusted official packages", async () => {
    const packageDir = makeTempDir();
    await addEscapingDependencyLink(packageDir);

    await expect(
      scanPackageInstallSourceRuntime({
        extensions: ["index.js"],
        logger: {},
        packageDir,
        pluginId: "@openclaw/matrix",
        source: { kind: "npm", authority: "official", mutable: false, network: true },
        trustedSourceLinkedOfficialInstall: true,
      }),
    ).rejects.toThrow("node_modules symlink target outside install root");
    expect(runInstallPolicyMock).not.toHaveBeenCalled();
  });

  it("still runs install policy for mutable workspace skill sources", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });

    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: {
        type: "workspace",
        skillName: "local-skill",
        installId: "node",
      },
      source: { kind: "workspace", authority: "user", mutable: true, network: false },
      skillName: "local-skill",
      sourceDir: "/tmp/local-skill",
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });
});

describe("installed dependency tree scan", () => {
  it("accepts a managed host link declared as a runtime dependency", async () => {
    const npmRoot = makeTempDir();
    const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
    const hostLink = path.join(packageDir, "node_modules", "openclaw");
    await fs.mkdir(path.dirname(hostLink), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "runtime-plugin",
        dependencies: { openclaw: "2026.7.1" },
      }),
      "utf8",
    );
    await fs.symlink(process.cwd(), hostLink, "junction");

    const result = await scanInstalledPackageDependencyTreeRuntime({
      allowManagedNpmRootPackagePeerSymlinks: true,
      dependencyScanRootDir: npmRoot,
      logger: {},
      packageDir,
      pluginId: "runtime-plugin",
    });

    expect(result).toBeUndefined();
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an openclaw dependency symlink that does not target the trusted host", async () => {
    const npmRoot = makeTempDir();
    const outsideRoot = makeTempDir("openclaw-install-outside-");
    const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
    const hostLink = path.join(packageDir, "node_modules", "openclaw");
    await fs.mkdir(path.dirname(hostLink), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "runtime-plugin",
        dependencies: { openclaw: "2026.7.1" },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(outsideRoot, "package.json"), '{"name":"openclaw"}', "utf8");
    await fs.symlink(outsideRoot, hostLink, "junction");

    await expect(
      scanInstalledPackageDependencyTreeRuntime({
        allowManagedNpmRootPackagePeerSymlinks: true,
        dependencyScanRootDir: npmRoot,
        logger: {},
        packageDir,
        pluginId: "runtime-plugin",
      }),
    ).rejects.toThrow("installed dependency scan found package outside install root");
  });

  it("rejects escaping dependency symlinks for trusted official installs", async () => {
    const npmRoot = makeTempDir();
    const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "runtime-plugin" }),
      "utf8",
    );
    await addEscapingDependencyLink(packageDir);

    await expect(
      scanInstalledPackageDependencyTreeRuntime({
        dependencyScanRootDir: npmRoot,
        logger: {},
        packageDir,
        pluginId: "runtime-plugin",
        source: { kind: "npm", authority: "official", mutable: false, network: true },
        trustedSourceLinkedOfficialInstall: true,
      }),
    ).rejects.toThrow("node_modules symlink target outside install root");
    expect(runInstallPolicyMock).not.toHaveBeenCalled();
  });
});

describe("package dependency boundaries", () => {
  it("rejects dependency symlinks outside the staged package", async () => {
    const packageDir = makeTempDir();
    const outsideRoot = makeTempDir("openclaw-install-outside-");
    const dependencyLink = path.join(packageDir, "node_modules", "outside-package");
    await fs.mkdir(path.dirname(dependencyLink), { recursive: true });
    await fs.symlink(outsideRoot, dependencyLink, "junction");

    await expect(
      scanPackageInstallSourceRuntime({
        extensions: ["index.js"],
        logger: {},
        packageDir,
        pluginId: "boundary-test",
      }),
    ).rejects.toThrow("node_modules symlink target outside install root");
    expect(runInstallPolicyMock).not.toHaveBeenCalled();
  });
});

describe("legacy file install scan compatibility", () => {
  it("continues after one acknowledgement and a fresh evaluation of the same warning", async () => {
    const onInstallPolicyWarning = vi.fn().mockResolvedValue({ status: "approved" });
    runInstallPolicyMock
      .mockResolvedValueOnce({
        warning: { reason: "review this plugin", fingerprint: "warning-a" },
      })
      .mockResolvedValueOnce({
        warning: { reason: "review this plugin", fingerprint: "warning-a" },
      });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      onInstallPolicyWarning,
      pluginId: "payload",
    });

    expect(result).toBeUndefined();
    expect(onInstallPolicyWarning).toHaveBeenCalledWith({
      reason: "review this plugin",
      targetName: "payload",
      targetType: "plugin",
      requestMode: "install",
    });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(2);
  });

  it("requires approval again when policy re-evaluation returns a changed warning", async () => {
    const onInstallPolicyWarning = vi.fn().mockResolvedValue({ status: "approved" });
    runInstallPolicyMock
      .mockResolvedValueOnce({
        warning: { reason: "review this plugin", fingerprint: "warning-a" },
      })
      .mockResolvedValueOnce({
        warning: { reason: "review the new finding", fingerprint: "warning-b" },
        findings: [
          {
            ruleId: "changed-warning",
            severity: "warn",
            message: "new finding",
          },
        ],
      });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      onInstallPolicyWarning,
      pluginId: "payload",
    });

    expect(result?.blocked).toMatchObject({
      code: "security_scan_blocked",
    });
    expect(result?.blocked?.reason).toContain("Reason: review the new finding");
    expect(result?.blocked?.reason).toContain("new finding");
    expect(result?.blocked?.reason).toContain("The policy warning changed after approval.");
    expect(onInstallPolicyWarning).toHaveBeenCalledTimes(1);
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(2);
  });

  it("renders metadata changes that require approval again", async () => {
    const onInstallPolicyWarning = vi.fn().mockResolvedValue({ status: "approved" });
    const initialWarning = {
      warning: { reason: "same bounded reason", fingerprint: "full-warning-a" },
      findings: [
        {
          ruleId: "initial-rule",
          severity: "warn" as const,
          message: "same bounded message",
          evidence: "initial evidence",
        },
      ],
    };
    runInstallPolicyMock.mockResolvedValueOnce(initialWarning).mockResolvedValueOnce({
      warning: { ...initialWarning.warning, fingerprint: "full-warning-b" },
      findings: [
        {
          ruleId: "refreshed-rule",
          severity: "critical",
          message: "same bounded message",
          evidence: "refreshed evidence",
        },
      ],
    });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      onInstallPolicyWarning,
      pluginId: "payload",
    });

    expect(result?.blocked?.reason).toContain("The policy warning changed after approval.");
    expect(result?.blocked?.reason).toContain("same bounded reason");
    expect(result?.blocked?.reason).toContain(
      "[CRITICAL] refreshed-rule: same bounded message Evidence: refreshed evidence",
    );
    expect(result?.blocked?.reason).not.toContain("initial-rule");
    expect(result?.blocked?.reason).not.toContain("initial evidence");
    expect(onInstallPolicyWarning).toHaveBeenCalledTimes(1);
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the deprecated unsafe flag inert when policy warns", async () => {
    runInstallPolicyMock.mockResolvedValue({
      warning: { reason: "review this plugin", fingerprint: "warning-a" },
    });

    const result = await scanFileInstallSourceRuntime({
      dangerouslyForceUnsafeInstall: true,
      filePath: "/tmp/payload.js",
      logger: {},
      pluginId: "payload",
    });

    expect(result?.blocked).toEqual({
      code: "security_scan_blocked",
      installPolicyWarning: {
        reason: "review this plugin",
        requestMode: "install",
        targetName: "payload",
        targetType: "plugin",
      },
      reason: expectedInstallPolicyNotice({
        decision: "warn",
        guidance: [
          "This invocation cannot approve install policy warnings.",
          "To continue:",
          "  • Run the matching direct `openclaw plugins ...` or `openclaw skills ...` command interactively.",
          "  • For reviewed direct CLI automation, add --acknowledge-install-policy-warning.",
          "  • If no equivalent direct command exists, change security.installPolicy to allow this reviewed request, then retry.",
          "  • --force does not approve install policy warnings.",
        ],
        reason: "review this plugin",
        targetName: "payload",
        targetType: "plugin",
      }),
    });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a block from acknowledged policy re-evaluation terminal", async () => {
    runInstallPolicyMock
      .mockResolvedValueOnce({
        warning: { reason: "review this plugin", fingerprint: "warning-a" },
      })
      .mockResolvedValueOnce({
        blocked: { code: "security_scan_blocked", reason: "now blocked" },
      });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      onInstallPolicyWarning: vi.fn().mockResolvedValue({ status: "approved" }),
      pluginId: "payload",
    });

    expect(result?.blocked).toEqual({ code: "security_scan_blocked", reason: "now blocked" });
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(2);
  });

  it("renders warning details as one readable review notice", async () => {
    const warnings: string[] = [];
    runInstallPolicyMock.mockResolvedValue({
      warning: { reason: "review this plugin", fingerprint: "warning-a" },
      findings: [{ ruleId: "context", severity: "info", message: "Informational context." }],
    });

    await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: { warn: (message) => warnings.push(message) },
      onInstallPolicyWarning: vi.fn().mockResolvedValue({ status: "declined" }),
      pluginId: "payload",
    });

    expect(warnings).toEqual([
      `${expectedInstallPolicyNotice({
        decision: "warn",
        findings: ["[INFO] context: Informational context."],
        reason: "review this plugin",
        targetName: "payload",
        targetType: "plugin",
      })}\n`,
    ]);
  });

  it("renders install policy blocks as one readable denial", async () => {
    runInstallPolicyMock.mockResolvedValue({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by install policy: unapproved source",
      },
      findings: [{ ruleId: "blocked", severity: "critical", message: "Unsafe package." }],
    });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      pluginId: "payload",
    });

    expect(result?.blocked?.reason).toBe(
      expectedInstallPolicyNotice({
        decision: "block",
        findings: ["[CRITICAL] blocked: Unsafe package."],
        reason: "unapproved source",
        targetName: "payload",
        targetType: "plugin",
      }),
    );
  });

  function createMaximumPolicyFindings() {
    const maxText = "x".repeat(1_000);
    return {
      maxText,
      findings: Array.from({ length: 100 }, (_, index) => ({
        ruleId: `${String(index).padStart(3, "0")}${"r".repeat(997)}`,
        severity: "critical" as const,
        message: maxText,
        file: maxText,
        evidence: maxText,
      })),
    };
  }

  it("fails closed when a maximum-size warning exceeds the aggregate display limit", async () => {
    const { findings, maxText } = createMaximumPolicyFindings();
    runInstallPolicyMock.mockResolvedValue({
      warning: {
        reason: maxText,
        fingerprint: "oversized-warning",
      },
      findings,
    });
    const onInstallPolicyWarning = vi.fn().mockResolvedValue({ status: "approved" });
    const warnings: string[] = [];

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: { warn: (message) => warnings.push(message) },
      onInstallPolicyWarning,
      pluginId: "payload",
    });

    expect(result?.blocked).toEqual({
      code: "security_scan_failed",
      reason:
        "install policy failed closed: policy review exceeds the 4,000-character display limit; reduce or coalesce the reason and findings",
    });
    expect(result?.blocked?.reason.length).toBeLessThan(200);
    expect(onInstallPolicyWarning).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a changed warning exceeds the aggregate display limit", async () => {
    const { findings, maxText } = createMaximumPolicyFindings();
    runInstallPolicyMock
      .mockResolvedValueOnce({
        warning: {
          reason: "review this plugin",
          fingerprint: "initial-warning",
        },
      })
      .mockResolvedValueOnce({
        warning: {
          reason: maxText,
          fingerprint: "oversized-warning",
        },
        findings,
      });
    const onInstallPolicyWarning = vi.fn().mockResolvedValue({ status: "approved" });
    const warnings: string[] = [];

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: { warn: (message) => warnings.push(message) },
      onInstallPolicyWarning,
      pluginId: "payload",
    });

    expect(result?.blocked).toEqual({
      code: "security_scan_failed",
      reason:
        "install policy failed closed: policy review exceeds the 4,000-character display limit; reduce or coalesce the reason and findings",
    });
    expect(onInstallPolicyWarning).toHaveBeenCalledTimes(1);
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(2);
    expect(warnings.join("\n")).toContain("review this plugin");
    expect(warnings.join("\n")).not.toContain(maxText);
  });

  it.each([
    { size: 4_000, code: "security_scan_blocked" },
    { size: 4_001, code: "security_scan_failed" },
  ] as const)(
    "enforces the aggregate warning boundary at $size characters",
    async ({ size, code }) => {
      const reason = "r".repeat(1_000);
      const ruleId = "u".repeat(700);
      const message = "m".repeat(700);
      const file = "f".repeat(700);
      const findingPrefix = `[CRITICAL] ${ruleId}: ${message} (${file}) Evidence: `;
      const guidance = [
        "This invocation cannot approve install policy warnings.",
        "To continue:",
        "  • Run the matching direct `openclaw plugins ...` or `openclaw skills ...` command interactively.",
        "  • For reviewed direct CLI automation, add --acknowledge-install-policy-warning.",
        "  • If no equivalent direct command exists, change security.installPolicy to allow this reviewed request, then retry.",
        "  • --force does not approve install policy warnings.",
      ];
      const withoutEvidence = expectedInstallPolicyNotice({
        decision: "warn",
        findings: [findingPrefix],
        guidance,
        reason,
        targetName: "payload",
        targetType: "plugin",
      });
      const evidence = `${"e".repeat(size - withoutEvidence.length - 3)}\ne`;
      runInstallPolicyMock.mockResolvedValueOnce({
        warning: {
          reason,
          fingerprint: `warning-${String(size)}`,
        },
        findings: [{ ruleId, severity: "critical", message, file, evidence }],
      });

      const result = await scanFileInstallSourceRuntime({
        filePath: "/tmp/payload.js",
        logger: {},
        pluginId: "payload",
      });

      expect(result?.blocked?.code).toBe(code);
      if (size === 4_000) {
        expect(result?.blocked?.reason).toHaveLength(4_000);
      }
    },
  );

  it("keeps a maximum-size block terminal with a bounded denial", async () => {
    const { findings, maxText } = createMaximumPolicyFindings();
    runInstallPolicyMock.mockResolvedValue({
      blocked: {
        code: "security_scan_blocked",
        reason: `blocked by install policy: ${maxText}`,
      },
      findings,
    });
    const onInstallPolicyWarning = vi.fn().mockResolvedValue({ status: "approved" });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      onInstallPolicyWarning,
      pluginId: "payload",
    });

    expect(result?.blocked?.code).toBe("security_scan_blocked");
    expect(result?.blocked?.reason).toContain("Findings omitted");
    expect(result?.blocked?.reason.length).toBeLessThanOrEqual(4_000);
    expect(onInstallPolicyWarning).not.toHaveBeenCalled();
  });

  it("bounds maximum-size allow findings without blocking the install", async () => {
    const { findings } = createMaximumPolicyFindings();
    runInstallPolicyMock.mockResolvedValue({ findings });
    const warnings: string[] = [];

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: { warn: (message) => warnings.push(message) },
      pluginId: "payload",
    });

    expect(result).toBeUndefined();
    expect(warnings.join("\n")).toContain("additional findings omitted");
    expect(warnings.join("\n").length).toBeLessThanOrEqual(4_000);
  });

  it.each(["security_scan_blocked", "security_scan_failed"] as const)(
    "does not let acknowledgement override %s",
    async (code) => {
      runInstallPolicyMock.mockResolvedValueOnce({
        blocked: { code, reason: "blocked by operator policy" },
      });

      const result = await scanFileInstallSourceRuntime({
        dangerouslyForceUnsafeInstall: true,
        filePath: "/tmp/payload.js",
        logger: {},
        pluginId: "payload",
      });

      expect(result?.blocked?.reason).toBe("blocked by operator policy");
    },
  );

  it("preserves policy and hook metadata for published lazy install chunks", async () => {
    const warnings: string[] = [];
    const hasHooks = vi.fn().mockReturnValue(true);
    const runBeforeInstall = vi.fn().mockResolvedValue(undefined);
    getGlobalHookRunnerMock.mockReturnValue({ hasHooks, runBeforeInstall });
    runInstallPolicyMock.mockResolvedValueOnce({
      findings: [
        {
          ruleId: "registry-review",
          severity: "warn",
          message: "Registry requires review.",
        },
      ],
    });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: { warn: (message) => warnings.push(message) },
      mode: "update",
      pluginId: "payload",
      requestedSpecifier: "./payload.js",
    });

    expect(result).toBeUndefined();
    expect(warnings).toEqual(["Install policy: [WARN] registry-review: Registry requires review."]);
    expect(runInstallPolicyMock).toHaveBeenCalledWith({
      config: undefined,
      logger: expect.any(Object),
      request: {
        targetName: "payload",
        targetType: "plugin",
        sourcePath: "/tmp/payload.js",
        sourcePathKind: "file",
        source: { kind: "file", authority: "user", mutable: true, network: false },
        origin: { type: "plugin-file" },
        request: {
          kind: "plugin-file",
          mode: "update",
          requestedSpecifier: "./payload.js",
        },
        plugin: {
          contentType: "file",
          pluginId: "payload",
          extensions: ["payload.js"],
        },
      },
    });
    expect(hasHooks).toHaveBeenCalledWith("before_install");
    expect(runBeforeInstall).toHaveBeenCalledWith(
      {
        targetName: "payload",
        targetType: "plugin",
        origin: "plugin-file",
        sourcePath: "/tmp/payload.js",
        sourcePathKind: "file",
        request: {
          kind: "plugin-file",
          mode: "update",
          requestedSpecifier: "./payload.js",
        },
        builtinScan: {
          status: "ok",
          scannedFiles: 0,
          critical: 0,
          warn: 0,
          info: 0,
          findings: [],
        },
        plugin: {
          contentType: "file",
          pluginId: "payload",
          extensions: ["payload.js"],
        },
      },
      {
        origin: "plugin-file",
        targetType: "plugin",
        requestKind: "plugin-file",
      },
    );
  });

  it("returns operator policy blocks before invoking hooks", async () => {
    runInstallPolicyMock.mockResolvedValueOnce({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });

    const result = await scanFileInstallSourceRuntime({
      filePath: "/tmp/payload.js",
      logger: {},
      pluginId: "payload",
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: "blocked by operator policy",
      },
    });
    expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
  });
});
