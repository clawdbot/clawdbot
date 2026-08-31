import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  sealInstallSmokeCandidatePayload,
  verifyInstallSmokeCandidatePayload,
} from "../../scripts/install-smoke-candidate-payload.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const IDENTITY = {
  harnessRepository: "openclaw/openclaw",
  harnessSha: "1".repeat(40),
  repository: "openclaw/openclaw",
  runAttempt: "2",
  runId: "12345",
  targetSha: "2".repeat(40),
};
const PACKAGE_VERSION = "2026.8.1-beta.3";

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function createTarball(archivePath: string, sourceDir: string, entries: string[]): void {
  execFileSync("tar", ["-czf", archivePath, "-C", sourceDir, ...entries], {
    // The candidate packer runs in Linux; prevent macOS tar from adding AppleDouble files.
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

function createFixture(options: { symlinkInstaller?: boolean; symlinkPackage?: boolean } = {}) {
  const root = tempDirs.make("install-smoke-candidate-payload-");
  const archiveRoot = path.join(root, "candidate-root");
  const scriptsDir = path.join(archiveRoot, "scripts");
  const packageRoot = path.join(root, "package-root");
  const packageContents = path.join(packageRoot, "package");
  const packageDir = path.join(root, "package-output");
  const payloadDir = path.join(root, "payload");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(packageContents, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(payloadDir, { recursive: true });

  writeFileSync(path.join(scriptsDir, "install-target.sh"), "#!/bin/sh\necho install\n");
  if (options.symlinkInstaller) {
    symlinkSync("install-target.sh", path.join(scriptsDir, "install.sh"));
  } else {
    writeFileSync(path.join(scriptsDir, "install.sh"), "#!/bin/sh\necho install\n");
  }
  writeFileSync(path.join(scriptsDir, "install-cli.sh"), "#!/bin/sh\necho cli\n");
  const archivePath = path.join(root, "candidate.tar.gz");
  createTarball(archivePath, root, ["candidate-root"]);

  writeFileSync(
    path.join(packageContents, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: PACKAGE_VERSION })}\n`,
  );
  writeFileSync(path.join(packageContents, "index.js"), "console.log('openclaw');\n");
  const packagePath = path.join(packageDir, "candidate.tgz");
  createTarball(packagePath, packageRoot, ["package"]);
  if (options.symlinkPackage) {
    unlinkSync(packagePath);
    symlinkSync(path.join(root, "candidate.tar.gz"), packagePath);
  }
  return { archivePath, packageDir, packagePath, packageContents, payloadDir, root };
}

async function sealFixture(options: { symlinkInstaller?: boolean; symlinkPackage?: boolean } = {}) {
  const fixture = createFixture(options);
  const manifest = await sealInstallSmokeCandidatePayload({
    ...IDENTITY,
    archivePath: fixture.archivePath,
    outputDir: fixture.payloadDir,
    packageDir: fixture.packageDir,
  });
  const manifestPath = path.join(fixture.payloadDir, "install-smoke-candidate-payload.json");
  return {
    ...fixture,
    manifest,
    manifestPath,
    manifestSha256: sha256(manifestPath),
  };
}

function verifyOptions(payloadDir: string, manifestSha256: string, sourceArchiveSha256: string) {
  return {
    ...IDENTITY,
    expectedManifestSha256: manifestSha256,
    expectedPackageVersion: PACKAGE_VERSION,
    expectedSourceArchiveSha256: sourceArchiveSha256,
    payloadDir,
  };
}

describe("install smoke candidate payload", () => {
  it("seals source installers and package bytes into a fully bound payload", async () => {
    const fixture = await sealFixture();
    const verified = await verifyInstallSmokeCandidatePayload(
      verifyOptions(
        fixture.payloadDir,
        fixture.manifestSha256,
        fixture.manifest.sourceArchiveSha256,
      ),
    );

    expect(verified).toEqual(fixture.manifest);
    expect(verified).toMatchObject({
      ...IDENTITY,
      packageVersion: PACKAGE_VERSION,
      schema: "openclaw.install-smoke-candidate-payload/v1",
      sourceArchiveSha256: sha256(fixture.archivePath),
    });
    expect(verified.files.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: "candidate.tgz", role: "package" },
      { name: "candidate-pack.json", role: "package-metadata" },
      { name: "install.sh", role: "installer" },
      { name: "install-cli.sh", role: "cli-installer" },
    ]);
    expect(
      JSON.parse(readFileSync(path.join(fixture.payloadDir, "candidate-pack.json"), "utf8")),
    ).toEqual([
      {
        entryCount: 2,
        filename: "candidate.tgz",
        name: "openclaw",
        size: statSync(fixture.packagePath).size,
        unpackedSize:
          statSync(path.join(fixture.packageContents, "package.json")).size +
          statSync(path.join(fixture.packageContents, "index.js")).size,
        version: PACKAGE_VERSION,
      },
    ]);
    expect(readFileSync(path.join(fixture.payloadDir, "install.sh"), "utf8")).toContain(
      "echo install",
    );
  });

  it.each(["candidate.tgz", "candidate-pack.json", "install.sh", "install-cli.sh"])(
    "rejects tampering with %s after sealing",
    async (filename) => {
      const fixture = await sealFixture();
      writeFileSync(path.join(fixture.payloadDir, filename), "tampered\n");

      await expect(
        verifyInstallSmokeCandidatePayload(
          verifyOptions(
            fixture.payloadDir,
            fixture.manifestSha256,
            fixture.manifest.sourceArchiveSha256,
          ),
        ),
      ).rejects.toThrow(`candidate payload digest does not match for ${filename}`);
    },
  );

  it("rejects manifest tampering before trusting its file inventory", async () => {
    const fixture = await sealFixture();
    writeFileSync(fixture.manifestPath, "{}\n");

    await expect(
      verifyInstallSmokeCandidatePayload(
        verifyOptions(
          fixture.payloadDir,
          fixture.manifestSha256,
          fixture.manifest.sourceArchiveSha256,
        ),
      ),
    ).rejects.toThrow("candidate payload manifest digest does not match producer output");
  });

  it("rejects tuple drift and unexpected artifact files", async () => {
    const tupleFixture = await sealFixture();
    await expect(
      verifyInstallSmokeCandidatePayload({
        ...verifyOptions(
          tupleFixture.payloadDir,
          tupleFixture.manifestSha256,
          tupleFixture.manifest.sourceArchiveSha256,
        ),
        targetSha: "3".repeat(40),
      }),
    ).rejects.toThrow("candidate payload manifest targetSha does not match the expected tuple");

    await expect(
      verifyInstallSmokeCandidatePayload({
        ...verifyOptions(
          tupleFixture.payloadDir,
          tupleFixture.manifestSha256,
          tupleFixture.manifest.sourceArchiveSha256,
        ),
        expectedSourceArchiveSha256: "4".repeat(64),
      }),
    ).rejects.toThrow("candidate payload source archive digest does not match producer output");

    const extraFixture = await sealFixture();
    writeFileSync(path.join(extraFixture.payloadDir, "extra"), "unexpected\n");
    await expect(
      verifyInstallSmokeCandidatePayload(
        verifyOptions(
          extraFixture.payloadDir,
          extraFixture.manifestSha256,
          extraFixture.manifest.sourceArchiveSha256,
        ),
      ),
    ).rejects.toThrow("candidate payload contains missing or unexpected files");
  });

  it("rejects symlinked candidate inputs before sealing", async () => {
    const installerFixture = createFixture({ symlinkInstaller: true });
    await expect(
      sealInstallSmokeCandidatePayload({
        ...IDENTITY,
        archivePath: installerFixture.archivePath,
        outputDir: installerFixture.payloadDir,
        packageDir: installerFixture.packageDir,
      }),
    ).rejects.toThrow("scripts/install.sh must be a regular file");

    const packageFixture = createFixture({ symlinkPackage: true });
    await expect(
      sealInstallSmokeCandidatePayload({
        ...IDENTITY,
        archivePath: packageFixture.archivePath,
        outputDir: packageFixture.payloadDir,
        packageDir: packageFixture.packageDir,
      }),
    ).rejects.toThrow("candidate package tarball must be a regular file");
  });
});
