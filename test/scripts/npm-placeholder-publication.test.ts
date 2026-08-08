import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertFinalRegistryState,
  classifyRegistryState,
  createPlaceholderPublication,
  createPlaceholderTarball,
  parseSelectedPackages,
  publishPlaceholders,
  resolveSelectedPackageSources,
  verifyPlaceholderArtifact,
} from "../../scripts/npm-placeholder-publication.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);
const WORKFLOW = ".github/workflows/npm-placeholder-bootstrap.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function packageJson(name: string) {
  return {
    name,
    openclaw: {
      install: {
        npmSpec: name,
      },
      build: {
        bundledDist: false,
      },
      release: {
        publishToClawHub: true,
        publishToNpm: true,
      },
    },
  };
}

function createRepo(packages: Array<{ dir: string; manifest: Record<string, unknown> }>) {
  const root = tempDirs.make("npm-placeholder-repo-");
  for (const entry of packages) {
    const dir = join(root, "extensions", entry.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(entry.manifest)}\n`);
  }
  const catalogDir = join(root, "scripts", "lib");
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(
    join(catalogDir, "official-external-plugin-catalog.json"),
    `${JSON.stringify({
      entries: packages.map((entry) => ({
        name: entry.manifest.name,
        source: "official",
        openclaw: { install: { npmSpec: entry.manifest.name } },
      })),
    })}\n`,
  );
  for (const name of ["provider", "channel"]) {
    writeFileSync(join(catalogDir, `official-external-${name}-catalog.json`), '{"entries":[]}\n');
  }
  return root;
}

function registryResponse(packument?: Record<string, unknown>) {
  if (packument === undefined) {
    return new Response("", { status: 404 });
  }
  return new Response(JSON.stringify(packument), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function identity(packageName: string) {
  const tarball = createPlaceholderTarball(packageName);
  return {
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    shasum: createHash("sha1").update(tarball).digest("hex"),
  };
}

describe("npm placeholder publication", () => {
  it("preserves selected multi-package order and binds unique release-enabled manifests", async () => {
    const names = ["@openclaw/zoom-meetings", "@openclaw/comfy-provider"] as const;
    const root = createRepo([
      { dir: "comfy", manifest: packageJson(names[1]) },
      { dir: "zoom-meetings", manifest: packageJson(names[0]) },
    ]);
    const outputDir = join(tempDirs.make("npm-placeholder-output-parent-"), "publication");
    const manifest = await createPlaceholderPublication({
      repoRoot: root,
      outputDir,
      packages: names.join(","),
      targetSha: SHA,
      workflowSha: WORKFLOW_SHA,
      fetchImpl: async () => registryResponse(),
    });

    expect(manifest.packages.map((entry) => entry.packageName)).toEqual(names);
    expect(manifest.packages.map((entry) => entry.packageDir)).toEqual([
      "extensions/zoom-meetings",
      "extensions/comfy",
    ]);
    expect(manifest.packages.every((entry) => entry.action === "publish")).toBe(true);
    expect(manifest.packages.every((entry) => entry.newPackage)).toBe(true);
    expect(readFileSync(join(outputDir, "npm-placeholder-manifest.json"), "utf8")).toContain(
      `"targetSha": "${SHA}"`,
    );
  });

  it("creates deterministic canonical two-file placeholder tarballs", () => {
    const first = createPlaceholderTarball("@openclaw/comfy-provider");
    const second = createPlaceholderTarball("@openclaw/comfy-provider");

    expect(first).toEqual(second);
    expect(first.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  it("requires three stable registry observations during planning", async () => {
    const packageName = "@openclaw/comfy-provider";
    const root = createRepo([{ dir: "comfy", manifest: packageJson(packageName) }]);
    const responses = [
      registryResponse(),
      registryResponse({ "dist-tags": {}, versions: {} }),
      registryResponse(),
    ];

    await expect(
      createPlaceholderPublication({
        repoRoot: root,
        outputDir: join(tempDirs.make("npm-placeholder-unstable-parent-"), "publication"),
        packages: packageName,
        targetSha: SHA,
        workflowSha: WORKFLOW_SHA,
        fetchImpl: async () => responses.shift() ?? registryResponse(),
      }),
    ).rejects.toThrow("npm registry state changed during placeholder planning");
  });

  it("classifies E404, existing-version backfill, and exact idempotent reruns", () => {
    const packageName = "@openclaw/meta-provider";
    const expected = identity(packageName);
    expect(
      classifyRegistryState({
        expectedIntegrity: expected.integrity,
        expectedShasum: expected.shasum,
        packageName,
        registry: { status: 404, packument: null },
      }),
    ).toEqual({ action: "publish", newPackage: true, nonPlaceholderTags: {} });

    expect(
      classifyRegistryState({
        expectedIntegrity: expected.integrity,
        expectedShasum: expected.shasum,
        packageName,
        registry: {
          status: 200,
          packument: {
            "dist-tags": { latest: "2026.7.2", beta: "2026.7.2-beta.7" },
            versions: { "2026.7.2": {} },
          },
        },
      }),
    ).toEqual({
      action: "publish",
      newPackage: false,
      nonPlaceholderTags: { beta: "2026.7.2-beta.7", latest: "2026.7.2" },
    });

    expect(
      classifyRegistryState({
        expectedIntegrity: expected.integrity,
        expectedShasum: expected.shasum,
        packageName,
        registry: {
          status: 200,
          packument: {
            "dist-tags": { placeholder: "0.0.0", latest: "2026.7.2" },
            versions: { "0.0.0": { dist: expected } },
          },
        },
      }),
    ).toEqual({
      action: "skip",
      newPackage: false,
      nonPlaceholderTags: { latest: "2026.7.2" },
    });
    expect(
      classifyRegistryState({
        expectedIntegrity: expected.integrity,
        expectedShasum: expected.shasum,
        packageName,
        registry: {
          status: 200,
          packument: {
            "dist-tags": { latest: "2026.7.2" },
            versions: { "0.0.0": { dist: expected } },
          },
        },
      }),
    ).toEqual({
      action: "tag",
      newPackage: false,
      nonPlaceholderTags: { latest: "2026.7.2" },
    });
  });

  it("rejects mismatched 0.0.0 bytes and conflicting placeholder tags", () => {
    const packageName = "@openclaw/duckduckgo-plugin";
    const expected = identity(packageName);
    expect(() =>
      classifyRegistryState({
        expectedIntegrity: expected.integrity,
        expectedShasum: expected.shasum,
        packageName,
        registry: {
          status: 200,
          packument: {
            "dist-tags": { placeholder: "0.0.0" },
            versions: {
              "0.0.0": { dist: { integrity: "sha512-different", shasum: "different" } },
            },
          },
        },
      }),
    ).toThrow("npm registry tarball bytes differ");
    expect(() =>
      classifyRegistryState({
        expectedIntegrity: expected.integrity,
        expectedShasum: expected.shasum,
        packageName,
        registry: {
          status: 200,
          packument: {
            "dist-tags": { placeholder: "1.2.3" },
            versions: {},
          },
        },
      }),
    ).toThrow("placeholder dist-tag points to 1.2.3");
  });

  it("publishes serially and preserves every non-placeholder dist-tag", async () => {
    const names = ["@openclaw/byteplus-provider", "@openclaw/meta-provider"] as const;
    const root = createRepo([
      { dir: "byteplus", manifest: packageJson(names[0]) },
      { dir: "meta", manifest: packageJson(names[1]) },
    ]);
    const artifactDir = join(tempDirs.make("npm-placeholder-artifact-parent-"), "artifact");
    const existingMeta = registryResponse({
      "dist-tags": { latest: "2026.7.2", beta: "2026.7.2-beta.7" },
      versions: { "2026.7.2": {} },
    });
    const manifest = await createPlaceholderPublication({
      repoRoot: root,
      outputDir: artifactDir,
      packages: names.join(","),
      targetSha: SHA,
      workflowSha: WORKFLOW_SHA,
      fetchImpl: async (input) =>
        String(input).includes(encodeURIComponent(names[0]))
          ? registryResponse()
          : existingMeta.clone(),
    });
    expect(manifest.packages).toHaveLength(2);
    const [firstPackage, secondPackage] = manifest.packages;
    if (!firstPackage || !secondPackage) {
      throw new Error("Expected two placeholder manifest packages.");
    }
    const firstIdentity = firstPackage.tarball;
    const secondIdentity = secondPackage.tarball;
    const publishResponses = [
      registryResponse(),
      registryResponse({
        "dist-tags": { placeholder: "0.0.0" },
        versions: { "0.0.0": { dist: firstIdentity } },
      }),
      registryResponse({
        "dist-tags": { latest: "2026.7.2", beta: "2026.7.2-beta.7" },
        versions: { "2026.7.2": {} },
      }),
      registryResponse({
        "dist-tags": {
          latest: "2026.7.2",
          beta: "2026.7.2-beta.7",
          placeholder: "0.0.0",
        },
        versions: {
          "0.0.0": { dist: secondIdentity },
          "2026.7.2": {},
        },
      }),
    ];
    const calls: string[][] = [];
    const tempRoot = tempDirs.make("npm-placeholder-token-success-");
    const result = await publishPlaceholders({
      artifactDir,
      npmToken: "test-token",
      targetSha: SHA,
      workflowSha: WORKFLOW_SHA,
      fetchImpl: async () => publishResponses.shift() ?? registryResponse(),
      npmRunner: (args) => calls.push(args),
      registryAttempts: 1,
      sleep: async () => undefined,
      tempRoot,
    });

    expect(calls.map((args) => args[0])).toEqual(["publish", "publish"]);
    expect(
      calls.map((args) => {
        const tarballPath = args[1];
        if (!tarballPath) {
          throw new Error("Expected npm publish tarball argument.");
        }
        return basenameForTarball(tarballPath);
      }),
    ).toEqual(manifest.packages.map((entry) => entry.tarball.name));
    expect(result.results.map((entry) => entry.packageName)).toEqual(names);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("rejects malicious package input, duplicate identity, and unsafe manifest paths", () => {
    expect(() => parseSelectedPackages("@openclaw/good,../../evil")).toThrow(
      "Invalid OpenClaw package name",
    );
    expect(() => parseSelectedPackages("@openclaw/good,@openclaw/good")).toThrow("duplicates");

    const duplicateRoot = createRepo([
      { dir: "one", manifest: packageJson("@openclaw/good") },
      { dir: "two", manifest: packageJson("@openclaw/good") },
    ]);
    expect(() => resolveSelectedPackageSources(duplicateRoot, ["@openclaw/good"])).toThrow(
      "must map uniquely",
    );

    const unsafeRoot = createRepo([{ dir: "good", manifest: packageJson("@openclaw/good") }]);
    writeFileSync(join(unsafeRoot, "extensions", "good", "package.json"), "{}\n");
    expect(() => resolveSelectedPackageSources(unsafeRoot, ["@openclaw/good"])).toThrow(
      "must map uniquely",
    );

    const privateRoot = createRepo([
      {
        dir: "private",
        manifest: {
          ...packageJson("@openclaw/private"),
          publishConfig: { access: "private" },
        },
      },
    ]);
    expect(() => resolveSelectedPackageSources(privateRoot, ["@openclaw/private"])).toThrow(
      "not a public release-enabled npm plugin",
    );
  });

  it("fails final verification when any pre-existing dist-tag changes", () => {
    const packageName = "@openclaw/meta-provider";
    const expected = identity(packageName);
    const entry = {
      packageDir: "extensions/meta",
      packageName,
      sourcePackageJsonSha256: "c".repeat(64),
      action: "publish" as const,
      newPackage: false,
      preExistingDistTags: { latest: "2026.7.2" },
      tarball: {
        name: "openclaw-meta-provider-0.0.0.tgz",
        sha256: "d".repeat(64),
        sizeBytes: 1,
        ...expected,
      },
    };
    expect(() =>
      assertFinalRegistryState(entry, {
        status: 200,
        packument: {
          "dist-tags": { latest: "2026.7.1", placeholder: "0.0.0" },
          versions: { "0.0.0": { dist: expected } },
        },
      }),
    ).toThrow("non-placeholder dist-tag changed");
  });

  it("rejects manifest state combinations that could lie about registry creation", async () => {
    const packageName = "@openclaw/comfy-provider";
    const root = createRepo([{ dir: "comfy", manifest: packageJson(packageName) }]);
    const artifactDir = join(tempDirs.make("npm-placeholder-invalid-parent-"), "artifact");
    await createPlaceholderPublication({
      repoRoot: root,
      outputDir: artifactDir,
      packages: packageName,
      targetSha: SHA,
      workflowSha: WORKFLOW_SHA,
      fetchImpl: async () => registryResponse(),
    });
    const manifestPath = join(artifactDir, "npm-placeholder-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.packages[0].action = "skip";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      publishPlaceholders({
        artifactDir,
        npmToken: "test-token",
        targetSha: SHA,
        workflowSha: WORKFLOW_SHA,
        fetchImpl: async () => registryResponse(),
        registryAttempts: 1,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("dist-tag snapshot is not canonical");
  });

  it("removes token-bearing npm config after mutation and readback failure", async () => {
    const packageName = "@openclaw/comfy-provider";
    const root = createRepo([{ dir: "comfy", manifest: packageJson(packageName) }]);
    const artifactDir = join(tempDirs.make("npm-placeholder-failure-parent-"), "artifact");
    await createPlaceholderPublication({
      repoRoot: root,
      outputDir: artifactDir,
      packages: packageName,
      targetSha: SHA,
      workflowSha: WORKFLOW_SHA,
      fetchImpl: async () => registryResponse(),
    });
    const tempRoot = tempDirs.make("npm-placeholder-token-failure-");

    await expect(
      publishPlaceholders({
        artifactDir,
        npmToken: "test-token",
        targetSha: SHA,
        workflowSha: WORKFLOW_SHA,
        fetchImpl: async () => registryResponse(),
        npmRunner: () => {
          throw new Error("ambiguous npm failure");
        },
        registryAttempts: 1,
        sleep: async () => undefined,
        tempRoot,
      }),
    ).rejects.toThrow("mutation failed and exact registry readback did not converge");
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("repairs a missing placeholder tag and accepts exact readback after an ambiguous error", async () => {
    const packageName = "@openclaw/meta-provider";
    const root = createRepo([{ dir: "meta", manifest: packageJson(packageName) }]);
    const expected = identity(packageName);
    const before = {
      "dist-tags": { latest: "2026.7.2" },
      versions: { "0.0.0": { dist: expected } },
    };
    const artifactDir = join(tempDirs.make("npm-placeholder-tag-parent-"), "artifact");
    await createPlaceholderPublication({
      repoRoot: root,
      outputDir: artifactDir,
      packages: packageName,
      targetSha: SHA,
      workflowSha: WORKFLOW_SHA,
      fetchImpl: async () => registryResponse(before),
    });
    const responses = [
      registryResponse(before),
      registryResponse({
        "dist-tags": { latest: "2026.7.2", placeholder: "0.0.0" },
        versions: { "0.0.0": { dist: expected } },
      }),
    ];
    const calls: string[][] = [];
    const tempRoot = tempDirs.make("npm-placeholder-tag-token-");

    const result = await publishPlaceholders({
      artifactDir,
      npmToken: "test-token",
      targetSha: SHA,
      workflowSha: WORKFLOW_SHA,
      fetchImpl: async () => responses.shift() ?? registryResponse(),
      npmRunner: (args) => {
        calls.push(args);
        throw new Error("ambiguous npm failure");
      },
      registryAttempts: 1,
      sleep: async () => undefined,
      tempRoot,
    });

    expect(calls).toEqual([["dist-tag", "add", `${packageName}@0.0.0`, "placeholder"]]);
    expect(result.results).toEqual([{ action: "tag", newPackage: false, packageName }]);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("preserves prototype-looking npm dist-tags as ordinary tag entries", () => {
    const packageName = "@openclaw/meta-provider";
    const expected = identity(packageName);
    const distTags = JSON.parse(
      '{"__proto__":"2026.7.1","latest":"2026.7.2","placeholder":"0.0.0"}',
    );

    expect(
      classifyRegistryState({
        expectedIntegrity: expected.integrity,
        expectedShasum: expected.shasum,
        packageName,
        registry: {
          status: 200,
          packument: {
            "dist-tags": distTags,
            versions: { "0.0.0": { dist: expected } },
          },
        },
      }),
    ).toEqual({
      action: "skip",
      newPackage: false,
      nonPlaceholderTags: Object.fromEntries([
        ["__proto__", "2026.7.1"],
        ["latest", "2026.7.2"],
      ]),
    });
  });

  it("keeps npm credentials isolated to the protected serial publish step", () => {
    const workflow = parse(readFileSync(WORKFLOW, "utf8")) as {
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      jobs?: Record<
        string,
        {
          environment?: string;
          permissions?: Record<string, string>;
          steps?: Array<{ name?: string; env?: Record<string, string>; run?: string }>;
        }
      >;
    };
    const plan = workflow.jobs?.plan;
    const verify = workflow.jobs?.verify;
    const publish = workflow.jobs?.publish;
    expect(workflow.concurrency).toEqual({
      group: "npm-placeholder-release",
      "cancel-in-progress": false,
    });
    expect(plan?.environment).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain("NPM_TOKEN");
    expect(verify?.environment).toBeUndefined();
    expect(JSON.stringify(verify)).not.toContain("NPM_TOKEN");
    expect(
      verify?.steps?.find((step) => step.name === "Verify immutable placeholder publication"),
    ).toBeDefined();
    expect(publish?.environment).toBe("npm-release");
    expect(publish?.permissions).toMatchObject({
      actions: "read",
      contents: "read",
      "id-token": "write",
    });
    const publishStep = publish?.steps?.find(
      (step) => step.name === "Publish verified placeholders serially",
    );
    expect(publishStep?.env?.NPM_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(readFileSync("scripts/npm-placeholder-publication.mjs", "utf8")).toContain(
      '"--provenance"',
    );
    expect(publishStep?.run).not.toContain("npm trust");
    expect(readFileSync(WORKFLOW, "utf8")).toContain("plugin-npm-release.yml");
    const planSteps = plan?.steps ?? [];
    const digestStep = planSteps.find((step) => step.name === "Bind immutable artifact digest");
    expect(digestStep?.env?.RAW_DIGEST).toBe("${{ steps.upload.outputs.artifact-digest }}");
    expect(digestStep?.run).toContain("digest=sha256:${RAW_DIGEST}");
    for (const job of [verify, publish]) {
      const metadataStep = job?.steps?.find(
        (step) => step.name === "Resolve immutable artifact metadata",
      );
      expect(metadataStep?.run).toContain(".digest == $digest");
    }
  });

  it("binds the artifact name to the exact workflow run and producer attempt", async () => {
    await expect(
      verifyPlaceholderArtifact({
        artifactDigest: `sha256:${"a".repeat(64)}`,
        artifactId: 1,
        artifactName: "npm-placeholder-publication-123-2",
        artifactSizeBytes: 1,
        consumerRunAttempt: 1,
        outputDir: "/tmp/unused",
        producerRunAttempt: 1,
        repository: "openclaw/openclaw",
        runId: 123,
        targetRoot: "/tmp/unused",
        targetSha: SHA,
        token: "test-token",
        workflowSha: WORKFLOW_SHA,
      }),
    ).rejects.toThrow("artifact name does not match its workflow run and attempt");
  });
});

function basenameForTarball(path: string) {
  return path.split("/").at(-1);
}
