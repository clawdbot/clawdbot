// ClawHub lifecycle tests cover registry metadata lookup and error handling.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClawHubSkillSecurityVerdictItem,
  ClawHubSkillVerificationResponse,
} from "../../infra/clawhub-skills.js";
import { hasErrnoCode } from "../../infra/errno.js";
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
const digestClawHubSkillTreeMock = vi.fn(async () => `sha256:${"a".repeat(64)}`);
const markClawPackageIndependentlyOwnedMock = vi.fn();
const tempDirs = createTrackedTempDirs();

vi.mock("../../infra/clawhub-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/clawhub-skills.js")>()),
  fetchClawHubSkillDetail: fetchClawHubSkillDetailMock,
  fetchClawHubSkillInstallResolution: fetchClawHubSkillInstallResolutionMock,
  fetchClawHubSkillVerification: fetchClawHubSkillVerificationMock,
  fetchClawHubSkillSecurityVerdicts: fetchClawHubSkillSecurityVerdictsMock,
  reportClawHubSkillInstallTelemetry: reportClawHubSkillInstallTelemetryMock,
  searchClawHubSkills: searchClawHubSkillsMock,
}));

vi.mock("../../infra/clawhub-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/clawhub-artifacts.js")>()),
  downloadClawHubSkillArchive: downloadClawHubSkillArchiveMock,
  downloadClawHubSkillArchiveUrl: downloadClawHubSkillArchiveUrlMock,
  downloadClawHubGitHubSkillArchive: downloadClawHubGitHubSkillArchiveMock,
}));

vi.mock("../../infra/clawhub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/clawhub-client.js")>()),
  isDefaultClawHubBaseUrl: isDefaultClawHubBaseUrlMock,
  resolveClawHubBaseUrl: resolveClawHubBaseUrlMock,
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

vi.mock("../../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/fs-safe.js")>()),
  pathExists: pathExistsMock,
}));

vi.mock("./skill-tree-digest.js", () => ({
  digestClawHubSkillTree: digestClawHubSkillTreeMock,
}));

vi.mock("../../state/claw-package-adoption.js", () => ({
  markClawPackageIndependentlyOwned: markClawPackageIndependentlyOwnedMock,
}));

const { ClawHubRequestError } = await import("../../infra/clawhub-client.js");

const {
  installSkillFromClawHub,
  preflightSkillFromClawHub,
  readClawHubSkillsLockfileStatusSync,
  readTrackedClawHubSkillSlugs,
  readVerifiedClawHubSkillSourceUrl,
  resolveClawHubSkillStatusLinkSync,
  resolveClawHubSkillVerificationTarget,
  searchSkillsFromClawHub,
  untrackClawHubSkill,
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

function installTestSkill(
  workspaceDir: string,
  slug: string,
  params: Omit<Parameters<typeof installSkillFromClawHub>[0], "workspaceDir" | "slug"> = {},
) {
  return installSkillFromClawHub({ workspaceDir, slug, ...params });
}

function updateTestSkill(
  workspaceDir: string,
  slug?: string,
  params: Omit<Parameters<typeof updateSkillsFromClawHub>[0], "workspaceDir" | "slug"> = {},
) {
  return updateSkillsFromClawHub({ workspaceDir, ...(slug ? { slug } : {}), ...params });
}

function mockArchiveInstallResolution(slug: string, version: string, downloadUrl: string) {
  fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
    ok: true,
    slug,
    installKind: "archive",
    archive: { version, downloadUrl },
  });
}

function mockGitHubInstallResolution(params: {
  slug: string;
  repo: string;
  path: string;
  commit: string;
  contentHash: string;
  sourceUrl: string;
}) {
  fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
    ok: true,
    slug: params.slug,
    installKind: "github",
    github: {
      repo: params.repo,
      path: params.path,
      commit: params.commit,
      contentHash: params.contentHash,
      sourceUrl: params.sourceUrl,
    },
  });
}

function mockSkillSecurityVerdict(item: ClawHubSkillSecurityVerdictItem) {
  fetchClawHubSkillSecurityVerdictsMock.mockResolvedValueOnce({
    schema: "clawhub.skill.security-verdicts.v1",
    items: [
      {
        ...item,
        overview: item.overview ?? "No security analysis has been recorded yet.",
        securityAuditUrl:
          item.securityAuditUrl ??
          `${item.skillUrl ?? `https://clawhub.ai/${item.publisherHandle ?? "openclaw"}/skills/${item.requestedSlug}`}/security-audit?version=${item.requestedVersion}`,
      },
    ],
  });
}

function mockSkillVerification(response: ClawHubSkillVerificationResponse) {
  fetchClawHubSkillVerificationMock.mockResolvedValueOnce(response);
}

function mockInstalledSkillFile(content: string) {
  installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
    await fs.mkdir(params.targetDir, { recursive: true });
    await fs.writeFile(path.join(params.targetDir, "SKILL.md"), content, "utf8");
    return { ok: true, targetDir: params.targetDir };
  });
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function writeClawHubOriginFixture(params: {
  workspaceDir: string;
  slug: string;
  originSlug?: string;
  ownerHandle?: string;
  requestedReference?: string;
  trustState?: string;
  registry?: string;
  installedVersion?: string;
  installedAt?: number;
  writeLock?: boolean;
  skillMd?: string;
  skillFile?: { path: string; sha256: string };
  fileTreeSha256?: string;
}) {
  const skillDir = path.join(params.workspaceDir, "skills", params.slug);
  const registry = params.registry ?? "https://private.example.com/clawhub";
  const installedVersion = params.installedVersion ?? "1.2.3";
  const installedAt = params.installedAt ?? 123;
  const skillFile =
    params.skillFile ??
    (params.skillMd !== undefined
      ? {
          path: "SKILL.md",
          sha256: createHash("sha256").update(params.skillMd).digest("hex"),
        }
      : undefined);
  const fileTreeSha256 =
    params.fileTreeSha256 ??
    (params.skillMd !== undefined ? `sha256:${"a".repeat(64)}` : undefined);
  const digests = {
    ...(skillFile ? { skillFile } : {}),
    ...(fileTreeSha256 ? { fileTreeSha256 } : {}),
  };
  await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
  if (params.skillMd !== undefined) {
    await fs.writeFile(path.join(skillDir, "SKILL.md"), params.skillMd, "utf8");
  }
  await fs.writeFile(
    path.join(skillDir, ".clawhub", "origin.json"),
    `${JSON.stringify(
      {
        version: 1,
        registry,
        slug: params.originSlug ?? params.slug,
        ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
        ...(params.requestedReference ? { requestedReference: params.requestedReference } : {}),
        ...(params.trustState ? { trustState: params.trustState } : {}),
        installedVersion,
        installedAt,
        ...digests,
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
              ...(params.requestedReference
                ? { requestedReference: params.requestedReference }
                : {}),
              ...(params.trustState ? { trustState: params.trustState } : {}),
              ...digests,
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

function writeTrackedSkill(
  workspaceDir: string,
  slug: string,
  params: Omit<Parameters<typeof writeClawHubOriginFixture>[0], "workspaceDir" | "slug"> = {},
) {
  return writeClawHubOriginFixture({ workspaceDir, slug, ...params });
}

describe("skills-clawhub", () => {
  let testWorkspaceDir: string;

  afterEach(async () => {
    await tempDirs.cleanup();
  });

  beforeEach(async () => {
    testWorkspaceDir = await tempDirs.make("openclaw-clawhub-workspace-");
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
    markClawPackageIndependentlyOwnedMock.mockReset();

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
          overview: "No security analysis has been recorded yet.",
          securityAuditUrl: `https://clawhub.ai/${item.ownerHandle ?? "openclaw"}/skills/${item.slug}/security-audit?version=${item.version}`,
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
    installPackageDirMock.mockImplementation(
      async (params: {
        targetDir: string;
        afterBackup?: (
          backupDir: string,
        ) => Promise<{ ok: boolean; error?: string; code?: string }>;
      }) => {
        const backup = await params.afterBackup?.(params.targetDir);
        if (backup && !backup.ok) {
          return backup;
        }
        return { ok: true, targetDir: path.join(testWorkspaceDir, "skills", "agentreceipt") };
      },
    );
    evaluateSkillInstallPolicyMock.mockResolvedValue(undefined);
  });

  it("installs ClawHub skills from flat-root archives", async () => {
    const result = await installTestSkill(testWorkspaceDir, "agentreceipt");

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
      targetDir: path.join(testWorkspaceDir, "skills", "agentreceipt"),
    });
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
    expect(reportClawHubSkillInstallTelemetryMock).toHaveBeenCalledWith({
      baseUrl: undefined,
      slug: "agentreceipt",
      version: "1.0.0",
    });
  });

  it.each([
    {
      name: "maps missing install resolutions to the skills-info recovery message",
      lookup: "install",
      status: 404,
      path: "/api/v1/skills/missing-skill/install",
      body: "remote not-found detail",
      expected:
        'Skill "missing-skill" not found on ClawHub. Run `openclaw skills search missing-skill` to find the right skill reference.',
    },
    {
      name: "maps missing versioned skills to the skills-info recovery message",
      lookup: "detail",
      status: 404,
      path: "/custom-clawhub/api/v1/skills/missing-skill",
      body: "remote versioned not-found detail",
      expected:
        'Skill "missing-skill" not found on ClawHub. Run `openclaw skills search missing-skill` to find the right skill reference.',
    },
    {
      name: "keeps server failures distinct from missing skills",
      lookup: "install",
      status: 500,
      path: "/api/v1/skills/missing-skill/install",
      body: "remote-controlled server failure",
      expected:
        'ClawHub is temporarily unavailable while installing skill "missing-skill". Try again later.',
    },
  ] as const)("$name", async ({ lookup, status, path: requestPath, body, expected }) => {
    const requestError = new ClawHubRequestError({ path: requestPath, status, body });
    if (lookup === "detail") {
      fetchClawHubSkillDetailMock.mockRejectedValueOnce(requestError);
    } else {
      fetchClawHubSkillInstallResolutionMock.mockRejectedValueOnce(requestError);
    }

    const result = await installTestSkill(
      testWorkspaceDir,
      "missing-skill",
      lookup === "detail" ? { version: "1.2.3" } : {},
    );

    expect(result).toEqual({ ok: false, error: expected });
    expect(result.ok ? "" : result.error).not.toContain("/api/v1/");
    expect(result.ok ? "" : result.error).not.toContain(body);
  });

  it("installs skills-sh references via a ClawHub-approved pinned GitHub commit", async () => {
    const commit = "a".repeat(40);
    const reference = "skills-sh:openclaw/skills/weather";
    const trustState = "not-scanned-by-clawhub";
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: true,
      slug: "weather",
      installKind: "github",
      trust: { state: trustState },
      github: {
        repo: "openclaw/skills",
        path: "skills/weather",
        commit,
        trustState,
        contentHash: "sha256:approved",
        sourceUrl: `https://github.com/openclaw/skills/tree/${commit}/skills/weather`,
      },
    });
    withExtractedArchiveRootMock.mockImplementationOnce(async (params) => {
      expect(params.rootMarkers).toBeUndefined();
      return await params.onExtracted("/tmp/extracted-github-repo");
    });
    installPackageDirMock.mockResolvedValueOnce({
      ok: true,
      targetDir: path.join(testWorkspaceDir, "skills", "weather"),
    });

    const result = await installTestSkill(testWorkspaceDir, reference);

    expect(fetchClawHubSkillInstallResolutionMock).toHaveBeenCalledWith({
      slug: "weather",
      baseUrl: undefined,
      requestedReference: reference,
    });
    expect(downloadClawHubGitHubSkillArchiveMock).toHaveBeenCalledWith({
      repo: "openclaw/skills",
      commit,
    });
    expect(fetchClawHubSkillVerificationMock).toHaveBeenCalledWith({
      slug: "weather",
      requestedReference: reference,
      version: undefined,
      baseUrl: undefined,
    });
    expect(installPolicyInput()).toMatchObject({
      requestedSpecifier: reference,
      origin: {
        slug: "weather",
        version: commit,
        repo: "openclaw/skills",
        path: "skills/weather",
        commit,
      },
    });
    expectInstalledSkill(result, {
      slug: "weather",
      version: commit,
      targetDir: path.join(testWorkspaceDir, "skills", "weather"),
    });
    expect(result.warning).toBe("Not scanned by ClawHub");
    expect(reportClawHubSkillInstallTelemetryMock).toHaveBeenCalledWith({
      baseUrl: undefined,
      slug: "weather",
      version: commit,
      requestedReference: reference,
      trustState,
    });
  });

  it("rejects a mutable GitHub ref for a skills-sh resolution before downloading", async () => {
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: true,
      slug: "weather",
      installKind: "github",
      trust: { state: "not-scanned-by-clawhub" },
      github: {
        repo: "openclaw/skills",
        path: "skills/weather",
        commit: "main",
        contentHash: "sha256:approved",
        sourceUrl: "https://github.com/openclaw/skills/tree/main/skills/weather",
      },
    });

    const result = await installTestSkill(testWorkspaceDir, "skills-sh:openclaw/skills/weather");

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("expected a full 40-character commit SHA");
    expect(downloadClawHubGitHubSkillArchiveMock).not.toHaveBeenCalled();
    expect(withExtractedArchiveRootMock).not.toHaveBeenCalled();
    expect(installPackageDirMock).not.toHaveBeenCalled();
  });

  it.each([
    "skills-sh:",
    "skills-sh/owner/repo/slug",
    "skills-sh:owner/repo",
    "skills-sh:owner/repo/slug/extra",
    "skills-sh:-owner/repo/slug",
    "skills-sh:owner/../slug",
  ])("rejects invalid skills-sh reference %s before network access", async (reference) => {
    const result = await installTestSkill(testWorkspaceDir, reference);

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid skills.sh skill reference"),
    });
    expect(fetchClawHubSkillInstallResolutionMock).not.toHaveBeenCalled();
    expect(downloadClawHubGitHubSkillArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects versions for skills-sh references before network access", async () => {
    const result = await installTestSkill(testWorkspaceDir, "skills-sh:openclaw/skills/weather", {
      version: "1.2.3",
    });

    expect(result).toEqual({
      ok: false,
      error: "--version is not supported for skills-sh references.",
    });
    expect(fetchClawHubSkillInstallResolutionMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects non-GitHub resolutions for skills-sh references", async () => {
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: true,
      slug: "weather",
      installKind: "archive",
      trust: { state: "not-scanned-by-clawhub" },
      archive: {
        version: "1.0.0",
        downloadUrl: "https://clawhub.ai/api/v1/download?slug=weather&version=1.0.0",
      },
    });

    const result = await installTestSkill(testWorkspaceDir, "skills-sh:openclaw/skills/weather");

    expect(result).toEqual({
      ok: false,
      error: 'Skill "weather" did not resolve to an unscanned, commit-pinned GitHub source.',
    });
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
    expect(downloadClawHubGitHubSkillArchiveMock).not.toHaveBeenCalled();
  });

  it.each([undefined, { state: "scanned-by-clawhub" }])(
    "rejects skills-sh resolutions without the external unscanned trust state",
    async (trust) => {
      fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
        ok: true,
        slug: "weather",
        installKind: "github",
        ...(trust ? { trust } : {}),
        github: {
          repo: "openclaw/skills",
          path: "skills/weather",
          commit: "a".repeat(40),
          contentHash: "sha256:approved",
          sourceUrl: "https://github.com/openclaw/skills",
        },
      });

      const result = await installTestSkill(testWorkspaceDir, "skills-sh:openclaw/skills/weather");

      expect(result).toEqual({
        ok: false,
        error: 'Skill "weather" did not resolve to an unscanned, commit-pinned GitHub source.',
      });
      expect(downloadClawHubGitHubSkillArchiveMock).not.toHaveBeenCalled();
    },
  );

  it("resolves an exact skill artifact without mutating the workspace", async () => {
    const integrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    downloadClawHubSkillArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/agentreceipt.zip",
      integrity,
      sha256Hex: "a".repeat(64),
      artifact: "archive",
      cleanup: archiveCleanupMock,
    });

    const result = await preflightSkillFromClawHub({
      workspaceDir: testWorkspaceDir,
      slug: "agentreceipt",
      version: "1.0.0",
    });

    expect(result).toEqual({ ok: true, action: "install", integrity });
    expect(withExtractedArchiveRootMock).not.toHaveBeenCalled();
    expect(installPackageDirMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a downloaded skill whose bytes do not match the consented plan", async () => {
    const observed = `sha256-${Buffer.from("b".repeat(64), "hex").toString("base64")}`;
    const expected = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    downloadClawHubSkillArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/agentreceipt.zip",
      integrity: observed,
      sha256Hex: "b".repeat(64),
      artifact: "archive",
      cleanup: archiveCleanupMock,
    });

    const result = await installTestSkill(testWorkspaceDir, "agentreceipt", {
      version: "1.0.0",
      expectedIntegrity: `sha256:${"a".repeat(64)}`,
    });

    expect(result).toEqual({
      ok: false,
      error: `ClawHub archive integrity mismatch: expected ${expected}, got ${observed}.`,
    });
    expect(withExtractedArchiveRootMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
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

    const result = await installTestSkill(testWorkspaceDir, "agentreceipt");

    expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
      targetDir: path.join(testWorkspaceDir, "skills", "agentreceipt"),
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

    const result = await installTestSkill(testWorkspaceDir, "tao-setup-nvidia-gpu-host");

    expectInstalledSkill(result, {
      slug: "tao-setup-nvidia-gpu-host",
      version: "1.0.0",
      targetDir: path.join(testWorkspaceDir, "skills", "tao-setup-nvidia-gpu-host"),
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
    mockSkillSecurityVerdict({
      ok: false,
      decision: "fail",
      reasons: ["scan:malicious"],
      requestedSlug: "agentreceipt",
      requestedVersion: "1.0.0",
      slug: "agentreceipt",
      version: "1.0.0",
      publisherHandle: "acme",
      overview: "ClawHub found malicious behavior in this release.",
      securityAuditUrl: "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0",
      security: {
        status: "malicious",
        passed: false,
      },
    });

    const result = await installTestSkill(testWorkspaceDir, "@acme/agentreceipt", {
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
    expect(result.warning).toContain("Blocked");
    expect(result.warning).toContain("ClawHub found malicious behavior in this release.");
    expect(result.warning).toContain(
      "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0",
    );
    expect(result.warning).not.toContain('replying "Install"');
    expect(warnings.join("\n")).toContain("Blocked");
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
  });

  it("prints the ClawHub audit and installs releases with a Review outcome", async () => {
    const warnings: string[] = [];
    mockSkillSecurityVerdict({
      ok: false,
      decision: "fail",
      reasons: ["security.status_not_clean"],
      requestedSlug: "agentreceipt",
      requestedVersion: "1.0.0",
      slug: "agentreceipt",
      version: "1.0.0",
      skillUrl: "https://clawhub.ai/acme/skills/agentreceipt",
      securityAuditUrl: "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0",
      overview:
        "The skill combines gateway and GitHub mutation authority with mutable remote issue content.\n\nReview the requested capabilities before installing.",
      security: {
        status: "suspicious",
        passed: false,
      },
    });

    const result = await installTestSkill(testWorkspaceDir, "agentreceipt", {
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    expectInstalledSkill(result, { slug: "agentreceipt", version: "1.0.0" });
    if (!result.ok) {
      throw new Error("expected Review skill install success");
    }
    const warning = result.warning;
    if (!warning) {
      throw new Error("expected Review skill audit output");
    }
    expect(warning).toContain("ClawHub Security Audit");
    expect(warning).toMatch(/│ agentreceipt@1\.0\.0[^\n]*\n│\s*│\n│ Outcome: Review/u);
    expect(warning).toContain("Outcome: Review");
    expect(warning).toContain("Overview:");
    expect(warning.replace(/[│\s]+/gu, " ")).toContain(
      "The skill combines gateway and GitHub mutation authority with mutable remote issue content.",
    );
    expect(warning).toContain("Review the requested capabilities before installing.");
    expect(warning).toContain(
      "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0",
    );
    expect(warnings.join("\n")).toContain("Outcome: Review");
    expect(warnings.join("\n")).toContain(
      "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0",
    );
    expect(warnings.join("\n")).not.toContain("suspicious");
    expect(warnings.join("\n")).not.toContain("unsigned");
    expect(downloadClawHubSkillArchiveUrlMock).toHaveBeenCalled();
  });

  it("returns review-recommended warnings with successful ClawHub skill installs", async () => {
    mockSkillSecurityVerdict({
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
    });

    const result = await installTestSkill(testWorkspaceDir, "agentreceipt");

    expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
    });
    if (!result.ok) {
      throw new Error("expected review-recommended skill install success");
    }
    expect(result.warning).toContain("Review");
    expect(result.warning).toContain("Overview:");
  });

  it("fails closed when ClawHub skill trust checks are unavailable", async () => {
    fetchClawHubSkillSecurityVerdictsMock.mockRejectedValueOnce(
      new Error("security verdicts unavailable"),
    );

    const result = await installTestSkill(testWorkspaceDir, "agentreceipt");

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

    const result = await installTestSkill(testWorkspaceDir, "agentreceipt");

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
    mockSkillSecurityVerdict({
      ok: true,
      decision: "pass",
      reasons: [],
      requestedSlug: "agentreceipt",
      requestedVersion: "1.0.0",
      slug: "agentreceipt",
      version: "1.0.0",
      ...verdict,
    });

    const result = await installTestSkill(testWorkspaceDir, "agentreceipt");

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
    mockSkillSecurityVerdict({
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
    });

    const result = await installTestSkill(testWorkspaceDir, "agentreceipt", {
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
    expect(warnings.join("\n")).toContain("Blocked");
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
  });

  it("treats a failed verdict with clean nested scan status as Review", async () => {
    mockSkillSecurityVerdict({
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
    });

    const result = await installTestSkill(testWorkspaceDir, "agentreceipt");

    expectInstalledSkill(result, { slug: "agentreceipt", version: "1.0.0" });
    if (!result.ok) {
      throw new Error("expected Review skill install success");
    }
    expect(result.warning).toContain("Outcome: Review");
    expect(downloadClawHubSkillArchiveUrlMock).toHaveBeenCalled();
  });

  it("uses the owner-qualified skill name in Review audits", async () => {
    mockSkillSecurityVerdict({
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
    });

    const result = await installTestSkill(testWorkspaceDir, "@acme/agentreceipt");

    expectInstalledSkill(result, { slug: "agentreceipt", version: "1.0.0" });
    if (!result.ok) {
      throw new Error("expected owner-qualified Review install success");
    }
    expect(result.warning).toContain("@acme/agentreceipt@1.0.0");
    expect(result.warning).toContain("https://clawhub.ai/acme/skills/agentreceipt");
    expect(result.warning).toContain(
      "https://clawhub.ai/acme/skills/agentreceipt/security-audit?version=1.0.0",
    );
    expect(downloadClawHubSkillArchiveUrlMock).toHaveBeenCalled();
  });

  it("installs suspicious ClawHub skill releases after printing Review", async () => {
    mockSkillSecurityVerdict({
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
    });

    const result = await installTestSkill(testWorkspaceDir, "agentreceipt");

    expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
    });
    if (!result.ok) {
      throw new Error("expected Review skill install success");
    }
    expect(result.warning).toContain("Outcome: Review");
    expect(downloadClawHubSkillArchiveUrlMock).toHaveBeenCalledWith({
      url: "https://clawhub.ai/api/v1/download?slug=agentreceipt&version=1.0.0",
      baseUrl: undefined,
    });
  });

  it("installs owner-qualified ClawHub skills without using owner as a local path", async () => {
    const workspaceDir = await tempDirs.make("openclaw-owner-skill-");
    mockSkillVerification({
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
      skill: { slug: "weather", displayName: "Weather" },
      publisher: { handle: "demo-owner", displayName: "Demo Owner" },
      card: { available: true, sha256: "card-sha" },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: { source: "unavailable" },
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });
    mockInstalledSkillFile("# Weather\n");

    const result = await installTestSkill(workspaceDir, "@demo-owner/weather");

    if (!result.ok) {
      throw new Error(result.error);
    }

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

    const lock = await readJson<{ skills: Record<string, Record<string, unknown>> }>(
      path.join(workspaceDir, ".clawhub", "lock.json"),
    );
    expect(lock.skills.weather).toMatchObject({
      version: "1.0.0",
      registry: "https://clawhub.ai",
      ownerHandle: "demo-owner",
    });
    const origin = await readJson<Record<string, unknown>>(
      path.join(workspaceDir, "skills", "weather", ".clawhub", "origin.json"),
    );
    expect(origin).toMatchObject({
      version: 1,
      registry: "https://clawhub.ai",
      slug: "weather",
      ownerHandle: "demo-owner",
      installedVersion: "1.0.0",
    });
    expect(markClawPackageIndependentlyOwnedMock).toHaveBeenCalledWith({
      kind: "skill",
      source: "clawhub",
      ref: "@demo-owner/weather",
      version: "1.0.0",
      workspace: workspaceDir,
    });
    expect(reportClawHubSkillInstallTelemetryMock).toHaveBeenCalledWith({
      baseUrl: undefined,
      slug: "weather",
      ownerHandle: "demo-owner",
      version: "1.0.0",
    });
  });

  it("installs owner-qualified clean skills missing only cards", async () => {
    const workspaceDir = await tempDirs.make("openclaw-owner-card-missing-");
    mockSkillVerification({
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
      skill: { slug: "weather", displayName: "Weather" },
      publisher: { handle: "demo-owner", displayName: "Demo Owner" },
      card: { available: false },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: { source: "unavailable" },
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });
    mockInstalledSkillFile("# Weather\n");

    const result = await installTestSkill(workspaceDir, "@demo-owner/weather");

    if (!result.ok) {
      throw new Error(result.error);
    }
    expectInstalledSkill(result, {
      slug: "weather",
      version: "1.0.0",
      targetDir: path.join(workspaceDir, "skills", "weather"),
    });
    expect(downloadClawHubSkillArchiveUrlMock).toHaveBeenCalled();
  });

  it("does not let owner-qualified fallback mask missing exact versions", async () => {
    mockSkillSecurityVerdict({
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
    });
    mockSkillVerification({
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
      skill: { slug: "weather", displayName: "Weather" },
      publisher: { handle: "demo-owner", displayName: "Demo Owner" },
      card: { available: true, sha256: "card-sha" },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: { source: "unavailable" },
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });

    const result = await installTestSkill(testWorkspaceDir, "@demo-owner/weather");

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

    const result = await installTestSkill(testWorkspaceDir, "weather");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ambiguous slug failure");
    }
    expect(result.error).toContain('Skill "weather" is ambiguous on ClawHub.');
    expect(result.error).toContain("openclaw skills install @owner/weather");
    expect(result.error).toContain("Multiple ClawHub publishers provide weather.");
  });

  it("rejects malformed owner-qualified ClawHub install refs", async () => {
    const result = await installTestSkill(testWorkspaceDir, "@@demo-owner/weather");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid owner-qualified failure");
    }
    expect(result.error).toContain("Invalid ClawHub owner handle");
    expect(fetchClawHubSkillInstallResolutionMock).not.toHaveBeenCalled();
  });

  it.each([
    ["truncated JSON", '{"version":1,"skills":{"weather":'],
    ["JSON null", "null"],
    ["invalid lock shape", '{"version":2,"skills":{}}'],
  ])("preserves a shared lock with %s instead of installing over it", async (_label, damaged) => {
    const workspaceDir = await tempDirs.make("openclaw-skills-damaged-lock-");
    const skillDir = await writeTrackedSkill(workspaceDir, "weather", {
      skillMd: "---\nname: weather\n---\n",
    });
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    await fs.mkdir(path.join(workspaceDir, ".clawdhub"));
    await fs.copyFile(lockPath, path.join(workspaceDir, ".clawdhub", "lock.json"));
    await fs.writeFile(lockPath, damaged);
    const originalSkill = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    mockInstalledSkillFile("---\nname: agentreceipt\n---\n");
    mockInstalledSkillFile("---\nname: replacement\n---\n");

    for (const slug of ["agentreceipt", "weather"]) {
      const result = await installTestSkill(workspaceDir, slug, { force: slug === "weather" });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Malformed workspace ClawHub lockfile"),
      });
    }
    expect(installPackageDirMock).not.toHaveBeenCalled();
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(damaged);
    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toBe(originalSkill);
    await expect(fs.stat(path.join(workspaceDir, "skills", "agentreceipt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([".clawhub", ".clawdhub"])(
    "rejects damaged %s tracking in update, untracking, status and verification",
    async (directory) => {
      const workspaceDir = await tempDirs.make("openclaw-skills-damaged-tracking-");
      const lockPath = path.join(workspaceDir, directory, "lock.json");
      const damaged = '{"version":1,"skills":{"weather":';
      await fs.mkdir(path.dirname(lockPath));
      await fs.writeFile(lockPath, damaged);

      await expect(readTrackedClawHubSkillSlugs(workspaceDir)).rejects.toThrow(
        "Malformed workspace ClawHub lockfile",
      );
      await expect(untrackClawHubSkill(workspaceDir, "weather")).rejects.toThrow(
        "Malformed workspace ClawHub lockfile",
      );
      await expect(updateTestSkill(workspaceDir)).rejects.toThrow(
        "Malformed workspace ClawHub lockfile",
      );
      expect(readClawHubSkillsLockfileStatusSync(workspaceDir)).toMatchObject({
        kind: "malformed",
        path: lockPath,
      });
      await expect(
        resolveClawHubSkillVerificationTarget({ workspaceDir, slug: "weather" }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("Malformed workspace ClawHub lockfile"),
      });
      await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(damaged);
    },
  );

  it("preserves tracking added while a skill is downloading", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skills-install-tracking-");
    await writeTrackedSkill(workspaceDir, "weather");
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    const existing = await readJson<{ skills: Record<string, unknown> }>(lockPath);
    const added = { version: "3.0.0", installedAt: 456, verification: { decision: "pass" } };
    mockInstalledSkillFile("---\nname: agentreceipt\n---\n");
    downloadClawHubSkillArchiveUrlMock.mockImplementationOnce(async () => {
      await fs.writeFile(
        lockPath,
        JSON.stringify({ ...existing, skills: { ...existing.skills, calendar: added } }),
      );
      return {
        archivePath: "/tmp/agentreceipt.zip",
        integrity: "sha256-test",
        sha256Hex: "a".repeat(64),
        artifact: "archive",
        cleanup: archiveCleanupMock,
      };
    });

    expectInstalledSkill(await installTestSkill(workspaceDir, "agentreceipt"));
    const installed = await readJson<{ skills: Record<string, unknown> }>(lockPath);
    expect(installed.skills.weather).toEqual(existing.skills.weather);
    expect(installed.skills.calendar).toEqual(added);
    expect(installed.skills.agentreceipt).toMatchObject({ version: "1.0.0" });
  });

  it.for([".clawhub", ".clawdhub"])(
    "rejects symlinked %s tracking without changing the link or its target",
    async (directory, context) => {
      const workspaceDir = await tempDirs.make("openclaw-skills-linked-tracking-");
      const target = path.join(workspaceDir, "original.json");
      const content = JSON.stringify({ version: 1, skills: {} });
      const lockPath = path.join(workspaceDir, directory, "lock.json");
      await fs.writeFile(target, content);
      await fs.mkdir(path.dirname(lockPath));
      try {
        await fs.symlink(target, lockPath);
      } catch (error) {
        if (process.platform === "win32" && hasErrnoCode(error, "EPERM")) {
          // Windows file symlinks require a host-granted capability.
          context.skip();
          return;
        }
        throw error;
      }

      await expect(readTrackedClawHubSkillSlugs(workspaceDir)).rejects.toThrow(
        "Malformed workspace ClawHub lockfile",
      );
      expect((await fs.lstat(lockPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe(content);
    },
  );

  it("reads the replacement tracking when an existing lock changes before open", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skills-replaced-tracking-");
    await writeTrackedSkill(workspaceDir, "weather");
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    const replacement = path.join(workspaceDir, "replacement.json");
    await fs.writeFile(
      replacement,
      JSON.stringify({ version: 1, skills: { calendar: { version: "2.0.0", installedAt: 123 } } }),
    );
    const open = fs.open.bind(fs);
    let replaced = false;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (!replaced && args[0] === lockPath) {
        replaced = true;
        await fs.rename(replacement, lockPath);
      }
      return await open(...args);
    });
    try {
      await expect(readTrackedClawHubSkillSlugs(workspaceDir)).resolves.toEqual(["calendar"]);
      expect(replaced).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("persists install artifact and verification provenance in the ClawHub lockfile", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skills-lock-");
    const warn = vi.fn();
    const skillContent = "---\nname: agentreceipt\ndescription: Receipt helper\n---\n";
    const skillSha256 = createHash("sha256").update(skillContent).digest("hex");
    mockInstalledSkillFile(skillContent);

    try {
      const result = await installTestSkill(workspaceDir, "agentreceipt", {
        logger: { warn },
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
      expect(warn).not.toHaveBeenCalled();
      const lock = await readJson<{ skills: Record<string, Record<string, unknown>> }>(
        path.join(workspaceDir, ".clawhub", "lock.json"),
      );
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
      const origin = await readJson<Record<string, unknown>>(
        path.join(workspaceDir, "skills", "agentreceipt", ".clawhub", "origin.json"),
      );
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
    mockInstalledSkillFile("# AgentReceipt\n");

    try {
      const result = await installTestSkill(workspaceDir, "agentreceipt", {
        version: "1.0.0",
      });

      expectInstalledSkill(result, {
        slug: "agentreceipt",
        version: "1.0.0",
        targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
      });
      const lock = await readJson<{ skills: Record<string, Record<string, unknown>> }>(
        path.join(workspaceDir, ".clawhub", "lock.json"),
      );
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
      const origin = await readJson<Record<string, unknown>>(
        path.join(workspaceDir, "skills", "agentreceipt", ".clawhub", "origin.json"),
      );
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
    mockInstalledSkillFile("# AgentReceipt\n");

    try {
      const result = await installTestSkill(workspaceDir, "agentreceipt", {
        version: "1.0.0",
      });

      expectInstalledSkill(result, {
        slug: "agentreceipt",
        version: "1.0.0",
        targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
      });
      const lock = await readJson<{ skills: Record<string, Record<string, unknown>> }>(
        path.join(workspaceDir, ".clawhub", "lock.json"),
      );
      expect(lock.skills.agentreceipt?.sourceUrl).toBeUndefined();
      const origin = await readJson<Record<string, unknown>>(
        path.join(workspaceDir, "skills", "agentreceipt", ".clawhub", "origin.json"),
      );
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
    mockInstalledSkillFile("# AgentReceipt\n");

    try {
      const result = await installTestSkill(workspaceDir, "agentreceipt", {
        version: "1.0.0",
      });

      expectInstalledSkill(result, {
        slug: "agentreceipt",
        version: "1.0.0",
        targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
      });
      const lock = await readJson<{ skills: Record<string, Record<string, unknown>> }>(
        path.join(workspaceDir, ".clawhub", "lock.json"),
      );
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
    const warn = vi.fn();
    fetchClawHubSkillVerificationMock.mockRejectedValueOnce(new Error("verification down"));
    installPackageDirMock.mockImplementationOnce(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# AgentReceipt\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    try {
      const result = await installTestSkill(workspaceDir, "agentreceipt", {
        logger: { warn },
      });

      expectInstalledSkill(result, { slug: "agentreceipt", version: "1.0.0" });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "Skill verification for agentreceipt failed: verification down",
      );
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
    mockGitHubInstallResolution({
      slug: "aiq-deploy",
      repo: "NVIDIA/skills",
      path: "skills/aiq-deploy",
      commit: paddedCommit,
      contentHash: "hash-aiq-deploy",
      sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
    });
    withExtractedArchiveRootMock.mockImplementationOnce(async (params) => {
      expect(params.rootMarkers).toBeUndefined();
      return await params.onExtracted("/tmp/extracted-github-repo");
    });
    installPackageDirMock.mockResolvedValueOnce({
      ok: true,
      targetDir: path.join(testWorkspaceDir, "skills", "aiq-deploy"),
    });

    const result = await installTestSkill(testWorkspaceDir, "aiq-deploy");

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
      targetDir: path.join(testWorkspaceDir, "skills", "aiq-deploy"),
    });
  });

  it("rejects a mutable GitHub ref before downloading a ClawHub skill", async () => {
    mockGitHubInstallResolution({
      slug: "aiq-deploy",
      repo: "NVIDIA/skills",
      path: "skills/aiq-deploy",
      commit: "main",
      contentHash: "hash-aiq-deploy",
      sourceUrl: "https://github.com/NVIDIA/skills/tree/main/skills/aiq-deploy",
    });

    const result = await installTestSkill(testWorkspaceDir, "aiq-deploy");

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("expected a full 40-character commit SHA");
    expect(downloadClawHubGitHubSkillArchiveMock).not.toHaveBeenCalled();
    expect(withExtractedArchiveRootMock).not.toHaveBeenCalled();
    expect(installPackageDirMock).not.toHaveBeenCalled();
  });

  it("passes forceInstall to the ClawHub install resolver", async () => {
    const commit = "b".repeat(40);
    mockGitHubInstallResolution({
      slug: "aiq-deploy",
      repo: "NVIDIA/skills",
      path: "skills/aiq-deploy",
      commit,
      contentHash: "hash-aiq-deploy",
      sourceUrl: `https://github.com/NVIDIA/skills/tree/${commit}/skills/aiq-deploy`,
    });
    withExtractedArchiveRootMock.mockImplementationOnce(async (params) => {
      return await params.onExtracted("/tmp/extracted-github-repo");
    });
    installPackageDirMock.mockResolvedValueOnce({
      ok: true,
      targetDir: path.join(testWorkspaceDir, "skills", "aiq-deploy"),
    });

    const result = await installTestSkill(testWorkspaceDir, "aiq-deploy", {
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
      targetDir: path.join(testWorkspaceDir, "skills", "aiq-deploy"),
    });
  });

  it("keeps ClawHub install telemetry best-effort", async () => {
    reportClawHubSkillInstallTelemetryMock.mockRejectedValueOnce(new Error("telemetry down"));

    const result = await installTestSkill(testWorkspaceDir, "agentreceipt");

    expectInstalledSkill(result, {
      slug: "agentreceipt",
      version: "1.0.0",
    });
  });

  it("marks custom ClawHub skill registries as third-party install policy authority", async () => {
    const result = await installTestSkill(testWorkspaceDir, "agentreceipt", {
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

      const result = await installTestSkill(testWorkspaceDir, "agentreceipt");

      expectInstalledSkill(result);
      expectInstallPackageSourceDir("/tmp/extracted-skill");
    },
  );

  it("updates skills.sh installs with the stored reference", async () => {
    const workspaceDir = await tempDirs.make("openclaw-owner-update-");
    const commit = "b".repeat(40);
    await writeTrackedSkill(workspaceDir, "weather", {
      requestedReference: "skills-sh:openclaw/skills/weather",
      trustState: "not-scanned-by-clawhub",
      registry: "https://private.example.com/clawhub",
      installedVersion: "0.9.0",
      skillMd: "# Fixture\n",
    });
    fetchClawHubSkillInstallResolutionMock.mockResolvedValueOnce({
      ok: true,
      slug: "weather",
      installKind: "github",
      trust: { state: "not-scanned-by-clawhub" },
      github: {
        repo: "openclaw/skills",
        path: "skills/weather",
        commit,
        contentHash: "sha256:approved",
        sourceUrl: `https://github.com/openclaw/skills/tree/${commit}/skills/weather`,
      },
    });
    withExtractedArchiveRootMock.mockImplementationOnce(async (params) => {
      return await params.onExtracted("/tmp/extracted-github-repo");
    });
    mockInstalledSkillFile("# Weather\n");

    const results = await updateTestSkill(workspaceDir, "skills-sh:openclaw/skills/weather");

    expect(fetchClawHubSkillInstallResolutionMock).toHaveBeenCalledWith({
      slug: "weather",
      requestedReference: "skills-sh:openclaw/skills/weather",
      baseUrl: "https://private.example.com/clawhub",
    });
    expect(fetchClawHubSkillVerificationMock).toHaveBeenCalledWith({
      slug: "weather",
      requestedReference: "skills-sh:openclaw/skills/weather",
      version: undefined,
      baseUrl: "https://private.example.com/clawhub",
    });
    expect(results).toEqual([
      {
        ok: true,
        slug: "weather",
        previousVersion: "0.9.0",
        version: commit,
        changed: true,
        targetDir: path.join(workspaceDir, "skills", "weather"),
        warning: "Not scanned by ClawHub",
      },
    ]);
    const lock = JSON.parse(
      await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
    ) as { skills: Record<string, Record<string, unknown>> };
    expect(lock.skills.weather).toMatchObject({
      requestedReference: "skills-sh:openclaw/skills/weather",
      trustState: "not-scanned-by-clawhub",
    });
  });

  it("reports a tracked skill removed from ClawHub with the same recovery message", async () => {
    const workspaceDir = await tempDirs.make("openclaw-missing-update-");
    await writeTrackedSkill(workspaceDir, "missing-skill", {
      installedVersion: "0.9.0",
      skillMd: "# Missing skill\n",
    });
    const body = "remote update not-found detail";
    fetchClawHubSkillInstallResolutionMock.mockRejectedValueOnce(
      new ClawHubRequestError({
        path: "/clawhub/api/v1/skills/missing-skill/install",
        status: 404,
        body,
      }),
    );

    const results = await updateTestSkill(workspaceDir, "missing-skill");

    expect(results).toEqual([
      {
        ok: false,
        error:
          'Skill "missing-skill" not found on ClawHub. Run `openclaw skills search missing-skill` to find the right skill reference.',
      },
    ]);
    expect(results[0]?.ok ? "" : results[0]?.error).not.toContain(body);
  });

  it("updates official publisher ClawHub skills without fetching security verdicts", async () => {
    const workspaceDir = await tempDirs.make("openclaw-official-owner-update-");
    await writeTrackedSkill(workspaceDir, "tao-setup-nvidia-gpu-host", {
      ownerHandle: "nvidia",
      registry: "https://clawhub.ai",
      installedVersion: "0.9.0",
      skillMd: "# Fixture\n",
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
    mockArchiveInstallResolution(
      "tao-setup-nvidia-gpu-host",
      "1.0.0",
      "https://clawhub.ai/api/v1/download?slug=tao-setup-nvidia-gpu-host&ownerHandle=nvidia&version=1.0.0",
    );
    fetchClawHubSkillSecurityVerdictsMock.mockRejectedValueOnce(new Error("should not be called"));
    mockInstalledSkillFile("# NVIDIA\n");

    const results = await updateTestSkill(workspaceDir, "tao-setup-nvidia-gpu-host");

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

  it.each([
    {
      ownerHandle: undefined,
      skillRef: "agentreceipt",
      workspaceName: "agent-workspace",
    },
    {
      ownerHandle: "acme",
      skillRef: "@acme/agentreceipt",
      workspaceName: "different agent workspace",
    },
    {
      ownerHandle: undefined,
      skillRef: "agentreceipt",
      workspaceName: ".openclaw",
    },
    {
      ownerHandle: undefined,
      skillRef: "a;printf X",
      workspaceName: "shared state;printf PWN",
    },
    {
      ownerHandle: undefined,
      skillRef: "b$(printf X)",
      workspaceName: "agent$(printf PWN)",
    },
    {
      ownerHandle: undefined,
      skillRef: "c`printf X`",
      workspaceName: "agent`printf PWN`",
    },
    {
      ownerHandle: undefined,
      skillRef: "white space",
      workspaceName: "custom state directory",
    },
    {
      ownerHandle: undefined,
      skillRef: "d'$(printf X)",
      workspaceName: "agent's $(printf PWN) state",
    },
  ])(
    "explains that a malicious skill update will not be downloaded ($skillRef)",
    async ({ ownerHandle, skillRef, workspaceName }) => {
      const tempRoot = await tempDirs.make("openclaw-skill-malicious-update-");
      const workspaceDir = path.join(tempRoot, workspaceName);
      const warnings: string[] = [];
      const slug = ownerHandle ? skillRef.slice(skillRef.indexOf("/") + 1) : skillRef;
      await writeTrackedSkill(workspaceDir, slug, {
        ownerHandle,
        installedVersion: "0.9.0",
        skillMd: "# Fixture\n",
      });
      mockSkillSecurityVerdict({
        ok: false,
        decision: "fail",
        reasons: ["scan:malicious"],
        requestedSlug: slug,
        requestedVersion: "1.0.0",
        slug,
        version: "1.0.0",
        ...(ownerHandle ? { publisherHandle: ownerHandle } : {}),
        security: {
          status: "malicious",
          passed: false,
        },
      });

      const results = await updateTestSkill(workspaceDir, skillRef, {
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
      expect(warnings.join("\n")).toContain("ClawHub Security Audit");
      expect(warnings.join("\n")).toContain("Outcome: Blocked");
      expect(warnings.join("\n")).toContain("Overview:");
      expect(warnings.join("\n")).not.toContain('replying "Update"');
      expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
      expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
    },
  );

  it("updates owner-qualified ClawHub skills when the requested owner matches tracking", async () => {
    const workspaceDir = await tempDirs.make("openclaw-owner-update-request-");
    await writeTrackedSkill(workspaceDir, "weather", {
      ownerHandle: "demo-owner",
      installedVersion: "0.9.0",
      skillMd: "# Fixture\n",
    });
    mockArchiveInstallResolution(
      "weather",
      "1.0.0",
      "https://clawhub.ai/api/v1/download?slug=weather&ownerHandle=demo-owner&version=1.0.0",
    );
    mockInstalledSkillFile("# Weather\n");

    const results = await updateTestSkill(workspaceDir, "@demo-owner/weather");

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

  it("refuses to update a ClawHub skill with local changes unless forced", async () => {
    const workspaceDir = await tempDirs.make("openclaw-local-changes-update-");
    const skillDir = await writeTrackedSkill(workspaceDir, "weather", {
      installedVersion: "0.9.0",
      skillFile: {
        path: "SKILL.md",
        sha256: createHash("sha256").update("# Weather\n").digest("hex"),
      },
      fileTreeSha256: `sha256:${"a".repeat(64)}`,
    });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Weather with local edits\n", "utf8");
    pathExistsMock.mockImplementation(
      async (input: string) => input === skillDir || input.endsWith("SKILL.md"),
    );

    const results = await updateTestSkill(workspaceDir, "weather");

    expect(results).toEqual([
      {
        ok: false,
        code: "force_required",
        error:
          'Skill "weather" has local SKILL.md changes. Updating replaces the installed skill directory.',
      },
    ]);
    expect(installPackageDirMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(
      "# Weather with local edits\n",
    );
  });

  it("refuses to update a ClawHub skill whose SKILL.md is unreadable unless forced", async () => {
    const workspaceDir = await tempDirs.make("openclaw-unreadable-update-");
    const skillDir = await writeTrackedSkill(workspaceDir, "weather", {
      installedVersion: "0.9.0",
      skillFile: {
        path: "SKILL.md",
        sha256: createHash("sha256").update("# Weather\n").digest("hex"),
      },
      fileTreeSha256: `sha256:${"a".repeat(64)}`,
    });
    await fs.mkdir(path.join(skillDir, "SKILL.md"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md", "notes.txt"), "local content\n", "utf8");

    const results = await updateTestSkill(workspaceDir, "weather");

    expect(results).toEqual([
      expect.objectContaining({
        ok: false,
        code: "force_required",
        error: expect.stringContaining("EISDIR"),
      }),
    ]);
    expect(installPackageDirMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveUrlMock).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(skillDir, "SKILL.md", "notes.txt"), "utf8")).toBe(
      "local content\n",
    );
  });

  it("refuses to replace a ClawHub skill edited while the update was downloading", async () => {
    const workspaceDir = await tempDirs.make("openclaw-concurrent-edit-update-");
    const skillDir = await writeTrackedSkill(workspaceDir, "weather", {
      installedVersion: "0.9.0",
      skillMd: "# Weather\n",
    });
    pathExistsMock.mockImplementation(
      async (input: string) => input === skillDir || input.endsWith("SKILL.md"),
    );
    mockArchiveInstallResolution(
      "weather",
      "1.0.0",
      "https://clawhub.ai/api/v1/download?slug=weather&version=1.0.0",
    );
    downloadClawHubSkillArchiveUrlMock.mockImplementationOnce(async () => {
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "# Weather edited during download\n",
        "utf8",
      );
      return {
        archivePath: "/tmp/weather.zip",
        integrity: "sha256-test",
        sha256Hex: "a".repeat(64),
        artifact: "archive",
        cleanup: archiveCleanupMock,
      };
    });

    const results = await updateTestSkill(workspaceDir, "weather");

    expect(results).toEqual([
      {
        ok: false,
        code: "force_required",
        error:
          'Skill "weather" changed during update. Updating replaces the installed skill directory.',
      },
    ]);
    expect(downloadClawHubSkillArchiveUrlMock).toHaveBeenCalledTimes(1);
    expect(installPackageDirMock).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(
      "# Weather edited during download\n",
    );
  });

  it("updates a ClawHub skill with local changes when forced", async () => {
    const workspaceDir = await tempDirs.make("openclaw-local-changes-forced-update-");
    const skillDir = await writeTrackedSkill(workspaceDir, "weather", {
      installedVersion: "0.9.0",
      skillFile: {
        path: "SKILL.md",
        sha256: createHash("sha256").update("# Weather\n").digest("hex"),
      },
      fileTreeSha256: `sha256:${"a".repeat(64)}`,
    });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Weather with local edits\n", "utf8");
    pathExistsMock.mockImplementation(
      async (input: string) => input === skillDir || input.endsWith("SKILL.md"),
    );
    mockArchiveInstallResolution(
      "weather",
      "1.0.0",
      "https://clawhub.ai/api/v1/download?slug=weather&version=1.0.0",
    );
    mockInstalledSkillFile("# Weather\n");

    const results = await updateTestSkill(workspaceDir, "weather", {
      force: true,
    });

    expect(results).toEqual([
      expect.objectContaining({
        ok: true,
        slug: "weather",
        previousVersion: "0.9.0",
        version: "1.0.0",
      }),
    ]);
    expect(installPackageDirMock).toHaveBeenCalledTimes(1);
  });

  it("requires a one-time force for tracked skills without recorded digests, then verifies digests", async () => {
    const workspaceDir = await tempDirs.make("openclaw-predigest-update-");
    const skillDir = await writeTrackedSkill(workspaceDir, "weather", {
      installedVersion: "0.9.0",
    });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Weather\n", "utf8");
    pathExistsMock.mockImplementation(
      async (input: string) => input === skillDir || input.endsWith("SKILL.md"),
    );
    fetchClawHubSkillInstallResolutionMock.mockResolvedValue({
      ok: true,
      slug: "weather",
      installKind: "archive",
      archive: {
        version: "1.0.0",
        downloadUrl: "https://clawhub.ai/api/v1/download?slug=weather&version=1.0.0",
      },
    });
    installPackageDirMock.mockImplementation(async (params: { targetDir: string }) => {
      await fs.mkdir(params.targetDir, { recursive: true });
      await fs.writeFile(path.join(params.targetDir, "SKILL.md"), "# Weather\n", "utf8");
      return { ok: true, targetDir: params.targetDir };
    });

    const refused = await updateTestSkill(workspaceDir, "weather");
    expect(refused).toEqual([
      {
        ok: false,
        code: "force_required",
        error:
          'Skill "weather" was installed before OpenClaw recorded file fingerprints, so local changes cannot be detected. Updating replaces the installed skill directory.',
      },
    ]);

    const forced = await updateTestSkill(workspaceDir, "weather", { force: true });
    expect(forced).toEqual([
      expect.objectContaining({ ok: true, slug: "weather", version: "1.0.0" }),
    ]);
    const lock = JSON.parse(
      await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
    ) as { skills: Record<string, { skillFile?: unknown; fileTreeSha256?: unknown }> };
    expect(lock.skills.weather?.skillFile).toMatchObject({ path: "SKILL.md" });
    expect(lock.skills.weather?.fileTreeSha256).toBe(`sha256:${"a".repeat(64)}`);

    const verified = await updateTestSkill(workspaceDir, "weather");
    expect(verified).toEqual([
      expect.objectContaining({ ok: true, slug: "weather", version: "1.0.0" }),
    ]);
    expect(installPackageDirMock).toHaveBeenCalledTimes(2);
  });

  it("updates an unmodified ClawHub skill without requiring force", async () => {
    const workspaceDir = await tempDirs.make("openclaw-clean-update-");
    const skillDir = await writeTrackedSkill(workspaceDir, "weather", {
      installedVersion: "0.9.0",
      skillFile: {
        path: "SKILL.md",
        sha256: createHash("sha256").update("# Weather\n").digest("hex"),
      },
      fileTreeSha256: `sha256:${"a".repeat(64)}`,
    });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Weather\n", "utf8");
    pathExistsMock.mockImplementation(
      async (input: string) => input === skillDir || input.endsWith("SKILL.md"),
    );
    mockArchiveInstallResolution(
      "weather",
      "1.0.0",
      "https://clawhub.ai/api/v1/download?slug=weather&version=1.0.0",
    );
    mockInstalledSkillFile("# Weather\n");

    const results = await updateTestSkill(workspaceDir, "weather");

    expect(results).toEqual([
      expect.objectContaining({
        ok: true,
        slug: "weather",
        previousVersion: "0.9.0",
        version: "1.0.0",
      }),
    ]);
    expect(installPackageDirMock).toHaveBeenCalledTimes(1);
  });

  it("rejects owner-qualified ClawHub updates when the requested owner does not match tracking", async () => {
    const workspaceDir = await tempDirs.make("openclaw-owner-update-mismatch-");
    await writeTrackedSkill(workspaceDir, "weather", {
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
      const workspaceDir = await tempDirs.make("openclaw-skills-clawhub-");
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
        const results = await updateTestSkill(workspaceDir, undefined, {
          force: true,
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
        const results = await updateTestSkill(workspaceDir, undefined, {
          force: true,
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
      const results = await updateTestSkill(workspaceDir, undefined, {
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

      const results = await updateTestSkill(workspaceDir, "calendar");

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
        const results = await updateTestSkill(workspaceDir, slug, {
          force: true,
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
      const result = await installTestSkill(testWorkspaceDir, "re\u0430ct");
      expectInvalidSlug(result);
    });

    it("rejects Cyrillic homograph 'е' (U+0435) in slug", async () => {
      const result = await installTestSkill(testWorkspaceDir, "r\u0435act");
      expectInvalidSlug(result);
    });

    it("rejects Cyrillic homograph 'о' (U+043E) in slug", async () => {
      const result = await installTestSkill(testWorkspaceDir, "t\u043Edo");
      expectInvalidSlug(result);
    });

    it("rejects slug with mixed Unicode and ASCII", async () => {
      const result = await installTestSkill(testWorkspaceDir, "cаlеndаr");
      expectInvalidSlug(result);
    });

    it("rejects slug with non-Latin scripts", async () => {
      const result = await installTestSkill(testWorkspaceDir, "技能");
      expectInvalidSlug(result);
    });

    it("rejects Unicode that case-folds to ASCII (Kelvin sign U+212A)", async () => {
      // "\u212A" (Kelvin sign) lowercases to "k" — must be caught before lowercasing
      const result = await installTestSkill(testWorkspaceDir, "\u212Aalendar");
      expectInvalidSlug(result);
    });

    it("rejects slug starting with a hyphen", async () => {
      const result = await installTestSkill(testWorkspaceDir, "-calendar");
      expectInvalidSlug(result);
    });

    it("rejects slug ending with a hyphen", async () => {
      const result = await installTestSkill(testWorkspaceDir, "calendar-");
      expectInvalidSlug(result);
    });

    it("accepts uppercase ASCII slugs (preserves original casing behavior)", async () => {
      const result = await installTestSkill(testWorkspaceDir, "React");
      expectInstalledSkill(result);
    });

    it("accepts valid lowercase ASCII slugs", async () => {
      const result = await installTestSkill(testWorkspaceDir, "calendar-2");
      expectInstalledSkill(result);
    });
  });

  describe("verification target resolution", () => {
    it("preserves installed skills.sh references for verification", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        const skillDir = await writeTrackedSkill(workspaceDir, "agentreceipt", {
          requestedReference: "skills-sh:openclaw/skills/agentreceipt",
          trustState: "not-scanned-by-clawhub",
          registry: "https://private.example.com/clawhub/",
          installedVersion: "2.0.0",
        });

        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "skills-sh:openclaw/skills/agentreceipt",
          }),
        ).resolves.toEqual({
          ok: true,
          slug: "agentreceipt",
          requestedReference: "skills-sh:openclaw/skills/agentreceipt",
          trustState: "not-scanned-by-clawhub",
          baseUrl: "https://private.example.com/clawhub",
          version: undefined,
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

    it("rejects a different installed skills.sh reference before verification", async () => {
      const workspaceDir = await tempDirs.make("openclaw-skill-verify-");
      await writeTrackedSkill(workspaceDir, "agentreceipt", {
        requestedReference: "skills-sh:owner-a/repo-a/agentreceipt",
        trustState: "not-scanned-by-clawhub",
        installedVersion: "a".repeat(40),
      });

      await expect(
        resolveClawHubSkillVerificationTarget({
          workspaceDir,
          slug: "skills-sh:owner-b/repo-b/agentreceipt",
        }),
      ).resolves.toEqual({
        ok: false,
        error: 'Skill "agentreceipt" is not tracked from skills-sh:owner-b/repo-b/agentreceipt.',
      });
      expect(fetchClawHubSkillVerificationMock).not.toHaveBeenCalled();
    });

    it.each([
      { version: "2.0.0", tag: undefined },
      { version: undefined, tag: "latest" },
    ])(
      "rejects selectors for exact skills.sh verification references",
      async ({ version, tag }) => {
        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir: testWorkspaceDir,
            slug: "skills-sh:openclaw/skills/agentreceipt",
            version,
            tag,
          }),
        ).resolves.toEqual({
          ok: false,
          error: "--version and --tag are not supported for skills-sh references.",
        });
      },
    );

    it.each([
      { version: "2.0.0", tag: undefined },
      { version: undefined, tag: "latest" },
    ])(
      "rejects selectors when an installed skill is tracked from skills.sh",
      async ({ version, tag }) => {
        const workspaceDir = await tempDirs.make("openclaw-skill-verify-");
        await writeTrackedSkill(workspaceDir, "agentreceipt", {
          requestedReference: "skills-sh:openclaw/skills/agentreceipt",
          trustState: "not-scanned-by-clawhub",
          installedVersion: "a".repeat(40),
        });

        await expect(
          resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug: "agentreceipt",
            version,
            tag,
          }),
        ).resolves.toEqual({
          ok: false,
          error: "--version and --tag are not supported for skills-sh references.",
        });
      },
    );

    it("uses installed owner namespace when resolving owner-qualified verification targets", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
      try {
        await writeTrackedSkill(workspaceDir, "weather", {
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
        await writeTrackedSkill(workspaceDir, "weather", {
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
        await writeTrackedSkill(workspaceDir, "weather", {
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
        await writeTrackedSkill(workspaceDir, "agentreceipt", {
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
        await writeTrackedSkill(workspaceDir, "agentreceipt", {
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
        await writeTrackedSkill(workspaceDir, "weather", {
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
        await writeTrackedSkill(workspaceDir, "agentreceipt", {
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
        await writeTrackedSkill(workspaceDir, "agentreceipt", {
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
        await writeTrackedSkill(workspaceDir, "agentreceipt", {
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
        await writeTrackedSkill(workspaceDir, "agentreceipt", {
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
          workspaceDir: testWorkspaceDir,
          slug: "bad/slug",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "Invalid skill slug: bad/slug",
      });

      await expect(
        resolveClawHubSkillVerificationTarget({
          workspaceDir: testWorkspaceDir,
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
        ownerHandle: "acme",
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
          ownerHandle: "acme",
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
      expect(link.ownerHandle).toBe("acme");
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
