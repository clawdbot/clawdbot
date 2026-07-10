import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClawHubBootstrapArtifactManifest,
  downloadClawHubBootstrapArtifact,
  verifyClawHubPackedArtifactIdentity,
  verifyClawHubBootstrapArtifactManifest,
} from "../../scripts/lib/clawhub-bootstrap-artifact.mjs";

const tempDirs: string[] = [];
const targetSha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const clawhubToolchainSha256 = "c".repeat(64);
const clawhubToolchainVersion = "0.23.1";
const clawhubToolchainIntegrity =
  "sha512-YvUImhsVaM90BUAv3uP7lfABziwR5XL3ch2Owa+GvNxwQ2xzZFmZC0yVjAtQbvep+dDDS16nUGRwKx7jqnTOEA==";

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-bootstrap-"));
  tempDirs.push(root);
  const artifactRoot = join(root, "artifact");
  const packageRoot = join(artifactRoot, "packages", "meta");
  const existingPackageRoot = join(artifactRoot, "packages", "existing");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(existingPackageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "openclaw-meta-2026.7.1-beta.3.tgz"), "packed meta");
  writeFileSync(
    join(existingPackageRoot, "openclaw-existing-2026.7.1-beta.3.tgz"),
    "packed existing",
  );
  const matrixPath = join(root, "matrix.json");
  writeFileSync(
    matrixPath,
    JSON.stringify([
      {
        packageName: "@openclaw/meta",
        version: "2026.7.1-beta.3",
        packageDir: "extensions/meta",
        publishTag: "beta",
        bootstrapMode: "publish",
        requiresManualOverride: false,
      },
      {
        packageName: "@openclaw/existing",
        version: "2026.7.1-beta.3",
        packageDir: "extensions/existing",
        publishTag: "beta",
        bootstrapMode: "configure-only",
        requiresManualOverride: true,
      },
    ]),
  );
  return {
    artifactRoot,
    matrixPath,
    manifestPath: join(artifactRoot, "manifest.json"),
  };
}

function common(paths: ReturnType<typeof fixture>) {
  return {
    artifactRoot: paths.artifactRoot,
    artifactName: `clawhub-bootstrap-${targetSha.slice(0, 12)}-123-2`,
    clawhubToolchainIntegrity,
    clawhubToolchainSha256,
    clawhubToolchainVersion,
    plugins: "@openclaw/meta,@openclaw/existing",
    repository: "openclaw/openclaw",
    runAttempt: "2",
    runId: "123",
    targetSha,
    workflowSha,
  };
}

function writeTarField(header: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value);
  if (bytes.byteLength > length) {
    throw new Error(`tar field exceeds ${length} bytes`);
  }
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number) {
  writeTarField(header, offset, length, `${value.toString(8).padStart(length - 2, "0")} \0`);
}

function tarEntry(
  name: string,
  prefix: string,
  contents: string | Uint8Array,
  type: "0" | "5" = "0",
) {
  const bytes = Buffer.from(contents);
  const header = Buffer.alloc(512);
  writeTarField(header, 0, 100, name);
  writeTarOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, bytes.byteLength);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeTarField(header, 257, 6, "ustar\0");
  writeTarField(header, 263, 2, "00");
  writeTarOctal(header, 329, 8, 0);
  writeTarOctal(header, 337, 8, 0);
  writeTarField(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTarOctal(header, 148, 8, checksum);
  const padding = Buffer.alloc((512 - (bytes.byteLength % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
}

function writeClawPack(
  entries: Array<{
    name: string;
    prefix?: string;
    contents: string | Uint8Array;
    type?: "0" | "5";
  }>,
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-packed-"));
  tempDirs.push(root);
  const bytes = gzipSync(
    Buffer.concat([
      ...entries.map((entry) =>
        tarEntry(entry.name, entry.prefix ?? "", entry.contents, entry.type),
      ),
      Buffer.alloc(1024),
    ]),
  );
  const artifactPath = join(root, "package.tgz");
  writeFileSync(artifactPath, bytes);
  return {
    artifactPath,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("ClawHub bootstrap artifact manifest", () => {
  it("binds the exact package set and packed file identity", async () => {
    const paths = fixture();
    const created = await createClawHubBootstrapArtifactManifest({
      ...common(paths),
      matrixPath: paths.matrixPath,
      outputPath: paths.manifestPath,
    });
    const meta = created.entries.find((entry) => entry.packageName === "@openclaw/meta");
    expect(meta).toMatchObject({
      artifactPath: "packages/meta/openclaw-meta-2026.7.1-beta.3.tgz",
      size: 11,
    });
    expect(meta?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(created.clawhubToolchainIntegrity).toBe(clawhubToolchainIntegrity);
    expect(created.clawhubToolchainSha256).toBe(clawhubToolchainSha256);
    expect(created.clawhubToolchainVersion).toBe(clawhubToolchainVersion);

    await expect(
      verifyClawHubBootstrapArtifactManifest({
        ...common(paths),
        manifestPath: paths.manifestPath,
      }),
    ).resolves.toEqual(created);
  });

  it("rejects changed bytes and extra artifact files", async () => {
    const paths = fixture();
    await createClawHubBootstrapArtifactManifest({
      ...common(paths),
      matrixPath: paths.matrixPath,
      outputPath: paths.manifestPath,
    });
    writeFileSync(
      join(paths.artifactRoot, "packages", "meta", "openclaw-meta-2026.7.1-beta.3.tgz"),
      "changed",
    );
    await expect(
      verifyClawHubBootstrapArtifactManifest({
        ...common(paths),
        manifestPath: paths.manifestPath,
      }),
    ).rejects.toThrow("packed artifact hash or size mismatch");

    const manifest = JSON.parse(readFileSync(paths.manifestPath, "utf8"));
    writeFileSync(
      join(paths.artifactRoot, "packages", "meta", "openclaw-meta-2026.7.1-beta.3.tgz"),
      "packed meta",
    );
    writeFileSync(join(paths.artifactRoot, "unexpected.txt"), "unexpected");
    await expect(
      verifyClawHubBootstrapArtifactManifest({
        ...common(paths),
        manifestPath: paths.manifestPath,
      }),
    ).rejects.toThrow("artifact inventory mismatch");
    expect(manifest.entries).toHaveLength(2);
  });

  it("uses one exact fatal-UTF8 manifest schema for local and archive consumers", async () => {
    const paths = fixture();
    const created = await createClawHubBootstrapArtifactManifest({
      ...common(paths),
      matrixPath: paths.matrixPath,
      outputPath: paths.manifestPath,
    });

    writeFileSync(paths.manifestPath, JSON.stringify({ ...created, unexpected: true }));
    await expect(
      verifyClawHubBootstrapArtifactManifest({
        ...common(paths),
        manifestPath: paths.manifestPath,
      }),
    ).rejects.toThrow("keys are invalid");

    writeFileSync(paths.manifestPath, Buffer.from([0xff]));
    await expect(
      verifyClawHubBootstrapArtifactManifest({
        ...common(paths),
        manifestPath: paths.manifestPath,
      }),
    ).rejects.toThrow("not valid UTF-8 JSON");

    writeFileSync(paths.manifestPath, JSON.stringify(created));
    await expect(
      verifyClawHubBootstrapArtifactManifest({
        ...common(paths),
        clawhubToolchainSha256: "d".repeat(64),
        manifestPath: paths.manifestPath,
      }),
    ).rejects.toThrow("clawhubToolchainSha256 mismatch");

    writeFileSync(
      paths.manifestPath,
      JSON.stringify({
        ...created,
        entries: [null, ...created.entries.slice(1)],
      }),
    );
    await expect(
      verifyClawHubBootstrapArtifactManifest({
        ...common(paths),
        manifestPath: paths.manifestPath,
      }),
    ).rejects.toThrow("manifest.entries[0] must be an object");
  });

  it("binds exact target bytes to configure-only repairs", async () => {
    const paths = fixture();
    const manifest = await createClawHubBootstrapArtifactManifest({
      ...common(paths),
      matrixPath: paths.matrixPath,
      outputPath: paths.manifestPath,
    });
    const existing = manifest.entries.find((entry) => entry.packageName === "@openclaw/existing");
    expect(existing).toMatchObject({
      artifactPath: "packages/existing/openclaw-existing-2026.7.1-beta.3.tgz",
      size: 15,
    });
    expect(existing?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects preexisting and symlinked download output roots before fetching", async () => {
    const paths = fixture();
    const downloadOptions = {
      artifactDigest: "d".repeat(64),
      artifactId: "456",
      artifactName: `clawhub-bootstrap-${targetSha.slice(0, 12)}-123-2`,
      artifactSize: "1",
      clawhubToolchainIntegrity,
      clawhubToolchainSha256,
      clawhubToolchainVersion,
      consumerRunAttempt: "2",
      repository: "openclaw/openclaw",
      producerJobName: "Pack immutable ClawHub bootstrap artifacts",
      runAttempt: "2",
      runId: "123",
      targetSha,
      token: "test-token",
      workflowSha,
      fetchImpl: (() => {
        throw new Error("fetch must not run");
      }) as typeof fetch,
    };

    const existingRoot = join(paths.artifactRoot, "existing-output");
    mkdirSync(existingRoot);
    await expect(
      downloadClawHubBootstrapArtifact({
        ...downloadOptions,
        outputRoot: existingRoot,
      }),
    ).rejects.toThrow("output directory must not already exist");

    const symlinkTarget = join(paths.artifactRoot, "symlink-target");
    const symlinkRoot = join(paths.artifactRoot, "symlink-output");
    mkdirSync(symlinkTarget);
    symlinkSync(symlinkTarget, symlinkRoot);
    await expect(
      downloadClawHubBootstrapArtifact({
        ...downloadOptions,
        outputRoot: symlinkRoot,
      }),
    ).rejects.toThrow("output directory must not already exist");
  });
});

describe("ClawHub packed artifact identity", () => {
  const expectedIdentity = {
    expectedDir: "extensions/meta",
    expectedName: "@openclaw/meta-provider",
    expectedVersion: "2026.7.1-beta.3",
  };

  it("accepts one canonical package identity and plugin manifest", async () => {
    const pack = writeClawPack([
      {
        name: "package.json",
        prefix: "package",
        contents: JSON.stringify({
          name: "@openclaw/meta-provider",
          version: "2026.7.1-beta.3",
          openclaw: {
            release: {
              publishToClawHub: true,
              publishToNpm: true,
            },
          },
        }),
      },
      {
        name: "openclaw.plugin.json",
        prefix: "package",
        contents: JSON.stringify({ id: "meta" }),
      },
    ]);

    await expect(
      verifyClawHubPackedArtifactIdentity({
        artifactPath: pack.artifactPath,
        expectedSha256: pack.sha256,
        expectedSize: String(pack.bytes.byteLength),
        expectedDir: "extensions/meta",
        expectedName: "@openclaw/meta-provider",
        expectedVersion: "2026.7.1-beta.3",
      }),
    ).resolves.toMatchObject({
      packageName: "@openclaw/meta-provider",
      packageVersion: "2026.7.1-beta.3",
      sha256: pack.sha256,
      size: pack.bytes.byteLength,
    });
  });

  it("rejects a whitespace-bearing alias before a later package.json", async () => {
    const pack = writeClawPack([
      {
        name: " package.json ",
        prefix: " package ",
        contents: JSON.stringify({
          name: "@openclaw/meta-provider",
          version: "2026.7.1-beta.3",
        }),
      },
      {
        name: "package/package.json",
        contents: JSON.stringify({
          name: "@openclaw/other",
          version: "9.9.9",
        }),
      },
      {
        name: "package/openclaw.plugin.json",
        contents: JSON.stringify({ id: "meta" }),
      },
    ]);

    await expect(
      verifyClawHubPackedArtifactIdentity({
        artifactPath: pack.artifactPath,
        expectedSha256: pack.sha256,
        expectedSize: String(pack.bytes.byteLength),
        expectedDir: "extensions/meta",
        expectedName: "@openclaw/meta-provider",
        expectedVersion: "2026.7.1-beta.3",
      }),
    ).rejects.toThrow("changes under the pinned ClawHub path normalization");
  });

  it("rejects a whitespace-bearing alias after a canonical package.json", async () => {
    const pack = writeClawPack([
      {
        name: "package/package.json",
        contents: JSON.stringify({
          name: "@openclaw/meta-provider",
          version: "2026.7.1-beta.3",
        }),
      },
      {
        name: " package.json ",
        prefix: " package ",
        contents: JSON.stringify({
          name: "@openclaw/other",
          version: "9.9.9",
        }),
      },
    ]);

    await expect(
      verifyClawHubPackedArtifactIdentity({
        artifactPath: pack.artifactPath,
        expectedSha256: pack.sha256,
        expectedSize: String(pack.bytes.byteLength),
        ...expectedIdentity,
      }),
    ).rejects.toThrow("changes under the pinned ClawHub path normalization");
  });

  it("rejects a compressed artifact above the ClawHub package limit before reading it", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-packed-limit-"));
    tempDirs.push(root);
    const artifactPath = join(root, "oversized.tgz");
    writeFileSync(artifactPath, "");
    truncateSync(artifactPath, 120 * 1024 * 1024 + 1);

    await expect(
      verifyClawHubPackedArtifactIdentity({
        artifactPath,
        expectedSha256: "a".repeat(64),
        expectedSize: "1",
        ...expectedIdentity,
      }),
    ).rejects.toThrow("exceeds 125829120 bytes");
  });

  it("bounds expanded tar bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-clawhub-expanded-limit-"));
    tempDirs.push(root);
    const artifactPath = join(root, "expanded.tgz");
    const bytes = gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1));
    writeFileSync(artifactPath, bytes);

    await expect(
      verifyClawHubPackedArtifactIdentity({
        artifactPath,
        expectedSha256: createHash("sha256").update(bytes).digest("hex"),
        expectedSize: String(bytes.byteLength),
        ...expectedIdentity,
      }),
    ).rejects.toThrow("expands beyond 67108864 bytes");
  });

  it("bounds individual file payloads", async () => {
    const pack = writeClawPack([
      {
        name: "package/large.bin",
        contents: Buffer.alloc(50 * 1024 * 1024 + 1),
      },
    ]);

    await expect(
      verifyClawHubPackedArtifactIdentity({
        artifactPath: pack.artifactPath,
        expectedSha256: pack.sha256,
        expectedSize: String(pack.bytes.byteLength),
        ...expectedIdentity,
      }),
    ).rejects.toThrow("entry package/large.bin exceeds 52428800 bytes");
  });

  it("bounds total file payload bytes", async () => {
    const pack = writeClawPack(
      Array.from({ length: 6 }, (_, index) => ({
        name: `package/chunk-${index}.bin`,
        contents: Buffer.alloc(9 * 1024 * 1024),
      })),
    );

    await expect(
      verifyClawHubPackedArtifactIdentity({
        artifactPath: pack.artifactPath,
        expectedSha256: pack.sha256,
        expectedSize: String(pack.bytes.byteLength),
        ...expectedIdentity,
      }),
    ).rejects.toThrow("file payload exceeds 52428800 bytes");
  });

  it("bounds the total number of TAR entries", async () => {
    const entries: Array<{
      name: string;
      contents: string;
      type: "0" | "5";
    }> = Array.from({ length: 10_000 }, (_, index) => ({
      name: `package/dir-${index}/`,
      contents: "",
      type: "5",
    }));
    entries.push({
      name: "package/package.json",
      contents: "{}",
      type: "0",
    });
    const pack = writeClawPack(entries);

    await expect(
      verifyClawHubPackedArtifactIdentity({
        artifactPath: pack.artifactPath,
        expectedSha256: pack.sha256,
        expectedSize: String(pack.bytes.byteLength),
        ...expectedIdentity,
      }),
    ).rejects.toThrow("exceeds the 10000 entry limit");
  });
});
