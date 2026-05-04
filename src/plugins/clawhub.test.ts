import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parseClawHubPluginSpecMock = vi.fn();
const fetchClawHubPackageDetailMock = vi.fn();
const fetchClawHubPackageArtifactMock = vi.fn();
const fetchClawHubPackageVersionMock = vi.fn();
const downloadClawHubPackageArchiveMock = vi.fn();
const archiveCleanupMock = vi.fn();
const resolveLatestVersionFromPackageMock = vi.fn();
const resolveCompatibilityHostVersionMock = vi.fn();
const installPluginFromArchiveMock = vi.fn();

vi.mock("../infra/clawhub.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/clawhub.js")>("../infra/clawhub.js");
  return {
    ...actual,
    parseClawHubPluginSpec: (...args: unknown[]) => parseClawHubPluginSpecMock(...args),
    fetchClawHubPackageDetail: (...args: unknown[]) => fetchClawHubPackageDetailMock(...args),
    fetchClawHubPackageArtifact: (...args: unknown[]) => fetchClawHubPackageArtifactMock(...args),
    fetchClawHubPackageVersion: (...args: unknown[]) => fetchClawHubPackageVersionMock(...args),
    downloadClawHubPackageArchive: (...args: unknown[]) =>
      downloadClawHubPackageArchiveMock(...args),
    resolveLatestVersionFromPackage: (...args: unknown[]) =>
      resolveLatestVersionFromPackageMock(...args),
  };
});

vi.mock("../version.js", () => ({
  resolveCompatibilityHostVersion: (...args: unknown[]) =>
    resolveCompatibilityHostVersionMock(...args),
}));

vi.mock("./install.js", () => ({
  installPluginFromArchive: (...args: unknown[]) => installPluginFromArchiveMock(...args),
}));

vi.mock("../infra/archive.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/archive.js")>("../infra/archive.js");
  return {
    ...actual,
    DEFAULT_MAX_ENTRIES: 50_000,
    DEFAULT_MAX_EXTRACTED_BYTES: 512 * 1024 * 1024,
    DEFAULT_MAX_ENTRY_BYTES: 256 * 1024 * 1024,
  };
});

const { ClawHubRequestError } = await import("../infra/clawhub.js");
type ClawHubResolvedArtifact = import("../infra/clawhub.js").ClawHubResolvedArtifact;
const { CLAWHUB_INSTALL_ERROR_CODE, formatClawHubSpecifier, installPluginFromClawHub } =
  await import("./clawhub.js");

const DEMO_ARCHIVE_INTEGRITY = "sha256-qerEjGEpvES2+Tyan0j2xwDRkbcnmh4ZFfKN9vWbsa8=";
const DEMO_ARCHIVE_SHA256 = "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af";
const DEMO_CLAWPACK_SHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEMO_CLAWPACK_INTEGRITY = `sha256-${Buffer.from(DEMO_CLAWPACK_SHA256, "hex").toString(
  "base64",
)}`;
const tempDirs: string[] = [];

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function createClawHubArchive(entries: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
  tempDirs.push(dir);
  const archivePath = path.join(dir, "archive.zip");
  const zip = new JSZip();
  for (const [filePath, contents] of Object.entries(entries)) {
    zip.file(filePath, contents);
  }
  const archiveBytes = await zip.generateAsync({ type: "nodebuffer" });
  await fs.writeFile(archivePath, archiveBytes);
  return {
    archivePath,
    integrity: `sha256-${createHash("sha256").update(archiveBytes).digest("base64")}`,
  };
}

async function expectClawHubInstallError(params: {
  setup?: () => void;
  spec: string;
  expected: {
    ok: false;
    code: (typeof CLAWHUB_INSTALL_ERROR_CODE)[keyof typeof CLAWHUB_INSTALL_ERROR_CODE];
    error: string;
  };
}) {
  params.setup?.();
  await expect(installPluginFromClawHub({ spec: params.spec })).resolves.toMatchObject(
    params.expected,
  );
}

function createLoggerSpies() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createZipCentralDirectoryArchive(params: {
  actualEntryCount: number;
  declaredEntryCount?: number;
  declaredCentralDirectorySize?: number;
}): Buffer {
  const centralDirectory = Buffer.concat(
    Array.from({ length: params.actualEntryCount }, (_, index) => {
      const name = Buffer.from(`file-${index}.txt`);
      const header = Buffer.alloc(46 + name.byteLength);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(name.byteLength, 28);
      name.copy(header, 46);
      return header;
    }),
  );
  const declaredEntryCount = params.declaredEntryCount ?? params.actualEntryCount;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Math.min(declaredEntryCount, 0xffff), 8);
  eocd.writeUInt16LE(Math.min(declaredEntryCount, 0xffff), 10);
  eocd.writeUInt32LE(params.declaredCentralDirectorySize ?? centralDirectory.byteLength, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([centralDirectory, eocd]);
}

function expectClawHubInstallFlow(params: {
  baseUrl: string;
  version: string;
  archivePath: string;
}) {
  expect(fetchClawHubPackageDetailMock).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "demo",
      baseUrl: params.baseUrl,
    }),
  );
  expect(fetchClawHubPackageVersionMock).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "demo",
      version: params.version,
    }),
  );
  expect(fetchClawHubPackageArtifactMock).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "demo",
      version: params.version,
    }),
  );
  expect(installPluginFromArchiveMock).toHaveBeenCalledWith(
    expect.objectContaining({
      archivePath: params.archivePath,
    }),
  );
}

function expectSuccessfulClawHubInstall(result: unknown) {
  expect(result).toMatchObject({
    ok: true,
    pluginId: "demo",
    version: "2026.3.22",
    clawhub: {
      source: "clawhub",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
      integrity: DEMO_ARCHIVE_INTEGRITY,
    },
  });
}

describe("installPluginFromClawHub", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  beforeEach(() => {
    parseClawHubPluginSpecMock.mockReset();
    fetchClawHubPackageDetailMock.mockReset();
    fetchClawHubPackageArtifactMock.mockReset();
    fetchClawHubPackageVersionMock.mockReset();
    downloadClawHubPackageArchiveMock.mockReset();
    archiveCleanupMock.mockReset();
    resolveLatestVersionFromPackageMock.mockReset();
    resolveCompatibilityHostVersionMock.mockReset();
    installPluginFromArchiveMock.mockReset();

    parseClawHubPluginSpecMock.mockReturnValue({ name: "demo" });
    fetchClawHubPackageDetailMock.mockResolvedValue({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    resolveLatestVersionFromPackageMock.mockReturnValue("2026.3.22");
    fetchClawHubPackageVersionMock.mockResolvedValue({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    fetchClawHubPackageArtifactMock.mockImplementation((params) =>
      fetchClawHubPackageVersionMock(params),
    );
    downloadClawHubPackageArchiveMock.mockResolvedValue({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: DEMO_ARCHIVE_INTEGRITY,
      cleanup: archiveCleanupMock,
    });
    archiveCleanupMock.mockResolvedValue(undefined);
    resolveCompatibilityHostVersionMock.mockReturnValue("2026.3.22");
    installPluginFromArchiveMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/openclaw/plugins/demo",
      version: "2026.3.22",
    });
  });

  it("formats clawhub specifiers", () => {
    expect(formatClawHubSpecifier({ name: "demo" })).toBe("clawhub:demo");
    expect(formatClawHubSpecifier({ name: "demo", version: "1.2.3" })).toBe("clawhub:demo@1.2.3");
  });

  it("installs a ClawHub code plugin through the archive installer", async () => {
    const logger = createLoggerSpies();
    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger,
    });

    expectClawHubInstallFlow({
      baseUrl: "https://clawhub.ai",
      version: "2026.3.22",
      archivePath: "/tmp/clawhub-demo/archive.zip",
    });
    expectSuccessfulClawHubInstall(result);
    expect(logger.info).toHaveBeenCalledWith("ClawHub code-plugin demo@2026.3.22 channel=official");
    expect(logger.info).toHaveBeenCalledWith(
      "Compatibility: pluginApi=>=2026.3.22 minGateway=2026.3.0",
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("marks official source-linked OpenClaw packages as trusted for install scanning", async () => {
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        verification: {
          tier: "source-linked",
          sourceRepo: "openclaw/openclaw",
        },
      },
    });

    await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expect(installPluginFromArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedSourceLinkedOfficialInstall: true,
      }),
    );
  });

  it("resolves explicit ClawHub dist tags before fetching version metadata", async () => {
    parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "demo", version: "latest" });
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        tags: {
          latest: "2026.3.22",
        },
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo@latest",
      baseUrl: "https://clawhub.ai",
    });

    expectSuccessfulClawHubInstall(result);
    expect(fetchClawHubPackageVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo",
        version: "2026.3.22",
      }),
    );
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo",
        version: "2026.3.22",
      }),
    );
  });

  it("returns ClawPack metadata from compatible ClawHub package versions", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
        artifact: {
          kind: "npm-pack",
          format: "tgz",
          sha256: DEMO_CLAWPACK_SHA256,
          size: 4096,
          npmIntegrity: "sha512-clawpack",
          npmShasum: "1".repeat(40),
          npmTarballName: "demo-2026.3.22.tgz",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
      integrity: DEMO_CLAWPACK_INTEGRITY,
      sha256Hex: DEMO_CLAWPACK_SHA256,
      artifact: "clawpack",
      clawpackHeaderSha256: DEMO_CLAWPACK_SHA256,
      npmIntegrity: "sha512-clawpack",
      npmShasum: "1".repeat(40),
      npmTarballName: "demo-2026.3.22.tgz",
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expect(result).toMatchObject({
      ok: true,
      clawhub: {
        integrity: DEMO_CLAWPACK_INTEGRITY,
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
        npmIntegrity: "sha512-clawpack",
        npmShasum: "1".repeat(40),
        npmTarballName: "demo-2026.3.22.tgz",
        clawpackSha256: DEMO_CLAWPACK_SHA256,
        clawpackSize: 4096,
      },
    });
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: "clawpack",
        name: "demo",
        version: "2026.3.22",
      }),
    );
  });

  it("uses the artifact resolver response as the install decision", async () => {
    fetchClawHubPackageVersionMock.mockClear();
    fetchClawHubPackageArtifactMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      version: {
        version: "2026.3.22",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
      artifact: {
        source: "clawhub",
        artifactKind: "npm-pack",
        packageName: "demo",
        version: "2026.3.22",
        artifactSha256: DEMO_CLAWPACK_SHA256,
        npmIntegrity: "sha512-clawpack",
        npmShasum: "1".repeat(40),
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
      integrity: DEMO_CLAWPACK_INTEGRITY,
      sha256Hex: DEMO_CLAWPACK_SHA256,
      artifact: "clawpack",
      clawpackHeaderSha256: DEMO_CLAWPACK_SHA256,
      npmIntegrity: "sha512-clawpack",
      npmShasum: "1".repeat(40),
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expect(result).toMatchObject({
      ok: true,
      clawhub: {
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
        npmIntegrity: "sha512-clawpack",
        npmShasum: "1".repeat(40),
        clawpackSha256: DEMO_CLAWPACK_SHA256,
      },
    });
    expect(fetchClawHubPackageArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo",
        version: "2026.3.22",
      }),
    );
    expect(fetchClawHubPackageVersionMock).not.toHaveBeenCalled();
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: "clawpack",
        name: "demo",
        version: "2026.3.22",
      }),
    );
  });

  it("accepts the live ClawHub artifact resolver shape with kind/sha256 field names", async () => {
    fetchClawHubPackageVersionMock.mockClear();
    fetchClawHubPackageArtifactMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      version: "2026.3.22",
      artifact: {
        kind: "npm-pack",
        sha256: DEMO_CLAWPACK_SHA256,
        npmIntegrity: "sha512-clawpack",
        npmShasum: "1".repeat(40),
      } as unknown as ClawHubResolvedArtifact,
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
      integrity: DEMO_CLAWPACK_INTEGRITY,
      sha256Hex: DEMO_CLAWPACK_SHA256,
      artifact: "clawpack",
      clawpackHeaderSha256: DEMO_CLAWPACK_SHA256,
      npmIntegrity: "sha512-clawpack",
      npmShasum: "1".repeat(40),
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expect(result).toMatchObject({
      ok: true,
      clawhub: {
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
        npmIntegrity: "sha512-clawpack",
        npmShasum: "1".repeat(40),
        clawpackSha256: DEMO_CLAWPACK_SHA256,
      },
    });
    expect(fetchClawHubPackageVersionMock).not.toHaveBeenCalled();
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: "clawpack",
        name: "demo",
        version: "2026.3.22",
      }),
    );
  });

  it("accepts the live ClawHub legacy zip resolver shape with kind/sha256 field names", async () => {
    fetchClawHubPackageVersionMock.mockClear();
    fetchClawHubPackageArtifactMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      version: "2026.3.22",
      artifact: {
        kind: "legacy-zip",
        sha256: DEMO_ARCHIVE_SHA256,
      } as unknown as ClawHubResolvedArtifact,
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: DEMO_ARCHIVE_INTEGRITY,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expect(result).toMatchObject({
      ok: true,
      pluginId: "demo",
      clawhub: {
        artifactKind: "legacy-zip",
        artifactFormat: "zip",
        integrity: DEMO_ARCHIVE_INTEGRITY,
      },
    });
    expect(fetchClawHubPackageVersionMock).not.toHaveBeenCalled();
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: "archive",
        name: "demo",
        version: "2026.3.22",
      }),
    );
  });

  it("falls back to version metadata when the ClawHub artifact resolver route is missing", async () => {
    fetchClawHubPackageArtifactMock.mockRejectedValueOnce(
      new ClawHubRequestError({
        path: "/api/v1/packages/demo/versions/2026.3.22/artifact",
        status: 404,
        body: "Not Found",
      }),
    );
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
        artifact: {
          kind: "npm-pack",
          format: "tgz",
          sha256: DEMO_CLAWPACK_SHA256,
          size: 4096,
          npmIntegrity: "sha512-clawpack",
          npmShasum: "1".repeat(40),
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
      integrity: DEMO_CLAWPACK_INTEGRITY,
      sha256Hex: DEMO_CLAWPACK_SHA256,
      artifact: "clawpack",
      clawpackHeaderSha256: DEMO_CLAWPACK_SHA256,
      npmIntegrity: "sha512-clawpack",
      npmShasum: "1".repeat(40),
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expect(result).toMatchObject({
      ok: true,
      clawhub: {
        artifactKind: "npm-pack",
        npmIntegrity: "sha512-clawpack",
        clawpackSha256: DEMO_CLAWPACK_SHA256,
      },
    });
    expect(fetchClawHubPackageVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo",
        version: "2026.3.22",
      }),
    );
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: "clawpack",
        name: "demo",
        version: "2026.3.22",
      }),
    );
  });

  it("installs ClawPack artifacts when version metadata has no legacy archive hash", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
        artifact: {
          kind: "npm-pack",
          format: "tgz",
          sha256: DEMO_CLAWPACK_SHA256,
          size: 4096,
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
      integrity: DEMO_CLAWPACK_INTEGRITY,
      sha256Hex: DEMO_CLAWPACK_SHA256,
      artifact: "clawpack",
      clawpackHeaderSha256: DEMO_CLAWPACK_SHA256,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expect(result).toMatchObject({
      ok: true,
      clawhub: {
        integrity: DEMO_CLAWPACK_INTEGRITY,
        clawpackSha256: DEMO_CLAWPACK_SHA256,
      },
    });
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: "clawpack",
      }),
    );
    expect(installPluginFromArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
      }),
    );
  });

  it("rejects ClawPack artifacts when the download digest does not match version metadata", async () => {
    const mismatchedSha256 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
        artifact: {
          kind: "npm-pack",
          format: "tgz",
          sha256: DEMO_CLAWPACK_SHA256,
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
      integrity: `sha256-${Buffer.from(mismatchedSha256, "hex").toString("base64")}`,
      sha256Hex: mismatchedSha256,
      artifact: "clawpack",
      clawpackHeaderSha256: mismatchedSha256,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error: `ClawHub ClawPack integrity mismatch for "demo@2026.3.22": expected ${DEMO_CLAWPACK_SHA256}, got ${mismatchedSha256}.`,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("points explicit ClawHub ClawPack download failures at npm during launch rollout", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
        artifact: {
          kind: "npm-pack",
          format: "tgz",
          sha256: DEMO_CLAWPACK_SHA256,
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockRejectedValueOnce(
      new ClawHubRequestError({
        path: "/api/v1/packages/demo/versions/2026.3.22/artifact/download",
        status: 404,
        body: "Not Found",
      }),
    );

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expect(result).toMatchObject({
      ok: false,
      error:
        'ClawHub artifact download for "demo@2026.3.22" is not available yet (ClawHub /api/v1/packages/demo/versions/2026.3.22/artifact/download failed (404): Not Found). Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    });
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: "clawpack",
      }),
    );
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("does not persist package-level ClawPack metadata for version records without ClawPack facts", async () => {
    parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "demo", version: "2026.3.21" });
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
        artifact: {
          kind: "npm-pack",
          format: "tgz",
          sha256: DEMO_CLAWPACK_SHA256,
          size: 4096,
        },
      },
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.21",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo@2026.3.21",
      baseUrl: "https://clawhub.ai",
    });

    expect(result).toMatchObject({
      ok: true,
      clawhub: {
        source: "clawhub",
      },
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.clawhub.clawpackSha256).toBeUndefined();
    expect(result.clawhub.clawpackSpecVersion).toBeUndefined();
    expect(result.clawhub.clawpackManifestSha256).toBeUndefined();
    expect(result.clawhub.clawpackSize).toBeUndefined();
  });

  it("installs when ClawHub advertises a wildcard plugin API range", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        compatibility: {
          pluginApiRange: "*",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expectSuccessfulClawHubInstall(result);
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalledTimes(1);
    expect(installPluginFromArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        archivePath: "/tmp/clawhub-demo/archive.zip",
      }),
    );
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a wildcard plugin API range hide an invalid runtime version", async () => {
    resolveCompatibilityHostVersionMock.mockReturnValueOnce("invalid");
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        compatibility: {
          pluginApiRange: "*",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
      error: 'Plugin "demo" requires plugin API *, but this OpenClaw runtime exposes invalid.',
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).not.toHaveBeenCalled();
  });

  it("passes dangerous force unsafe install through to archive installs", async () => {
    await installPluginFromClawHub({
      spec: "clawhub:demo",
      dangerouslyForceUnsafeInstall: true,
    });

    expect(installPluginFromArchiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        archivePath: "/tmp/clawhub-demo/archive.zip",
        dangerouslyForceUnsafeInstall: true,
      }),
    );
  });

  it("cleans up the downloaded archive even when archive install fails", async () => {
    installPluginFromArchiveMock.mockResolvedValueOnce({
      ok: false,
      error: "bad archive",
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "bad archive",
    });
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("accepts version-endpoint SHA-256 hashes expressed as raw hex", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: "sha256-qerEjGEpvES2+Tyan0j2xwDRkbcnmh4ZFfKN9vWbsa8=",
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
  });

  it("accepts version-endpoint SHA-256 hashes expressed as unpadded SRI", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: "sha256-qerEjGEpvES2+Tyan0j2xwDRkbcnmh4ZFfKN9vWbsa8",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: DEMO_ARCHIVE_INTEGRITY,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
  });

  it("falls back to strict files[] verification when sha256hash is missing", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
      "dist/index.js": 'export const demo = "ok";',
      "_meta.json": '{"slug":"demo","version":"2026.3.22"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: null,
        files: [
          {
            path: "dist/index.js",
            size: 25,
            sha256: sha256Hex('export const demo = "ok";'),
          },
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });
    const logger = createLoggerSpies();

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      logger,
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: dist/index.js, openclaw.plugin.json. Validated generated metadata files present in archive: _meta.json (JSON parse plus slug/version match only).',
    );
  });

  it("validates _meta.json against canonical package and resolved version metadata", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
      "_meta.json": '{"slug":"demo","version":"2026.3.22"}',
    });
    parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "DemoAlias", version: "latest" });
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: null,
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });
    const logger = createLoggerSpies();

    const result = await installPluginFromClawHub({
      spec: "clawhub:DemoAlias@latest",
      logger,
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo", version: "2026.3.22" });
    expect(fetchClawHubPackageDetailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "DemoAlias",
      }),
    );
    expect(fetchClawHubPackageVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo",
        version: "latest",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: openclaw.plugin.json. Validated generated metadata files present in archive: _meta.json (JSON parse plus slug/version match only).',
    );
  });

  it("fails closed when sha256hash is present but unrecognized instead of silently falling back", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: "definitely-not-a-sha256",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid sha256hash (unrecognized value "definitely-not-a-sha256").',
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub installs when sha256hash is explicitly null and files[] is unavailable", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: null,
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub package "demo@2026.3.22" does not expose a downloadable plugin artifact yet. Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub installs when the version metadata has no archive hash or fallback files[]", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub package "demo@2026.3.22" does not expose a downloadable plugin artifact yet. Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("fails closed when files[] contains a malformed entry", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [null as unknown as { path: string; sha256: string }],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0] entry (expected an object, got null).',
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("fails closed when files[] contains an invalid sha256", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: "not-a-digest",
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0].sha256 (value "not-a-digest" is not a 64-character hexadecimal SHA-256 digest).',
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("fails closed when sha256hash is not a string", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: 123 as unknown as string,
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid sha256hash (non-string value of type number).',
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("returns a typed install failure when the archive download throws", async () => {
    downloadClawHubPackageArchiveMock.mockRejectedValueOnce(new Error("network timeout"));

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "network timeout",
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("returns a typed install failure when fallback archive verification cannot read the zip", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "archive.zip");
    await fs.writeFile(archivePath, "not-a-zip", "utf8");
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath,
      integrity: "sha256-not-used-in-fallback",
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error: "ClawHub archive fallback verification failed while reading the downloaded archive.",
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub installs when the downloaded archive hash drifts from metadata", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: "1111111111111111111111111111111111111111111111111111111111111111",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: DEMO_ARCHIVE_INTEGRITY,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error: `ClawHub archive integrity mismatch for "demo@2026.3.22": expected sha256-ERERERERERERERERERERERERERERERERERERERERERE=, got ${DEMO_ARCHIVE_INTEGRITY}.`,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("rejects fallback verification when an expected file is missing from the archive", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
          {
            path: "dist/index.js",
            size: 25,
            sha256: sha256Hex('export const demo = "ok";'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": missing "dist/index.js".',
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when the archive includes an unexpected file", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
      "dist/index.js": 'export const demo = "ok";',
      "extra.txt": "surprise",
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
          {
            path: "dist/index.js",
            size: 25,
            sha256: sha256Hex('export const demo = "ok";'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": unexpected file "extra.txt".',
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("accepts root-level files[] paths and allows _meta.json as an unvalidated generated file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "archive.zip");
    const zip = new JSZip();
    zip.file("scripts/search.py", "print('ok')\n");
    zip.file("SKILL.md", "# Demo\n");
    zip.file("_meta.json", '{"slug":"demo","version":"2026.3.22"}');
    const archiveBytes = await zip.generateAsync({ type: "nodebuffer" });
    await fs.writeFile(archivePath, archiveBytes);
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "scripts/search.py",
            size: 12,
            sha256: sha256Hex("print('ok')\n"),
          },
          {
            path: "SKILL.md",
            size: 7,
            sha256: sha256Hex("# Demo\n"),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath,
      integrity: `sha256-${createHash("sha256").update(archiveBytes).digest("base64")}`,
      cleanup: archiveCleanupMock,
    });
    const logger = createLoggerSpies();

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      logger,
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: SKILL.md, scripts/search.py. Validated generated metadata files present in archive: _meta.json (JSON parse plus slug/version match only).',
    );
  });

  it("omits the skipped-files suffix when no generated extras are present", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });
    const logger = createLoggerSpies();

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      logger,
    });

    expect(result).toMatchObject({ ok: true, pluginId: "demo" });
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: openclaw.plugin.json.',
    );
  });

  it("rejects fallback verification when _meta.json is not valid JSON", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
      "_meta.json": "{not-json",
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": _meta.json is not valid JSON.',
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when _meta.json slug does not match the package name", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
      "_meta.json": '{"slug":"wrong","version":"2026.3.22"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": _meta.json slug does not match the package name.',
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when _meta.json exceeds the per-file size limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "archive.zip");
    await fs.writeFile(archivePath, "placeholder", "utf8");
    const oversizedMetaEntry = {
      name: "_meta.json",
      dir: false,
      _data: { uncompressedSize: 256 * 1024 * 1024 + 1 },
      nodeStream: vi.fn(),
    } as unknown as JSZip.JSZipObject;
    const listedFileEntry = {
      name: "openclaw.plugin.json",
      dir: false,
      _data: { uncompressedSize: 13 },
      nodeStream: () => Readable.from([Buffer.from('{"id":"demo"}')]),
    } as unknown as JSZip.JSZipObject;
    const loadAsyncSpy = vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce({
      files: {
        "_meta.json": oversizedMetaEntry,
        "openclaw.plugin.json": listedFileEntry,
      },
    } as unknown as JSZip);
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath,
      integrity: "sha256-not-used-in-fallback",
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    loadAsyncSpy.mockRestore();
    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive fallback verification rejected "_meta.json" because it exceeds the per-file size limit.',
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when archive directories alone exceed the entry limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "archive.zip");
    await fs.writeFile(archivePath, "placeholder", "utf8");
    const zipEntries = Object.fromEntries(
      Array.from({ length: 50_001 }, (_, index) => [
        `folder-${index}/`,
        {
          name: `folder-${index}/`,
          dir: true,
        },
      ]),
    );
    const loadAsyncSpy = vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce({
      files: zipEntries,
    } as unknown as JSZip);
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath,
      integrity: "sha256-not-used-in-fallback",
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    loadAsyncSpy.mockRestore();
    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error: "ClawHub archive fallback verification exceeded the archive entry limit.",
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when the actual ZIP central directory exceeds the entry limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "archive.zip");
    await fs.writeFile(
      archivePath,
      createZipCentralDirectoryArchive({
        actualEntryCount: 50_001,
        declaredEntryCount: 1,
        declaredCentralDirectorySize: 0,
      }),
    );
    const loadAsyncSpy = vi.spyOn(JSZip, "loadAsync");
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath,
      integrity: "sha256-not-used-in-fallback",
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    loadAsyncSpy.mockRestore();
    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error: "ClawHub archive fallback verification exceeded the archive entry limit.",
    });
    expect(loadAsyncSpy).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when the downloaded archive exceeds the ZIP size limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-archive-"));
    tempDirs.push(dir);
    const archivePath = path.join(dir, "archive.zip");
    await fs.writeFile(archivePath, "placeholder", "utf8");
    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (filePath, options) => {
      if (filePath === archivePath) {
        return {
          size: 256 * 1024 * 1024 + 1,
        } as Awaited<ReturnType<typeof fs.stat>>;
      }
      return await realStat(filePath, options);
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      archivePath,
      integrity: "sha256-not-used-in-fallback",
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    statSpy.mockRestore();
    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        "ClawHub archive fallback verification rejected the downloaded archive because it exceeds the ZIP archive size limit.",
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when a file hash drifts from files[] metadata", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: "1".repeat(64),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error: `ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": expected openclaw.plugin.json to hash to ${"1".repeat(64)}, got ${sha256Hex('{"id":"demo"}')}.`,
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback metadata with an unsafe files[] path", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "../evil.txt",
            size: 4,
            sha256: "1".repeat(64),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0].path (path "../evil.txt" contains dot segments).',
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback metadata with leading or trailing path whitespace", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json ",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0].path (path "openclaw.plugin.json " has leading or trailing whitespace).',
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback verification when the archive includes a whitespace-suffixed file path", async () => {
    const archive = await createClawHubArchive({
      "openclaw.plugin.json": '{"id":"demo"}',
      "openclaw.plugin.json ": '{"id":"demo"}',
    });
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    downloadClawHubPackageArchiveMock.mockResolvedValueOnce({
      ...archive,
      cleanup: archiveCleanupMock,
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": invalid package file path "openclaw.plugin.json " (path "openclaw.plugin.json " has leading or trailing whitespace).',
    });
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback metadata with duplicate files[] paths", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
          {
            path: "openclaw.plugin.json",
            size: 13,
            sha256: sha256Hex('{"id":"demo"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" has duplicate files[] path "openclaw.plugin.json".',
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects fallback metadata when files[] includes generated _meta.json", async () => {
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        files: [
          {
            path: "_meta.json",
            size: 64,
            sha256: sha256Hex('{"slug":"demo","version":"2026.3.22"}'),
          },
        ],
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(result).toMatchObject({
      ok: false,
      code: CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      error:
        'ClawHub version metadata for "demo@2026.3.22" must not include generated file "_meta.json" in files[].',
    });
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "rejects packages whose plugin API range exceeds the runtime version",
      setup: () => {
        resolveCompatibilityHostVersionMock.mockReturnValueOnce("2026.3.21");
      },
      spec: "clawhub:demo",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
        error:
          'Plugin "demo" requires plugin API >=2026.3.22, but this OpenClaw runtime exposes 2026.3.21.',
      },
    },
    {
      name: "rejects skill families and redirects to skills install",
      setup: () => {
        fetchClawHubPackageDetailMock.mockResolvedValueOnce({
          package: {
            name: "calendar",
            displayName: "Calendar",
            family: "skill",
            channel: "official",
            isOfficial: true,
            createdAt: 0,
            updatedAt: 0,
          },
        });
      },
      spec: "clawhub:calendar",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.SKILL_PACKAGE,
        error: '"calendar" is a skill. Use "openclaw skills install calendar" instead.',
      },
    },
    {
      name: "redirects skill families before missing archive metadata checks",
      setup: () => {
        fetchClawHubPackageDetailMock.mockResolvedValueOnce({
          package: {
            name: "calendar",
            displayName: "Calendar",
            family: "skill",
            channel: "official",
            isOfficial: true,
            createdAt: 0,
            updatedAt: 0,
          },
        });
        fetchClawHubPackageVersionMock.mockResolvedValueOnce({
          version: {
            version: "2026.3.22",
            createdAt: 0,
            changelog: "",
          },
        });
      },
      spec: "clawhub:calendar",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.SKILL_PACKAGE,
        error: '"calendar" is a skill. Use "openclaw skills install calendar" instead.',
      },
    },
    {
      name: "returns typed package-not-found failures",
      setup: () => {
        fetchClawHubPackageDetailMock.mockRejectedValueOnce(
          new ClawHubRequestError({
            path: "/api/v1/packages/demo",
            status: 404,
            body: "Package not found",
          }),
        );
      },
      spec: "clawhub:demo",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND,
        error: "Package not found on ClawHub.",
      },
    },
    {
      name: "returns typed version-not-found failures",
      setup: () => {
        parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "demo", version: "9.9.9" });
        fetchClawHubPackageVersionMock.mockRejectedValueOnce(
          new ClawHubRequestError({
            path: "/api/v1/packages/demo/versions/9.9.9",
            status: 404,
            body: "Version not found",
          }),
        );
      },
      spec: "clawhub:demo@9.9.9",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND,
        error: "Version not found on ClawHub: demo@9.9.9.",
      },
    },
  ] as const)("$name", async ({ setup, spec, expected }) => {
    await expectClawHubInstallError({ setup, spec, expected });
  });
});
