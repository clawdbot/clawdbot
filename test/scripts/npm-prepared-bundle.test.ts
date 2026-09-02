import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeNpmBundle,
  downloadPreparedNpmBundle,
  NPM_PACKAGE_PRODUCER_WORKFLOW,
  NPM_SOURCE_CHECK_SCHEMA,
  PREPARED_NPM_BUNDLE_SCHEMA,
  prepareNpmPackageBundle,
  qualifyNpmPackageBundle,
  validatePreparedNpmBundleDescriptor,
  verifyPreparedNpmBundleFiles,
  verifyNpmSourceCheck,
} from "../../scripts/npm-prepared-bundle.mjs";
import { validatePreflightManifest } from "../../scripts/release-candidate-checklist.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repository = "openclaw/openclaw";
const sourceSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const workflowPath = ".github/workflows/full-release-validation.yml";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function packageProducer() {
  return {
    repository,
    workflowRef: `${repository}/${workflowPath}@refs/heads/main`,
    workflowSha: toolingSha,
    runId: "12",
    runAttempt: "2",
    jobId: "45",
    jobName: "Prepare npm package / Prepare publishable npm package",
    producerWorkflowPath: NPM_PACKAGE_PRODUCER_WORKFLOW,
  };
}

function packageSourceFixture(
  packageVersion: string,
  baseTag?: "same-source" | "different-source",
) {
  const sourceDir = tempDirs.make("npm-source-");
  const outputDir = join(tempDirs.make("npm-package-output-"), "prepared");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        sourceDir,
        "-c",
        "user.name=Release fixture",
        "-c",
        "user.email=release-fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "--quiet");
  writeFileSync(
    join(sourceDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: packageVersion }),
  );
  git("add", "package.json");
  git("commit", "--quiet", "-m", "release package fixture");
  if (baseTag) {
    git("tag", `v${packageVersion}`);
    if (baseTag === "different-source") {
      git("commit", "--quiet", "--allow-empty", "-m", "different release source");
    }
  }
  const runPack = vi.fn((directory: string, destination: string) => {
    const staging = tempDirs.make("npm-package-staging-");
    mkdirSync(join(staging, "package"));
    copyFileSync(join(directory, "package.json"), join(staging, "package/package.json"));
    return execFileSync("tar", [
      "-czf",
      join(destination, `openclaw-${packageVersion}.tgz`),
      "-C",
      staging,
      "package",
    ]);
  });
  return {
    sourceDir,
    outputDir,
    releaseRef: git("rev-parse", "HEAD"),
    npmDistTag: "beta",
    producer: packageProducer(),
    runPack,
  };
}

async function bundleFixture() {
  const producer = packageProducer();
  const tarball = Buffer.from("exact publishable root archive");
  const aiTarball = Buffer.from("exact publishable AI archive");
  const corePackage = {
    packageName: "@openclaw/ai",
    packageVersion: "2026.8.1",
    tarballName: "openclaw-ai-2026.8.1.tgz",
    tarballSha256: hash(aiTarball),
  };
  const manifest = {
    schema: "openclaw.npm-package-bundle/v1",
    producer,
    releaseTag: "v2026.8.1",
    releaseSha: sourceSha,
    npmDistTag: "beta",
    packageName: "openclaw",
    packageVersion: "2026.8.1",
    tarballName: "openclaw-2026.8.1.tgz",
    tarballSha256: hash(tarball),
    corePackageTarballs: [corePackage],
    dependencyTarballs: [corePackage],
  };
  const files = new Map([
    ["package-bundle.json", Buffer.from(`${JSON.stringify(manifest)}\n`)],
    [manifest.tarballName, tarball],
    [corePackage.tarballName, aiTarball],
  ]);
  const zip = new JSZip();
  for (const [name, bytes] of files) {
    zip.file(name, bytes);
  }
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "STORE",
    platform: "UNIX",
  });
  const descriptor = {
    schema: PREPARED_NPM_BUNDLE_SCHEMA,
    source: { sha: sourceSha },
    artifact: {
      id: "78",
      name: "openclaw-npm-package-12-2",
      digest: hash(archive),
      runId: "12",
      runAttempt: "2",
    },
    package: {
      name: "openclaw",
      fileName: manifest.tarballName,
      sha256: hash(tarball),
      version: manifest.packageVersion,
      sourceSha,
    },
    corePackages: [corePackage],
    manifestSha256: hash(files.get("package-bundle.json")!),
    producer,
  };
  const run = {
    id: 12,
    run_attempt: 2,
    head_sha: toolingSha,
    path: workflowPath,
    head_branch: "main",
    event: "workflow_dispatch",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    status: "in_progress",
    conclusion: null,
  };
  const job = {
    id: 45,
    run_id: 12,
    run_attempt: 2,
    head_sha: toolingSha,
    name: producer.jobName,
    status: "completed",
    conclusion: "success",
  };
  const metadata = {
    id: 78,
    name: descriptor.artifact.name,
    digest: `sha256:${descriptor.artifact.digest}`,
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2026-10-01T00:00:00Z",
    workflow_run: { id: 12, head_sha: toolingSha },
  };
  const runGh = (args: string[]) => {
    const endpoint = args[1];
    if (!endpoint) {
      throw new Error("GitHub request endpoint is required");
    }
    if (endpoint.includes("/jobs?")) {
      return JSON.stringify({ total_count: 1, jobs: [job] });
    }
    if (endpoint.endsWith("/attempts/2")) {
      return JSON.stringify(run);
    }
    if (endpoint.endsWith("/artifacts/78")) {
      return JSON.stringify(metadata);
    }
    throw new Error(`Unexpected GitHub request: ${endpoint}`);
  };
  const fetchImpl: typeof fetch = async (url) => {
    if (typeof url !== "string") {
      throw new Error("Expected a URL string");
    }
    return url.endsWith("/zip") ? new Response(new Uint8Array(archive)) : Response.json(metadata);
  };
  return { archive, descriptor, fetchImpl, files, job, manifest, metadata, run, runGh };
}

describe("prepared npm bundle", () => {
  it.each([
    ["2026.8.1", "v2026.8.1-2", "same-source"],
    ["2026.8.1-2", "v2026.8.1-2", undefined],
    ["2026.8.1", undefined, undefined],
  ] as const)(
    "preserves package %s and requested tag %s through preparation and qualification",
    (packageVersion, releaseTag, baseTag) => {
      const fixture = packageSourceFixture(packageVersion, baseTag);
      const prepared = prepareNpmPackageBundle({ ...fixture, releaseTag });
      const expectedTag = releaseTag ?? `v${packageVersion}`;
      expect(prepared.releaseTag).toBe(expectedTag);
      expect(prepared.releaseSha).toBe(fixture.releaseRef);
      const descriptor = describeNpmBundle({
        directory: fixture.outputDir,
        artifact: {
          id: "78",
          name: "openclaw-npm-package-12-2",
          digest: "c".repeat(64),
          runId: "12",
          runAttempt: "2",
        },
      });
      const evidenceDir = tempDirs.make("npm-dependency-evidence-");
      writeFileSync(join(evidenceDir, "dependency-evidence-manifest.json"), "{}\n");
      const outputDir = join(tempDirs.make("npm-qualified-output-"), "qualified");
      const qualified = qualifyNpmPackageBundle({
        descriptor,
        inputDir: fixture.outputDir,
        outputDir,
        producer: { ...fixture.producer, jobId: "46", jobName: "Qualify prepared npm package" },
        pluginSdkApi: {},
        dependencyEvidenceDir: evidenceDir,
      });
      expect(qualified.releaseTag).toBe(expectedTag);
      expect(qualified.packageVersion).toBe(packageVersion);
      const params = { tag: expectedTag, targetSha: fixture.releaseRef, npmDistTag: "beta" };
      expect(() => validatePreflightManifest(qualified, params)).not.toThrow();
      expect(() => validatePreflightManifest(qualified, { ...params, tag: "v2026.8.1-3" })).toThrow(
        "npm preflight tag mismatch",
      );
      expect(
        JSON.parse(
          execFileSync(
            "tar",
            ["-xOf", join(outputDir, qualified.tarballName), "package/package.json"],
            { encoding: "utf8" },
          ),
        ).version,
      ).toBe(packageVersion);
      expect(readFileSync(join(outputDir, qualified.tarballName))).toEqual(
        readFileSync(join(fixture.outputDir, prepared.tarballName)),
      );
    },
  );

  it.each([
    ["missing base tag", "2026.8.1", undefined, false],
    ["base tag at another source", "2026.8.1", "different-source", false],
    ["different package base", "2026.8.2", "same-source", false],
    ["different requested source", "2026.8.1", "same-source", true],
  ] as const)(
    "rejects a correction with %s before packing",
    (_label, version, baseTag, wrongSource) => {
      const fixture = packageSourceFixture(version, baseTag);
      expect(() =>
        prepareNpmPackageBundle({
          ...fixture,
          releaseTag: "v2026.8.1-2",
          releaseRef: wrongSource ? "f".repeat(40) : fixture.releaseRef,
        }),
      ).toThrow();
      expect(fixture.runPack).not.toHaveBeenCalled();
      expect(existsSync(fixture.outputDir)).toBe(false);
    },
  );

  it("accepts descriptor JSON whose object keys were reordered without changing its contents", async () => {
    const { descriptor, files, manifest } = await bundleFixture();
    const reordered = JSON.parse(
      JSON.stringify(descriptor, (_key, value: unknown) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).toReversed())
          : value,
      ),
    );
    expect(JSON.stringify(reordered.producer)).not.toBe(JSON.stringify(descriptor.producer));
    expect(verifyPreparedNpmBundleFiles({ descriptor: reordered, files })).toEqual(manifest);
  });

  it.each([undefined, "v2026.8.1"])(
    "qualifies exact package bytes with large SDK evidence (release tag=%s)",
    async (releaseTag) => {
      const fixture = await bundleFixture();
      const directory = tempDirs.make("npm-bundle-");
      const inputDir = join(directory, "prepared");
      const outputDir = join(directory, "qualified");
      const downloaded = await downloadPreparedNpmBundle({
        ...fixture,
        repository,
        sourceSha,
        toolingSha,
        outputDir: inputDir,
        token: "test-token",
        npmDistTag: "beta",
        releaseTag,
      });
      expect(readFileSync(downloaded.tarballPath)).toEqual(
        fixture.files.get(fixture.manifest.tarballName),
      );
      const evidenceDir = join(directory, "dependency-evidence");
      mkdirSync(evidenceDir);
      writeFileSync(join(evidenceDir, "dependency-evidence-manifest.json"), "{}\n");
      const manifest = qualifyNpmPackageBundle({
        descriptor: fixture.descriptor,
        inputDir,
        outputDir,
        producer: {
          ...fixture.descriptor.producer,
          jobId: "46",
          jobName: "Qualify prepared npm package",
        },
        pluginSdkApi: {
          baseline: "published",
          // Successful releases can carry multi-megabyte declaration diffs.
          diff: { exports: [{ before: "export type Previous = unknown;\n".repeat(150_000) }] },
        },
        dependencyEvidenceDir: evidenceDir,
      });
      expect(manifest.version).toBe(3);
      expect(manifest.preparedBundle).toEqual(fixture.descriptor);
      for (const entry of [
        fixture.descriptor.package.fileName,
        ...fixture.descriptor.corePackages.map((pkg) => pkg.tarballName),
      ]) {
        expect(readFileSync(join(outputDir, entry))).toEqual(fixture.files.get(entry));
      }
      expect(
        describeNpmBundle({
          directory: outputDir,
          artifact: fixture.descriptor.artifact,
          qualified: true,
        }),
      ).toMatchObject({
        schema: "openclaw.qualified-npm-preflight/v1",
        source: { sha: sourceSha },
        preparedBundle: fixture.descriptor,
      });
    },
  );

  it("rejects a valid bundle for another publication tag before extracting artifacts", async () => {
    const fixture = await bundleFixture();
    const outputDir = join(tempDirs.make("npm-wrong-release-"), "output");
    await expect(
      downloadPreparedNpmBundle({
        ...fixture,
        repository,
        sourceSha,
        toolingSha,
        outputDir,
        token: "test-token",
        npmDistTag: "beta",
        releaseTag: "v2026.8.1-2",
      }),
    ).rejects.toThrow("release tag mismatch");
    expect(existsSync(outputDir)).toBe(false);
  });

  it("rejects an unfinished package producer before downloading or extracting artifacts", async () => {
    const fixture = await bundleFixture();
    fixture.job.status = "in_progress";
    const outputDir = join(tempDirs.make("npm-unfinished-"), "output");
    await expect(
      downloadPreparedNpmBundle({
        ...fixture,
        repository,
        sourceSha,
        toolingSha,
        outputDir,
        token: "test-token",
        npmDistTag: "beta",
        releaseTag: fixture.manifest.releaseTag,
        fetchImpl: async () => {
          throw new Error("must not download before producer success");
        },
      }),
    ).rejects.toThrow("unique exact completed producer job");
    expect(existsSync(outputDir)).toBe(false);
  });

  it("rejects a substituted tarball before sealing qualification", async () => {
    const fixture = await bundleFixture();
    const inputDir = tempDirs.make("npm-substitution-");
    for (const [name, bytes] of fixture.files) {
      writeFileSync(join(inputDir, name), bytes);
    }
    writeFileSync(join(inputDir, fixture.manifest.tarballName), "replacement archive");
    const outputDir = join(inputDir, "qualified");
    expect(() =>
      qualifyNpmPackageBundle({
        descriptor: fixture.descriptor,
        inputDir,
        outputDir,
        producer: fixture.descriptor.producer,
        pluginSdkApi: {},
        dependencyEvidenceDir: inputDir,
      }),
    ).toThrow("tarball digest mismatch");
    expect(existsSync(outputDir)).toBe(false);
  });

  it("rejects a descriptor for another source or reusable owner", async () => {
    const { descriptor } = await bundleFixture();
    expect(() =>
      validatePreparedNpmBundleDescriptor({
        descriptor,
        repository,
        sourceSha: "c".repeat(40),
        toolingSha,
      }),
    ).toThrow("source SHA mismatch");
    descriptor.producer.producerWorkflowPath = ".github/workflows/ci.yml";
    expect(() =>
      validatePreparedNpmBundleDescriptor({ descriptor, repository, sourceSha, toolingSha }),
    ).toThrow("trusted preflight owner");
  });

  it("requires source proof from its exact completed source-check job", async () => {
    const fixture = await bundleFixture();
    const descriptor = {
      schema: NPM_SOURCE_CHECK_SCHEMA,
      source: { sha: sourceSha },
      producer: { ...fixture.descriptor.producer, jobName: "Check npm release source" },
    };
    fixture.job.name = descriptor.producer.jobName;
    expect(
      verifyNpmSourceCheck({ descriptor, repository, sourceSha, toolingSha, runGh: fixture.runGh })
        .job.id,
    ).toBe(45);
    fixture.job.run_attempt = 1;
    expect(() =>
      verifyNpmSourceCheck({ descriptor, repository, sourceSha, toolingSha, runGh: fixture.runGh }),
    ).toThrow("unique exact completed producer job");
  });
});
