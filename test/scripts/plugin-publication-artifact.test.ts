import { createHash } from "node:crypto";
/* oxlint-disable typescript/no-base-to-string -- fetch mocks normalize standard RequestInfo inputs exactly as the production fetch boundary does. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginPublicationArtifact,
  downloadActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
  verifyPluginPublicationArtifact,
} from "../../scripts/plugin-publication-artifact.mjs";

const TARGET_SHA = "1".repeat(40);
const WORKFLOW_SHA = "2".repeat(40);
const ARTIFACT_ID = 12345;
const RUN_ID = 67890;
const RUN_ATTEMPT = 2;
const REPOSITORY = "openclaw/openclaw";
const WORKFLOW_PATH = ".github/workflows/plugin-npm-release.yml";
const ARTIFACT_NAME = "plugin-npm-package-meta-2026.7.1-beta.3";
const PACKAGE_NAME = "@openclaw/meta-provider";
const PRODUCER_JOB_NAME = `Preflight plugin npm package (${PACKAGE_NAME})`;
const PACKAGE_VERSION = "2026.7.1-beta.3";
const PACKAGE_DIR = "extensions/meta";
const TARBALL_NAME = "openclaw-meta-provider-2026.7.1-beta.3.tgz";
const MANUAL_OVERRIDE_REASON =
  "OpenClaw Release Publish run 12345 approved token release for v2026.7.1-beta.3";
const PUBLICATION_REASON = "First npm publication for the approved beta3 Meta package.";
const PUBLISHER_POLICY = {
  policyId: "2026.7.1-beta.3",
  schema: "openclaw.plugin-npm-publisher-policy/v1",
  sha256: "6a40c33756ff1016744bb929660c1d9bf271cd478b0b9811fa8e2d8f1f775e95",
};

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-publication-artifact-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`Tar field is too long: ${value}`);
  }
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const raw = value.toString(8).padStart(length - 2, "0");
  if (raw.length !== length - 2) {
    throw new Error(`Tar number is too large: ${value}`);
  }
  writeTarString(header, offset, length, `${raw} \0`);
}

type TarEntry = {
  content?: Buffer | string;
  format?: "ustar" | "v7";
  linkPath?: string;
  path: string;
  prefix?: string;
  type?: "0" | "2" | "3" | "5" | "K" | "L" | "g" | "x";
};

function tarEntry(entry: TarEntry): Buffer {
  const type = entry.type ?? "0";
  const content = Buffer.isBuffer(entry.content)
    ? entry.content
    : Buffer.from(entry.content ?? "", "utf8");
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, entry.path);
  writeTarOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, content.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  if (entry.linkPath) {
    writeTarString(header, 157, 100, entry.linkPath);
  }
  if (entry.format !== "v7") {
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");
  }
  writeTarOctal(header, 329, 8, 0);
  writeTarOctal(header, 337, 8, 0);
  if (entry.prefix) {
    writeTarString(header, 345, 155, entry.prefix);
  }
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTarOctal(header, 148, 8, checksum);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function mutateTarEntryHeader(
  entry: Buffer,
  mutate: (header: Buffer) => void,
  options: { preserveChecksumBytes?: boolean } = {},
): Buffer {
  const result = Buffer.from(entry);
  const header = result.subarray(0, 512);
  mutate(header);
  if (!options.preserveChecksumBytes) {
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    writeTarOctal(header, 148, 8, checksum);
  }
  return result;
}

function createTarball(entries: TarEntry[]): Buffer {
  return gzipSync(Buffer.concat([...entries.map((entry) => tarEntry(entry)), Buffer.alloc(1024)]));
}

function createTarballFromParts(parts: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

function paxRecord(key: string, value: string): Buffer {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  while (true) {
    const record = `${length} ${payload}`;
    const actualLength = Buffer.byteLength(record);
    if (actualLength === length) {
      return Buffer.from(record, "utf8");
    }
    length = actualLength;
  }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type ZipFile = {
  bytes: Buffer;
  centralFlags?: number;
  compression?: 0 | 8;
  compressedBytes?: Buffer;
  declaredExpandedSize?: number;
  descriptor?: boolean;
  descriptorCrc?: number;
  flags?: number;
  gapAfter?: Buffer;
  localCrc?: number;
  localExpandedSize?: number;
  localFlags?: number;
  localNameBytes?: Buffer;
  localCompressedSize?: number;
  name: string;
  nameBytes?: Buffer;
};

function createZip(files: ZipFile[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = file.nameBytes ?? Buffer.from(file.name, "utf8");
    const localName = file.localNameBytes ?? name;
    const compression = file.compression ?? 0;
    const compressed =
      file.compressedBytes ?? (compression === 8 ? deflateRawSync(file.bytes) : file.bytes);
    const expandedSize = file.declaredExpandedSize ?? file.bytes.length;
    const checksum = crc32(file.bytes);
    const flags = file.flags ?? (file.descriptor ? 0x0008 : 0);
    const localFlags = file.localFlags ?? flags;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(localFlags, 6);
    local.writeUInt16LE(compression, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(file.localCrc ?? (file.descriptor ? 0 : checksum), 14);
    local.writeUInt32LE(file.localCompressedSize ?? (file.descriptor ? 0 : compressed.length), 18);
    local.writeUInt32LE(file.localExpandedSize ?? (file.descriptor ? 0 : expandedSize), 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(0, 28);
    const descriptor = file.descriptor
      ? (() => {
          const value = Buffer.alloc(16);
          value.writeUInt32LE(0x08074b50, 0);
          value.writeUInt32LE(file.descriptorCrc ?? checksum, 4);
          value.writeUInt32LE(compressed.length, 8);
          value.writeUInt32LE(expandedSize, 12);
          return value;
        })()
      : Buffer.alloc(0);
    const gap = file.gapAfter ?? Buffer.alloc(0);
    localParts.push(local, localName, compressed, descriptor, gap);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.centralFlags ?? flags, 8);
    central.writeUInt16LE(compression, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(expandedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100600 * 0x10000) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset +=
      local.length + localName.length + compressed.length + descriptor.length + gap.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function inspectTestZip(
  zip: Buffer,
  overrides: Partial<{
    maxArchiveBytes: number;
    maxCompressedEntryBytes: (name: string) => number;
    maxEntries: number;
    maxExpandedBytes: number;
    maxEntryBytes: (name: string) => number;
    minEntries: number;
  }> = {},
) {
  return inspectActionsArtifactZipWithPolicy(zip, {
    minEntries: 1,
    maxEntries: 8,
    maxArchiveBytes: 1024 * 1024,
    maxExpandedBytes: 1024 * 1024,
    allowPath: () => true,
    maxCompressedEntryBytes: () => 1024 * 1024,
    maxEntryBytes: () => 1024 * 1024,
    ...overrides,
  });
}

function metaPackageJson(markerPath: string, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      type: "module",
      scripts: {
        preinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'bad')"`,
        postinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'bad')"`,
      },
      openclaw: {
        release: {
          publishToClawHub: true,
          publishToNpm: true,
        },
      },
      ...overrides,
    },
    null,
    2,
  )}\n`;
}

function publicationParams(artifactDir: string, overrides: Record<string, unknown> = {}) {
  const route = typeof overrides.route === "string" ? overrides.route : "npm-token-bootstrap";
  const npmPolicy = route.startsWith("npm-")
    ? {
        publicationReason: PUBLICATION_REASON,
        publisherPolicy: PUBLISHER_POLICY,
      }
    : {};
  return {
    artifactDir,
    artifactName: ARTIFACT_NAME,
    packageDir: PACKAGE_DIR,
    packageName: PACKAGE_NAME,
    publishTag: "beta",
    route,
    sourcePackageJsonSha256: "3".repeat(64),
    targetSha: TARGET_SHA,
    version: PACKAGE_VERSION,
    ...npmPolicy,
    ...overrides,
  };
}

function createFixture(
  options: {
    packageJson?: string;
    publicationOverrides?: Record<string, unknown>;
    tarEntries?: TarEntry[];
  } = {},
) {
  const root = tempDir();
  const artifactDir = path.join(root, "artifact");
  const outputDir = path.join(root, "verified");
  const markerPath = path.join(root, "lifecycle-ran");
  mkdirSync(artifactDir, { recursive: true });
  const packageJson = options.packageJson ?? metaPackageJson(markerPath);
  const tarball = createTarball(
    options.tarEntries ?? [
      { path: "package/", type: "5" },
      { content: packageJson, path: "package/package.json" },
      { content: '{"id":"meta"}\n', path: "package/openclaw.plugin.json" },
      { content: "export default {};\n", path: "package/index.js" },
    ],
  );
  writeFileSync(path.join(artifactDir, TARBALL_NAME), tarball);
  const created = createPluginPublicationArtifact(
    publicationParams(artifactDir, options.publicationOverrides),
  );
  const manifestBytes = readFileSync(created.manifestPath);
  const zip = createZip([
    { bytes: tarball, name: TARBALL_NAME },
    { bytes: manifestBytes, name: "plugin-publication-manifest.json" },
  ]);
  const zipPath = path.join(root, "artifact.zip");
  const metadataPath = path.join(root, "artifact.json");
  const workflowRunPath = path.join(root, "run.json");
  const workflowJobsPath = path.join(root, "jobs.json");
  writeFileSync(zipPath, zip);
  writeArtifactMetadata(metadataPath, zip);
  writeWorkflowRunMetadata(workflowRunPath);
  writeFileSync(
    workflowJobsPath,
    `${JSON.stringify({
      total_count: 1,
      jobs: [
        {
          name: PRODUCER_JOB_NAME,
          run_id: RUN_ID,
          run_attempt: RUN_ATTEMPT,
          head_sha: WORKFLOW_SHA,
          status: "completed",
          conclusion: "success",
        },
      ],
    })}\n`,
  );
  return {
    artifactDir,
    created,
    markerPath,
    metadataPath,
    outputDir,
    publicationOverrides: options.publicationOverrides,
    root,
    tarball,
    workflowRunPath,
    workflowJobsPath,
    zip,
    zipPath,
  };
}

function writeArtifactMetadata(metadataPath: string, zip: Buffer): void {
  writeFileSync(
    metadataPath,
    `${JSON.stringify({
      id: ARTIFACT_ID,
      name: ARTIFACT_NAME,
      expired: false,
      digest: `sha256:${sha256(zip)}`,
      size_in_bytes: zip.length,
      workflow_run: {
        id: RUN_ID,
        head_sha: WORKFLOW_SHA,
      },
    })}\n`,
  );
}

function writeWorkflowRunMetadata(workflowRunPath: string): void {
  writeFileSync(
    workflowRunPath,
    `${JSON.stringify({
      id: RUN_ID,
      run_attempt: RUN_ATTEMPT,
      head_sha: WORKFLOW_SHA,
      head_branch: "main",
      event: "workflow_dispatch",
      path: WORKFLOW_PATH,
      status: "completed",
      conclusion: "success",
      repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY },
    })}\n`,
  );
}

function replaceArtifactZip(fixture: ReturnType<typeof createFixture>, files: ZipFile[]): void {
  const zip = createZip(files);
  fixture.zip = zip;
  writeFileSync(fixture.zipPath, zip);
  writeArtifactMetadata(fixture.metadataPath, zip);
}

function verifyFixture(
  fixture: ReturnType<typeof createFixture>,
  overrides: Record<string, unknown> = {},
) {
  return verifyPluginPublicationArtifact({
    ...publicationParams(fixture.artifactDir, fixture.publicationOverrides),
    artifactDigest: `sha256:${sha256(fixture.zip)}`,
    artifactId: ARTIFACT_ID,
    artifactMetadataPath: fixture.metadataPath,
    artifactSizeBytes: fixture.zip.length,
    artifactZipPath: fixture.zipPath,
    outputDir: fixture.outputDir,
    producerRunAttempt: RUN_ATTEMPT,
    producerRunId: RUN_ID,
    repository: REPOSITORY,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: "main",
    workflowPath: WORKFLOW_PATH,
    workflowRunMetadataPath: fixture.workflowRunPath,
    workflowSha: WORKFLOW_SHA,
    ...overrides,
  });
}

describe("plugin publication artifact", () => {
  it("canonically binds and verifies the Meta beta3 token-bootstrap tuple without running lifecycle scripts", () => {
    const fixture = createFixture();
    const verified = verifyFixture(fixture);

    expect(verified.manifest).toMatchObject({
      targetSha: TARGET_SHA,
      package: {
        dir: PACKAGE_DIR,
        name: PACKAGE_NAME,
        sourcePackageJsonSha256: "3".repeat(64),
        version: PACKAGE_VERSION,
      },
      publication: {
        authMode: "token-bootstrap",
        capability: "first-publication",
        publisherPolicy: PUBLISHER_POLICY,
        reason: PUBLICATION_REASON,
        route: "npm-token-bootstrap",
        tag: "beta",
      },
      artifact: {
        name: ARTIFACT_NAME,
        npmIntegrity: `sha512-${createHash("sha512").update(fixture.tarball).digest("base64")}`,
        npmShasum: createHash("sha1").update(fixture.tarball).digest("hex"),
        sha256: sha256(fixture.tarball),
      },
    });
    expect(verified).toMatchObject({
      npmIntegrity: verified.manifest.artifact.npmIntegrity,
      npmShasum: verified.manifest.artifact.npmShasum,
      packageJsonSha256: verified.manifest.package.packageJsonSha256,
      pluginManifestSha256: verified.manifest.package.pluginManifestSha256,
      sourcePackageJsonSha256: "3".repeat(64),
      tarballName: TARBALL_NAME,
    });
    expect(readFileSync(verified.tarballPath)).toEqual(fixture.tarball);
    expect(verified.tarballInventory).toEqual(verified.manifest.artifact.inventory);
    expect(verified.tarballSizeBytes).toBe(fixture.tarball.length);
    expect(existsSync(fixture.markerPath)).toBe(false);
  });

  it("derives the closed npm auth capability and binds placeholder-recovery policy", () => {
    const fixture = createFixture({
      publicationOverrides: {
        route: "npm-token-placeholder-recovery",
      },
    });
    const verified = verifyFixture(fixture);

    expect(verified.manifest.publication).toEqual({
      authMode: "token-bootstrap",
      capability: "placeholder-recovery",
      publisherPolicy: PUBLISHER_POLICY,
      reason: PUBLICATION_REASON,
      route: "npm-token-placeholder-recovery",
      tag: "beta",
    });
    expect(() =>
      verifyFixture(fixture, {
        authMode: "release-token",
      }),
    ).toThrow("auth mode must be token-bootstrap");
    expect(() =>
      verifyFixture(fixture, {
        capability: "first-publication",
      }),
    ).toThrow("capability must be placeholder-recovery");
  });

  it("requires npm publication reason and exact publisher-policy identity", () => {
    const fixture = createFixture();
    for (const overrides of [
      { publicationReason: "" },
      { publicationReason: "invalid\nreason" },
      { publisherPolicy: undefined },
      { publisherPolicy: { ...PUBLISHER_POLICY, sha256: "A".repeat(64) } },
      { publisherPolicy: { ...PUBLISHER_POLICY, extra: true } },
    ]) {
      expect(() => verifyFixture(fixture, overrides)).toThrow();
    }
  });

  it("rejects a publication artifact bound to a different target package.json", () => {
    const fixture = createFixture();

    expect(() =>
      verifyFixture(fixture, {
        sourcePackageJsonSha256: "4".repeat(64),
      }),
    ).toThrow("source package.json SHA-256 does not match the approved target source");
  });

  it("binds exact tarball size and canonical inventory", () => {
    const fixture = createFixture();
    const expectedInventory = JSON.parse(readFileSync(fixture.created.manifestPath, "utf8"))
      .artifact.inventory;
    expect(
      verifyFixture(fixture, {
        expectedInventory,
        expectedTarballSha256: sha256(fixture.tarball),
        expectedTarballSizeBytes: fixture.tarball.length,
      }),
    ).toMatchObject({
      tarballInventory: expectedInventory,
      tarballSha256: sha256(fixture.tarball),
      tarballSizeBytes: fixture.tarball.length,
    });

    const wrongSizeFixture = createFixture();
    expect(() =>
      verifyFixture(wrongSizeFixture, {
        expectedTarballSizeBytes: wrongSizeFixture.tarball.length + 1,
      }),
    ).toThrow("tarball size does not match");

    const wrongInventoryFixture = createFixture();
    expect(() =>
      verifyFixture(wrongInventoryFixture, {
        expectedInventory: expectedInventory.slice(0, -1),
      }),
    ).toThrow("tarball inventory does not match");
  });

  it("requires a fresh non-symlink output directory", () => {
    const existingFixture = createFixture();
    mkdirSync(existingFixture.outputDir);
    expect(() => verifyFixture(existingFixture)).toThrow("must not already exist");

    const symlinkFixture = createFixture();
    const symlinkTarget = path.join(symlinkFixture.root, "output-target");
    mkdirSync(symlinkTarget);
    symlinkSync(symlinkTarget, symlinkFixture.outputDir);
    expect(() => verifyFixture(symlinkFixture)).toThrow("must not already exist");
  });

  it("binds the exact ClawHub token-release manual override reason", () => {
    const fixture = createFixture({
      publicationOverrides: {
        manualOverrideReason: MANUAL_OVERRIDE_REASON,
        requiresManualOverride: true,
        route: "clawhub-token-release",
      },
    });
    const verified = verifyFixture(fixture);

    expect(verified.manifest.publication).toMatchObject({
      manualOverrideReason: MANUAL_OVERRIDE_REASON,
      requiresManualOverride: true,
      route: "clawhub-token-release",
    });
    expect(() =>
      verifyFixture(fixture, {
        manualOverrideReason:
          "OpenClaw Release Publish run 12345 approved token release for v2026.7.1-beta.4",
      }),
    ).toThrow(/does not canonically bind/u);
  });

  it("requires a valid reason exactly when a ClawHub manual override is approved", () => {
    const fixture = createFixture();
    const invalidControls: Record<string, unknown>[] = [
      {
        requiresManualOverride: true,
        route: "clawhub-token-release",
      },
      {
        manualOverrideReason: MANUAL_OVERRIDE_REASON,
        route: "clawhub-token-release",
      },
      {
        manualOverrideReason: `${MANUAL_OVERRIDE_REASON}\nunsafe`,
        requiresManualOverride: true,
        route: "clawhub-token-release",
      },
      {
        bootstrapMode: "publish",
        manualOverrideReason: MANUAL_OVERRIDE_REASON,
        requiresManualOverride: false,
        route: "clawhub-token-bootstrap",
      },
    ];

    for (const controls of invalidControls) {
      expect(() =>
        verifyPluginPublicationArtifact({
          ...publicationParams(fixture.artifactDir, controls),
          artifactDigest: `sha256:${sha256(fixture.zip)}`,
          artifactId: ARTIFACT_ID,
          artifactMetadataPath: fixture.metadataPath,
          artifactZipPath: fixture.zipPath,
          outputDir: fixture.outputDir,
          runId: RUN_ID,
          workflowSha: WORKFLOW_SHA,
        }),
      ).toThrow();
    }
  });

  it("rejects every mutable artifact identity dimension", () => {
    const fixture = createFixture();
    const mismatches: Array<[string, Record<string, unknown>]> = [
      ["artifact id", { artifactId: ARTIFACT_ID + 1 }],
      ["artifact name", { artifactName: "plugin-npm-package-other-2026.7.1-beta.3" }],
      ["artifact digest", { artifactDigest: `sha256:${"f".repeat(64)}` }],
      ["artifact size", { artifactSizeBytes: fixture.zip.length + 1 }],
      ["workflow run id", { producerRunId: RUN_ID + 1 }],
      ["workflow run attempt", { producerRunAttempt: RUN_ATTEMPT + 1 }],
      ["repository", { repository: "openclaw/not-openclaw" }],
      ["workflow SHA", { workflowSha: "3".repeat(40) }],
      ["workflow path", { workflowPath: ".github/workflows/other.yml" }],
      ["workflow event", { workflowEvent: "workflow_call" }],
      ["workflow head branch", { workflowHeadBranch: "release/2026.7.1" }],
      ["target SHA", { targetSha: "4".repeat(40) }],
      ["package name", { packageName: "@openclaw/not-meta" }],
      ["package dir", { packageDir: "extensions/not-meta" }],
      ["package version", { version: "2026.7.1-beta.2" }],
      ["publication route", { route: "npm-oidc" }],
      ["publish tag", { publishTag: "alpha" }],
    ];
    for (const [label, overrides] of mismatches) {
      expect(() => verifyFixture(fixture, overrides), label).toThrow();
    }
  });

  it("binds authoritative workflow status, conclusion, and head repository", () => {
    const mutations = [
      (run: Record<string, unknown>) => {
        run.status = "in_progress";
      },
      (run: Record<string, unknown>) => {
        run.conclusion = "cancelled";
      },
      (run: Record<string, unknown>) => {
        run.head_repository = { full_name: "openclaw/not-openclaw" };
      },
    ];
    for (const mutate of mutations) {
      const fixture = createFixture();
      const run = JSON.parse(readFileSync(fixture.workflowRunPath, "utf8"));
      mutate(run);
      writeFileSync(fixture.workflowRunPath, `${JSON.stringify(run)}\n`);
      expect(() => verifyFixture(fixture)).toThrow(
        /workflow run does not match the immutable publication tuple/u,
      );
    }
  });

  it("accepts only the exact successful producer job for same-run publication", () => {
    const fixture = createFixture();
    const workflowRun = JSON.parse(readFileSync(fixture.workflowRunPath, "utf8"));
    workflowRun.status = "in_progress";
    workflowRun.conclusion = null;
    writeFileSync(fixture.workflowRunPath, `${JSON.stringify(workflowRun)}\n`);

    expect(
      verifyFixture(fixture, {
        consumerRunAttempt: RUN_ATTEMPT,
        producerJobName: PRODUCER_JOB_NAME,
        runStatePolicy: "same-run-producer-success",
        workflowJobsMetadataPath: fixture.workflowJobsPath,
      }),
    ).toMatchObject({ producerRunAttempt: RUN_ATTEMPT, producerRunId: RUN_ID });

    const jobs = JSON.parse(readFileSync(fixture.workflowJobsPath, "utf8"));
    jobs.jobs[0].conclusion = "failure";
    writeFileSync(fixture.workflowJobsPath, `${JSON.stringify(jobs)}\n`);
    const failedFixture = createFixture();
    writeFileSync(failedFixture.workflowRunPath, `${JSON.stringify(workflowRun)}\n`);
    writeFileSync(failedFixture.workflowJobsPath, `${JSON.stringify(jobs)}\n`);
    expect(() =>
      verifyFixture(failedFixture, {
        consumerRunAttempt: RUN_ATTEMPT,
        producerJobName: PRODUCER_JOB_NAME,
        runStatePolicy: "same-run-producer-success",
        workflowJobsMetadataPath: failedFixture.workflowJobsPath,
      }),
    ).toThrow("producer job did not complete successfully");
  });

  it("accepts an environment-waiting current producer attempt", () => {
    const fixture = createFixture();
    const workflowRun = JSON.parse(readFileSync(fixture.workflowRunPath, "utf8"));
    workflowRun.status = "waiting";
    workflowRun.conclusion = null;
    writeFileSync(fixture.workflowRunPath, `${JSON.stringify(workflowRun)}\n`);

    expect(
      verifyFixture(fixture, {
        consumerRunAttempt: RUN_ATTEMPT,
        producerJobName: PRODUCER_JOB_NAME,
        runStatePolicy: "same-run-producer-success",
        workflowJobsMetadataPath: fixture.workflowJobsPath,
      }),
    ).toMatchObject({ producerRunAttempt: RUN_ATTEMPT, producerRunId: RUN_ID });
  });

  it("retries bounded metadata, attempt, and archive failures against the exact run attempt", async () => {
    const zip = createZip([{ bytes: Buffer.from("proof"), name: "proof.txt" }]);
    const artifactMetadata = {
      id: ARTIFACT_ID,
      name: ARTIFACT_NAME,
      expired: false,
      digest: `sha256:${sha256(zip)}`,
      size_in_bytes: zip.length,
      workflow_run: {
        id: RUN_ID,
        head_sha: WORKFLOW_SHA,
      },
    };
    const workflowRun = {
      id: RUN_ID,
      run_attempt: RUN_ATTEMPT,
      head_sha: WORKFLOW_SHA,
      head_branch: "main",
      event: "workflow_dispatch",
      path: WORKFLOW_PATH,
      status: "completed",
      conclusion: "success",
      repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY },
    };
    const callCounts = { archive: 0, artifact: 0, run: 0 };
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith(`/actions/artifacts/${ARTIFACT_ID}`)) {
        callCounts.artifact += 1;
        return callCounts.artifact === 1
          ? new Response("retry", { status: 503 })
          : Response.json(artifactMetadata);
      }
      if (url.endsWith(`/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`)) {
        callCounts.run += 1;
        return callCounts.run === 1
          ? new Response("{", { status: 200 })
          : Response.json(workflowRun);
      }
      if (url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
        callCounts.archive += 1;
        return callCounts.archive === 1
          ? new Response("retry", { status: 502 })
          : new Response(zip as unknown as BodyInit, {
              status: 200,
              headers: { "content-length": String(zip.length) },
            });
      }
      return new Response("unexpected", { status: 404 });
    }) as typeof fetch;

    const result = await downloadActionsArtifactArchive({
      expected: {
        artifactDigest: `sha256:${sha256(zip)}`,
        artifactId: ARTIFACT_ID,
        artifactName: ARTIFACT_NAME,
        artifactSizeBytes: zip.length,
        repository: REPOSITORY,
        runStatePolicy: "completed-success",
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
        workflowEvent: "workflow_dispatch",
        workflowHeadBranch: "main",
        workflowPath: WORKFLOW_PATH,
        workflowSha: WORKFLOW_SHA,
      },
      fetchImpl,
      maxArchiveBytes: 1024 * 1024,
      retryAttempts: 3,
      retryDelayMs: 1,
      token: "test-token",
    });

    expect(result.archiveBytes).toEqual(zip);
    expect(callCounts).toEqual({ archive: 2, artifact: 2, run: 2 });
    expect(urls).toContain(
      `https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`,
    );
  });

  it("reuses only an exact successful producer job from the current or a prior attempt", async () => {
    const zip = createZip([{ bytes: Buffer.from("proof"), name: "proof.txt" }]);
    const artifactMetadata = {
      id: ARTIFACT_ID,
      name: ARTIFACT_NAME,
      expired: false,
      digest: `sha256:${sha256(zip)}`,
      size_in_bytes: zip.length,
      workflow_run: {
        id: RUN_ID,
        head_sha: WORKFLOW_SHA,
      },
    };
    const producerJobName = "Pack immutable ClawHub bootstrap artifacts";

    async function downloadForAttempts(
      producerAttempt: number,
      consumerAttempt: number,
      producerConclusion = "success",
    ) {
      const workflowRun = {
        id: RUN_ID,
        run_attempt: producerAttempt,
        head_sha: WORKFLOW_SHA,
        head_branch: "main",
        event: "workflow_dispatch",
        path: WORKFLOW_PATH,
        status: producerAttempt === consumerAttempt ? "in_progress" : "completed",
        conclusion: producerAttempt === consumerAttempt ? null : "failure",
        repository: { full_name: REPOSITORY },
        head_repository: { full_name: REPOSITORY },
      };
      const workflowJobs = {
        total_count: 1,
        jobs: [
          {
            name: producerJobName,
            run_id: RUN_ID,
            run_attempt: producerAttempt,
            head_sha: WORKFLOW_SHA,
            status: "completed",
            conclusion: producerConclusion,
          },
        ],
      };
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith(`/actions/artifacts/${ARTIFACT_ID}`)) {
          return Response.json(artifactMetadata);
        }
        if (url.endsWith(`/actions/runs/${RUN_ID}/attempts/${producerAttempt}`)) {
          return Response.json(workflowRun);
        }
        if (url.endsWith(`/actions/runs/${RUN_ID}/attempts/${producerAttempt}/jobs?per_page=100`)) {
          return Response.json(workflowJobs);
        }
        if (url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
          return new Response(zip as unknown as BodyInit, {
            status: 200,
            headers: { "content-length": String(zip.length) },
          });
        }
        return new Response("unexpected", { status: 404 });
      }) as typeof fetch;

      return downloadActionsArtifactArchive({
        expected: {
          artifactDigest: `sha256:${sha256(zip)}`,
          artifactId: ARTIFACT_ID,
          artifactName: ARTIFACT_NAME,
          artifactSizeBytes: zip.length,
          consumerRunAttempt: consumerAttempt,
          producerJobName,
          repository: REPOSITORY,
          runStatePolicy: "same-run-producer-success",
          runAttempt: producerAttempt,
          runId: RUN_ID,
          workflowEvent: "workflow_dispatch",
          workflowHeadBranch: "main",
          workflowPath: WORKFLOW_PATH,
          workflowSha: WORKFLOW_SHA,
        },
        fetchImpl,
        maxArchiveBytes: 1024 * 1024,
        retryAttempts: 1,
        token: "test-token",
      });
    }

    await expect(downloadForAttempts(2, 2)).resolves.toMatchObject({
      workflowJobs: { total_count: 1 },
    });
    await expect(downloadForAttempts(1, 2)).resolves.toMatchObject({
      workflowRun: { conclusion: "failure", status: "completed" },
    });
    await expect(downloadForAttempts(1, 2, "failure")).rejects.toThrow(
      "Actions artifact producer job did not complete successfully.",
    );
    await expect(downloadForAttempts(3, 2)).rejects.toThrow(
      "Producer workflow run attempt must not be newer than the consumer attempt.",
    );
  });

  it("rejects ZIP traversal, additional files, and byte tampering", () => {
    const fixture = createFixture();
    const manifest = readFileSync(fixture.created.manifestPath);
    const malformedArtifacts: Array<{
      expected: RegExp;
      files: Array<{ bytes: Buffer; name: string }>;
    }> = [
      {
        expected: /Unsafe ZIP entry path/u,
        files: [
          { bytes: fixture.tarball, name: TARBALL_NAME },
          { bytes: manifest, name: "../plugin-publication-manifest.json" },
        ],
      },
      {
        expected: /must contain between 2 and 2 exact files/u,
        files: [
          { bytes: fixture.tarball, name: TARBALL_NAME },
          { bytes: manifest, name: "plugin-publication-manifest.json" },
          { bytes: Buffer.from("unexpected"), name: "extra.txt" },
        ],
      },
    ];
    for (const { expected, files } of malformedArtifacts) {
      replaceArtifactZip(fixture, files);
      expect(() => verifyFixture(fixture)).toThrow(expected);
    }

    const tamperFixture = createFixture();
    const tampered = Buffer.from(tamperFixture.zip);
    tampered[35] = tampered.readUInt8(35) ^ 0xff;
    writeFileSync(tamperFixture.zipPath, tampered);
    expect(() => verifyFixture(tamperFixture)).toThrow(/digest/u);
  });

  it("accepts canonical signed data descriptors and rejects noncanonical ZIP structure", () => {
    const canonical = createZip([
      {
        bytes: Buffer.from("descriptor"),
        compression: 8,
        descriptor: true,
        name: "descriptor.txt",
      },
    ]);
    expect(inspectTestZip(canonical).get("descriptor.txt")?.toString()).toBe("descriptor");

    expect(() => inspectTestZip(Buffer.concat([canonical, Buffer.from("trailing")]))).toThrow(
      /exact terminal end-of-central-directory/u,
    );
    expect(() =>
      inspectTestZip(
        createZip([
          {
            bytes: Buffer.from("gap"),
            gapAfter: Buffer.from([0]),
            name: "gap.txt",
          },
        ]),
      ),
    ).toThrow(/gap or overlap/u);
    expect(() =>
      inspectTestZip(
        createZip([
          {
            bytes: Buffer.from("crc"),
            localCrc: 0,
            name: "crc.txt",
          },
        ]),
      ),
    ).toThrow(/local sizes or CRC/u);
    expect(() =>
      inspectTestZip(
        createZip([
          {
            bytes: Buffer.from("descriptor"),
            descriptor: true,
            descriptorCrc: 0,
            name: "descriptor.txt",
          },
        ]),
      ),
    ).toThrow(/data descriptor/u);
  });

  it("rejects unsupported flags, invalid names, aliases, and trailing deflate bytes", () => {
    for (const flags of [0x0040, 0x2000]) {
      expect(() =>
        inspectTestZip(createZip([{ bytes: Buffer.from("x"), flags, name: "flags.txt" }])),
      ).toThrow(/Unsupported Actions artifact ZIP flags/u);
    }

    expect(() =>
      inspectTestZip(createZip([{ bytes: Buffer.from("x"), name: "m\u00e9ta.txt" }])),
    ).toThrow(/must set the UTF-8 language flag/u);
    expect(
      inspectTestZip(
        createZip([{ bytes: Buffer.from("x"), flags: 0x0800, name: "m\u00e9ta.txt" }]),
      ).has("m\u00e9ta.txt"),
    ).toBe(true);
    expect(() =>
      inspectTestZip(
        createZip([
          {
            bytes: Buffer.from("x"),
            flags: 0x0800,
            name: "invalid.txt",
            nameBytes: Buffer.from([0xff]),
          },
        ]),
      ),
    ).toThrow(/not valid UTF-8/u);
    expect(() =>
      inspectTestZip(
        createZip([
          {
            bytes: Buffer.from("x"),
            localNameBytes: Buffer.from("other.txt"),
            name: "central.txt",
          },
        ]),
      ),
    ).toThrow(/local and central names differ/u);
    expect(() =>
      inspectTestZip(
        createZip([
          { bytes: Buffer.from("a"), name: "Case.txt" },
          { bytes: Buffer.from("b"), name: "case.txt" },
        ]),
      ),
    ).toThrow(/duplicate, or aliased/u);

    const content = Buffer.from("deflate");
    expect(() =>
      inspectTestZip(
        createZip([
          {
            bytes: content,
            compressedBytes: Buffer.concat([deflateRawSync(content), Buffer.from([0, 1])]),
            compression: 8,
            name: "deflate.txt",
          },
        ]),
      ),
    ).toThrow(/entry expansion exceeds/u);
    expect(() =>
      inspectTestZip(createZip([{ bytes: Buffer.from("compressed"), name: "cap.txt" }]), {
        maxCompressedEntryBytes: () => 1,
      }),
    ).toThrow(/entry is too large/u);
  });

  it("caps publication JSON and tarball members before ZIP expansion", () => {
    const fixture = createFixture();
    const manifest = readFileSync(fixture.created.manifestPath);
    const oversizedManifest = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);

    replaceArtifactZip(fixture, [
      { bytes: fixture.tarball, name: TARBALL_NAME },
      {
        bytes: oversizedManifest,
        compression: 8,
        name: "plugin-publication-manifest.json",
      },
    ]);
    expect(() => verifyFixture(fixture)).toThrow(
      /entry is too large: plugin-publication-manifest\.json/u,
    );

    replaceArtifactZip(fixture, [
      { bytes: fixture.tarball, name: TARBALL_NAME },
      {
        bytes: oversizedManifest,
        compression: 8,
        declaredExpandedSize: 1,
        name: "plugin-publication-manifest.json",
      },
    ]);
    expect(() => verifyFixture(fixture)).toThrow(
      /entry expansion exceeds its allowed range: plugin-publication-manifest\.json/u,
    );

    replaceArtifactZip(fixture, [
      {
        bytes: fixture.tarball,
        compression: 8,
        declaredExpandedSize: 256 * 1024 * 1024 + 1,
        name: TARBALL_NAME,
      },
      { bytes: manifest, name: "plugin-publication-manifest.json" },
    ]);
    expect(() => verifyFixture(fixture)).toThrow(
      new RegExp(`entry is too large: ${TARBALL_NAME.replaceAll(".", "\\.")}`, "u"),
    );
  });

  it("caps the number of tar headers before retaining their inventory", () => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, TARBALL_NAME),
      createTarball([
        { path: "package/", type: "5" },
        { content: metaPackageJson(markerPath), path: "package/package.json" },
        ...Array.from({ length: 10_000 }, (_, index) => ({
          path: `package/file-${index.toString().padStart(5, "0")}`,
        })),
      ]),
    );

    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      /exceeds the 10000 entry limit/u,
    );
  });

  it("rejects PAX metadata before retaining path inventory", () => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    const longPathPrefix = `package/${"a".repeat(900_000)}`;
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, TARBALL_NAME),
      createTarball([
        { path: "package/", type: "5" },
        { content: metaPackageJson(markerPath), path: "package/package.json" },
        ...Array.from({ length: 5 }, (_, index) => [
          {
            content: paxRecord("path", `${longPathPrefix}${index}`),
            path: `PaxHeader-${index}`,
            type: "x" as const,
          },
          {
            path: `placeholder-${index}`,
          },
        ]).flat(),
      ]),
    );

    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      /PAX and GNU tar metadata are not supported/u,
    );
  });

  it("rejects concatenated gzip members before trusting combined tar inventory", () => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    mkdirSync(artifactDir, { recursive: true });
    const firstMember = gzipSync(
      Buffer.concat([
        tarEntry({ path: "package/", type: "5" }),
        tarEntry({
          content: metaPackageJson(markerPath),
          path: "package/package.json",
        }),
        tarEntry({
          content: '{"id":"meta"}\n',
          path: "package/openclaw.plugin.json",
        }),
      ]),
    );
    const secondMember = gzipSync(
      Buffer.concat([
        tarEntry({
          content: "hidden from the pinned ClawHub reader\n",
          path: "package/second-member.txt",
        }),
        Buffer.alloc(1024),
      ]),
    );
    writeFileSync(path.join(artifactDir, TARBALL_NAME), Buffer.concat([firstMember, secondMember]));

    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      /must contain exactly one gzip member/u,
    );
  });

  it("rejects a hidden duplicate package.json after a single zero tar block", () => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    mkdirSync(artifactDir, { recursive: true });
    const tarball = gzipSync(
      Buffer.concat([
        tarEntry({ path: "package/", type: "5" }),
        tarEntry({
          content: metaPackageJson(markerPath),
          path: "package/package.json",
        }),
        Buffer.alloc(512),
        tarEntry({
          content: metaPackageJson(markerPath, {
            scripts: {
              postinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'hidden')"`,
            },
          }),
          path: "package/package.json",
        }),
        Buffer.alloc(1024),
      ]),
    );
    writeFileSync(path.join(artifactDir, TARBALL_NAME), tarball);

    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      /must end with two zero blocks and contain no trailing entries/u,
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it("rejects directory tar entries with nonzero declared size", () => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, TARBALL_NAME),
      createTarball([
        { content: "x", path: "package/", type: "5" },
        { content: metaPackageJson(markerPath), path: "package/package.json" },
      ]),
    );

    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      /Directory tar entry "package\/" must have size zero/u,
    );
  });

  it("rejects regular-file paths that the consumer coerces into directories", () => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    const tarballPath = path.join(artifactDir, TARBALL_NAME);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      tarballPath,
      createTarball([
        { path: "package/", type: "5" },
        {
          content: metaPackageJson(markerPath),
          path: "package/package.json/",
        },
      ]),
    );

    const consumerEntries: Array<{ path: string; size: number; type: string }> = [];
    tar.t({
      file: tarballPath,
      onReadEntry: (entry) => {
        consumerEntries.push({
          path: entry.path,
          size: entry.size,
          type: entry.type,
        });
      },
      onwarn: () => undefined,
      sync: true,
    });
    expect(consumerEntries.at(-1)).toMatchObject({
      path: "package/package.json/",
      size: 0,
      type: "Directory",
    });
    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      /Non-directory tar entry must not end with a slash/u,
    );
  });

  it.each([
    { path: " package.json", prefix: "package", field: "name" },
    { path: "package.json", prefix: " package", field: "prefix" },
  ])("rejects whitespace-bearing USTAR $field fields before manifest selection", (entry) => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, TARBALL_NAME),
      createTarball([
        { path: "package/", type: "5" },
        {
          content: metaPackageJson(markerPath, {
            scripts: {
              postinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'smuggled')"`,
            },
          }),
          path: entry.path,
          prefix: entry.prefix,
        },
        { content: metaPackageJson(markerPath), path: "package/package.json" },
      ]),
    );

    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      new RegExp(
        `tar entry ${entry.field} changes under the pinned ClawHub path normalization`,
        "u",
      ),
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it("rejects V7 headers whose prefix bytes disagree with node-tar path semantics", () => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    const tarballPath = path.join(artifactDir, TARBALL_NAME);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      tarballPath,
      createTarball([
        { path: "package/", type: "5" },
        {
          content: metaPackageJson(markerPath),
          format: "v7",
          path: "package.json",
          prefix: "package",
        },
      ]),
    );

    const consumerPaths: string[] = [];
    tar.t({
      file: tarballPath,
      onReadEntry: (entry) => consumerPaths.push(entry.path),
      onwarn: () => undefined,
      sync: true,
    });
    expect(consumerPaths).toContain("package.json");
    expect(consumerPaths).not.toContain("package/package.json");
    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      /canonical POSIX USTAR headers/u,
    );
  });

  it.each([
    {
      label: "regular-file link path",
      mutate(header: Buffer) {
        writeTarString(header, 157, 100, "package/alias");
      },
      message: /Plugin tar entries must not carry link targets/u,
    },
    {
      label: "hidden link-path padding",
      mutate(header: Buffer) {
        header.fill(0, 157, 257);
        Buffer.from("\0\nhidden-link", "utf8").copy(header, 157);
      },
      message: /tar entry link path has non-zero bytes after its NUL terminator/u,
    },
    {
      label: "unterminated checksum",
      mutate(header: Buffer) {
        const checksum = Number.parseInt(header.subarray(148, 156).toString("ascii").trim(), 8);
        writeTarString(header, 148, 8, checksum.toString(8).padStart(8, "0"));
      },
      preserveChecksumBytes: true,
      message: /tar checksum is not canonically encoded/u,
    },
    ...[
      ["mode", 100, 8, "tar entry mode"],
      ["uid", 108, 8, "tar entry uid"],
      ["gid", 116, 8, "tar entry gid"],
      ["mtime", 136, 12, "tar entry mtime"],
      ["device major", 329, 8, "tar entry device major"],
      ["device minor", 337, 8, "tar entry device minor"],
      ["access time", 476, 12, "tar entry access time"],
      ["change time", 488, 12, "tar entry change time"],
    ].map(([label, offset, length, field]) => ({
      label: `invalid base-256 ${label}`,
      mutate(header: Buffer) {
        header.fill(0, offset as number, (offset as number) + (length as number));
        header[offset as number] = 0x81;
      },
      message: new RegExp(`${field} must not use base-256 encoding`, "u"),
    })),
  ])("rejects $label headers that make npm consume a nested manifest", (testCase) => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    const tarballPath = path.join(artifactDir, TARBALL_NAME);
    mkdirSync(artifactDir, { recursive: true });

    const nestedManifest = tarEntry({
      content: metaPackageJson(markerPath, {
        scripts: {
          postinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'smuggled')"`,
        },
        tag: "latest",
      }),
      path: "package/package.json",
    });
    const decoy = mutateTarEntryHeader(
      tarEntry({
        content: nestedManifest,
        path: "package/decoy",
      }),
      testCase.mutate,
      { preserveChecksumBytes: testCase.preserveChecksumBytes },
    );
    writeFileSync(
      tarballPath,
      createTarballFromParts([
        tarEntry({ path: "package/", type: "5" }),
        tarEntry({
          content: metaPackageJson(markerPath),
          path: "package/package.json",
        }),
        decoy,
      ]),
    );

    const consumerPaths: string[] = [];
    tar.t({
      file: tarballPath,
      onReadEntry: (entry) => consumerPaths.push(entry.path),
      onwarn: () => undefined,
      sync: true,
    });
    expect(consumerPaths.filter((entryPath) => entryPath === "package/package.json")).toHaveLength(
      2,
    );
    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      testCase.message,
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it("rejects PAX metadata containing control characters", () => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    const tarballPath = path.join(artifactDir, TARBALL_NAME);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      tarballPath,
      createTarball([
        { path: "package/", type: "5" },
        { content: metaPackageJson(markerPath), path: "package/package.json" },
        {
          content: paxRecord("comment", "benign\npath=package/package.json"),
          path: "PaxHeader",
          type: "x",
        },
        {
          content: metaPackageJson(markerPath, {
            scripts: {
              postinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'injected')"`,
            },
          }),
          path: "package/ignored.json",
        },
      ]),
    );

    const consumerPaths: string[] = [];
    tar.t({
      file: tarballPath,
      onReadEntry: (entry) => consumerPaths.push(entry.path),
      onwarn: () => undefined,
      sync: true,
    });
    expect(consumerPaths.filter((entryPath) => entryPath === "package/package.json")).toHaveLength(
      1,
    );
    expect(consumerPaths).toContain("package/ignored.json");
    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      /PAX and GNU tar metadata are not supported/u,
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it("rejects local PAX and GNU metadata entries", () => {
    const cases: TarEntry[][] = [
      [
        { content: "package/ignored.json\0", path: "././@LongLink", type: "L" },
        {
          content: paxRecord("path", "package/package.json"),
          path: "PaxHeader",
          type: "x",
        },
      ],
      [
        {
          content: paxRecord("path", "package/ignored.json"),
          path: "PaxHeader",
          type: "x",
        },
        { content: "package/package.json\0", path: "././@LongLink", type: "L" },
      ],
      [
        {
          content: paxRecord("path", "package/package.json"),
          path: "PaxHeader",
          type: "x",
        },
        { content: paxRecord("mtime", "0"), path: "PaxHeader2", type: "x" },
      ],
    ];

    for (const [index, controls] of cases.entries()) {
      const root = tempDir();
      const artifactDir = path.join(root, `artifact-${index}`);
      const markerPath = path.join(root, "marker");
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        path.join(artifactDir, TARBALL_NAME),
        createTarball([
          { path: "package/", type: "5" },
          ...controls,
          {
            content: metaPackageJson(markerPath),
            path: `placeholder-${index}.json`,
          },
        ]),
      );

      expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
        /PAX and GNU tar metadata are not supported/u,
      );
    }
  });

  it("rejects local PAX size overrides", () => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, TARBALL_NAME),
      createTarball([
        { path: "package/", type: "5" },
        { content: metaPackageJson(markerPath), path: "package/package.json" },
        {
          content: paxRecord("size", "0"),
          path: "PaxHeader",
          type: "x",
        },
        { content: "nonempty", path: "package/index.js" },
      ]),
    );

    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      /PAX and GNU tar metadata are not supported/u,
    );
  });

  it("rejects canonical PAX metadata for every plugin publication route", () => {
    const root = tempDir();
    const markerPath = path.join(root, "marker");
    const longPath = `package/${"nested/".repeat(18)}index.js`;
    const content = Buffer.from("export {};\n", "utf8");
    const tarball = createTarball([
      { path: "package/", type: "5" },
      {
        content: metaPackageJson(markerPath),
        path: "package/package.json",
      },
      {
        content: Buffer.concat([
          paxRecord("path", longPath),
          paxRecord("size", String(content.length)),
        ]),
        path: "PaxHeader",
        type: "x",
      },
      { content, path: "package/placeholder.js" },
    ]);
    const npmArtifactDir = path.join(root, "npm-artifact");
    mkdirSync(npmArtifactDir, { recursive: true });
    writeFileSync(path.join(npmArtifactDir, TARBALL_NAME), tarball);
    expect(() => createPluginPublicationArtifact(publicationParams(npmArtifactDir))).toThrow(
      /PAX and GNU tar metadata are not supported/u,
    );

    for (const controls of [
      { route: "clawhub-token-release" },
      { bootstrapMode: "publish", route: "clawhub-token-bootstrap" },
      { route: "clawhub-readback" },
    ]) {
      const { route } = controls;
      const artifactDir = path.join(root, route);
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(path.join(artifactDir, TARBALL_NAME), tarball);
      expect(() =>
        createPluginPublicationArtifact(publicationParams(artifactDir, controls)),
      ).toThrow(/PAX and GNU tar metadata are not supported/u);
    }
  });

  it("rejects oversized PAX metadata before parsing it", () => {
    const root = tempDir();
    const artifactDir = path.join(root, "artifact");
    const markerPath = path.join(root, "marker");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, TARBALL_NAME),
      createTarball([
        { path: "package/", type: "5" },
        {
          content: paxRecord("comment", "x".repeat(1024 * 1024)),
          path: "PaxHeader",
          type: "x",
        },
        { content: metaPackageJson(markerPath), path: "package/package.json" },
      ]),
    );

    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      /PAX and GNU tar metadata are not supported/u,
    );
  });

  it("rejects beta npm artifacts bound to latest or extended-stable", () => {
    const fixture = createFixture();
    expect(() =>
      createPluginPublicationArtifact(
        publicationParams(fixture.artifactDir, { publishTag: "latest" }),
      ),
    ).toThrow(/does not match release channel beta/u);
    expect(() =>
      createPluginPublicationArtifact(
        publicationParams(fixture.artifactDir, { publishTag: "extended-stable" }),
      ),
    ).toThrow(/Extended-stable npm publication requires/u);
  });

  it("rejects a package manifest tag that can override the approved npm dist-tag", () => {
    const root = tempDir();
    const markerPath = path.join(root, "marker");
    const artifactDir = path.join(root, "artifact");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      path.join(artifactDir, TARBALL_NAME),
      createTarball([
        { path: "package/", type: "5" },
        {
          content: metaPackageJson(markerPath, { tag: "latest" }),
          path: "package/package.json",
        },
        { content: '{"id":"meta"}\n', path: "package/openclaw.plugin.json" },
      ]),
    );

    expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow(
      /must not override the approved publication tag/u,
    );
  });

  it("rejects publishConfig overrides in packed package metadata", () => {
    expect(() =>
      createFixture({
        packageJson: metaPackageJson(path.join(tempDir(), "marker"), {
          publishConfig: { tag: "beta" },
        }),
      }),
    ).toThrow(/must not override publication through publishConfig/u);
  });

  it("rejects traversal, links, and special entries inside the plugin tarball", () => {
    const root = tempDir();
    const markerPath = path.join(root, "marker");
    for (const badEntry of [
      { content: "bad", path: "package/../escape" },
      { linkPath: "package/package.json", path: "package/alias", type: "2" as const },
      { path: "package/device", type: "3" as const },
    ]) {
      const artifactDir = path.join(root, Math.random().toString(16).slice(2));
      mkdirSync(artifactDir, { recursive: true });
      const entries: TarEntry[] = [
        { path: "package/", type: "5" },
        { content: metaPackageJson(markerPath), path: "package/package.json" },
        badEntry,
      ];
      writeFileSync(path.join(artifactDir, TARBALL_NAME), createTarball(entries));
      expect(() => createPluginPublicationArtifact(publicationParams(artifactDir))).toThrow();
    }
    expect(existsSync(markerPath)).toBe(false);
  });

  it("requires the exact Meta package name, dir, and both publication flags", () => {
    const root = tempDir();
    const markerPath = path.join(root, "marker");
    const cases: Array<{
      manifestOverrides?: Record<string, unknown>;
      params?: Record<string, unknown>;
    }> = [
      {
        manifestOverrides: {
          openclaw: { release: { publishToClawHub: false, publishToNpm: true } },
        },
      },
      {
        manifestOverrides: {
          openclaw: { release: { publishToClawHub: true, publishToNpm: false } },
        },
      },
      {
        manifestOverrides: { name: "@openclaw/not-meta" },
        params: { packageName: "@openclaw/not-meta" },
      },
      {
        params: { packageDir: "extensions/not-meta" },
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const artifactDir = path.join(root, Math.random().toString(16).slice(2));
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        path.join(artifactDir, TARBALL_NAME),
        createTarball([
          { path: "package/", type: "5" },
          {
            content: metaPackageJson(markerPath, testCase.manifestOverrides),
            path: "package/package.json",
          },
          { content: '{"id":"meta"}\n', path: "package/openclaw.plugin.json" },
        ]),
      );
      expect(
        () => createPluginPublicationArtifact(publicationParams(artifactDir, testCase.params)),
        `Meta identity case ${index}`,
      ).toThrow(/Meta publication requires extensions\/meta with npm and ClawHub enabled/u);
    }
  });
});
