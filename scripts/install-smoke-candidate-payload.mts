#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_NAME = "install-smoke-candidate-payload.json";
const SCHEMA = "openclaw.install-smoke-candidate-payload/v1";
const PAYLOAD_FILES = [
  { name: "candidate.tgz", role: "package" },
  { name: "candidate-pack.json", role: "package-metadata" },
  { name: "install.sh", role: "installer" },
  { name: "install-cli.sh", role: "cli-installer" },
] as const;

type PayloadIdentity = {
  harnessRepository: string;
  harnessSha: string;
  repository: string;
  runAttempt: string;
  runId: string;
  targetSha: string;
};

type PayloadFile = {
  name: string;
  role: (typeof PAYLOAD_FILES)[number]["role"];
  sha256: string;
  size: number;
};

type InstallSmokeCandidatePayloadManifest = PayloadIdentity & {
  files: PayloadFile[];
  packageVersion: string;
  schema: typeof SCHEMA;
  sourceArchiveSha256: string;
};

type SealInstallSmokeCandidatePayloadOptions = PayloadIdentity & {
  archivePath: string;
  outputDir: string;
  packageDir: string;
};

type VerifyInstallSmokeCandidatePayloadOptions = PayloadIdentity & {
  expectedManifestSha256: string;
  expectedPackageVersion: string;
  expectedSourceArchiveSha256: string;
  payloadDir: string;
};

function assertRepository(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error(`${label} must be an owner/repository slug`);
  }
  return value;
}

function assertSha(value: string, label: string): string {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} must be a full lowercase commit SHA`);
  }
  return value;
}

function assertPositiveInteger(value: string, label: string): string {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function assertVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(value)) {
    throw new Error(`${label} must be a package version`);
  }
  return value;
}

function validateIdentity(identity: PayloadIdentity): PayloadIdentity {
  return {
    harnessRepository: assertRepository(identity.harnessRepository, "harness repository"),
    harnessSha: assertSha(identity.harnessSha, "harness SHA"),
    repository: assertRepository(identity.repository, "repository"),
    runAttempt: assertPositiveInteger(identity.runAttempt, "run attempt"),
    runId: assertPositiveInteger(identity.runId, "run ID"),
    targetSha: assertSha(identity.targetSha, "target SHA"),
  };
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function describeFile(
  filePath: string,
  descriptor: (typeof PAYLOAD_FILES)[number],
): Promise<PayloadFile> {
  await assertRegularFile(filePath, descriptor.name);
  const stat = await fs.stat(filePath);
  return {
    name: descriptor.name,
    role: descriptor.role,
    sha256: await sha256File(filePath),
    size: stat.size,
  };
}

async function readJson(filePath: string, label: string): Promise<unknown> {
  await assertRegularFile(filePath, label);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} must contain valid JSON`, { cause: error });
  }
}

function runPythonTarReader(args: string[]): Buffer {
  const script = String.raw`
import json
import pathlib
import sys
import tarfile

mode, archive_path, member_name = sys.argv[1:]
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    if mode == "repo-file":
        requested_name = member_name
        roots = {
            member.name.split("/", 1)[0]
            for member in members
            if (
                member.name
                and not member.name.startswith("/")
                and not member.name.split("/", 1)[0].startswith("._")
            )
        }
        if len(roots) != 1:
            raise RuntimeError("candidate archive must contain one repository root")
        member_name = next(iter(roots)) + "/" + member_name
    member = archive.getmember(member_name)
    if not member.isfile():
        label = requested_name if mode == "repo-file" else member_name
        raise RuntimeError(label + " must be a regular file in the candidate archive")
    extracted = archive.extractfile(member)
    if extracted is None:
        raise RuntimeError("failed to read " + member_name)
    sys.stdout.buffer.write(extracted.read())
`;
  const result = spawnSync("python3", ["-c", script, ...args], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new Error(`candidate archive read failed: ${stderr || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function readPackageVersionFromPackJson(value: unknown): {
  filename: string;
  normalized: unknown[];
  version: string;
} {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("candidate pack metadata must contain at least one package result");
  }
  const last = value.at(-1);
  if (!last || typeof last !== "object" || Array.isArray(last)) {
    throw new Error("candidate pack metadata must end with a package result");
  }
  const record = last as Record<string, unknown>;
  const filename = record.filename;
  if (
    typeof filename !== "string" ||
    filename !== path.basename(filename) ||
    filename !== path.win32.basename(filename) ||
    !/^openclaw-[A-Za-z0-9._-]+\.tgz$/u.test(filename)
  ) {
    throw new Error("candidate pack metadata contains an unsafe tarball filename");
  }
  const version = assertVersion(record.version, "candidate pack version");
  return {
    filename,
    normalized: value.map((entry, index) =>
      index === value.length - 1 && entry && typeof entry === "object" && !Array.isArray(entry)
        ? { ...entry, filename: "candidate.tgz" }
        : entry,
    ),
    version,
  };
}

function readPackageJsonFromTarball(tarballPath: string): Record<string, unknown> {
  const raw = runPythonTarReader(["member", tarballPath, "package/package.json"]);
  try {
    const value = JSON.parse(raw.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("package/package.json must be an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error("candidate package tarball has invalid package/package.json", { cause: error });
  }
}

async function writeExclusive(filePath: string, contents: string | Uint8Array): Promise<void> {
  await fs.writeFile(filePath, contents, { flag: "wx", mode: 0o644 });
}

export async function sealInstallSmokeCandidatePayload(
  options: SealInstallSmokeCandidatePayloadOptions,
): Promise<InstallSmokeCandidatePayloadManifest> {
  const identity = validateIdentity(options);
  await assertRegularFile(options.archivePath, "candidate source archive");
  await fs.mkdir(options.outputDir, { recursive: true });
  const existing = await fs.readdir(options.outputDir);
  if (existing.length > 0) {
    throw new Error("candidate payload output directory must be empty");
  }

  const packJsonPath = path.join(options.packageDir, "pack.json");
  const pack = readPackageVersionFromPackJson(
    await readJson(packJsonPath, "candidate pack metadata"),
  );
  const sourceTarballPath = path.join(options.packageDir, pack.filename);
  await assertRegularFile(sourceTarballPath, "candidate package tarball");
  const packageJson = readPackageJsonFromTarball(sourceTarballPath);
  if (packageJson.name !== "openclaw") {
    throw new Error("candidate package tarball must contain the openclaw package");
  }
  if (packageJson.version !== pack.version) {
    throw new Error("candidate package tarball version does not match pack metadata");
  }

  // Re-read installers from the immutable source archive after candidate execution. Candidate
  // build hooks never get a writable handle to the sealed scripts consumed by privileged jobs.
  const installScript = runPythonTarReader([
    "repo-file",
    options.archivePath,
    "scripts/install.sh",
  ]);
  const cliInstallScript = runPythonTarReader([
    "repo-file",
    options.archivePath,
    "scripts/install-cli.sh",
  ]);
  await fs.copyFile(sourceTarballPath, path.join(options.outputDir, "candidate.tgz"));
  await writeExclusive(
    path.join(options.outputDir, "candidate-pack.json"),
    `${JSON.stringify(pack.normalized, null, 2)}\n`,
  );
  await writeExclusive(path.join(options.outputDir, "install.sh"), installScript);
  await writeExclusive(path.join(options.outputDir, "install-cli.sh"), cliInstallScript);

  const files = await Promise.all(
    PAYLOAD_FILES.map((descriptor) =>
      describeFile(path.join(options.outputDir, descriptor.name), descriptor),
    ),
  );
  const manifest: InstallSmokeCandidatePayloadManifest = {
    ...identity,
    files,
    packageVersion: pack.version,
    schema: SCHEMA,
    sourceArchiveSha256: await sha256File(options.archivePath),
  };
  await writeExclusive(
    path.join(options.outputDir, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function validateManifest(
  value: unknown,
  expectedIdentity: PayloadIdentity,
  expectedPackageVersion: string,
  expectedSourceArchiveSha256: string,
): InstallSmokeCandidatePayloadManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("candidate payload manifest must be an object");
  }
  const manifest = value as Partial<InstallSmokeCandidatePayloadManifest>;
  if (manifest.schema !== SCHEMA) {
    throw new Error("candidate payload manifest schema is invalid");
  }
  for (const [key, expected] of Object.entries(expectedIdentity)) {
    if (manifest[key as keyof PayloadIdentity] !== expected) {
      throw new Error(`candidate payload manifest ${key} does not match the expected tuple`);
    }
  }
  if (manifest.packageVersion !== expectedPackageVersion) {
    throw new Error("candidate payload package version does not match the expected version");
  }
  if (manifest.sourceArchiveSha256 !== expectedSourceArchiveSha256) {
    throw new Error("candidate payload source archive digest does not match producer output");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== PAYLOAD_FILES.length) {
    throw new Error("candidate payload manifest file inventory is invalid");
  }
  return manifest as InstallSmokeCandidatePayloadManifest;
}

export async function verifyInstallSmokeCandidatePayload(
  options: VerifyInstallSmokeCandidatePayloadOptions,
): Promise<InstallSmokeCandidatePayloadManifest> {
  const identity = validateIdentity(options);
  const expectedPackageVersion = assertVersion(
    options.expectedPackageVersion,
    "expected package version",
  );
  if (!/^[0-9a-f]{64}$/u.test(options.expectedManifestSha256)) {
    throw new Error("expected manifest SHA-256 must be lowercase hexadecimal");
  }
  if (!/^[0-9a-f]{64}$/u.test(options.expectedSourceArchiveSha256)) {
    throw new Error("expected source archive SHA-256 must be lowercase hexadecimal");
  }
  const entries = (await fs.readdir(options.payloadDir)).toSorted();
  const expectedEntries = [...PAYLOAD_FILES.map(({ name }) => name), MANIFEST_NAME].toSorted();
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    throw new Error("candidate payload contains missing or unexpected files");
  }
  const manifestPath = path.join(options.payloadDir, MANIFEST_NAME);
  await assertRegularFile(manifestPath, "candidate payload manifest");
  if ((await sha256File(manifestPath)) !== options.expectedManifestSha256) {
    throw new Error("candidate payload manifest digest does not match producer output");
  }
  const manifest = validateManifest(
    await readJson(manifestPath, "candidate payload manifest"),
    identity,
    expectedPackageVersion,
    options.expectedSourceArchiveSha256,
  );
  for (let index = 0; index < PAYLOAD_FILES.length; index += 1) {
    const descriptor = PAYLOAD_FILES[index]!;
    const expected = manifest.files[index];
    if (
      !expected ||
      expected.name !== descriptor.name ||
      expected.role !== descriptor.role ||
      !/^[0-9a-f]{64}$/u.test(expected.sha256) ||
      !Number.isSafeInteger(expected.size) ||
      expected.size < 0
    ) {
      throw new Error(`candidate payload manifest entry is invalid for ${descriptor.name}`);
    }
    const actual = await describeFile(path.join(options.payloadDir, descriptor.name), descriptor);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error(`candidate payload digest does not match for ${descriptor.name}`);
    }
  }
  return manifest;
}

function readOption(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1] || argv[index + 1]!.startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  if (argv.includes(name, index + 1)) {
    throw new Error(`${name} may only be provided once`);
  }
  return argv[index + 1]!;
}

function readIdentity(argv: string[]): PayloadIdentity {
  return {
    harnessRepository: readOption(argv, "--harness-repository"),
    harnessSha: readOption(argv, "--harness-sha"),
    repository: readOption(argv, "--repository"),
    runAttempt: readOption(argv, "--run-attempt"),
    runId: readOption(argv, "--run-id"),
    targetSha: readOption(argv, "--target-sha"),
  };
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "seal") {
    const manifest = await sealInstallSmokeCandidatePayload({
      ...readIdentity(argv),
      archivePath: readOption(argv, "--archive"),
      outputDir: readOption(argv, "--output-dir"),
      packageDir: readOption(argv, "--package-dir"),
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }
  if (command === "verify") {
    const manifest = await verifyInstallSmokeCandidatePayload({
      ...readIdentity(argv),
      expectedManifestSha256: readOption(argv, "--manifest-sha256"),
      expectedPackageVersion: readOption(argv, "--package-version"),
      expectedSourceArchiveSha256: readOption(argv, "--source-archive-sha256"),
      payloadDir: readOption(argv, "--payload-dir"),
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }
  throw new Error("usage: install-smoke-candidate-payload.mts <seal|verify> [options]");
}

if (
  process.argv[1] &&
  (await fs.realpath(process.argv[1])) === (await fs.realpath(fileURLToPath(import.meta.url)))
) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
