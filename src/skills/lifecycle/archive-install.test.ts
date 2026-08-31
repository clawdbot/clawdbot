// Archive install tests cover archive validation, extraction, and install output.
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
  installExtractedSkillRoot,
  resolveWorkspaceSkillInstallDir,
} from "./archive-install.js";

const tempDirs = createTrackedTempDirs();

async function writeZipArchive(params: {
  archivePath: string;
  entries: Record<string, string>;
}): Promise<void> {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(params.entries)) {
    zip.file(entryPath, content);
  }
  await fs.writeFile(
    params.archivePath,
    Buffer.from(await zip.generateAsync({ type: "nodebuffer" })),
  );
}

async function isCaseSensitiveFileSystem(root: string): Promise<boolean> {
  const marker = path.join(root, "case-check");
  await fs.writeFile(marker, "case", "utf8");
  const upperExists = await fs
    .stat(path.join(root, "CASE-CHECK"))
    .then(() => true)
    .catch(() => false);
  return !upperExists;
}

async function expectFlatRootMarkerRejected(params: {
  marker: string;
  root: string;
}): Promise<void> {
  const archivePath = path.join(params.root, `flat-${params.marker}.zip`);
  await writeZipArchive({
    archivePath,
    entries: {
      [params.marker]: skillFileContent("Flat Legacy Marker"),
    },
  });

  const result = await withExtractedArchiveRoot({
    archivePath,
    tempDirPrefix: "openclaw-skill-clawhub-test-",
    timeoutMs: 120_000,
    rootMarkers: ["SKILL.md"],
    onExtracted: async () => ({ ok: true as const }),
  });

  expect(result).toEqual({
    ok: false,
    error: "Error: unexpected archive layout (dirs: )",
  });
}

function skillFileContent(name: string): string {
  return ["---", `name: ${name}`, "description: Test skill", "---", "", "# Test", ""].join("\n");
}

function versionedSkillFileContent(name: string, version: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: Lifecycle test skill",
    `version: ${version}`,
    "---",
    "",
    "# Test",
    "",
  ].join("\n");
}

afterEach(async () => {
  resetGlobalHookRunner();
  await tempDirs.cleanup();
});

describe("skill archive install", () => {
  it.each(["skill.md", "skills.md", "SKILL.MD"])(
    "installs a single-root ClawHub archive with legacy marker %s",
    async (marker) => {
      const root = await tempDirs.make("openclaw-skill-archive-install-");
      const archivePath = path.join(root, "legacy.zip");
      const workspaceDir = path.join(root, "workspace");
      await writeZipArchive({
        archivePath,
        entries: {
          [`mydir/${marker}`]: skillFileContent("Legacy Marker"),
        },
      });

      const result = await withExtractedArchiveRoot({
        archivePath,
        tempDirPrefix: "openclaw-skill-clawhub-test-",
        timeoutMs: 120_000,
        rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
        onExtracted: async (extractedRoot) =>
          await installExtractedSkillRoot({
            workspaceDir,
            slug: `legacy-${marker.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            extractedRoot,
            mode: "install",
            rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
          }),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      await expect(fs.readFile(path.join(result.targetDir, marker), "utf8")).resolves.toContain(
        "Legacy Marker",
      );
    },
  );

  it("keeps flat-root non-SKILL.md legacy markers rejected by strict packed-root resolution", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    await expectFlatRootMarkerRejected({ marker: "skills.md", root });
  });

  it("keeps flat-root lowercase skill.md rejected by strict packed-root resolution on case-sensitive filesystems", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const caseSensitive = await isCaseSensitiveFileSystem(root);
    if (!caseSensitive) {
      expect(caseSensitive).toBe(false);
      return;
    }
    await expectFlatRootMarkerRejected({ marker: "skill.md", root });
  });

  it("keeps skill archive policy installs independent from built-in scanner blocks", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("ClawHub Policy"));
    await fs.writeFile(path.join(extractedRoot, "payload.js"), "eval('danger');\n");
    const handler = vi.fn().mockReturnValue({});
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "clawhub-policy-only",
      extractedRoot,
      mode: "install",
      policy: {
        config: {},
        installId: "clawhub",
        origin: { type: "clawhub", slug: "clawhub-policy-only", version: "1.0.0" },
        source: { kind: "clawhub", authority: "openclaw", mutable: false, network: true },
        requestedSpecifier: "clawhub:clawhub-policy-only@1.0.0",
      },
      rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0]?.[0] as
      | { builtinScan?: { status?: string; scannedFiles?: number; findings?: unknown[] } }
      | undefined;
    expect(payload?.builtinScan).toMatchObject({
      status: "ok",
      scannedFiles: 0,
      findings: [],
    });
  });

  it("keeps legacy skill-upload origin for before_install hooks", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("Uploaded Policy"));
    const handler = vi.fn().mockReturnValue({});
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "uploaded-policy",
      extractedRoot,
      mode: "install",
      policy: {
        config: {},
        installId: "upload",
        origin: { type: "upload", uploadId: "upload-123", sha256: "0".repeat(64) },
        source: { kind: "upload", authority: "user", mutable: false, network: false },
        requestedSpecifier: "upload:upload-123",
      },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0]?.[0] as { origin?: string } | undefined;
    const ctx = handler.mock.calls[0]?.[1] as { origin?: string } | undefined;
    expect(payload?.origin).toBe("skill-upload");
    expect(ctx?.origin).toBe("skill-upload");
  });

  it("reports forced installs of missing skills as install mode to policy", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("Forced Missing"));
    const handler = vi.fn((payload: unknown) => {
      const event = payload as { request?: { mode?: string } };
      if (event.request?.mode === "install") {
        return { block: true, blockReason: "fresh skill installs are disabled by policy" };
      }
      return {};
    });
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "forced-missing",
      extractedRoot,
      mode: "update",
      policy: {
        config: {},
        installId: "archive",
        origin: { type: "upload", uploadId: "upload-456", sha256: "1".repeat(64) },
        source: { kind: "upload", authority: "user", mutable: false, network: false },
        requestedSpecifier: "upload:upload-456",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("fresh skill installs are disabled by policy");
    }
    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0]?.[0] as { request?: { mode?: string } } | undefined;
    expect(payload?.request?.mode).toBe("install");
  });

  it("restores a skill when backup validation blocks replacement", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("Staged Update"));
    const targetDir = resolveWorkspaceSkillInstallDir(workspaceDir, "staged-update");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "SKILL.md"), skillFileContent("Installed Skill"));
    const skillsDir = path.dirname(targetDir);
    let stageDirsAtGuard: string[] = [];

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "staged-update",
      extractedRoot,
      mode: "update",
      rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
      onAfterBackup: async (backupDir) => {
        stageDirsAtGuard = (await fs.readdir(skillsDir)).filter((entry) =>
          entry.startsWith(".openclaw-install-stage-"),
        );
        await fs.writeFile(path.join(backupDir, "notes.md"), "edited before backup", "utf8");
        return 'Skill "staged-update" has local file changes.';
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'Skill "staged-update" has local file changes.',
      failureKind: "invalid-request",
    });
    expect(stageDirsAtGuard).toHaveLength(1);
    await expect(fs.readFile(path.join(targetDir, "notes.md"), "utf8")).resolves.toBe(
      "edited before backup",
    );
    await expect(fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).resolves.toContain(
      "Installed Skill",
    );
    await expect(
      fs.readdir(path.join(skillsDir, ".openclaw-install-backups")),
    ).resolves.toHaveLength(0);
  });

  it.each([
    {
      label: "ClawHub",
      origin: { type: "clawhub", slug: "hook-clawhub", version: "1.2.3" },
      expectedSource: "clawhub",
      expectedSourceVersion: "1.2.3",
    },
    {
      label: "upload",
      origin: { type: "upload", uploadId: "upload-123", sha256: "0".repeat(64) },
      expectedSource: "upload",
      expectedSourceVersion: undefined,
    },
    {
      label: "path",
      origin: { type: "path", spec: "./skill" },
      expectedSource: "source-install",
      expectedSourceVersion: undefined,
    },
  ] as const)("attributes committed $label archive installs", async (testCase) => {
    const root = await tempDirs.make("openclaw-skill-change-create-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(
      path.join(extractedRoot, "SKILL.md"),
      versionedSkillFileContent("Hook Create", "4.5.6"),
    );
    await fs.writeFile(path.join(extractedRoot, "binary.bin"), Buffer.from([0, 255, 1, 254]));
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "hook-create",
      extractedRoot,
      mode: "install",
      policy: {
        origin: testCase.origin,
      },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      action: "created",
      source: testCase.expectedSource,
      after: {
        name: "Hook Create",
        skillKey: "hook-create",
        description: "Lifecycle test skill",
        source: testCase.expectedSource,
        revision: {
          declaredVersion: "4.5.6",
          contentSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          treeSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          ...(testCase.expectedSourceVersion
            ? { sourceVersion: testCase.expectedSourceVersion }
            : {}),
        },
      },
    });
  });

  it("emits before and after artifacts for committed updates", async () => {
    const root = await tempDirs.make("openclaw-skill-change-update-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(
      path.join(extractedRoot, "SKILL.md"),
      versionedSkillFileContent("Before Update", "1.0.0"),
    );
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));
    await installExtractedSkillRoot({
      workspaceDir,
      slug: "hook-update",
      extractedRoot,
      mode: "install",
      policy: { origin: { type: "path", spec: "./skill" } },
    });
    handler.mockClear();
    await fs.writeFile(
      path.join(extractedRoot, "SKILL.md"),
      versionedSkillFileContent("After Update", "2.0.0"),
    );
    await fs.writeFile(path.join(extractedRoot, "payload.bin"), Buffer.from([0, 128, 255]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "hook-update",
      extractedRoot,
      mode: "update",
      policy: {
        origin: { type: "git", spec: "git:https://example.test/skill.git", commit: "abc123" },
      },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0] as {
      action: string;
      source: string;
      before: { name: string; revision: { contentSha256: string; treeSha256: string } };
      after: {
        name: string;
        revision: { contentSha256: string; treeSha256: string; sourceVersion?: string };
      };
    };
    expect(event).toMatchObject({
      action: "updated",
      source: "source-install",
      before: { name: "Before Update" },
      after: {
        name: "After Update",
        revision: { sourceVersion: "abc123" },
      },
    });
    expect(event.before.revision.contentSha256).not.toBe(event.after.revision.contentSha256);
    expect(event.before.revision.treeSha256).not.toBe(event.after.revision.treeSha256);
  });

  it("does not emit when an archive mutation fails", async () => {
    const root = await tempDirs.make("openclaw-skill-change-failure-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("Failure"));
    await fs.mkdir(path.join(workspaceDir, "skills", "hook-failure"), { recursive: true });
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "hook-failure",
      extractedRoot,
      mode: "install",
      policy: { origin: { type: "upload" } },
    });

    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
