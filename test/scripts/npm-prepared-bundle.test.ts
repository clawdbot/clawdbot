import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeNpmBundle,
  downloadPreparedNpmBundle,
  NPM_PACKAGE_PRODUCER_WORKFLOW,
  NPM_SOURCE_CHECK_SCHEMA,
  PREPARED_NPM_BUNDLE_SCHEMA,
  qualifyNpmPackageBundle,
  validatePreparedNpmBundleDescriptor,
  verifyPreparedNpmBundleFiles,
  verifyNpmSourceCheck,
} from "../../scripts/npm-prepared-bundle.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repository = "openclaw/openclaw";
const sourceSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const workflowPath = ".github/workflows/full-release-validation.yml";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function bundleFixture() {
  const producer = {
    repository,
    workflowRef: `${repository}/${workflowPath}@refs/heads/main`,
    workflowSha: toolingSha,
    runId: "12",
    runAttempt: "2",
    jobId: "45",
    jobName: "Prepare npm package / Prepare publishable npm package",
    producerWorkflowPath: NPM_PACKAGE_PRODUCER_WORKFLOW,
  };
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

  it("qualifies exact package bytes with large SDK evidence while the parent is still running", async () => {
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
