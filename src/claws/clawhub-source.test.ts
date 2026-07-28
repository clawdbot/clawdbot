import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  detail: vi.fn(),
  version: vi.fn(),
  artifact: vi.fn(),
  download: vi.fn(),
  trust: vi.fn(),
  extract: vi.fn(),
  read: vi.fn(),
}));

vi.mock("../infra/clawhub.js", () => ({
  searchClawHubPackages: mocks.search,
  fetchClawHubPackageDetail: mocks.detail,
  fetchClawHubPackageVersion: mocks.version,
  fetchClawHubPackageArtifact: mocks.artifact,
  downloadClawHubPackageArchive: mocks.download,
  normalizeClawHubSha256Hex: (value: string) => (/^[a-f0-9]{64}$/.test(value) ? value : undefined),
}));

vi.mock("../infra/clawhub-install-trust.js", () => ({
  ensureClawHubPackageTrustAcknowledged: mocks.trust,
}));

vi.mock("../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: mocks.extract,
}));

vi.mock("./reader.js", () => ({
  readClawManifestFile: mocks.read,
}));

import {
  ClawHubSourceError,
  readClawHubClawDetail,
  searchClawHubClaws,
  withResolvedClawHubSource,
} from "./clawhub-source.js";

const digest = "a".repeat(64);

function packageEntry(family: "claw" | "plugin" = "claw") {
  return {
    score: 1,
    package: {
      name: family === "claw" ? "financial-analyst" : "markets",
      displayName: family === "claw" ? "Financial Analyst" : "Markets",
      family,
      channel: "official",
      isOfficial: true,
      summary: "Research setup",
      createdAt: 1,
      updatedAt: 2,
      latestVersion: "1.2.0",
      stats: { downloads: 12 },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trust.mockResolvedValue({ ok: true });
  mocks.download.mockResolvedValue({
    archivePath: "/tmp/claw.tgz",
    sha256Hex: digest,
    cleanup: vi.fn(),
  });
  mocks.extract.mockImplementation(async ({ onExtracted }) => await onExtracted("/tmp/package"));
  mocks.read.mockResolvedValue({
    ok: true,
    manifest: {},
    source: { kind: "package", name: "financial-analyst", version: "1.2.0" },
    diagnostics: [],
  });
});

describe("ClawHub Claw source resolution", () => {
  it("requests only Claw packages and projects safe catalog metadata", async () => {
    mocks.search.mockResolvedValue([packageEntry(), packageEntry("plugin")]);

    const result = await searchClawHubClaws({ query: "finance" });

    expect(mocks.search).toHaveBeenCalledWith({ query: "finance", family: "claw", limit: 20 });
    expect(result).toEqual([
      expect.objectContaining({
        packageName: "financial-analyst",
        latestVersion: "1.2.0",
        downloads: 12,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("artifact");
  });

  it("uses the validated release summary rather than downloading a manifest for detail", async () => {
    mocks.detail.mockResolvedValue({
      package: {
        ...packageEntry().package,
        clawManifestSummary: null,
      },
    });
    mocks.version.mockResolvedValue({
      package: { name: "financial-analyst", displayName: "Financial Analyst", family: "claw" },
      version: {
        version: "1.2.0",
        createdAt: 2,
        changelog: "",
        verification: { scanStatus: "clean" },
        clawManifestSummary: {
          schemaVersion: 1,
          agent: { id: "analyst", name: "Analyst" },
          workspace: { bootstrapFiles: ["SOUL.md"], fileCount: 1 },
          packages: { skillCount: 2, pluginCount: 1 },
          mcpServerCount: 1,
          cronJobCount: 1,
        },
      },
    });

    await expect(
      readClawHubClawDetail({ packageName: "financial-analyst" }),
    ).resolves.toMatchObject({
      version: "1.2.0",
      workspaceFiles: 2,
      skills: 2,
      plugins: 1,
      mcpServers: 1,
      scheduledJobs: 1,
      scanStatus: "clean",
    });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("accepts the artifact endpoint's version object and verifies the selected identity", async () => {
    mocks.artifact.mockResolvedValue({
      package: { name: "financial-analyst", family: "claw" },
      version: { version: "1.2.0" },
      artifact: { artifactKind: "npm-pack", artifactSha256: digest },
    });

    const result = await withResolvedClawHubSource({
      coordinate: { packageName: "financial-analyst", version: "1.2.0" },
      mode: "preview",
      run: async (loaded) => loaded.source.name,
    });

    expect(result.value).toBe("financial-analyst");
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "financial-analyst",
        version: "1.2.0",
        artifact: "clawpack",
      }),
    );
  });

  it("rejects a downloaded artifact whose digest differs from the selected release", async () => {
    mocks.artifact.mockResolvedValue({
      package: { name: "financial-analyst", family: "claw" },
      version: "1.2.0",
      artifact: { artifactKind: "npm-pack", artifactSha256: digest },
    });
    mocks.download.mockResolvedValue({
      archivePath: "/tmp/claw.tgz",
      sha256Hex: "b".repeat(64),
      cleanup: vi.fn(),
    });

    await expect(
      withResolvedClawHubSource({
        coordinate: { packageName: "financial-analyst", version: "1.2.0" },
        mode: "preview",
        run: async () => undefined,
      }),
    ).rejects.toMatchObject<Partial<ClawHubSourceError>>({
      code: "clawhub_artifact_integrity_mismatch",
    });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("persists an exact verified source only for apply", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clawhub-source-test-"));
    const extractedRoot = path.join(temp, "extracted");
    const stateDir = path.join(temp, "state");
    await fs.mkdir(extractedRoot);
    await fs.writeFile(path.join(extractedRoot, "package.json"), "{}\n");
    mocks.artifact.mockResolvedValue({
      package: { name: "financial-analyst", family: "claw" },
      version: "1.2.0",
      artifact: { artifactKind: "npm-pack", artifactSha256: digest },
    });
    mocks.extract.mockImplementation(async ({ onExtracted }) => await onExtracted(extractedRoot));

    try {
      await withResolvedClawHubSource({
        coordinate: { packageName: "financial-analyst", version: "1.2.0" },
        mode: "preview",
        stateDir,
        run: async () => undefined,
      });
      await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });

      await withResolvedClawHubSource({
        coordinate: { packageName: "financial-analyst", version: "1.2.0" },
        mode: "apply",
        stateDir,
        run: async () => undefined,
      });
      await expect(
        fs.readFile(path.join(stateDir, "claws", "sources", digest, "package.json"), "utf8"),
      ).resolves.toBe("{}\n");
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it("binds preview and apply plans to the same immutable artifact identity", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "clawhub-integrity-test-"));
    const extractedRoot = path.join(temp, "extracted");
    const stateDir = path.join(temp, "state");
    await fs.mkdir(extractedRoot);
    await fs.writeFile(path.join(extractedRoot, "package.json"), "{}\n");
    mocks.artifact.mockResolvedValue({
      package: { name: "financial-analyst", family: "claw" },
      version: "1.2.0",
      artifact: { artifactKind: "npm-pack", artifactSha256: digest },
    });
    mocks.extract.mockImplementation(async ({ onExtracted }) => await onExtracted(extractedRoot));
    mocks.read.mockImplementation(async (sourceRoot: string) => ({
      ok: true,
      manifest: {},
      source: {
        kind: "package",
        name: "financial-analyst",
        version: "1.2.0",
        packageRoot: sourceRoot,
        manifestPath: path.join(sourceRoot, "openclaw.claw.json"),
        integrityKind: "development-snapshot",
        integrity: `sha256:${sourceRoot}`,
        byteLength: 1,
      },
      diagnostics: [],
    }));

    try {
      const preview = await withResolvedClawHubSource({
        coordinate: { packageName: "financial-analyst", version: "1.2.0" },
        mode: "preview",
        stateDir,
        run: async (loaded) => loaded.source,
      });
      const apply = await withResolvedClawHubSource({
        coordinate: { packageName: "financial-analyst", version: "1.2.0" },
        mode: "apply",
        stateDir,
        run: async (loaded) => loaded.source,
      });

      expect(preview.value.packageRoot).not.toBe(apply.value.packageRoot);
      expect(preview.value.integrityKind).toBe("artifact");
      expect(apply.value.integrityKind).toBe("artifact");
      expect(preview.value.integrity).toBe(`sha256:${digest}`);
      expect(apply.value.integrity).toBe(preview.value.integrity);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
