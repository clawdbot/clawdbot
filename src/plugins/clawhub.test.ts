/** Verifies ClawHub plugin spec parsing and install metadata handling. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createZipCentralDirectoryArchive } from "../test-utils/zip-central-directory-fixture.js";

const parseClawHubPluginSpecMock = vi.fn();
const fetchClawHubPackageDetailMock = vi.fn();
const fetchClawHubPackageArtifactMock = vi.fn();
const fetchClawHubPackageSecurityMock = vi.fn();
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
    fetchClawHubPackageSecurity: (...args: unknown[]) => fetchClawHubPackageSecurityMock(...args),
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
  PLUGIN_INSTALL_ERROR_CODE: {
    PLUGIN_ID_MISMATCH: "plugin_id_mismatch",
  },
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
type ClawHubRiskAcknowledgementRequest = import("./clawhub.js").ClawHubRiskAcknowledgementRequest;
const { CLAWHUB_INSTALL_ERROR_CODE, installPluginFromClawHub } = await import("./clawhub.js");

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
  const result = await installPluginFromClawHub({ spec: params.spec });
  const failure = expectInstallFailure(result);
  expect(failure.code).toBe(params.expected.code);
  expect(failure.error).toBe(params.expected.error);
}

function createLoggerSpies() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function mockCommunityClawHubPackageDetail() {
  fetchClawHubPackageDetailMock.mockResolvedValue({
    package: {
      name: "demo",
      displayName: "Demo",
      family: "code-plugin",
      channel: "community",
      isOfficial: false,
      createdAt: 0,
      updatedAt: 0,
      compatibility: {
        pluginApiRange: ">=2026.3.22",
        minGatewayVersion: "2026.3.0",
      },
    },
  });
}

function mockOfficialClawHubPackageDetail(overrides: Record<string, unknown>): void {
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
      ...overrides,
    },
  });
}

function expectClawHubInstallFlow(params: {
  baseUrl: string;
  version: string;
  archivePath: string;
  expectSecurityCall?: boolean;
}) {
  expect(packageDetailCall().name).toBe("demo");
  expect(packageDetailCall().baseUrl).toBe(params.baseUrl);
  expect(packageVersionCall().name).toBe("demo");
  expect(packageVersionCall().version).toBe(params.version);
  expect(packageArtifactCall().name).toBe("demo");
  expect(packageArtifactCall().version).toBe(params.version);
  if (params.expectSecurityCall ?? true) {
    expect(packageSecurityCall().name).toBe("demo");
    expect(packageSecurityCall().version).toBe(params.version);
  } else {
    expect(fetchClawHubPackageSecurityMock).not.toHaveBeenCalled();
  }
  expect(archiveInstallCall().archivePath).toBe(params.archivePath);
}

function expectSuccessfulClawHubInstall(
  result: unknown,
  expected: { clawhubChannel?: string } = {},
) {
  const success = expectInstallSuccess(result);
  expect(success.pluginId).toBe("demo");
  expect(success.version).toBe("2026.3.22");
  expect(success.clawhub?.source).toBe("clawhub");
  expect(success.clawhub?.clawhubPackage).toBe("demo");
  expect(success.clawhub?.clawhubFamily).toBe("code-plugin");
  expect(success.clawhub?.clawhubChannel).toBe(expected.clawhubChannel ?? "official");
  expect(success.clawhub?.integrity).toBe(DEMO_ARCHIVE_INTEGRITY);
}

type MockWithCalls = {
  mock: {
    calls: readonly (readonly unknown[])[];
  };
};

type PackageLookupCall = {
  artifact?: string;
  baseUrl?: string;
  name?: string;
  version?: string;
};

type ArchiveInstallCall = {
  archivePath?: string;
  dangerouslyForceUnsafeInstall?: boolean;
  expectedPluginId?: string;
  installPolicyRequest?: {
    kind?: string;
    requestedSpecifier?: string;
    source?: { kind?: string; authority?: string; mutable?: boolean; network?: boolean };
  };
  trustedSourceLinkedOfficialInstall?: boolean;
};

type InstallSuccess = {
  clawhub?: Record<string, unknown>;
  ok: true;
  packageName?: string;
  pluginId?: string;
  version?: string;
  warning?: string;
};

type InstallFailure = {
  code?: string;
  error: string;
  ok: false;
  version?: string;
  warning?: string;
};

function mockCallArg(mock: MockWithCalls, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  if (call.length <= argIndex) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function packageDetailCall(callIndex = 0): PackageLookupCall {
  return mockCallArg(fetchClawHubPackageDetailMock, callIndex) as PackageLookupCall;
}

function packageVersionCall(callIndex = 0): PackageLookupCall {
  return mockCallArg(fetchClawHubPackageVersionMock, callIndex) as PackageLookupCall;
}

function packageArtifactCall(callIndex = 0): PackageLookupCall {
  return mockCallArg(fetchClawHubPackageArtifactMock, callIndex) as PackageLookupCall;
}

function packageSecurityCall(callIndex = 0): PackageLookupCall {
  return mockCallArg(fetchClawHubPackageSecurityMock, callIndex) as PackageLookupCall;
}

function archiveDownloadCall(callIndex = 0): PackageLookupCall {
  return mockCallArg(downloadClawHubPackageArchiveMock, callIndex) as PackageLookupCall;
}

function archiveInstallCall(callIndex = 0): ArchiveInstallCall {
  return mockCallArg(installPluginFromArchiveMock, callIndex) as ArchiveInstallCall;
}

function expectInstallSuccess(result: unknown): InstallSuccess {
  expect((result as { ok?: unknown }).ok).toBe(true);
  return result as InstallSuccess;
}

function expectInstallFailure(result: unknown): InstallFailure {
  expect((result as { ok?: unknown }).ok).toBe(false);
  return result as InstallFailure;
}

function expectInstallFailureFields(
  result: unknown,
  code: (typeof CLAWHUB_INSTALL_ERROR_CODE)[keyof typeof CLAWHUB_INSTALL_ERROR_CODE],
  error: string,
) {
  const failure = expectInstallFailure(result);
  expect(failure.code).toBe(code);
  expect(failure.error).toBe(error);
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
    fetchClawHubPackageSecurityMock.mockReset();
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
    fetchClawHubPackageSecurityMock.mockImplementation(
      (params: { name?: string; version?: string }) =>
        Promise.resolve({
          package: {
            name: params.name ?? "demo",
            displayName: "Demo",
            family: "code-plugin",
          },
          release: {
            version: params.version ?? "2026.3.22",
          },
          trust: {
            scanStatus: "clean",
            moderationState: null,
            blockedFromDownload: false,
            reasons: [],
            pending: false,
            stale: false,
          },
        }),
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

  it("installs a ClawHub plugin through the archive installer", async () => {
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
      expectSecurityCall: false,
    });
    expectSuccessfulClawHubInstall(result);
    expect(archiveInstallCall().installPolicyRequest).toEqual({
      kind: "plugin-archive",
      requestedSpecifier: "clawhub:demo",
      source: { kind: "clawhub", authority: "official", mutable: false, network: true },
    });
    expect(archiveInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Package   demo@2026.3.22"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Type      plugin"));
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Requires  pluginApi >=2026.3.22"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("ClawHub   https://clawhub.ai/plugins/demo"),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["package runtimeId", { runtimeId: "demo-runtime" }],
    ["capabilities.runtimeId", { capabilities: { runtimeId: "demo-runtime" } }],
  ])("pins archive installation to the advertised %s", async (_label, overrides) => {
    mockOfficialClawHubPackageDetail(overrides);
    installPluginFromArchiveMock.mockResolvedValueOnce({
      ok: true,
      pluginId: "demo-runtime",
      targetDir: "/tmp/openclaw/plugins/demo-runtime",
      version: "2026.3.22",
    });

    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });

    expect(expectInstallSuccess(result).pluginId).toBe("demo-runtime");
    expect(archiveInstallCall().expectedPluginId).toBe("demo-runtime");
  });

  it("rejects caller and advertised runtime id mismatches before download", async () => {
    mockOfficialClawHubPackageDetail({ runtimeId: "advertised-runtime" });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      expectedPluginId: "expected-runtime",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe("plugin_id_mismatch");
    expect(failure.error).toBe(
      'ClawHub package runtime id mismatch: expected "expected-runtime", got "advertised-runtime".',
    );
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects inconsistent advertised runtime ids before download", async () => {
    mockOfficialClawHubPackageDetail({
      runtimeId: "package-runtime",
      capabilities: { runtimeId: "capabilities-runtime" },
    });

    const result = await installPluginFromClawHub({ spec: "clawhub:demo" });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe("plugin_id_mismatch");
    expect(failure.error).toBe(
      'ClawHub package runtime id mismatch: package advertises "package-runtime" but capabilities advertise "capabilities-runtime".',
    );
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("accepts a matching catalog archive integrity pin", async () => {
    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      expectedIntegrity: `sha256:${DEMO_ARCHIVE_SHA256}`,
    });

    expectSuccessfulClawHubInstall(result);
    expect(installPluginFromArchiveMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a catalog archive integrity mismatch before extraction", async () => {
    const expectedIntegrity = `sha256-${Buffer.from("1".repeat(64), "hex").toString("base64")}`;

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      expectedIntegrity,
    });

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      `ClawHub archive integrity mismatch for "demo@2026.3.22": expected ${expectedIntegrity}, got ${DEMO_ARCHIVE_INTEGRITY}.`,
    );
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("marks custom ClawHub registries as third-party install policy authority", async () => {
    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.internal.example",
    });

    expectClawHubInstallFlow({
      baseUrl: "https://clawhub.internal.example",
      version: "2026.3.22",
      archivePath: "/tmp/clawhub-demo/archive.zip",
    });
    expectSuccessfulClawHubInstall(result);
    expect(archiveInstallCall().installPolicyRequest).toMatchObject({
      kind: "plugin-archive",
      requestedSpecifier: "clawhub:demo",
      source: { kind: "clawhub", authority: "third-party", mutable: false, network: true },
    });
  });

  it("does not warn just because a ClawHub package is community channel", async () => {
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "community",
        isOfficial: false,
        createdAt: 0,
        updatedAt: 0,
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    const logger = { ...createLoggerSpies(), terminalLinks: true };

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger,
    });

    const success = expectInstallSuccess(result);
    expect(success.pluginId).toBe("demo");
    expect(success.clawhub?.clawhubChannel).toBe("community");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sanitizes the ClawHub package summary link before logging", async () => {
    const logger = createLoggerSpies();

    await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai/\u001b]8;;https://evil.example\u0007\ninjected",
      logger,
    });

    const summary = logger.info.mock.calls.map(([message]) => message).join("\n");
    expect(summary).toContain("ClawHub");
    expect(summary).not.toContain("\u001b");
    expect(summary).not.toContain("\u0007");
    expect(summary).not.toContain("https://clawhub.ai/\ninjected");
    expect(summary).toContain("https://clawhub.ai/\\ninjected/plugins/demo");
  });

  it("blocks malicious ClawHub releases even when risk is acknowledged", async () => {
    mockCommunityClawHubPackageDetail();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "malicious",
        moderationState: "quarantined",
        blockedFromDownload: true,
        reasons: ["manual_moderation"],
        pending: false,
        stale: false,
      },
    });
    const logger = { ...createLoggerSpies(), terminalLinks: true };

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger,
      acknowledgeClawHubRisk: true,
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED);
    expect(failure.error).toBe("ClawHub blocked this release; install was not started.");
    expect(failure.warning).toContain("ClawHub flagged this release as malicious");
    expect(failure.warning).not.toContain("\u001b");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("BLOCKED"));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ClawHub flagged this release as malicious"),
    );
    const warning = logger.warn.mock.calls[0]?.[0] ?? "";
    expect(warning).toContain("\u001b]8");
    expect(warning).toContain("• Security scan");
    expect(warning).toContain("malicious");
    expect(warning).toContain("• Moderation      quarantined");
    expect(warning).toContain("• Finding         manual_moderation");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("manual_moderation"));
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("explains that a malicious plugin update will not be downloaded", async () => {
    mockCommunityClawHubPackageDetail();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "malicious",
        moderationState: "quarantined",
        blockedFromDownload: true,
        reasons: ["scan:malicious"],
        pending: false,
        stale: false,
      },
    });
    const logger = createLoggerSpies();

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger,
      mode: "update",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED);
    const warning = logger.warn.mock.calls[0]?.[0] ?? "";
    expect(warning).toContain(
      "Latest plugin version is marked malicious; OpenClaw will not download it.",
    );
    expect(warning).toContain(
      "Uninstall the installed plugin unless you have independently reviewed it.",
    );
    expect(warning).not.toContain("Choose a different version");
    expect(warning).not.toContain("/security/static-analysis");
    expect(warning).not.toContain("/security/virustotal");
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("includes the blocked-download reason when other trust evidence exists", async () => {
    mockCommunityClawHubPackageDetail();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "clean",
        moderationState: null,
        blockedFromDownload: true,
        reasons: [],
        pending: false,
        stale: false,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED);
    expect(failure.warning).toContain("BLOCKED - ClawHub blocked this release");
    expect(failure.warning).not.toContain("flagged this release as malicious");
    expect(failure.warning).toContain("Security scan   clean");
    expect(failure.warning).toContain("Download disabled by ClawHub for this release");
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("requires acknowledgement before downloading non-clean ClawHub releases", async () => {
    mockCommunityClawHubPackageDetail();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "not-run",
        moderationState: null,
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: false,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED);
    expect(failure.warning).toContain("WARNING - ClawHub found security risks");
    expect(failure.warning).toContain("Security scan   not-run");
    expect(failure.warning).toContain("large local system blast radius");
    expect(failure.warning).toContain("before installing");
    expect(failure.warning).not.toContain("blockedFromDownload=false");
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("renders derived risk reasons when ClawHub trust evidence fields are missing", async () => {
    mockCommunityClawHubPackageDetail();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: null,
        moderationState: null,
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: false,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED);
    expect(failure.warning).toContain("WARNING - ClawHub found security risks");
    expect(failure.warning).toContain("security scan status is missing");
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("uses update wording in non-clean ClawHub release warnings during update", async () => {
    mockCommunityClawHubPackageDetail();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "not-run",
        moderationState: null,
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: false,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      mode: "update",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED);
    expect(failure.warning).toContain("before updating");
    expect(failure.warning).not.toContain("before installing");
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("sanitizes ClawHub trust warning fields before logging", async () => {
    mockCommunityClawHubPackageDetail();
    const logger = createLoggerSpies();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "clean\u001b[2K",
        moderationState: null,
        blockedFromDownload: false,
        reasons: ["bad\nreason"],
        pending: false,
        stale: false,
      },
    });

    await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger,
    });

    const warning = logger.warn.mock.calls[0]?.[0];
    expect(warning).toContain("bad\\nreason");
    expect(warning).not.toContain("\u001b");
    expect(warning).not.toContain("bad\nreason");
  });

  it("requires acknowledgement before downloading releases with unknown moderation state", async () => {
    mockCommunityClawHubPackageDetail();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "clean",
        moderationState: "manual-review",
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: false,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED);
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("stops when ClawHub security identity does not match the requested release", async () => {
    mockCommunityClawHubPackageDetail();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.21",
      },
      trust: {
        scanStatus: "clean",
        moderationState: null,
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: false,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE);
    expect(failure.version).toBe("2026.3.22");
    expect(failure.error).toContain('returned version "2026.3.21"');
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("sanitizes ClawHub security identity mismatch labels before returning errors", async () => {
    mockCommunityClawHubPackageDetail();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.21\nrewritten\u001b[2K",
      },
      trust: {
        scanStatus: "clean",
        moderationState: null,
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: false,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE);
    expect(failure.error).toContain('returned version "2026.3.21\\nrewritten"');
    expect(failure.error).not.toContain("\n");
    expect(failure.error).not.toContain("\u001b");
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("sanitizes ClawHub security fetch failure labels before returning errors", async () => {
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        name: "demo\npkg",
        displayName: "Demo",
        family: "code-plugin",
        channel: "community",
        isOfficial: false,
        createdAt: 0,
        updatedAt: 0,
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    fetchClawHubPackageSecurityMock.mockRejectedValueOnce(new Error("bad\nupstream\u001b[2K"));

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE);
    expect(failure.error).toContain('"demo\\npkg@2026.3.22"');
    expect(failure.error).toContain("bad\\nupstream");
    expect(failure.error).not.toContain("\n");
    expect(failure.error).not.toContain("\u001b");
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("continues after a risky ClawHub release is acknowledged", async () => {
    mockCommunityClawHubPackageDetail();
    const onClawHubRisk = vi.fn(async (_request: ClawHubRiskAcknowledgementRequest) => true);
    const logger = { ...createLoggerSpies(), terminalLinks: true };
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "suspicious",
        moderationState: null,
        blockedFromDownload: false,
        reasons: ["payload_strings"],
        pending: false,
        stale: false,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger,
      onClawHubRisk,
    });

    expectSuccessfulClawHubInstall(result, { clawhubChannel: "community" });
    const success = expectInstallSuccess(result);
    expect(success.clawhub?.clawhubTrustDisposition).toBe("review-required");
    expect(success.clawhub?.clawhubTrustScanStatus).toBe("suspicious");
    expect(success.clawhub?.clawhubTrustReasons).toEqual(["payload_strings"]);
    expect(success.clawhub?.clawhubTrustCheckedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );
    expect(success.clawhub?.clawhubTrustAcknowledgedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );
    expect(onClawHubRisk).toHaveBeenCalledWith(
      expect.objectContaining({
        acknowledgementKind: "type-package",
        packageName: "demo",
        version: "2026.3.22",
        warning: expect.stringContaining("payload strings"),
      }),
    );
    expect(onClawHubRisk.mock.calls[0]?.[0].warning).not.toContain("\u001b");
    expect(logger.warn.mock.calls.map(([message]) => message).join("\n")).toContain("\u001b]8");
    expect(downloadClawHubPackageArchiveMock).toHaveBeenCalled();
  });

  it("warns for stale clean ClawHub trust without requiring acknowledgement", async () => {
    mockCommunityClawHubPackageDetail();
    const onClawHubRisk = vi.fn(async () => false);
    const logger = createLoggerSpies();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "clean",
        moderationState: null,
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: true,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger,
      onClawHubRisk,
    });

    expectSuccessfulClawHubInstall(result, { clawhubChannel: "community" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("REVIEW RECOMMENDED"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("scan data is stale"));
    expect(onClawHubRisk).not.toHaveBeenCalled();
  });

  it("warns for pending ClawHub scans without requiring acknowledgement", async () => {
    mockCommunityClawHubPackageDetail();
    const onClawHubRisk = vi.fn(async () => false);
    const logger = createLoggerSpies();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "pending",
        moderationState: null,
        blockedFromDownload: false,
        reasons: ["scan:pending"],
        pending: true,
        stale: false,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
      logger,
      onClawHubRisk,
    });

    expectSuccessfulClawHubInstall(result, { clawhubChannel: "community" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("REVIEW RECOMMENDED"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("security scan is pending"));
    expect(onClawHubRisk).not.toHaveBeenCalled();
  });

  it("requires acknowledgement when pending reason codes appear without pending or stale trust", async () => {
    mockCommunityClawHubPackageDetail();
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "pending",
        moderationState: null,
        blockedFromDownload: false,
        reasons: ["scan:pending"],
        pending: false,
        stale: false,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED);
    expect(failure.warning).toContain("WARNING - ClawHub found security risks");
    expect(failure.warning).toContain("Security scan   pending");
    expect(failure.warning).toContain("scan pending");
    expect(failure.warning).not.toContain("blockedFromDownload=false");
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("stops when the ClawHub security response is unavailable", async () => {
    mockCommunityClawHubPackageDetail();
    fetchClawHubPackageSecurityMock.mockRejectedValueOnce(
      new ClawHubRequestError({
        path: "/api/v1/packages/demo/versions/2026.3.22/security",
        status: 404,
        body: "not found",
      }),
    );

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE);
    expect(failure.error).toContain("ClawHub release trust check failed");
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("bypasses ClawHub trust checks for official packages", async () => {
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
    fetchClawHubPackageSecurityMock.mockRejectedValueOnce(new Error("should not be called"));

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const success = expectInstallSuccess(result);
    expect(success.clawhub?.clawhubTrustDisposition).toBeUndefined();
    expect(success.clawhub?.clawhubTrustScanStatus).toBeUndefined();
    expect(fetchClawHubPackageSecurityMock).not.toHaveBeenCalled();
    expect(archiveInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(archiveInstallCall().installPolicyRequest?.source).toEqual({
      kind: "clawhub",
      authority: "official",
      mutable: false,
      network: true,
    });
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
    expect(packageVersionCall().name).toBe("demo");
    expect(packageVersionCall().version).toBe("2026.3.22");
    expect(archiveDownloadCall().name).toBe("demo");
    expect(archiveDownloadCall().version).toBe("2026.3.22");
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

    const success = expectInstallSuccess(result);
    expect(success.clawhub?.integrity).toBe(DEMO_CLAWPACK_INTEGRITY);
    expect(success.clawhub?.artifactKind).toBe("npm-pack");
    expect(success.clawhub?.artifactFormat).toBe("tgz");
    expect(success.clawhub?.npmIntegrity).toBe("sha512-clawpack");
    expect(success.clawhub?.npmShasum).toBe("1".repeat(40));
    expect(success.clawhub?.npmTarballName).toBe("demo-2026.3.22.tgz");
    expect(success.clawhub?.clawpackSha256).toBe(DEMO_CLAWPACK_SHA256);
    expect(success.clawhub?.clawpackSize).toBe(4096);
    expect(archiveDownloadCall().artifact).toBe("clawpack");
    expect(archiveDownloadCall().name).toBe("demo");
    expect(archiveDownloadCall().version).toBe("2026.3.22");
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

    const success = expectInstallSuccess(result);
    expect(success.clawhub?.artifactKind).toBe("npm-pack");
    expect(success.clawhub?.artifactFormat).toBe("tgz");
    expect(success.clawhub?.npmIntegrity).toBe("sha512-clawpack");
    expect(success.clawhub?.npmShasum).toBe("1".repeat(40));
    expect(success.clawhub?.clawpackSha256).toBe(DEMO_CLAWPACK_SHA256);
    expect(packageArtifactCall().name).toBe("demo");
    expect(packageArtifactCall().version).toBe("2026.3.22");
    expect(fetchClawHubPackageVersionMock).not.toHaveBeenCalled();
    expect(archiveDownloadCall().artifact).toBe("clawpack");
    expect(archiveDownloadCall().name).toBe("demo");
    expect(archiveDownloadCall().version).toBe("2026.3.22");
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

    const success = expectInstallSuccess(result);
    expect(success.clawhub?.artifactKind).toBe("npm-pack");
    expect(success.clawhub?.artifactFormat).toBe("tgz");
    expect(success.clawhub?.npmIntegrity).toBe("sha512-clawpack");
    expect(success.clawhub?.npmShasum).toBe("1".repeat(40));
    expect(success.clawhub?.clawpackSha256).toBe(DEMO_CLAWPACK_SHA256);
    expect(fetchClawHubPackageVersionMock).not.toHaveBeenCalled();
    expect(archiveDownloadCall().artifact).toBe("clawpack");
    expect(archiveDownloadCall().name).toBe("demo");
    expect(archiveDownloadCall().version).toBe("2026.3.22");
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

    const success = expectInstallSuccess(result);
    expect(success.pluginId).toBe("demo");
    expect(success.clawhub?.artifactKind).toBe("legacy-zip");
    expect(success.clawhub?.artifactFormat).toBe("zip");
    expect(success.clawhub?.integrity).toBe(DEMO_ARCHIVE_INTEGRITY);
    expect(fetchClawHubPackageVersionMock).not.toHaveBeenCalled();
    expect(archiveDownloadCall().artifact).toBe("archive");
    expect(archiveDownloadCall().name).toBe("demo");
    expect(archiveDownloadCall().version).toBe("2026.3.22");
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

    const success = expectInstallSuccess(result);
    expect(success.clawhub?.artifactKind).toBe("npm-pack");
    expect(success.clawhub?.npmIntegrity).toBe("sha512-clawpack");
    expect(success.clawhub?.clawpackSha256).toBe(DEMO_CLAWPACK_SHA256);
    expect(packageVersionCall().name).toBe("demo");
    expect(packageVersionCall().version).toBe("2026.3.22");
    expect(archiveDownloadCall().artifact).toBe("clawpack");
    expect(archiveDownloadCall().name).toBe("demo");
    expect(archiveDownloadCall().version).toBe("2026.3.22");
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

    const success = expectInstallSuccess(result);
    expect(success.clawhub?.integrity).toBe(DEMO_CLAWPACK_INTEGRITY);
    expect(success.clawhub?.clawpackSha256).toBe(DEMO_CLAWPACK_SHA256);
    expect(archiveDownloadCall().artifact).toBe("clawpack");
    expect(archiveInstallCall().archivePath).toBe("/tmp/clawhub-demo/demo-2026.3.22.tgz");
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

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH);
    expect(failure.error).toBe(
      `ClawHub ClawPack integrity mismatch for "demo@2026.3.22": expected ${DEMO_CLAWPACK_SHA256}, got ${mismatchedSha256}.`,
    );
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

    const failure = expectInstallFailure(result);
    expect(failure.error).toBe(
      'ClawHub artifact download for "demo@2026.3.22" is not available yet (ClawHub /api/v1/packages/demo/versions/2026.3.22/artifact/download failed (404): Not Found). Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    );
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE);
    expect(archiveDownloadCall().artifact).toBe("clawpack");
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("treats blocked ClawHub ClawPack downloads as non-fallback trust failures", async () => {
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
        status: 403,
        body: "Blocked: this package release has been flagged as malicious and cannot be downloaded.",
      }),
    );

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.error).toBe(
      'ClawHub blocked artifact download for "demo@2026.3.22"; install was not started. ClawHub /api/v1/packages/demo/versions/2026.3.22/artifact/download failed (403): Blocked: this package release has been flagged as malicious and cannot be downloaded.',
    );
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED);
    expect(failure.version).toBe("2026.3.22");
    expect(archiveDownloadCall().artifact).toBe("clawpack");
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("keeps generic forbidden ClawHub ClawPack downloads fallback-eligible", async () => {
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
        status: 403,
        body: "Forbidden.",
      }),
    );

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE);
    expect(failure.error).toContain(
      'ClawHub artifact download for "demo@2026.3.22" is not available yet',
    );
    expect(failure.error).toContain('Use "npm:demo@2026.3.22"');
    expect(failure.version).toBeUndefined();
    expect(archiveDownloadCall().artifact).toBe("clawpack");
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

    const success = expectInstallSuccess(result);
    expect(success.clawhub?.source).toBe("clawhub");
    expect(success.clawhub?.clawpackSha256).toBeUndefined();
    expect(success.clawhub?.clawpackSpecVersion).toBeUndefined();
    expect(success.clawhub?.clawpackManifestSha256).toBeUndefined();
    expect(success.clawhub?.clawpackSize).toBeUndefined();
  });

  it("does not inherit package-level compatibility when version-specific compatibility is absent for pinned older version", async () => {
    parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "demo", version: "2026.6.8" });
    resolveLatestVersionFromPackageMock.mockReturnValue("2026.6.10");
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        latestVersion: "2026.6.10",
        compatibility: {
          pluginApiRange: ">=2026.6.10",
          minGatewayVersion: "2026.6.10",
        },
      },
    });
    resolveCompatibilityHostVersionMock.mockReturnValue("2026.6.8");
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.6.8",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo@2026.6.8",
      baseUrl: "https://clawhub.ai",
    });

    expectSuccessfulClawHubInstall(result);
  });

  it("recovers version-specific compatibility from version endpoint when artifact metadata is sparse", async () => {
    parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "demo", version: "2026.6.8" });
    resolveLatestVersionFromPackageMock.mockReturnValue("2026.6.10");
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        latestVersion: "2026.6.10",
        compatibility: {
          pluginApiRange: ">=2026.6.10",
          minGatewayVersion: "2026.6.10",
        },
      },
    });
    resolveCompatibilityHostVersionMock.mockReturnValue("2026.6.5");
    // Artifact endpoint returns sparse metadata (no compatibility).
    fetchClawHubPackageArtifactMock.mockResolvedValueOnce({
      version: {
        version: "2026.6.8",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
      },
    });
    // Version endpoint has the real version-specific compatibility.
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.6.8",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        compatibility: {
          pluginApiRange: ">=2026.6.8",
          minGatewayVersion: "2026.6.8",
        },
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo@2026.6.8",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.error).toContain("2026.6.8");
  });

  it("fails closed when version endpoint is unavailable for sparse artifact metadata on pinned version", async () => {
    parseClawHubPluginSpecMock.mockReturnValueOnce({ name: "demo", version: "2026.6.8" });
    resolveLatestVersionFromPackageMock.mockReturnValue("2026.6.10");
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        latestVersion: "2026.6.10",
        compatibility: {
          pluginApiRange: ">=2026.6.10",
          minGatewayVersion: "2026.6.10",
        },
      },
    });
    resolveCompatibilityHostVersionMock.mockReturnValue("2026.6.8");
    // Artifact endpoint returns sparse metadata (no compatibility).
    fetchClawHubPackageArtifactMock.mockResolvedValueOnce({
      version: {
        version: "2026.6.8",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
      },
    });
    // Version endpoint fails.
    fetchClawHubPackageVersionMock.mockRejectedValueOnce(new Error("500 Internal Server Error"));

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo@2026.6.8",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.ok).toBe(false);
  });

  it("enforces package-level compatibility for unpinned latest install when version response omits compatibility", async () => {
    resolveLatestVersionFromPackageMock.mockReturnValue("2026.6.10");
    fetchClawHubPackageDetailMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        latestVersion: "2026.6.10",
        compatibility: {
          pluginApiRange: ">=2026.6.10",
          minGatewayVersion: "2026.6.10",
        },
      },
    });
    resolveCompatibilityHostVersionMock.mockReturnValue("2026.6.8");
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.6.10",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      baseUrl: "https://clawhub.ai",
    });

    const failure = expectInstallFailure(result);
    expect(failure.error).toContain("2026.6.10");
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
    expect(archiveInstallCall().archivePath).toBe("/tmp/clawhub-demo/archive.zip");
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("installs when a release correction runtime satisfies the base plugin API range", async () => {
    resolveCompatibilityHostVersionMock.mockReturnValueOnce("2026.5.3-1");
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.5.3",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        compatibility: {
          pluginApiRange: ">=2026.5.3",
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
    expect(archiveInstallCall().archivePath).toBe("/tmp/clawhub-demo/archive.zip");
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("installs when a beta runtime is on the same plugin API floor", async () => {
    resolveCompatibilityHostVersionMock.mockReturnValueOnce("2026.5.27-beta.1");
    fetchClawHubPackageVersionMock.mockResolvedValueOnce({
      version: {
        version: "2026.5.27",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        compatibility: {
          pluginApiRange: ">=2026.5.27",
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
    expect(archiveInstallCall().archivePath).toBe("/tmp/clawhub-demo/archive.zip");
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

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API);
    expect(failure.error).toBe(
      'Plugin "demo" requires plugin API *, but this OpenClaw runtime exposes invalid.',
    );
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).not.toHaveBeenCalled();
  });

  it("passes dangerous force unsafe install through to archive installs", async () => {
    await installPluginFromClawHub({
      spec: "clawhub:demo",
      dangerouslyForceUnsafeInstall: true,
    });

    expect(archiveInstallCall().archivePath).toBe("/tmp/clawhub-demo/archive.zip");
    expect(archiveInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
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

    expect(expectInstallFailure(result).error).toBe("bad archive");
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

    const success = expectInstallSuccess(result);
    expect(success.pluginId).toBe("demo");
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

    const success = expectInstallSuccess(result);
    expect(success.pluginId).toBe("demo");
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

    const success = expectInstallSuccess(result);
    expect(success.pluginId).toBe("demo");
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

    const success = expectInstallSuccess(result);
    expect(success.pluginId).toBe("demo");
    expect(success.version).toBe("2026.3.22");
    expect(packageDetailCall().name).toBe("DemoAlias");
    expect(packageVersionCall().name).toBe("demo");
    expect(packageVersionCall().version).toBe("latest");
    expect(fetchClawHubPackageSecurityMock).not.toHaveBeenCalled();
    expect(archiveDownloadCall().name).toBe("demo");
    expect(success.packageName).toBe("demo");
    expect(success.clawhub?.clawhubPackage).toBe("demo");
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

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY);
    expect(failure.error).toBe(
      'ClawHub version metadata for "demo@2026.3.22" has an invalid sha256hash (unrecognized value "definitely-not-a-sha256").',
    );
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

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE);
    expect(failure.error).toBe(
      'ClawHub package "demo@2026.3.22" does not expose a downloadable plugin artifact yet. Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    );
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("checks trust before returning artifact-unavailable fallback errors", async () => {
    mockCommunityClawHubPackageDetail();
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
    fetchClawHubPackageSecurityMock.mockResolvedValueOnce({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
      },
      release: {
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "malicious",
        moderationState: "quarantined",
        blockedFromDownload: true,
        reasons: ["scan:malicious"],
        pending: false,
        stale: false,
      },
    });

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
      acknowledgeClawHubRisk: true,
    });

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED);
    expect(packageSecurityCall().name).toBe("demo");
    expect(failure.error).toBe("ClawHub blocked this release; install was not started.");
    expect(failure.warning).toContain("BLOCKED - ClawHub flagged this release as malicious");
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

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE);
    expect(failure.error).toBe(
      'ClawHub package "demo@2026.3.22" does not expose a downloadable plugin artifact yet. Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    );
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

    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY);
    expect(failure.error).toBe(
      'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0] entry (expected an object, got null).',
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0].sha256 (value "not-a-digest" is not a 64-character hexadecimal SHA-256 digest).',
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      'ClawHub version metadata for "demo@2026.3.22" has an invalid sha256hash (non-string value of type number).',
    );
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
  });

  it("returns a typed install failure when the archive download throws", async () => {
    downloadClawHubPackageArchiveMock.mockRejectedValueOnce(new Error("network timeout"));

    const result = await installPluginFromClawHub({
      spec: "clawhub:demo",
    });

    expect(expectInstallFailure(result).error).toBe("network timeout");
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      "ClawHub archive fallback verification failed while reading the downloaded archive.",
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      `ClawHub archive integrity mismatch for "demo@2026.3.22": expected sha256-ERERERERERERERERERERERERERERERERERERERERERE=, got ${DEMO_ARCHIVE_INTEGRITY}.`,
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": missing "dist/index.js".',
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": unexpected file "extra.txt".',
    );
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

    expect(expectInstallSuccess(result).pluginId).toBe("demo");
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

    expect(expectInstallSuccess(result).pluginId).toBe("demo");
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": _meta.json is not valid JSON.',
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": _meta.json slug does not match the package name.',
    );
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
    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      'ClawHub archive fallback verification rejected "_meta.json" because it exceeds the per-file size limit.',
    );
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
    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      "ClawHub archive fallback verification exceeded the archive entry limit.",
    );
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
    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      "ClawHub archive fallback verification exceeded the archive entry limit.",
    );
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
    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      "ClawHub archive fallback verification rejected the downloaded archive because it exceeds the ZIP archive size limit.",
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      `ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": expected openclaw.plugin.json to hash to ${"1".repeat(64)}, got ${sha256Hex('{"id":"demo"}')}.`,
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0].path (path "../evil.txt" contains dot segments).',
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      'ClawHub version metadata for "demo@2026.3.22" has an invalid files[0].path (path "openclaw.plugin.json " has leading or trailing whitespace).',
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
      'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": invalid package file path "openclaw.plugin.json " (path "openclaw.plugin.json " has leading or trailing whitespace).',
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      'ClawHub version metadata for "demo@2026.3.22" has duplicate files[] path "openclaw.plugin.json".',
    );
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

    expectInstallFailureFields(
      result,
      CLAWHUB_INSTALL_ERROR_CODE.MISSING_ARCHIVE_INTEGRITY,
      'ClawHub version metadata for "demo@2026.3.22" must not include generated file "_meta.json" in files[].',
    );
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
            ownerHandle: "openclaw",
            createdAt: 0,
            updatedAt: 0,
          },
        });
      },
      spec: "clawhub:calendar",
      expected: {
        ok: false,
        code: CLAWHUB_INSTALL_ERROR_CODE.SKILL_PACKAGE,
        error: '"calendar" is a skill. Use "openclaw skills install @openclaw/calendar" instead.',
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
            ownerHandle: "openclaw",
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
        error: '"calendar" is a skill. Use "openclaw skills install @openclaw/calendar" instead.',
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
