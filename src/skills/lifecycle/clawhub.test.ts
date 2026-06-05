// ClawHub lifecycle tests cover registry metadata lookup and error handling.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchClawHubSkillDetailMock = vi.fn();
const fetchClawHubSkillInstallResolutionMock = vi.fn();
const downloadClawHubSkillArchiveMock = vi.fn();
const downloadClawHubSkillArchiveUrlMock = vi.fn();
const downloadClawHubGitHubSkillArchiveMock = vi.fn();
const listClawHubSkillsMock = vi.fn();
const reportClawHubSkillInstallTelemetryMock = vi.fn();
const resolveClawHubBaseUrlMock = vi.fn(() => "https://clawhub.ai");
const isDefaultClawHubBaseUrlMock = vi.fn((baseUrl?: string) => !baseUrl);
const searchClawHubSkillsMock = vi.fn();
const archiveCleanupMock = vi.fn();
const withExtractedArchiveRootMock = vi.fn();
const installPackageDirMock = vi.fn();
const evaluateSkillInstallPolicyMock = vi.fn();
const pathExistsMock = vi.fn();

vi.mock("../../infra/clawhub.js", () => ({
  fetchClawHubSkillDetail: fetchClawHubSkillDetailMock,
  fetchClawHubSkillInstallResolution: fetchClawHubSkillInstallResolutionMock,
  downloadClawHubSkillArchive: downloadClawHubSkillArchiveMock,
  downloadClawHubSkillArchiveUrl: downloadClawHubSkillArchiveUrlMock,
  downloadClawHubGitHubSkillArchive: downloadClawHubGitHubSkillArchiveMock,
  listClawHubSkills: listClawHubSkillsMock,
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
        origin?: { registry?: string };
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
  beforeEach(() => {
    fetchClawHubSkillDetailMock.mockReset();
    fetchClawHubSkillInstallResolutionMock.mockReset();
    downloadClawHubSkillArchiveMock.mockReset();
    downloadClawHubSkillArchiveUrlMock.mockReset();
    downloadClawHubGitHubSkillArchiveMock.mockReset();
    listClawHubSkillsMock.mockReset();
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
    isDefaultClawHubBaseUrlMock.mockImplementation((baseUrl?: string) => !baseUrl);
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
    downloadClawHubSkillArchiveMock.mockResolvedValue({
      archivePath: "/tmp/agentreceipt.zip",
      integrity: "sha256-test",
      cleanup: archiveCleanupMock,
    });
    downloadClawHubSkillArchiveUrlMock.mockResolvedValue({
      archivePath: "/tmp/agentreceipt.zip",
      integrity: "sha256-test",
      cleanup: archiveCleanupMock,
    });
    downloadClawHubGitHubSkillArchiveMock.mockResolvedValue({
      archivePath: "/tmp/github-agentreceipt.zip",
      integrity: "sha256-github-test",
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
      root: "/tmp/workspace",
      skills: expect.objectContaining({
        agentreceipt: {
          version: "1.0.0",
          installedAt: expect.any(Number),
          registry: "https://clawhub.ai",
        },
      }),
    });
  });

  it("installs GitHub-backed ClawHub skills from the pinned resolver source path", async () => {
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
          ...lock.skills.agentreceipt,
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
          ...lock.skills.agentreceipt,
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
    expect(listClawHubSkillsMock).not.toHaveBeenCalled();
  });
});
