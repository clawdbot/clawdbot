// ClawHub lifecycle tests cover registry metadata lookup and error handling.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

const fetchClawHubSkillDetailMock = vi.fn();
const fetchClawHubSkillInstallResolutionMock = vi.fn();
const fetchClawHubSkillVerificationMock = vi.fn();
const fetchClawHubSkillSecurityVerdictsMock = vi.fn();
const downloadClawHubSkillArchiveMock = vi.fn();
const downloadClawHubSkillArchiveUrlMock = vi.fn();
const downloadClawHubGitHubSkillArchiveMock = vi.fn();
const reportClawHubSkillInstallTelemetryMock = vi.fn();
const resolveClawHubBaseUrlMock = vi.fn(() => "https://clawhub.ai");
const isDefaultClawHubBaseUrlMock = vi.fn((baseUrl?: string) => !baseUrl);
const searchClawHubSkillsMock = vi.fn();
const archiveCleanupMock = vi.fn();
const withExtractedArchiveRootMock = vi.fn();
const installPackageDirMock = vi.fn();
const evaluateSkillInstallPolicyMock = vi.fn();
const pathExistsMock = vi.fn();
const tempDirs = createTrackedTempDirs();

vi.mock("../../infra/clawhub.js", () => ({
  fetchClawHubSkillDetail: fetchClawHubSkillDetailMock,
  fetchClawHubSkillInstallResolution: fetchClawHubSkillInstallResolutionMock,
  fetchClawHubSkillVerification: fetchClawHubSkillVerificationMock,
  fetchClawHubSkillSecurityVerdicts: fetchClawHubSkillSecurityVerdictsMock,
  downloadClawHubSkillArchive: downloadClawHubSkillArchiveMock,
  downloadClawHubSkillArchiveUrl: downloadClawHubSkillArchiveUrlMock,
  downloadClawHubGitHubSkillArchive: downloadClawHubGitHubSkillArchiveMock,
  reportClawHubSkillInstallTelemetry: reportClawHubSkillInstallTelemetryMock,
  isDefaultClawHubBaseUrl: isDefaultClawHubBaseUrlMock,
  resolveClawHubBaseUrl: resolveClawHubBaseUrlMock,
  searchClawHubSkills: searchClawHubSkillsMock,
}));

vi.mock("../../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: withExtractedArchiveRootMock,
}));

vi.mock("../../infra/install-package-dir.js", () => ({
  installPackageDir: installPackageDirMock,
}));

vi.mock("../../plugins/install-security-scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/install-security-scan.js")>();
  return {
    ...actual,
    evaluateSkillInstallPolicy: (...args: unknown[]) => evaluateSkillInstallPolicyMock(...args),
  };
});

vi.mock("../../infra/fs-safe.js", () => ({
  pathExists: pathExistsMock,
}));

const {
  installSkillFromClawHub,
  readVerifiedClawHubSkillSourceUrl,
  resolveClawHubSkillStatusLinkSync,
  resolveClawHubSkillVerificationTarget,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} = await import("./clawhub.js");

function expectInstallPackageSourceDir(sourceDir: string) {
  const call = installPackageDirMock.mock.calls.at(0);
  if (!call) {
    throw new Error("expected installPackageDir call");
  }
  expect(call[0]?.sourceDir).toBe(sourceDir);
}

function installPolicyInput() {
  const call = evaluateSkillInstallPolicyMock.mock.calls.at(0);
  if (!call) {
    throw new Error("expected evaluateSkillInstallPolicy call");
  }
  return call[0] as
    | {
        origin?: { registry?: string; slug?: string; ownerHandle?: string };
        requestedSpecifier?: string;
        source?: { kind?: string; authority?: string; mutable?: boolean; network?: boolean };
      }
    | undefined;
}

function expectInstalledSkill(
  result: Awaited<ReturnType<typeof installSkillFromClawHub>>,
  expected: { slug?: string; version?: string; targetDir?: string } = {},
) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected skill install success, got ${result.error}`);
  }
  if (expected.slug) {
    expect(result.slug).toBe(expected.slug);
  }
  if (expected.version) {
    expect(result.version).toBe(expected.version);
  }
  if (expected.targetDir) {
    expect(result.targetDir).toBe(expected.targetDir);
  }
}

function expectInvalidSlug(result: Awaited<ReturnType<typeof installSkillFromClawHub>>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected invalid slug failure");
  }
  expect(result.error).toContain("Invalid skill slug");
}

async function writeClawHubOriginFixture(params: {
  workspaceDir: string;
  slug: string;
  originSlug?: string;
  ownerHandle?: string;
  registry?: string;
  installedVersion?: string;
  installedAt?: number;
  writeLock?: boolean;
}) {
  const skillDir = path.join(params.workspaceDir, "skills", params.slug);
  const registry = params.registry ?? "https://private.example.com/clawhub";
  const installedVersion = params.installedVersion ?? "1.2.3";
  const installedAt = params.installedAt ?? 123;
  await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, ".clawhub", "origin.json"),
    `${JSON.stringify(
      {
        version: 1,
        registry,
        slug: params.originSlug ?? params.slug,
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        installedVersion,
        installedAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (params.writeLock !== false) {
    await fs.mkdir(path.join(params.workspaceDir, ".clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(params.workspaceDir, ".clawhub", "lock.json"),
      `${JSON.stringify(
        {
          version: 1,
          skills: {
            [params.slug]: {
              version: installedVersion,
              installedAt,
              registry,
              ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  return skillDir;
}

describe("skills-clawhub", () => {
  afterEach(async () => {
    await tempDirs.cleanup();
  });

  beforeEach(() => {
    fetchClawHubSkillDetailMock.mockReset();
    fetchClawHubSkillInstallResolutionMock.mockReset();
    fetchClawHubSkillVerificationMock.mockReset();
    fetchClawHubSkillSecurityVerdictsMock.mockReset();
    downloadClawHubSkillArchiveMock.mockReset();
    downloadClawHubSkillArchiveUrlMock.mockReset();
    downloadClawHubGitHubSkillArchiveMock.mockReset();
    reportClawHubSkillInstallTelemetryMock.mockReset();
    resolveClawHubBaseUrlMock.mockReset();
    isDefaultClawHubBaseUrlMock.mockReset();
    searchClawHubSkillsMock.mockReset();
    archiveCleanupMock.mockReset();
    withExtractedArchiveRootMock.mockReset();
    installPackageDirMock.mockReset();
    evaluateSkillInstallPolicyMock.mockReset();
    pathExistsMock.mockReset();

    resolveClawHubBaseUrlMock.mockImplementation((baseUrl?: string) =>
      (baseUrl ?? "https://clawhub.ai").replace(/\/+$/, ""),
    );
    isDefaultClawHubBaseUrlMock.mockImplementation(
      (baseUrl?: string) => !baseUrl || baseUrl.replace(/\/+$/, "") === "https://clawhub.ai",
    );
    pathExistsMock.mockImplementation(async (input: string) => input.endsWith("SKILL.md"));
    fetchClawHubSkillDetailMock.mockResolvedValue({
      skill: {
        slug: "agentreceipt",
        displayName: "AgentReceipt",
        createdAt: 1,
        updatedAt: 2,
      },
      latestVersion: {
        version: "1.0.0",
        createdAt: 3,
      },
    });
    fetchClawHubSkillInstallResolutionMock.mockResolvedValue({
      ok: true,
      slug: "agentreceipt",
      installKind: "archive",
      archive: {
        version: "1.0.0",
        downloadUrl: "https://clawhub.ai/api/v1/download?slug=agentreceipt&version=1.0.0",
      },
    });
    fetchClawHubSkillVerificationMock.mockResolvedValue({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      card: { available: true, sha256: "card-sha" },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: { source: "unavailable" },
      security: { status: "clean", signals: { staticScan: { engineVersion: "v2.4.24" } } },
      signature: { status: "unsigned" },
    });
    fetchClawHubSkillSecurityVerdictsMock.mockImplementation(
      async (params: {
        items: Array<{ slug: string; ownerHandle?: string; version: string }>;
      }) => ({
        schema: "clawhub.skill.security-verdicts.v1",
        items: params.items.map((item) => ({
          ok: true,
          decision: "pass",
          reasons: [],
          requestedSlug: item.slug,
          requestedVersion: item.version,
          slug: item.slug,
          version: item.version,
          displayName: "Agent Receipt",
          ...(item.ownerHandle ? { publisherHandle: item.ownerHandle } : {}),
          security: {
            status: "clean",
            passed: true,
          },
        })),
      }),
    );
    downloadClawHubSkillArchiveMock.mockResolvedValue({
      archivePath: "/tmp/agentreceipt.zip",
      integrity: "sha256-test",
      sha256Hex: "a".repeat(64),
      artifact: "archive",
      cleanup: archiveCleanupMock,
    });
    downloadClawHubSkillArchiveUrlMock.mockResolvedValue({
      archivePath: "/tmp/agentreceipt.zip",
      integrity: "sha256-test",
      sha256Hex: "a".repeat(64),
      artifact: "archive",
      cleanup: archiveCleanupMock,
    });
    downloadClawHubGitHubSkillArchiveMock.mockResolvedValue({
      archivePath: "/tmp/github-agentreceipt.zip",
      integrity: "sha256-github-test",
      sha256Hex: "b".repeat(64),
      artifact: "archive",
      cleanup: archiveCleanupMock,
    });
    reportClawHubSkillInstallTelemetryMock.mockResolvedValue(undefined);
    archiveCleanupMock.mockResolvedValue(undefined);
    searchClawHubSkillsMock.mockResolvedValue([]);
    withExtractedArchiveRootMock.mockImplementation(async (params) => {
      expect(params.rootMarkers).toEqual(["SKILL.md", "skill.md", "skills.md", "SKILL.MD"]);
      return await params.onExtracted("/tmp/extracted-skill");
    });
    installPackageDirMock.mockResolvedValue({
      ok: true,
      targetDir: "/tmp/workspace/skills/agentreceipt",
    });
    evaluateSkillInstallPolicyMock.mockResolvedValue(undefined);
  });

  it("installs ClawHub skills from flat-root archives", async () => {
    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(fetchClawHubSkillInstallResolutionMock).toHaveBeenCalledWith({
      slug: "agentreceipt",
      baseUrl: undefined,
    });
    expect(downloadClawHubSkillArchiveUrlMock).toHaveBeenCalledWith({
      url: "https://clawhub.ai/api/v1/download?slug=agentreceipt&version=1.0.0",
      baseUrl: undefined,
    });
    expectInstallPackageSourceDir("/tmp/extracted-skill");
    expect(installPolicyInput()).toMatchObject({
      origin: { registry: "https://clawhub.ai" },
      source: { kind: "clawhub", authority: "openclaw", mutable: false, network: true },
    });
    expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
      targetDir: "/tmp/workspace/skills/agentreceipt",
    });
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
    expect(reportClawHubSkillInstallTelemetryMock).toHaveBeenCalledWith({
      baseUrl: undefined,
      slug: "agentreceipt",
      version: "1.0.0",
    });
  });

  it("bypasses ClawHub trust checks for official skill install resolutions", async () => {
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: true,
      slug: "agentreceipt",
      channel: "official",
      isOfficial: true,
      installKind: "archive",
      archive: {
        version: "1.0.0",
        downloadUrl: "https://clawhub.ai/api/v1/download?slug=agentreceipt&version=1.0.0",
      },
    });
    fetchClawHubSkillSecurityVerdictsMock.mockRejectedValueOnce(new Error("should not be called"));

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
      targetDir: "/tmp/workspace/skills/agentreceipt",
    });
    expect(fetchClawHubSkillSecurityVerdictsMock).not.toHaveBeenCalled();
    expect(installPolicyInput()).toMatchObject({
      origin: { registry: "https://clawhub.ai" },
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });
  });

  it("bypasses ClawHub trust checks when skill detail has an official owner", async () => {
    fetchClawHubSkillDetailMock.mockResolvedValueOnce({
      skill: {
        slug: "tao-setup-nvidia-gpu-host",
        displayName: "TAO Setup NVIDIA GPU Host",
        createdAt: 1,
        updatedAt: 2,
      },
      owner: {
        handle: "nvidia",
        displayName: "NVIDIA",
        official: true,
      },
      latestVersion: {
        version: "1.0.0",
        createdAt: 3,
      },
    });
    fetchClawHubSkillSecurityVerdictsMock.mockRejectedValueOnce(new Error("should not be called"));

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "tao-setup-nvidia-gpu-host",
    });

    expectInstalledSkill(result, {
      slug: "tao-setup-nvidia-gpu-host",
      version: "1.0.0",
      targetDir: "/tmp/workspace/skills/tao-setup-nvidia-gpu-host",
    });
    expect(fetchClawHubSkillDetailMock).toHaveBeenCalledWith({
      slug: "tao-setup-nvidia-gpu-host",
      baseUrl: undefined,
    });
    expect(fetchClawHubSkillSecurityVerdictsMock).not.toHaveBeenCalled();
    expect(installPolicyInput()).toMatchObject({
      origin: { registry: "https://clawhub.ai" },
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });
  });

  it("blocks ClawHub skill installs when release trust is malicious", async () => {
    const warnings: string[] = [];
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: false,
          decision: "fail",
          reasons: ["scan:malicious"],
          requestedSlug: "agentreceipt",
          requestedVersion: "1.0.0",
          slug: "agentreceipt",
          version: "1.0.0",
          publisherHandle: "acme",
          security: {
            status: "malicious",
            passed: false,
          },
        },
      ],
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "@acme/agentreceipt",
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected malicious skill install failure");
    }
    expect(result.error).toBe("ClawHub blocked this release; install was not started.");
    expect(result.code).toBe("clawhub_download_blocked");
    expect(result.warning).toContain("BLOCKED - ClawHub flagged this release as malicious");
    expect(warnings.join("\n")).toContain("BLOCKED - ClawHub flagged this release as malicious");
    expect(warnings.join("\n")).toContain("OpenClaw will not install this skill release");
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
  });

  it("requires acknowledgement before installing suspicious ClawHub skill releases", async () => {
    const warnings: string[] = [];
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: false,
          decision: "fail",
          reasons: ["security.status_not_clean"],
          requestedSlug: "agentreceipt",
          requestedVersion: "1.0.0",
          slug: "agentreceipt",
          version: "1.0.0",
          skillUrl: "https://clawhub.ai/acme/skills/agentreceipt",
          securityAuditUrl:
            "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0",
          security: {
            status: "suspicious",
            passed: false,
          },
        },
      ],
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected suspicious skill install failure");
    }
    expect(result.error).toContain("--acknowledge-clawhub-risk");
    expect(result.version).toBe("1.0.0");
    expect(result.warning).toContain("WARNING - ClawHub found security risks");
    expect(result.warning).toContain(
      "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0",
    );
    expect(warnings.join("\n")).toContain("WARNING - ClawHub found security risks");
    expect(warnings.join("\n")).toContain(
      "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0",
    );
    expect(warnings.join("\n")).toContain("large instruction/tool-use blast radius");
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
  });

  it("returns review-recommended warnings with successful ClawHub skill installs", async () => {
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: true,
          decision: "pass",
          reasons: ["scan:pending"],
          requestedSlug: "agentreceipt",
          requestedVersion: "1.0.0",
          slug: "agentreceipt",
          version: "1.0.0",
          security: {
            status: "pending",
            passed: true,
          },
        },
      ],
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
    });
    if (!result.ok) {
      throw new Error("expected review-recommended skill install success");
    }
    expect(result.warning).toContain(
      "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check",
    );
    expect(result.warning).toContain("security scan is pending");
  });

  it("fails closed when ClawHub skill trust checks are unavailable", async () => {
    fetchClawHubSkillSecurityVerdictsMock.mockRejectedValueOnce(
      new Error("security verdicts unavailable"),
    );

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected unavailable skill trust failure");
    }
    expect(result.code).toBe("clawhub_security_unavailable");
    expect(result.error).toContain("ClawHub release trust check failed");
    expect(result.error).toContain("security verdicts unavailable");
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
  });

  it("fails closed when ClawHub returns no skill trust verdict", async () => {
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [],
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected missing skill trust verdict failure");
    }
    expect(result.code).toBe("clawhub_security_unavailable");
    expect(result.error).toContain("returned 0 verdicts");
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "omitted security",
      verdict: {},
    },
    {
      name: "null security",
      verdict: { security: null },
    },
  ])("fails closed when a passing skill verdict has $name", async ({ verdict }) => {
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: true,
          decision: "pass",
          reasons: [],
          requestedSlug: "agentreceipt",
          requestedVersion: "1.0.0",
          slug: "agentreceipt",
          version: "1.0.0",
          ...verdict,
        },
      ],
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected unusable skill trust verdict failure");
    }
    expect(result.code).toBe("clawhub_security_unavailable");
    expect(result.error).toContain("did not return a usable security verdict");
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
  });

  it("blocks ClawHub skill installs when moderation marks the release as malware-blocked", async () => {
    const warnings: string[] = [];
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: false,
          decision: "fail",
          reasons: ["moderation.malware_blocked"],
          requestedSlug: "agentreceipt",
          requestedVersion: "1.0.0",
          slug: "agentreceipt",
          version: "1.0.0",
          security: {
            status: "clean",
            passed: false,
          },
        },
      ],
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
      acknowledgeClawHubRisk: true,
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected moderation-blocked skill install failure");
    }
    expect(result.error).toBe("ClawHub blocked this release; install was not started.");
    expect(result.code).toBe("clawhub_download_blocked");
    expect(warnings.join("\n")).toContain("BLOCKED - ClawHub blocked this release");
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
  });

  it("requires acknowledgement when ClawHub returns a failed skill verdict with clean nested scan status", async () => {
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: false,
          decision: "fail",
          reasons: [],
          requestedSlug: "agentreceipt",
          requestedVersion: "1.0.0",
          slug: "agentreceipt",
          version: "1.0.0",
          security: {
            status: "clean",
            passed: false,
          },
        },
      ],
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failed skill verdict install failure");
    }
    expect(result.error).toContain("--acknowledge-clawhub-risk");
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
  });

  it("uses the owner-qualified skill name for suspicious ClawHub acknowledgements", async () => {
    const onClawHubRisk = vi.fn<
      NonNullable<Parameters<typeof installSkillFromClawHub>[0]["onClawHubRisk"]>
    >(async () => false);
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: false,
          decision: "fail",
          reasons: ["security.status_not_clean"],
          requestedSlug: "agentreceipt",
          requestedVersion: "1.0.0",
          slug: "agentreceipt",
          version: "1.0.0",
          publisherHandle: "acme",
          security: {
            status: "suspicious",
            passed: false,
          },
        },
      ],
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "@acme/agentreceipt",
      onClawHubRisk,
    });

    expect(result.ok).toBe(false);
    expect(onClawHubRisk).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "@acme/agentreceipt",
        version: "1.0.0",
      }),
    );
    const acknowledgementRequest = onClawHubRisk.mock.calls[0]?.[0];
    expect(acknowledgementRequest?.warning).toContain(
      "https://clawhub.ai/acme/skills/agentreceipt",
    );
    expect(acknowledgementRequest?.warning).toContain(
      "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0",
    );
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
  });

  it("continues after explicit acknowledgement for suspicious ClawHub skill releases", async () => {
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: false,
          decision: "fail",
          reasons: ["security.status_not_clean"],
          requestedSlug: "agentreceipt",
          requestedVersion: "1.0.0",
          slug: "agentreceipt",
          version: "1.0.0",
          security: {
            status: "suspicious",
            passed: false,
          },
        },
      ],
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
      acknowledgeClawHubRisk: true,
    });

    expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
    });
    if (!result.ok) {
      throw new Error("expected acknowledged suspicious skill install success");
    }
    expect(result.warning).toContain("WARNING - ClawHub found security risks");
    expect(downloadClawHubSkillArchiveUrlMock).toHaveBeenCalledWith({
      url: "https://clawhub.ai/api/v1/download?slug=agentreceipt&version=1.0.0",
      baseUrl: undefined,
    });
  });

  it("installs owner-qualified ClawHub skills without using owner as a local path", async () => {
    const workspaceDir = await tempDirs.make("openclaw-owner-skill-");
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: false,
          decision: "fail",
          reasons: ["skill.not_found"],
          requestedSlug: "weather",
          requestedVersion: "1.0.0",
          slug: "weather",
          version: null,
          security: null,
          error: {
            code: "skill_not_found",
            message: "Skill not found",
          },
        },
      ],
    });
    fetchClawHubSkillVerificationMock.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      slug: "weather",
      displayName: "Weather",
      pageUrl: "https://clawhub.ai/demo-owner/skills/weather",
      publisherHandle: "demo-owner",
      publisherDisplayName: "Demo Owner",
      version: "1.0.0",
      createdAt: 123,
      card: { available: true, sha256: "card-sha" },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: { source: "unavailable" },
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });
    installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# Weather\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    const result = await installSkillFromClawHub({
      workspaceDir,
      slug: "@demo-owner/weather",
    });

    expect(fetchClawHubSkillInstallResolutionMock).toHaveBeenCalledWith({
      slug: "weather",
      ownerHandle: "demo-owner",
      baseUrl: undefined,
    });
    expect(fetchClawHubSkillSecurityVerdictsMock).toHaveBeenCalledWith({
      items: [
        {
          slug: "weather",
          ownerHandle: "demo-owner",
          version: "1.0.0",
        },
      ],
      baseUrl: undefined,
      token: undefined,
      timeoutMs: undefined,
    });
    expect(fetchClawHubSkillVerificationMock).toHaveBeenNthCalledWith(1, {
      slug: "weather",
      ownerHandle: "demo-owner",
      version: "1.0.0",
      baseUrl: undefined,
      token: undefined,
      timeoutMs: undefined,
    });
    expectInstallPackageSourceDir("/tmp/extracted-skill");
    expect(installPolicyInput()).toMatchObject({
      origin: {
        registry: "https://clawhub.ai",
        slug: "weather",
        ownerHandle: "demo-owner",
      },
      requestedSpecifier: "clawhub:@demo-owner/weather@1.0.0",
    });
    expectInstalledSkill(result, {
      slug: "weather",
      version: "1.0.0",
      targetDir: path.join(workspaceDir, "skills", "weather"),
    });
    await expect(fs.access(path.join(workspaceDir, "skills", "@demo-owner"))).rejects.toThrow();

    const lock = JSON.parse(
      await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
    ) as { skills: Record<string, Record<string, unknown>> };
    expect(lock.skills.weather).toMatchObject({
      version: "1.0.0",
      registry: "https://clawhub.ai",
      ownerHandle: "demo-owner",
    });
    const origin = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, "skills", "weather", ".clawhub", "origin.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(origin).toMatchObject({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "weather",
      ownerHandle: "demo-owner",
      installedVersion: "1.0.0",
    });
    expect(reportClawHubSkillInstallTelemetryMock).toHaveBeenCalledWith({
      baseUrl: undefined,
      slug: "weather",
      ownerHandle: "demo-owner",
      version: "1.0.0",
    });
  });

  it("does not require acknowledgement for owner-qualified clean skills missing only cards", async () => {
    const workspaceDir = await tempDirs.make("openclaw-owner-card-missing-");
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: false,
          decision: "fail",
          reasons: ["skill.not_found"],
          requestedSlug: "weather",
          requestedVersion: "1.0.0",
          slug: "weather",
          version: null,
          security: null,
          error: {
            code: "skill_not_found",
            message: "Skill not found",
          },
        },
      ],
    });
    fetchClawHubSkillVerificationMock.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: false,
      decision: "fail",
      reasons: ["card.missing"],
      slug: "weather",
      displayName: "Weather",
      pageUrl: "https://clawhub.ai/demo-owner/skills/weather",
      publisherHandle: "demo-owner",
      publisherDisplayName: "Demo Owner",
      version: "1.0.0",
      createdAt: 123,
      card: { available: false },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: { source: "unavailable" },
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });
    const onClawHubRisk = vi.fn(async () => false);
    installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# Weather\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    const result = await installSkillFromClawHub({
      workspaceDir,
      slug: "@demo-owner/weather",
      onClawHubRisk,
    });

    expectInstalledSkill(result, {
      slug: "weather",
      version: "1.0.0",
      targetDir: path.join(workspaceDir, "skills", "weather"),
    });
    expect(onClawHubRisk).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveUrlMock).toHaveBeenCalled();
  });

  it("does not let owner-qualified fallback acknowledgement mask missing exact versions", async () => {
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: false,
          decision: "fail",
          reasons: ["skill.not_found"],
          requestedSlug: "weather",
          requestedVersion: "1.0.0",
          slug: "weather",
          version: null,
          security: null,
          error: {
            code: "skill_not_found",
            message: "Skill not found",
          },
        },
      ],
    });
    fetchClawHubSkillVerificationMock.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: false,
      decision: "fail",
      reasons: ["version.not_found"],
      slug: "weather",
      displayName: "Weather",
      pageUrl: "https://clawhub.ai/demo-owner/skills/weather",
      publisherHandle: "demo-owner",
      publisherDisplayName: "Demo Owner",
      version: null,
      createdAt: 123,
      card: { available: true, sha256: "card-sha" },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: { source: "unavailable" },
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "@demo-owner/weather",
      acknowledgeClawHubRisk: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected owner-qualified missing version failure");
    }
    expect(result.code).toBe("clawhub_security_unavailable");
    expect(result.error).toContain('returned version "unknown"');
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
  });

  it("formats ambiguous ClawHub slug responses with owner-qualified guidance", async () => {
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: false,
      slug: "weather",
      reason: "ambiguous_slug",
      message: "Multiple ClawHub publishers provide weather.",
      status: 409,
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "weather",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ambiguous slug failure");
    }
    expect(result.error).toContain('Skill "weather" is ambiguous on ClawHub.');
    expect(result.error).toContain("openclaw skills install @owner/weather");
    expect(result.error).toContain("Multiple ClawHub publishers provide weather.");
  });

  it("rejects malformed owner-qualified ClawHub install refs", async () => {
    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "@@demo-owner/weather",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid owner-qualified failure");
    }
    expect(result.error).toContain("Invalid ClawHub owner handle");
    expect(fetchClawHubSkillInstallResolutionMock).not.toHaveBeenCalled();
  });

  it("persists install artifact and verification provenance in the ClawHub lockfile", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skills-lock-");
    const skillContent = "---\nname: agentreceipt\ndescription: Receipt helper\n---\n";
    const skillSha256 = createHash("sha256").update(skillContent).digest("hex");
    installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), skillContent, "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    try {
      const result = await installSkillFromClawHub({
        workspaceDir,
        slug: "agentreceipt",
      });

      expectInstalledSkill(result, {
        slug: "agentreceipt",
        version: "1.0.0",
        targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
      });
      expect(fetchClawHubSkillVerificationMock).toHaveBeenCalledWith({
        slug: "agentreceipt",
        version: "1.0.0",
        baseUrl: undefined,
      });
      const lock = JSON.parse(
        await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
      ) as { skills: Record<string, Record<string, unknown>> };
      expect(lock.skills.agentreceipt).toMatchObject({
        version: "1.0.0",
        registry: "https://clawhub.ai",
        artifact: {
          kind: "archive",
          sha256: "a".repeat(64),
          integrity: "sha256-test",
        },
        skillFile: {
          path: "SKILL.md",
          sha256: skillSha256,
        },
        verification: {
          schema: "clawhub.skill.verify.v1",
          ok: true,
          decision: "pass",
          reasons: [],
          provenance: { source: "unavailable" },
          security: { status: "clean", signals: { staticScan: { engineVersion: "v2.4.24" } } },
        },
      });
      const origin = JSON.parse(
        await fs.readFile(
          path.join(workspaceDir, "skills", "agentreceipt", ".clawhub", "origin.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(origin).toMatchObject({
        version: 1,
        slug: "agentreceipt",
        installedVersion: "1.0.0",
        artifact: {
          kind: "archive",
          sha256: "a".repeat(64),
          integrity: "sha256-test",
        },
        skillFile: {
          path: "SKILL.md",
          sha256: skillSha256,
        },
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("persists the source URL from server-resolved verification provenance", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skills-source-");
    const sourceUrl = "https://github.com/openclaw/skills/tree/main/agentreceipt";
    const verifiedSourceUrl =
      "https://github.com/openclaw/skills/tree/0123456789abcdef0123456789abcdef01234567/agentreceipt";
    fetchClawHubSkillDetailMock.mockResolvedValueOnce({
      skill: {
        slug: "agentreceipt",
        displayName: "AgentReceipt",
        createdAt: 1,
        updatedAt: 2,
      },
      latestVersion: {
        version: "1.0.0",
        createdAt: 3,
      },
    });
    fetchClawHubSkillVerificationMock.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      card: { available: true },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: {
        source: "server-resolved-github-import",
        kind: "github",
        url: sourceUrl,
        repo: "openclaw/skills",
        ref: "main",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "agentreceipt",
        importedAt: 4,
      },
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });
    installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# AgentReceipt\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    try {
      const result = await installSkillFromClawHub({
        workspaceDir,
        slug: "agentreceipt",
        version: "1.0.0",
      });

      expectInstalledSkill(result, {
        slug: "agentreceipt",
        version: "1.0.0",
        targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
      });
      const lock = JSON.parse(
        await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
      ) as { skills: Record<string, Record<string, unknown>> };
      expect(lock.skills.agentreceipt).toMatchObject({
        sourceUrl: verifiedSourceUrl,
        verification: {
          provenance: {
            source: "server-resolved-github-import",
            kind: "github",
            url: sourceUrl,
            repo: "openclaw/skills",
            ref: "main",
            commit: "0123456789abcdef0123456789abcdef01234567",
            path: "agentreceipt",
            importedAt: 4,
          },
        },
      });
      const origin = JSON.parse(
        await fs.readFile(
          path.join(workspaceDir, "skills", "agentreceipt", ".clawhub", "origin.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(origin.sourceUrl).toBe(verifiedSourceUrl);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("requires a full commit SHA before promoting verified source provenance", () => {
    const baseProvenance = {
      source: "server-resolved-github-import",
      repo: "openclaw/skills",
      path: "agentreceipt",
    };

    expect(
      readVerifiedClawHubSkillSourceUrl({
        ...baseProvenance,
        commit: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toBe(
      "https://github.com/openclaw/skills/tree/0123456789abcdef0123456789abcdef01234567/agentreceipt",
    );
    expect(
      readVerifiedClawHubSkillSourceUrl({
        ...baseProvenance,
        commit: "main",
      }),
    ).toBeUndefined();
    expect(
      readVerifiedClawHubSkillSourceUrl({
        ...baseProvenance,
        commit: "0123456",
      }),
    ).toBeUndefined();
  });

  it("does not treat detail metadata as verified source provenance", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skills-source-");
    fetchClawHubSkillDetailMock.mockResolvedValueOnce({
      skill: {
        slug: "agentreceipt",
        displayName: "AgentReceipt",
        createdAt: 1,
        updatedAt: 2,
        sourceUrl: "https://github.com/openclaw/skills/tree/latest/agentreceipt",
      },
      latestVersion: {
        version: "1.0.0",
        createdAt: 3,
        sourceUrl: "https://github.com/openclaw/skills/tree/latest/agentreceipt",
      },
    });
    fetchClawHubSkillVerificationMock.mockRejectedValueOnce(new Error("verification down"));
    installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# AgentReceipt\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    try {
      const result = await installSkillFromClawHub({
        workspaceDir,
        slug: "agentreceipt",
        version: "1.0.0",
      });

      expectInstalledSkill(result, {
        slug: "agentreceipt",
        version: "1.0.0",
        targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
      });
      const lock = JSON.parse(
        await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
      ) as { skills: Record<string, Record<string, unknown>> };
      expect(lock.skills.agentreceipt?.sourceUrl).toBeUndefined();
      const origin = JSON.parse(
        await fs.readFile(
          path.join(workspaceDir, "skills", "agentreceipt", ".clawhub", "origin.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(origin.sourceUrl).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not trust URLs from unavailable verification provenance", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skills-source-");
    fetchClawHubSkillVerificationMock.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      card: { available: true },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: {
        source: "unavailable",
        url: "https://github.com/openclaw/skills/tree/unverified/agentreceipt",
      },
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });
    installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# AgentReceipt\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    try {
      const result = await installSkillFromClawHub({
        workspaceDir,
        slug: "agentreceipt",
        version: "1.0.0",
      });

      expectInstalledSkill(result, {
        slug: "agentreceipt",
        version: "1.0.0",
        targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
      });
      const lock = JSON.parse(
        await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
      ) as { skills: Record<string, Record<string, unknown>> };
      expect(lock.skills.agentreceipt?.sourceUrl).toBeUndefined();
      const origin = JSON.parse(
        await fs.readFile(
          path.join(workspaceDir, "skills", "agentreceipt", ".clawhub", "origin.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(origin.sourceUrl).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps installing when the ClawHub verification snapshot is unavailable", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skills-lock-");
    fetchClawHubSkillVerificationMock.mockRejectedValueOnce(new Error("verification down"));
    installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# AgentReceipt\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    try {
      const result = await installSkillFromClawHub({
        workspaceDir,
        slug: "agentreceipt",
      });

      expectInstalledSkill(result, { slug: "agentreceipt", version: "1.0.0" });
      const lock = JSON.parse(
        await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
      ) as { skills: Record<string, Record<string, unknown>> };
      expect(lock.skills.agentreceipt?.verification).toBeUndefined();
      expect(lock.skills.agentreceipt?.artifact).toMatchObject({
        sha256: "a".repeat(64),
        integrity: "sha256-test",
      });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("installs GitHub-backed ClawHub skills from the pinned resolver source path", async () => {
    const commit = "b".repeat(40);
    const paddedCommit = `  ${commit.toUpperCase()}\n`;
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: true,
      slug: "aiq-deploy",
      installKind: "github",
      github: {
        repo: "NVIDIA/skills",
        path: "skills/aiq-deploy",
        commit: paddedCommit,
        contentHash: "hash-aiq-deploy",
        sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
      },
    });
    withExtractedArchiveRootMock.mockImplementationOnce(async (params) => {
      expect(params.rootMarkers).toBeUndefined();
      return await params.onExtracted("/tmp/extracted-github-repo");
    });
    installPackageDirMock.mockResolvedValueOnce({
      ok: true,
      targetDir: "/tmp/workspace/skills/aiq-deploy",
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "aiq-deploy",
    });

    expect(fetchClawHubSkillInstallResolutionMock).toHaveBeenCalledWith({
      slug: "aiq-deploy",
      baseUrl: undefined,
    });
    // GitHub-backed skills are approved by the install resolver before it
    // returns this pinned commit; they do not have a ClawHub release version.
    expect(fetchClawHubSkillSecurityVerdictsMock).not.toHaveBeenCalled();
    expect(downloadClawHubGitHubSkillArchiveMock).toHaveBeenCalledWith({
      repo: "NVIDIA/skills",
      commit,
    });
    expectInstallPackageSourceDir("/tmp/extracted-github-repo/skills/aiq-deploy");
    expect(installPolicyInput()).toMatchObject({
      origin: {
        registry: "https://clawhub.ai",
        repo: "NVIDIA/skills",
        path: "skills/aiq-deploy",
        commit,
      },
      source: { kind: "git", authority: "third-party", mutable: false, network: true },
    });
    expectInstalledSkill(result, {
      slug: "aiq-deploy",
      version: commit,
      targetDir: "/tmp/workspace/skills/aiq-deploy",
    });
  });

  it("rejects a mutable GitHub ref before downloading a ClawHub skill", async () => {
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: true,
      slug: "aiq-deploy",
      installKind: "github",
      github: {
        repo: "NVIDIA/skills",
        path: "skills/aiq-deploy",
        commit: "main",
        contentHash: "hash-aiq-deploy",
        sourceUrl: "https://github.com/NVIDIA/skills/tree/main/skills/aiq-deploy",
      },
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "aiq-deploy",
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("expected a full 40-character commit SHA");
    expect(downloadClawHubGitHubSkillArchiveMock).not.toHaveBeenCalled();
    expect(withExtractedArchiveRootMock).not.toHaveBeenCalled();
    expect(installPackageDirMock).not.toHaveBeenCalled();
  });

  it("passes forceInstall to the ClawHub install resolver", async () => {
    const commit = "b".repeat(40);
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: true,
      slug: "aiq-deploy",
      installKind: "github",
      github: {
        repo: "NVIDIA/skills",
        path: "skills/aiq-deploy",
        commit,
        contentHash: "hash-aiq-deploy",
        sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
      },
    });
    withExtractedArchiveRootMock.mockImplementationOnce(async (params) => {
      return await params.onExtracted("/tmp/extracted-github-repo");
    });
    installPackageDirMock.mockResolvedValueOnce({
      ok: true,
      targetDir: "/tmp/workspace/skills/aiq-deploy",
    });

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "aiq-deploy",
      forceInstall: true,
    });

    expect(fetchClawHubSkillInstallResolutionMock).toHaveBeenCalledWith({
      slug: "aiq-deploy",
      baseUrl: undefined,
      forceInstall: true,
    });
    // forceInstall is a resolver policy input for GitHub-backed skills.
    expect(fetchClawHubSkillSecurityVerdictsMock).not.toHaveBeenCalled();
    expectInstalledSkill(result, {
      slug: "aiq-deploy",
      version: commit,
      targetDir: "/tmp/workspace/skills/aiq-deploy",
    });
  });

  it("keeps ClawHub install telemetry best-effort", async () => {
    reportClawHubSkillInstallTelemetryMock.mockRejectedValueOnce(new Error("telemetry down"));

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
    });
  });

  it("marks custom ClawHub skill registries as third-party install policy authority", async () => {
    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
      baseUrl: "https://clawhub.internal.example",
    });

    expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
    });
    expect(installPolicyInput()).toMatchObject({
      origin: { registry: "https://clawhub.internal.example" },
      source: { kind: "clawhub", authority: "third-party", mutable: false, network: true },
    });
  });

  it.each(["skill.md", "skills.md", "SKILL.MD"])(
    "installs ClawHub archives whose packed root uses legacy marker %s",
    async (marker) => {
      pathExistsMock.mockImplementation(async (input: string) => input.endsWith(marker));

      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "agentreceipt",
      });

      expectInstalledSkill(result);
      expectInstallPackageSourceDir("/tmp/extracted-skill");
    },
  );

  it("updates owner-qualified ClawHub skills with the stored owner namespace", async () => {
    const workspaceDir = await tempDirs.make("openclaw-owner-update-");
    await writeClawHubOriginFixture({
      workspaceDir,
      slug: "weather",
      ownerHandle: "demo-owner",
      registry: "https://private.example.com/clawhub",
      installedVersion: "0.9.0",
    });
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: true,
      slug: "weather",
      installKind: "archive",
      archive: {
        version: "1.0.0",
        downloadUrl:
          "https://private.example.com/clawhub/api/v1/download?slug=weather&ownerHandle=demo-owner&version=1.0.0",
      },
    });
    installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# Weather\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    const results = await updateSkillsFromClawHub({
      workspaceDir,
      slug: "weather",
    });

    expect(fetchClawHubSkillInstallResolutionMock).toHaveBeenCalledWith({
      slug: "weather",
      ownerHandle: "demo-owner",
      baseUrl: "https://private.example.com/clawhub",
    });
    expect(fetchClawHubSkillVerificationMock).toHaveBeenCalledWith({
      slug: "weather",
      ownerHandle: "demo-owner",
      version: "1.0.0",
      baseUrl: "https://private.example.com/clawhub",
    });
    expect(results).toEqual([
      {
        ok: true,
        slug: "weather",
        previousVersion: "0.9.0",
        version: "1.0.0",
        changed: true,
        targetDir: path.join(workspaceDir, "skills", "weather"),
      },
    ]);
    const lock = JSON.parse(
      await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
    ) as { skills: Record<string, Record<string, unknown>> };
    expect(lock.skills.weather?.ownerHandle).toBe("demo-owner");
  });

  it("updates official publisher ClawHub skills without fetching security verdicts", async () => {
    const workspaceDir = await tempDirs.make("openclaw-official-owner-update-");
    await writeClawHubOriginFixture({
      workspaceDir,
      slug: "tao-setup-nvidia-gpu-host",
      ownerHandle: "nvidia",
      registry: "https://clawhub.ai",
      installedVersion: "0.9.0",
    });
    fetchClawHubSkillDetailMock.mockResolvedValueOnce({
      skill: {
        slug: "tao-setup-nvidia-gpu-host",
        displayName: "TAO Setup NVIDIA GPU Host",
        createdAt: 1,
        updatedAt: 2,
      },
      owner: {
        handle: "nvidia",
        displayName: "NVIDIA",
        official: true,
      },
      latestVersion: {
        version: "1.0.0",
        createdAt: 3,
      },
    });
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: true,
      slug: "tao-setup-nvidia-gpu-host",
      installKind: "archive",
      archive: {
        version: "1.0.0",
        downloadUrl:
          "https://clawhub.ai/api/v1/download?slug=tao-setup-nvidia-gpu-host&ownerHandle=nvidia&version=1.0.0",
      },
    });
    fetchClawHubSkillSecurityVerdictsMock.mockRejectedValueOnce(new Error("should not be called"));
    installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# NVIDIA\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    const results = await updateSkillsFromClawHub({
      workspaceDir,
      slug: "tao-setup-nvidia-gpu-host",
    });

    expect(fetchClawHubSkillDetailMock).toHaveBeenCalledWith({
      slug: "tao-setup-nvidia-gpu-host",
      ownerHandle: "nvidia",
      baseUrl: "https://clawhub.ai",
    });
    expect(fetchClawHubSkillSecurityVerdictsMock).not.toHaveBeenCalled();
    expect(results).toEqual([
      {
        ok: true,
        slug: "tao-setup-nvidia-gpu-host",
        previousVersion: "0.9.0",
        version: "1.0.0",
        changed: true,
        targetDir: path.join(workspaceDir, "skills", "tao-setup-nvidia-gpu-host"),
      },
    ]);
    expect(installPolicyInput()).toMatchObject({
      origin: { registry: "https://clawhub.ai", ownerHandle: "nvidia" },
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });
  });

  it("explains that a malicious skill update will not be downloaded", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-malicious-update-");
    const warnings: string[] = [];
    await writeClawHubOriginFixture({
      workspaceDir,
      slug: "agentreceipt",
      installedVersion: "0.9.0",
    });
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: false,
          decision: "fail",
          reasons: ["scan:malicious"],
          requestedSlug: "agentreceipt",
          requestedVersion: "1.0.0",
          slug: "agentreceipt",
          version: "1.0.0",
          security: {
            status: "malicious",
            passed: false,
          },
        },
      ],
    });

    const results = await updateSkillsFromClawHub({
      workspaceDir,
      slug: "agentreceipt",
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    expect(results).toEqual([
      expect.objectContaining({
        ok: false,
        code: "clawhub_download_blocked",
        error: "ClawHub blocked this release; update was not started.",
      }),
    ]);
    expect(warnings.join("\n")).toContain(
      "Latest skill version is marked malicious; OpenClaw will not download it.",
    );
    expect(warnings.join("\n")).toContain(
      "Uninstall the installed skill unless you have independently reviewed it.",
    );
    expect(warnings.join("\n")).not.toContain("Choose a different version");
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
  });

  it("updates owner-qualified ClawHub skills when the requested owner matches tracking", async () => {
    const workspaceDir = await tempDirs.make("openclaw-owner-update-request-");
    await writeClawHubOriginFixture({
      workspaceDir,
      slug: "weather",
      ownerHandle: "demo-owner",
      installedVersion: "0.9.0",
    });
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: true,
      slug: "weather",
      installKind: "archive",
      archive: {
        version: "1.0.0",
        downloadUrl:
          "https://clawhub.ai/api/v1/download?slug=weather&ownerHandle=demo-owner&version=1.0.0",
      },
    });
    installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# Weather\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    const results = await updateSkillsFromClawHub({
      workspaceDir,
      slug: "@demo-owner/weather",
    });

    expect(fetchClawHubSkillInstallResolutionMock).toHaveBeenCalledWith({
      slug: "weather",
      ownerHandle: "demo-owner",
      baseUrl: "https://private.example.com/clawhub",
    });
    expect(results).toEqual([
      expect.objectContaining({
        ok: true,
        slug: "weather",
        previousVersion: "0.9.0",
        version: "1.0.0",
      }),
    ]);
  });

  it("rejects owner-qualified ClawHub updates when the requested owner does not match tracking", async () => {
    const workspaceDir = await tempDirs.make("openclaw-owner-update-mismatch-");
    await writeClawHubOriginFixture({
      workspaceDir,
      slug: "weather",
      ownerHandle: "other-owner",
      installedVersion: "0.9.0",
    });

    await expect(
      updateSkillsFromClawHub({
        workspaceDir,
        slug: "@demo-owner/weather",
      }),
    ).rejects.toThrow(
      'Skill "weather" is tracked as @other-owner/weather, not @demo-owner/weather.',
    );
    expect(fetchClawHubSkillInstallResolutionMock).not.toHaveBeenCalled();
  });

  describe("legacy tracked slugs remain updatable", () => {
    async function createLegacyTrackedSkillFixture(slug: string) {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-clawhub-"));
      const skillDir = path.join(workspaceDir, "skills", slug);
      await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
      await fs.writeFile(
        path.join(skillDir, ".clawhub", "origin.json"),
        `${JSON.stringify(
          {
            version: 1,
            registry: "https://legacy.clawhub.ai",
            slug,
            installedVersion: "0.9.0",
            installedAt: 123,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(workspaceDir, ".clawhub", "lock.json"),
        `${JSON.stringify(
          {
            version: 1,
            skills: {
              [slug]: {
                version: "0.9.0",
                installedAt: 123,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return { workspaceDir, skillDir };
    }

    function expectLegacyUpdateSuccess(results: unknown, workspaceDir: string, slug: string) {
      expect(Array.isArray(results)).toBe(true);
      const first = (results as Array<Record<string, unknown>>)[0];
      expect(first?.ok).toBe(true);
      expect(first?.slug).toBe(slug);
      expect(first?.previousVersion).toBe("0.9.0");
      expect(first?.version).toBe("1.0.0");
      expect(first?.targetDir).toBe(path.join(workspaceDir, "skills", slug));
    }

    it("updates all tracked legacy Unicode slugs in place", async () => {
      const slug = "re\u0430ct";
      const { workspaceDir } = await createLegacyTrackedSkillFixture(slug);
      fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
        ok: true,
        slug,
        installKind: "archive",
        archive: {
          version: "1.0.0",
          downloadUrl: `https://legacy.clawhub.ai/api/v1/download?slug=${encodeURIComponent(slug)}&version=1.0.0`,
        },
      });
      installPackageDirMock.mockResolvedValueOnce({
        ok: true,
        targetDir: path.join(workspaceDir, "skills", slug),
      });

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
        });

        expect(fetchClawHubSkillInstallResolutionMock).toHaveBeenCalledWith({
          slug,
          baseUrl: "https://legacy.clawhub.ai",
        });
        expect(downloadClawHubSkillArchiveUrlMock).toHaveBeenCalledWith({
          url: `https://legacy.clawhub.ai/api/v1/download?slug=${encodeURIComponent(slug)}&version=1.0.0`,
          baseUrl: "https://legacy.clawhub.ai",
        });
        expectLegacyUpdateSuccess(results, workspaceDir, slug);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("passes forceInstall to resolver for tracked updates", async () => {
      const slug = "agentreceipt";
      const { workspaceDir } = await createLegacyTrackedSkillFixture(slug);
      fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
        ok: true,
        slug,
        installKind: "archive",
        archive: {
          version: "1.0.0",
          downloadUrl: `https://legacy.clawhub.ai/api/v1/download?slug=${encodeURIComponent(slug)}&version=1.0.0`,
        },
      });
      installPackageDirMock.mockResolvedValueOnce({
        ok: true,
        targetDir: path.join(workspaceDir, "skills", slug),
      });

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
          forceInstall: true,
        });

        expect(fetchClawHubSkillInstallResolutionMock).toHaveBeenCalledWith({
          slug,
          baseUrl: "https://legacy.clawhub.ai",
          forceInstall: true,
        });
        expectLegacyUpdateSuccess(results, workspaceDir, slug);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("does not install configured skills during update all without ClawHub tracking", async () => {
      const workspaceDir = await tempDirs.make("openclaw-configured-update-");
      const results = await updateSkillsFromClawHub({
        workspaceDir,
        config: {
          agents: {
            defaults: {
              skills: ["apple-notes", "sherpa-onnx-tts"],
            },
          },
        },
      });

      expect(results).toEqual([]);
      expect(fetchClawHubSkillInstallResolutionMock).not.toHaveBeenCalled();
      expect(installPackageDirMock).not.toHaveBeenCalled();
    });

    it("rejects untracked requested updates instead of installing by slug", async () => {
      const workspaceDir = await tempDirs.make("openclaw-untracked-update-");

      const results = await updateSkillsFromClawHub({
        workspaceDir,
        slug: "calendar",
      });

      expect(results).toEqual([
        {
          ok: false,
          error: 'Skill "calendar" is not tracked as a ClawHub install.',
        },
      ]);
      expect(fetchClawHubSkillInstallResolutionMock).not.toHaveBeenCalled();
      expect(installPackageDirMock).not.toHaveBeenCalled();
    });

    it("updates a legacy Unicode slug when requested explicitly", async () => {
      const slug = "re\u0430ct";
      const { workspaceDir } = await createLegacyTrackedSkillFixture(slug);
      installPackageDirMock.mockResolvedValueOnce({
        ok: true,
        targetDir: path.join(workspaceDir, "skills", slug),
      });

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
          slug,
        });

        expectLegacyUpdateSuccess(results, workspaceDir, slug);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("still rejects an untracked Unicode slug passed to update", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-clawhub-"));

      try {
        await expect(
          updateSkillsFromClawHub({
            workspaceDir,
            slug: "re\u0430ct",
          }),
        ).rejects.toThrow("Invalid skill slug");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  describe("normalizeSlug rejects non-ASCII homograph slugs", () => {
    it("rejects Cyrillic homograph 'а' (U+0430) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "re\u0430ct",
      });
      expectInvalidSlug(result);
    });

    it("rejects Cyrillic homograph 'е' (U+0435) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "r\u0435act",
      });
      expectInvalidSlug(result);
    });

    it("rejects Cyrillic homograph 'о' (U+043E) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "t\u043Edo",
      });
      expectInvalidSlug(result);
    });

    it("rejects slug with mixed Unicode and ASCII", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "cаlеndаr",
      });
      expectInvalidSlug(result);
    });

    it("rejects slug with non-Latin scripts", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "技能",
      });
      expectInvalidSlug(result);
    });

    it("rejects Unicode that case-folds to ASCII (Kelvin sign U+212A)", async () => {
      // "\u212A" (Kelvin sign) lowercases to "k" — must be caught before lowercasing
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "\u212Aalendar",
      });
      expectInvalidSlug(result);
    });

    it("rejects slug starting with a hyphen", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "-calendar",
      });
      expectInvalidSlug(result);
    });

    it("rejects slug ending with a hyphen", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "calendar-",
      });
      expectInvalidSlug(result);
    });

    it("accepts uppercase ASCII slugs (preserves original casing behavior)", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "React",
      });
      expectInstalledSkill(result);
    });

    it("accepts valid lowercase ASCII slugs", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "calendar-2",
      });
      expectInstalledSkill(result);
    });
  });

  describe("verification target resolution", () => {
    it("uses installed origin registry and installed version by default", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        const skillDir = await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          registry: "https://private.example.com/clawhub/",
          installedVersion: "2.0.0",
        });

        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "agentreceipt",
          }),
        ).resolves.toEqual({
          ok: true,
          slug: "agentreceipt",
          baseUrl: "https://private.example.com/clawhub",
          version: "2.0.0",
          tag: undefined,
          resolution: {
            source: "installed",
            selector: "installed-version",
            registry: "https://private.example.com/clawhub",
            skillDir,
            installedVersion: "2.0.0",
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("uses installed owner namespace when resolving owner-qualified verification targets", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "weather",
          ownerHandle: "demo-owner",
          registry: "https://private.example.com/clawhub",
          installedVersion: "2.0.0",
        });

        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "weather",
          }),
        ).resolves.toMatchObject({
          ok: true,
          slug: "weather",
          ownerHandle: "demo-owner",
          baseUrl: "https://private.example.com/clawhub",
          version: "2.0.0",
          tag: undefined,
          resolution: {
            source: "installed",
            selector: "installed-version",
            registry: "https://private.example.com/clawhub",
            installedVersion: "2.0.0",
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("accepts owner-qualified installed verification targets", async () => {
      const workspaceDir = await tempDirs.make("openclaw-skill-verify-");
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "weather",
          ownerHandle: "demo-owner",
          registry: "https://private.example.com/clawhub",
          installedVersion: "2.0.0",
        });

        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "@demo-owner/weather",
          }),
        ).resolves.toMatchObject({
          ok: true,
          slug: "weather",
          ownerHandle: "demo-owner",
          baseUrl: "https://private.example.com/clawhub",
          version: "2.0.0",
          tag: undefined,
          resolution: {
            source: "installed",
            selector: "installed-version",
            registry: "https://private.example.com/clawhub",
            installedVersion: "2.0.0",
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("rejects owner-qualified installed verification when the owner differs", async () => {
      const workspaceDir = await tempDirs.make("openclaw-skill-verify-");
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "weather",
          ownerHandle: "demo-owner",
        });

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "@other-owner/weather",
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected owner mismatch failure");
        }
        expect(result.error).toContain("is tracked as @demo-owner/weather");
        expect(result.error).toContain("not @other-owner/weather");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("keeps the installed registry when an explicit version overrides the installed version", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          registry: "https://private.example.com/clawhub",
          installedVersion: "2.0.0",
        });

        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "agentreceipt",
            version: "2.1.0",
            baseUrl: "https://clawhub.ai",
          }),
        ).resolves.toMatchObject({
          ok: true,
          slug: "agentreceipt",
          baseUrl: "https://private.example.com/clawhub",
          version: "2.1.0",
          tag: undefined,
          resolution: {
            source: "installed",
            selector: "version",
            registry: "https://private.example.com/clawhub",
            installedVersion: "2.0.0",
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("keeps the installed registry when an explicit tag is provided", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          registry: "https://private.example.com/clawhub",
          installedVersion: "2.0.0",
        });

        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "agentreceipt",
            tag: "beta",
            baseUrl: "https://clawhub.ai",
          }),
        ).resolves.toMatchObject({
          ok: true,
          slug: "agentreceipt",
          baseUrl: "https://private.example.com/clawhub",
          version: undefined,
          tag: "beta",
          resolution: {
            source: "installed",
            selector: "tag",
            registry: "https://private.example.com/clawhub",
            installedVersion: "2.0.0",
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("rejects installed owner namespace metadata that does not match lock tracking", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "weather",
          ownerHandle: "demo-owner",
        });
        const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
        const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
          skills: Record<string, { ownerHandle?: string }>;
        };
        expectDefined(lock.skills.weather, "lock.skills.weather test invariant").ownerHandle =
          "other-owner";
        await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "weather",
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected owner mismatch failure");
        }
        expect(result.error).toContain("origin metadata does not match");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("rejects installed origin metadata without workspace lock tracking", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          writeLock: false,
        });

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected untracked origin failure");
        }
        expect(result.error).toContain("not tracked by the workspace ClawHub lockfile");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("rejects installed origin metadata for a different skill slug", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          originSlug: "trusted-skill",
        });

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected slug mismatch failure");
        }
        expect(result.error).toContain('origin metadata for "trusted-skill"');
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("rejects installed origin metadata that does not match lock tracking", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          installedVersion: "2.0.0",
          installedAt: 123,
        });
        const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
        const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
          skills: Record<string, { version: string; installedAt: number; registry: string }>;
        };
        lock.skills.agentreceipt = {
          ...expectDefined(lock.skills.agentreceipt, "agentreceipt lock entry"),
          version: "1.0.0",
        };
        await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected lock mismatch failure");
        }
        expect(result.error).toContain("does not match the workspace ClawHub lockfile");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("rejects installed origin metadata when lock registry disagrees", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeClawHubOriginFixture({
          workspaceDir,
          slug: "agentreceipt",
          registry: "https://origin.example.com/clawhub",
          installedVersion: "2.0.0",
          installedAt: 123,
        });
        const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
        const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
          skills: Record<string, { version: string; installedAt: number; registry: string }>;
        };
        lock.skills.agentreceipt = {
          ...expectDefined(lock.skills.agentreceipt, "agentreceipt lock entry"),
          registry: "https://other.example.com/clawhub",
        };
        await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected registry mismatch failure");
        }
        expect(result.error).toContain("does not match the workspace ClawHub lockfile");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("rejects lock-tracked installed skills without origin metadata", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
        await fs.writeFile(
          path.join(workspaceDir, ".clawhub", "lock.json"),
          `${JSON.stringify(
            {
              version: 1,
              skills: {
                agentreceipt: {
                  version: "2.0.0",
                  installedAt: 123,
                  registry: "https://private.example.com/clawhub",
                },
              },
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected missing origin failure");
        }
        expect(result.error).toContain("missing ClawHub origin metadata");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("rejects malformed workspace locks before registry fallback", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
        await fs.writeFile(path.join(workspaceDir, ".clawhub", "lock.json"), "{not json", "utf8");

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected malformed lock failure");
        }
        expect(result.error).toContain("Malformed workspace ClawHub lockfile");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("uses the configured registry and latest selector for uninstalled skills", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      resolveClawHubBaseUrlMock.mockReturnValueOnce("https://configured.example.com/clawhub");
      try {
        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "agentreceipt",
            baseUrl: "https://configured.example.com/clawhub/",
          }),
        ).resolves.toEqual({
          ok: true,
          slug: "agentreceipt",
          baseUrl: "https://configured.example.com/clawhub",
          version: undefined,
          tag: undefined,
          resolution: {
            source: "registry",
            selector: "latest",
            registry: "https://configured.example.com/clawhub",
            skillDir: undefined,
            installedVersion: undefined,
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("uses owner-qualified registry verification targets", async () => {
      const workspaceDir = await tempDirs.make("openclaw-skill-verify-");
      resolveClawHubBaseUrlMock.mockReturnValueOnce("https://configured.example.com/clawhub");
      try {
        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "@demo-owner/weather",
            baseUrl: "https://configured.example.com/clawhub/",
          }),
        ).resolves.toEqual({
          ok: true,
          slug: "weather",
          ownerHandle: "demo-owner",
          baseUrl: "https://configured.example.com/clawhub",
          version: undefined,
          tag: undefined,
          resolution: {
            source: "registry",
            selector: "latest",
            registry: "https://configured.example.com/clawhub",
            skillDir: undefined,
            installedVersion: undefined,
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("keeps owner-qualified registry selectors for explicit versions and tags", async () => {
      const workspaceDir = await tempDirs.make("openclaw-skill-verify-");
      try {
        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "@demo-owner/weather",
            version: "2.0.0",
          }),
        ).resolves.toMatchObject({
          ok: true,
          slug: "weather",
          ownerHandle: "demo-owner",
          version: "2.0.0",
          tag: undefined,
          resolution: {
            source: "registry",
            selector: "version",
          },
        });

        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "@demo-owner/weather",
            tag: "beta",
          }),
        ).resolves.toMatchObject({
          ok: true,
          slug: "weather",
          ownerHandle: "demo-owner",
          version: undefined,
          tag: "beta",
          resolution: {
            source: "registry",
            selector: "tag",
          },
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("fails clearly when installed origin metadata is malformed", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        const skillDir = path.join(workspaceDir, "skills", "agentreceipt");
        await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
        await fs.writeFile(path.join(skillDir, ".clawhub", "origin.json"), "{not json", "utf8");

        const result = await resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(result.ok).toBe(false);
        if (result.ok) {
          throw new Error("expected malformed origin failure");
        }
        expect(result.error).toContain("Malformed ClawHub origin metadata");
        expect(result.error).toContain(path.join(skillDir, ".clawhub", "origin.json"));
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("fails clearly for invalid slugs and conflicting selectors", async () => {
      await expect(
        resolveClawHubSkillVerificationTarget({
          workspaceDir: "/tmp/workspace",
          slug: "bad/slug",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "Invalid skill slug: bad/slug",
      });

      await expect(
        resolveClawHubSkillVerificationTarget({
          workspaceDir: "/tmp/workspace",
          slug: "agentreceipt",
          version: "1.0.0",
          tag: "latest",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "Use either --version or --tag.",
      });
    });
  });

  it("uses search for browse-all skill discovery", async () => {
    searchClawHubSkillsMock.mockResolvedValueOnce([
      {
        score: 1,
        slug: "calendar",
        displayName: "Calendar",
        summary: "Calendar skill",
        version: "1.2.3",
        updatedAt: 123,
      },
    ]);

    await expect(searchSkillsFromClawHub({ limit: 20 })).resolves.toEqual([
      {
        score: 1,
        slug: "calendar",
        displayName: "Calendar",
        summary: "Calendar skill",
        version: "1.2.3",
        updatedAt: 123,
      },
    ]);
    expect(searchClawHubSkillsMock).toHaveBeenCalledWith({
      query: "*",
      limit: 20,
      baseUrl: undefined,
    });
  });
});

describe("ClawHub origin provenance readback", () => {
  async function writeOriginWithProvenance(params: {
    workspaceDir: string;
    slug: string;
    origin: Record<string, unknown>;
    lockSkill?: Record<string, unknown>;
  }) {
    const skillDir = path.join(params.workspaceDir, "skills", params.slug);
    await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Skill\n", "utf8");
    await fs.writeFile(
      path.join(skillDir, ".clawhub", "origin.json"),
      `${JSON.stringify(params.origin, null, 2)}\n`,
      "utf8",
    );
    await fs.mkdir(path.join(params.workspaceDir, ".clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(params.workspaceDir, ".clawhub", "lock.json"),
      `${JSON.stringify(
        {
          version: 1,
          skills: {
            [params.slug]: params.lockSkill ?? {
              version: params.origin.installedVersion,
              installedAt: params.origin.installedAt,
              registry: params.origin.registry,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return skillDir;
  }

  it("restores matching provenance and rejects one-sided origin edits", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-origin-prov-"));
    try {
      const artifact = {
        kind: "clawpack" as const,
        sha256: "a".repeat(64),
        integrity: "sha256-test",
      };
      const skillFile = { path: "SKILL.md", sha256: "b".repeat(64) };
      const sourceUrl = "https://github.com/acme/skills/tree/abc/agentreceipt";
      const origin = {
        version: 1,
        registry: "https://clawhub.ai",
        slug: "agentreceipt",
        installedVersion: "1.0.0",
        installedAt: 123,
        sourceUrl,
        artifact,
        skillFile,
      };
      const skillDir = await writeOriginWithProvenance({
        workspaceDir,
        slug: "agentreceipt",
        origin,
        lockSkill: {
          version: "1.0.0",
          installedAt: 123,
          registry: "https://clawhub.ai",
          sourceUrl,
          artifact,
          skillFile,
        },
      });

      const link = resolveClawHubSkillStatusLinkSync({
        workspaceDir,
        skillDir,
        skillKey: "agentreceipt",
      });

      expect(link?.status).toBe("linked");
      expect(link?.valid).toBe(true);
      if (link?.status !== "linked") {
        throw new Error(`expected linked status, got ${link?.status}`);
      }
      expect(link.artifact).toEqual(artifact);
      expect(link.skillFile).toEqual(skillFile);
      expect(link.sourceUrl).toBe(sourceUrl);

      const originPath = path.join(skillDir, ".clawhub", "origin.json");
      for (const override of [
        { sourceUrl: "https://github.com/acme/skills/tree/tampered/agentreceipt" },
        {
          artifact: {
            kind: "clawpack",
            sha256: "c".repeat(64),
            integrity: "sha256-tampered",
          },
        },
        { skillFile: { path: "SKILL.md", sha256: "d".repeat(64) } },
      ]) {
        await fs.writeFile(
          originPath,
          `${JSON.stringify({ ...origin, ...override }, null, 2)}\n`,
          "utf8",
        );
        expect(
          resolveClawHubSkillStatusLinkSync({
            workspaceDir,
            skillDir,
            skillKey: "agentreceipt",
          }),
        ).toMatchObject({
          status: "invalid",
          valid: false,
          reason: expect.stringContaining("does not match the workspace ClawHub lockfile"),
        });
      }
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("drops malformed provenance fields while keeping the link valid", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-origin-prov-"));
    try {
      const skillDir = await writeOriginWithProvenance({
        workspaceDir,
        slug: "agentreceipt",
        origin: {
          version: 1,
          registry: "https://clawhub.ai",
          slug: "agentreceipt",
          installedVersion: "1.0.0",
          installedAt: 123,
          sourceUrl: "   ",
          artifact: { kind: "bogus", sha256: 42, integrity: "" },
          skillFile: { path: "", sha256: "c".repeat(64) },
        },
      });

      const link = resolveClawHubSkillStatusLinkSync({
        workspaceDir,
        skillDir,
        skillKey: "agentreceipt",
      });

      expect(link?.status).toBe("linked");
      if (link?.status !== "linked") {
        throw new Error(`expected linked status, got ${link?.status}`);
      }
      expect(link.artifact).toBeUndefined();
      expect(link.skillFile).toBeUndefined();
      expect(link.sourceUrl).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
