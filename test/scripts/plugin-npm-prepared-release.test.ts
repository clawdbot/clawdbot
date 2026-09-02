import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  consumePreparedNpmPackage,
  createPreparedNpmRelease,
  downloadPreparedNpmRelease,
  PREPARED_NPM_MANIFEST,
  preparedNpmArtifactName,
  validatePreparedNpmRelease,
  verifyPreparedNpmRegistry,
} from "../../scripts/plugin-npm-prepared-release.mjs";
import { createPluginPublicationArtifact } from "../../scripts/plugin-publication-artifact.mjs";

const producer = {
  repository: "openclaw/openclaw",
  runId: 101,
  runAttempt: 2,
  workflowPath: ".github/workflows/plugin-npm-release.yml",
  workflowEvent: "workflow_dispatch",
  workflowHeadBranch: "main",
  workflowSha: "a".repeat(40),
};
const sourceSha = "b".repeat(40);
const policySha = "c".repeat(64);
const version = "2026.9.2-beta.1";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "plugin-npm-prepared-"));
  roots.push(root);
  return root;
}

function digest(bytes: Buffer, algorithm = "sha256") {
  return createHash(algorithm).update(bytes).digest("hex");
}

function plugin(extensionId: string, alreadyPublished = false) {
  return {
    extensionId,
    packageDir: `extensions/${extensionId}`,
    packageName: `@openclaw/${extensionId}`,
    version,
    channel: "beta",
    publishTag: "beta",
    installNpmSpec: `@openclaw/${extensionId}`,
    alreadyPublished,
  };
}

function workflowRun(completed = false) {
  return {
    id: producer.runId,
    run_attempt: producer.runAttempt,
    head_sha: producer.workflowSha,
    head_branch: producer.workflowHeadBranch,
    path: producer.workflowPath,
    event: producer.workflowEvent,
    repository: { full_name: producer.repository },
    head_repository: { full_name: producer.repository },
    status: completed ? "completed" : "in_progress",
    conclusion: completed ? "success" : null,
  };
}

function metadata(id: number, name: string, bytes: Buffer = Buffer.from("artifact")) {
  return {
    id,
    name,
    digest: `sha256:${digest(bytes)}`,
    size_in_bytes: bytes.length,
    expired: false,
    workflow_run: { id: producer.runId, head_sha: producer.workflowSha },
  };
}

function expectations() {
  return {
    sourceSha,
    workflowSha: producer.workflowSha,
    repository: producer.repository,
    npmDistTag: "default",
    selectionMode: "all-publishable",
    plugins: "",
    publisherPolicySha256: policySha,
  };
}

function preparation() {
  const matrix = [plugin("demo"), plugin("existing", true)] as const;
  const artifact = (entry: ReturnType<typeof plugin>, id: number) =>
    metadata(
      id,
      `plugin-npm-package-${entry.extensionId}-${entry.version}-npm-oidc-${producer.runId}-${producer.runAttempt}`,
    );
  const artifacts = [artifact(matrix[0], 1), artifact(matrix[1], 2)] satisfies [
    ReturnType<typeof metadata>,
    ReturnType<typeof metadata>,
  ];
  const job = (entry: ReturnType<typeof plugin>) => ({
    name: `Preflight plugin npm package (${entry.packageName})`,
    run_id: producer.runId,
    run_attempt: producer.runAttempt,
    head_sha: producer.workflowSha,
    status: "completed",
    conclusion: "success",
  });
  const workflowJobs = {
    total_count: matrix.length,
    jobs: [job(matrix[0]), job(matrix[1])] satisfies [
      ReturnType<typeof job>,
      ReturnType<typeof job>,
    ],
  };
  return {
    ...expectations(),
    producer,
    matrix,
    artifacts,
    workflowRun: workflowRun(),
    workflowJobs,
  };
}

function sourcePackage(root: string, entry: ReturnType<typeof plugin>) {
  const directory = join(root, entry.packageDir);
  mkdirSync(directory, { recursive: true });
  const value = {
    name: entry.packageName,
    version,
    type: "module",
    repository: "https://github.com/openclaw/openclaw",
    openclaw: {
      extensions: ["./dist/index.js"],
      runtimeExtensions: ["./dist/index.js"],
      install: { npmSpec: entry.installNpmSpec },
      release: { publishToNpm: true },
    },
  };
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(join(directory, "package.json"), bytes);
  writeFileSync(join(directory, "README.md"), "Prepared plugin package.");
  return { bytes, value, file: join(directory, "package.json") };
}

async function archive(files: Record<string, Buffer>) {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(files)) {
    zip.file(name, bytes);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

function artifactFetch(artifact: ReturnType<typeof metadata>, bytes: Buffer) {
  return async (input: string) => {
    if (input.endsWith(`/artifacts/${artifact.id}/zip`)) {
      return new Response(new Uint8Array(bytes));
    }
    if (input.endsWith(`/artifacts/${artifact.id}`)) {
      return Response.json(artifact);
    }
    if (input.endsWith(`/runs/${producer.runId}/attempts/${producer.runAttempt}`)) {
      return Response.json(workflowRun(true));
    }
    throw new Error(`Unexpected request: ${input}`);
  };
}

async function packedPluginFixture(runtime = true) {
  const root = tempRoot();
  const entry = plugin("demo");
  const source = sourcePackage(root, entry);
  const packageRoot = join(root, "archive/package");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), source.bytes);
  writeFileSync(join(packageRoot, "openclaw.plugin.json"), JSON.stringify({ id: "demo" }));
  if (runtime) {
    writeFileSync(join(packageRoot, "dist/index.js"), "export default {};\n");
  }
  writeFileSync(join(packageRoot, "README.md"), "Prepared plugin package.\n");
  const evidence = join(root, "evidence");
  mkdirSync(evidence);
  const tarballName = "openclaw-demo.tgz";
  const tarballPath = join(evidence, tarballName);
  await tar.c(
    {
      cwd: join(root, "archive"),
      file: tarballPath,
      gzip: true,
      portable: true,
      noPax: true,
      mtime: new Date("1985-10-26T08:15:00.000Z"),
    },
    [
      "package/package.json",
      "package/openclaw.plugin.json",
      "package/README.md",
      ...(runtime ? ["package/dist/index.js"] : []),
    ],
  );
  return { root, entry, source, evidence, tarballName, tarballPath };
}

describe("prepared plugin npm publication", () => {
  it("seals the full selection, including previously published packages", () => {
    const manifest = createPreparedNpmRelease(preparation());
    expect(manifest.packages.map((entry: { packageName: string }) => entry.packageName)).toEqual([
      "@openclaw/demo",
      "@openclaw/existing",
    ]);
    expect(manifest.packages[1].artifact).toMatchObject({
      runId: 101,
      runAttempt: 2,
      artifactId: 2,
    });
  });

  it.each(["missing-artifact", "prior-attempt", "failed-job", "conflicting-artifact"])(
    "refuses to seal %s instead of falling back to an older success",
    (fault) => {
      const input = preparation();
      if (fault === "missing-artifact") {
        input.artifacts.pop();
      }
      if (fault === "prior-attempt") {
        input.artifacts[0].name = input.artifacts[0].name.replace(/-2$/u, "-1");
      }
      if (fault === "failed-job") {
        input.workflowJobs.jobs[0].conclusion = "failure";
      }
      if (fault === "conflicting-artifact") {
        input.artifacts.push({ ...input.artifacts[0], id: 99 });
      }
      expect(() => createPreparedNpmRelease(input)).toThrow();
    },
  );

  it("compares the complete frozen-source roster and rejects a valid subset", () => {
    const input = preparation();
    const root = tempRoot();
    for (const entry of input.matrix) {
      sourcePackage(root, entry);
    }
    const manifest = createPreparedNpmRelease(input);
    expect(
      validatePreparedNpmRelease(manifest, { ...expectations(), sourceRoot: root }).packages,
    ).toHaveLength(2);
    manifest.packages.pop();
    expect(() =>
      validatePreparedNpmRelease(manifest, { ...expectations(), sourceRoot: root }),
    ).toThrow("complete selected frozen-source roster");
  });

  it.each(["sourceSha", "workflowSha", "publisherPolicySha256", "selectionMode", "npmDistTag"])(
    "rejects another prepared %s",
    (field) => {
      const manifest = createPreparedNpmRelease(preparation());
      expect(() =>
        validatePreparedNpmRelease(manifest, { ...expectations(), [field]: "different" }),
      ).toThrow();
    },
  );

  it("admits only the exact successful preparation artifact and source inventory", async () => {
    const input = preparation();
    const sourceRoot = tempRoot();
    for (const entry of input.matrix) {
      sourcePackage(sourceRoot, entry);
    }
    const manifest = createPreparedNpmRelease(input);
    const bytes = await archive({ [PREPARED_NPM_MANIFEST]: Buffer.from(JSON.stringify(manifest)) });
    const artifact = metadata(10, preparedNpmArtifactName(sourceSha, producer), bytes);
    const descriptor = {
      ...producer,
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.size_in_bytes,
    };
    const admitted = await downloadPreparedNpmRelease({
      ...expectations(),
      sourceRoot,
      artifact: descriptor,
      token: "synthetic-token",
      fetchImpl: artifactFetch(artifact, bytes),
      archivePath: join(sourceRoot, "prepared.zip"),
    });
    expect(admitted.packages).toEqual(manifest.packages);
    await expect(
      downloadPreparedNpmRelease({
        ...expectations(),
        sourceRoot,
        artifact: { ...descriptor, runAttempt: 1 },
        token: "synthetic-token",
        fetchImpl: artifactFetch(artifact, bytes),
      }),
    ).rejects.toThrow("approved producer");
  });

  it("consumes the original qualified package in another run without a source install or pack", async () => {
    const { root, entry, source, evidence, tarballName, tarballPath } = await packedPluginFixture();
    const artifactName = `plugin-npm-package-demo-${version}-npm-oidc-${producer.runId}-${producer.runAttempt}`;
    const created = createPluginPublicationArtifact({
      artifactDir: evidence,
      artifactName,
      packageDir: entry.packageDir,
      packageName: entry.packageName,
      version,
      route: "npm-oidc",
      publishTag: "beta",
      targetSha: sourceSha,
      sourcePackageJsonSha256: digest(source.bytes),
      publicationReason: "Stable npm registry preflight selected npm-oidc.",
      publisherPolicy: {
        policyId: "plugin-npm-release-workflow",
        schema: "openclaw.plugin-npm-publisher-policy/v1",
        sha256: policySha,
      },
    });
    const bytes = await archive({
      [tarballName]: readFileSync(tarballPath),
      "plugin-publication-manifest.json": readFileSync(created.manifestPath),
    });
    const artifact = metadata(11, artifactName, bytes);
    const result = await consumePreparedNpmPackage({
      ...expectations(),
      token: "synthetic-token",
      package: {
        ...entry,
        route: "npm-oidc",
        artifact: {
          ...producer,
          artifactId: artifact.id,
          artifactName,
          artifactDigest: artifact.digest,
          artifactSizeBytes: bytes.length,
        },
      },
      sourcePackageJson: source.file,
      cacheDir: join(root, "downloads"),
      outputDir: join(root, "verified"),
      fetchImpl: artifactFetch(artifact, bytes),
    });
    expect(readFileSync(result.tarballPath)).toEqual(readFileSync(tarballPath));
    expect(result.producerRunId).toBe(producer.runId);
    expect(result.producerRunAttempt).toBe(producer.runAttempt);
  });

  it.each([true, false])(
    "qualifies runtime entries before sealing (compiled runtime: %s)",
    async (runtime) => {
      const { root, evidence, tarballName } = await packedPluginFixture(runtime);
      const repoRoot = process.cwd();
      const workflow = parse(
        readFileSync(join(repoRoot, ".github/workflows/plugin-npm-release.yml"), "utf8"),
      );
      const qualification = workflow.jobs.preview_plugin_pack.steps.find(
        (entry: { name: string }) => entry.name === "Qualify packed plugin runtime",
      );
      expect(qualification).toBeDefined();
      symlinkSync(repoRoot, join(root, ".release-tooling"), "dir");
      symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
      writeFileSync(
        join(evidence, "preflight-manifest.json"),
        JSON.stringify({
          artifact: { tarballName },
          package: { name: "@openclaw/demo", version },
        }),
      );
      const result = spawnSync("bash", ["-c", qualification.run], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          ARTIFACT_DIR: evidence,
          TSX_TSCONFIG_PATH: join(repoRoot, "tsconfig.json"),
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
        },
      });
      if (runtime) {
        expect(result.status, result.stderr).toBe(0);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("runtime extension entry not found");
      }
    },
  );
});

describe("prepared npm registry readback", () => {
  function registryFixture() {
    const bytes = Buffer.from("exact qualified bytes");
    const tarballPath = join(tempRoot(), "qualified.tgz");
    writeFileSync(tarballPath, bytes);
    const name = "@openclaw/demo";
    const packument = {
      name,
      "dist-tags": { beta: version },
      versions: {
        [version]: {
          name,
          version,
          dist: {
            integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
            shasum: digest(bytes, "sha1"),
            tarball: "https://registry.npmjs.org/@openclaw/demo/-/demo.tgz",
          },
        },
      },
    };
    const params = {
      packageName: name,
      version,
      publishTag: "beta",
      route: "npm-oidc",
      tarballPath,
      allowMissing: true,
    };
    return { bytes, packument, params };
  }

  it("adopts an already-published version only after exact byte and selector readback", async () => {
    const { bytes, packument, params } = registryFixture();
    const requests: string[] = [];
    const result = await verifyPreparedNpmRegistry({
      ...params,
      fetchImpl: async (input: string) => {
        requests.push(input);
        return input.endsWith(".tgz")
          ? new Response(new Uint8Array(bytes))
          : Response.json(packument);
      },
    });
    expect(result).toEqual({ alreadyPublished: true });
    expect(requests).toHaveLength(2);
  });

  it("accepts an authoritative missing version as publication work, not a malformed response", async () => {
    const { packument, params } = registryFixture();
    const result = await verifyPreparedNpmRegistry({
      ...params,
      fetchImpl: async () => Response.json({ ...packument, versions: {} }),
    });
    expect(result).toEqual({ alreadyPublished: false });
    await expect(
      verifyPreparedNpmRegistry({ ...params, fetchImpl: async () => Response.json({}) }),
    ).rejects.toThrow("authoritative package inventory");
  });

  it("recovers a transient canonical tarball readback without another publication", async () => {
    const { bytes, packument, params } = registryFixture();
    let tarballReads = 0;
    const result = await verifyPreparedNpmRegistry({
      ...params,
      fetchImpl: async (url: string) => {
        if (url.endsWith(".tgz")) {
          tarballReads += 1;
          return tarballReads === 1
            ? new Response("unavailable", { status: 503 })
            : new Response(bytes);
        }
        return Response.json(packument);
      },
    });
    expect(result).toEqual({ alreadyPublished: true });
    expect(tarballReads).toBe(2);
  });

  it("reports pending verification rather than absence after accepted publication", async () => {
    const { params, packument } = registryFixture();
    await expect(
      verifyPreparedNpmRegistry({
        ...params,
        allowMissing: false,
        remainingReadbacks: 0,
        fetchImpl: async () => Response.json({ ...packument, versions: {} }),
      }),
    ).rejects.toThrow("verification pending. Retry readback, not publication.");
  });

  it.each(["integrity", "bytes", "selector", "removed-oidc-package"])(
    "refuses %s without authorizing a publish or changing a tag",
    async (fault) => {
      const { bytes, packument, params } = registryFixture();
      let tarballReads = 0;
      if (fault === "integrity") {
        packument.versions[version].dist.shasum = "0".repeat(40);
      }
      if (fault === "selector") {
        packument["dist-tags"].beta = "2026.9.2-beta.2";
      }
      await expect(
        verifyPreparedNpmRegistry({
          ...params,
          fetchImpl: async (input: string) => {
            if (fault === "removed-oidc-package") {
              return new Response("missing", { status: 404 });
            }
            if (input.endsWith(".tgz")) {
              tarballReads += 1;
              return new Response(
                new Uint8Array(fault === "bytes" ? Buffer.from("changed bytes") : bytes),
              );
            }
            return Response.json(packument);
          },
        }),
      ).rejects.toThrow();
      expect(tarballReads).toBe(fault === "bytes" || fault === "selector" ? 1 : 0);
    },
  );
});
