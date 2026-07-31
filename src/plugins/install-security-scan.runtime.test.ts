import { beforeEach, describe, expect, it, vi } from "vitest";

const runInstallPolicyMock = vi.fn();
const findBlockedManifestDependenciesMock = vi.fn();
const findBlockedNodeModulesDirectoryMock = vi.fn();
const findBlockedNodeModulesFileAliasMock = vi.fn();
const findBlockedPackageDirectoryInPathMock = vi.fn();
const findBlockedPackageFileAliasInPathMock = vi.fn();
const getGlobalHookRunnerMock = vi.fn();
const scanDirectoryWithSummaryMock = vi.fn();

vi.mock("../security/install-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/install-policy.js")>();
  return {
    ...actual,
    runInstallPolicy: (...args: unknown[]) => runInstallPolicyMock(...args),
  };
});

vi.mock("./dependency-denylist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dependency-denylist.js")>();
  return {
    ...actual,
    findBlockedManifestDependencies: (...args: unknown[]) =>
      findBlockedManifestDependenciesMock(...args),
    findBlockedNodeModulesDirectory: (...args: unknown[]) =>
      findBlockedNodeModulesDirectoryMock(...args),
    findBlockedNodeModulesFileAlias: (...args: unknown[]) =>
      findBlockedNodeModulesFileAliasMock(...args),
    findBlockedPackageDirectoryInPath: (...args: unknown[]) =>
      findBlockedPackageDirectoryInPathMock(...args),
    findBlockedPackageFileAliasInPath: (...args: unknown[]) =>
      findBlockedPackageFileAliasInPathMock(...args),
  };
});

vi.mock("./hook-runner-global.js", () => ({
  getGlobalHookRunner: () => getGlobalHookRunnerMock(),
}));

vi.mock("../skills/security/scanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills/security/scanner.js")>();
  return {
    ...actual,
    scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
  };
});

const {
  evaluateSkillInstallPolicyRuntime,
  preflightPluginNpmInstallPolicyRuntime,
  scanBundleInstallSourceRuntime,
} = await import("./install-security-scan.runtime.js");

function expectOnlyOperatorPolicyRan() {
  expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
  expect(findBlockedManifestDependenciesMock).not.toHaveBeenCalled();
  expect(findBlockedNodeModulesDirectoryMock).not.toHaveBeenCalled();
  expect(findBlockedNodeModulesFileAliasMock).not.toHaveBeenCalled();
  expect(findBlockedPackageDirectoryInPathMock).not.toHaveBeenCalled();
  expect(findBlockedPackageFileAliasInPathMock).not.toHaveBeenCalled();
  expect(getGlobalHookRunnerMock).not.toHaveBeenCalled();
}

describe("install security scan official bypass", () => {
  beforeEach(() => {
    runInstallPolicyMock.mockReset();
    findBlockedManifestDependenciesMock.mockReset();
    findBlockedNodeModulesDirectoryMock.mockReset();
    findBlockedNodeModulesFileAliasMock.mockReset();
    findBlockedPackageDirectoryInPathMock.mockReset();
    findBlockedPackageFileAliasInPathMock.mockReset();
    getGlobalHookRunnerMock.mockReset();
    scanDirectoryWithSummaryMock.mockReset();
  });

  it("bypasses plugin install friction for bundled OpenClaw sources", async () => {
    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "openclaw/kitchen-sink",
      sourceDir: "/tmp/openclaw-bundled-plugin",
      source: { kind: "bundled", authority: "openclaw", mutable: false, network: false },
    });

    expect(result).toBeUndefined();
    expectOnlyOperatorPolicyRan();
  });

  it("bypasses plugin install friction for official ClawHub sources", async () => {
    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "@openclaw/matrix",
      sourceDir: "/tmp/openclaw-official-clawhub-plugin",
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

    const result = await scanBundleInstallSourceRuntime({
      logger: {},
      pluginId: "@openclaw/matrix",
      sourceDir: "/tmp/openclaw-official-clawhub-plugin",
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
    // An operator-policy block short-circuits before the content scan runs.
    expect(scanDirectoryWithSummaryMock).not.toHaveBeenCalled();
  });
});

describe("evaluateSkillInstallPolicyRuntime content scan gate", () => {
  beforeEach(() => {
    runInstallPolicyMock.mockReset();
    scanDirectoryWithSummaryMock.mockReset();
    getGlobalHookRunnerMock.mockReset();
  });

  it("blocks a skill whose source directory has critical scan findings", async () => {
    scanDirectoryWithSummaryMock.mockResolvedValue({
      scannedFiles: 1,
      critical: 1,
      warn: 0,
      info: 0,
      truncated: false,
      findings: [
        {
          ruleId: "dangerous-exec",
          severity: "critical",
          file: "/tmp/skill/evil.js",
          line: 4,
          message: "executes a shell command",
          evidence: "execSync(...)",
        },
      ],
    });

    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: { type: "workspace", skillName: "evil", installId: "node" },
      source: { kind: "workspace", authority: "user", mutable: true, network: false },
      skillName: "evil",
      sourceDir: "/tmp/skill",
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_blocked",
        reason: expect.stringContaining("blocked by content security scan"),
      },
    });
    // Operator policy still runs first; the content gate is additive.
    expect(runInstallPolicyMock).toHaveBeenCalledTimes(1);
    expect(scanDirectoryWithSummaryMock).toHaveBeenCalledWith("/tmp/skill", {
      includeHiddenDirectories: true,
    });
  });

  it("passes a clean skill source directory through unblocked", async () => {
    scanDirectoryWithSummaryMock.mockResolvedValue({
      scannedFiles: 2,
      critical: 0,
      warn: 0,
      info: 0,
      truncated: false,
      findings: [],
    });

    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: { type: "workspace", skillName: "clean", installId: "node" },
      source: { kind: "workspace", authority: "user", mutable: true, network: false },
      skillName: "clean",
      sourceDir: "/tmp/clean",
    });

    expect(result).toBeUndefined();
    expect(scanDirectoryWithSummaryMock).toHaveBeenCalledWith("/tmp/clean", {
      includeHiddenDirectories: true,
    });
  });

  it("does not scan image-shipped bundled OpenClaw skills", async () => {
    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: { type: "openclaw-bundled", skillName: "peekaboo", installId: "node" },
      source: { kind: "bundled", authority: "openclaw", mutable: false, network: false },
      skillName: "peekaboo",
      sourceDir: "/tmp/openclaw-bundled-skill/peekaboo",
    });

    expect(result).toBeUndefined();
    expect(scanDirectoryWithSummaryMock).not.toHaveBeenCalled();
  });

  it("does not scan image-shipped managed OpenClaw skills", async () => {
    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: { type: "openclaw-managed", skillName: "managed-skill", installId: "node" },
      source: { kind: "managed", authority: "openclaw", mutable: false, network: false },
      skillName: "managed-skill",
      sourceDir: "/tmp/openclaw-managed-skill/managed-skill",
    });

    expect(result).toBeUndefined();
    expect(scanDirectoryWithSummaryMock).not.toHaveBeenCalled();
  });

  it("content-scans official immutable ClawHub sources that bypass install friction", async () => {
    scanDirectoryWithSummaryMock.mockResolvedValue({
      scannedFiles: 1,
      critical: 1,
      warn: 0,
      info: 0,
      truncated: false,
      findings: [
        {
          ruleId: "dangerous-exec",
          severity: "critical",
          file: "/tmp/clawhub/evil.js",
          line: 1,
          message: "executes a shell command",
          evidence: "child_process",
        },
      ],
    });

    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "clawhub",
      logger: {},
      origin: { type: "clawhub", registry: "clawhub", slug: "evil", version: "1.0.0" },
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
      skillName: "evil",
      sourceDir: "/tmp/clawhub",
    });

    expect(result?.blocked?.code).toBe("security_scan_blocked");
    expect(scanDirectoryWithSummaryMock).toHaveBeenCalledWith("/tmp/clawhub", {
      includeHiddenDirectories: true,
    });
  });

  it("fails closed with security_scan_failed when the scanner throws", async () => {
    scanDirectoryWithSummaryMock.mockRejectedValueOnce(new Error("scanner blew up"));

    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: { type: "workspace", skillName: "broken", installId: "node" },
      source: { kind: "workspace", authority: "user", mutable: true, network: false },
      skillName: "broken",
      sourceDir: "/tmp/broken",
    });

    expect(result).toEqual({
      blocked: {
        code: "security_scan_failed",
        reason: expect.stringContaining("content security scan failed"),
      },
    });
  });

  it("does not block on non-critical findings but surfaces them as warnings", async () => {
    const warnings: string[] = [];
    scanDirectoryWithSummaryMock.mockResolvedValue({
      scannedFiles: 1,
      critical: 0,
      warn: 1,
      info: 0,
      truncated: false,
      findings: [
        {
          ruleId: "maybe-sketchy",
          severity: "warn",
          file: "/tmp/sketch/index.js",
          line: 2,
          message: "looks odd",
          evidence: "foo",
        },
      ],
    });

    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: { warn: (message: string) => warnings.push(message) },
      origin: { type: "workspace", skillName: "sketch", installId: "node" },
      source: { kind: "workspace", authority: "user", mutable: true, network: false },
      skillName: "sketch",
      sourceDir: "/tmp/sketch",
    });

    expect(result).toBeUndefined();
    expect(warnings).toContainEqual(expect.stringContaining("maybe-sketchy"));
  });

  it("blocks when the content scan is truncated (fail-closed: refuse unscannable content)", async () => {
    scanDirectoryWithSummaryMock.mockResolvedValue({
      scannedFiles: 500,
      critical: 0,
      warn: 0,
      info: 0,
      truncated: true,
      findings: [],
    });

    const result = await evaluateSkillInstallPolicyRuntime({
      installId: "node",
      logger: {},
      origin: { type: "workspace", skillName: "big", installId: "node" },
      source: { kind: "workspace", authority: "user", mutable: true, network: false },
      skillName: "big",
      sourceDir: "/tmp/big",
    });

    expect(result?.blocked?.code).toBe("security_scan_blocked");
    expect(result?.blocked?.reason).toContain("could not complete");
  });
});
