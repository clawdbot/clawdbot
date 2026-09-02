import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  dockerReleaseArtifactName,
  preparedDockerEvidenceFromFullRelease,
  publishDockerRelease,
  sealDockerRelease,
  validateDockerReleaseIdentity,
  validateDockerReleaseManifest,
  verifyDockerReleaseLayout,
  verifyDockerReleaseProducer,
} from "../../scripts/docker-release-artifacts.mjs";

const sourceSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const repository = "openclaw/openclaw";
const runId = "100";
const runAttempt = "2";
const roots: string[] = [];
const mediaType = "application/vnd.oci.image.manifest.v1+json";
const indexMediaType = "application/vnd.oci.image.index.v1+json";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-docker-artifacts-"));
  roots.push(root);
  return root;
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function createLayout(
  directory: string,
  architecture: string,
  options: { labelSha?: string; provenance?: boolean; version?: string } = {},
) {
  function blob(value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const file = path.join(directory, "blobs", "sha256", digest);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return { digest: `sha256:${digest}`, size: bytes.length };
  }
  const config = blob({
    architecture,
    os: "linux",
    rootfs: { type: "layers", diff_ids: [] },
    config: {
      Labels: {
        "org.opencontainers.image.revision": options.labelSha ?? sourceSha,
        "org.opencontainers.image.version": options.version ?? "2026.8.1-beta.2",
        "org.opencontainers.image.created": "2026-09-01T00:00:00.000Z",
      },
    },
  });
  const image = blob({
    schemaVersion: 2,
    mediaType,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
    layers: [],
  });
  const predicates = [
    "https://spdx.dev/Document",
    ...(options.provenance === false ? [] : ["https://slsa.dev/provenance/v1"]),
  ];
  const attestation = blob({
    schemaVersion: 2,
    mediaType,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", ...blob({}) },
    layers: predicates.map((predicateType) =>
      Object.assign(
        blob({ predicateType, subject: [{ digest: { sha256: image.digest.slice(7) } }] }),
        {
          mediaType: "application/vnd.in-toto+json",
          annotations: { "in-toto.io/predicate-type": predicateType },
        },
      ),
    ),
  });
  const manifests = [
    { mediaType, ...image, platform: { os: "linux", architecture } },
    {
      mediaType,
      ...attestation,
      platform: { os: "unknown", architecture: "unknown" },
      annotations: {
        "vnd.docker.reference.type": "attestation-manifest",
        "vnd.docker.reference.digest": image.digest,
      },
    },
  ];
  const index = blob({ schemaVersion: 2, mediaType: indexMediaType, manifests });
  writeJson(path.join(directory, "oci-layout"), { imageLayoutVersion: "1.0.0" });
  writeJson(path.join(directory, "index.json"), {
    schemaVersion: 2,
    manifests: [{ mediaType: indexMediaType, ...index }],
  });
  return {
    indexDigest: index.digest,
    imageDigest: image.digest,
    configDigest: config.digest,
    manifests,
  };
}

async function createPreparedRelease(includeBrowser = true, version = "2026.8.1-beta.2") {
  const root = temporaryDirectory();
  const artifactName = dockerReleaseArtifactName(sourceSha, runAttempt);
  const context = {
    schemaVersion: 1,
    repository,
    sourceSha,
    toolingSha,
    tag: `v${version}`,
    version,
    imageTagSuffix: "-r20260901",
    builtAt: "2026-09-01T00:00:00.000Z",
    includeBrowser,
    producer: {
      runId,
      runAttempt,
      workflowRef: `${repository}/.github/workflows/full-release-validation.yml@refs/heads/main`,
      workflowSha: toolingSha,
      preparationWorkflowRef: `${repository}/.github/workflows/docker-release-prepare.yml@refs/heads/main`,
    },
  };
  const artifacts = ["amd64", "arm64"].map((architecture, index) => ({
    id: index + 10,
    name: `${artifactName}-${architecture}`,
    digest: `sha256:${String(index + 1).repeat(64)}`,
    expired: false,
    size_in_bytes: 1024,
    workflow_run: { id: Number(runId), head_sha: toolingSha },
  }));
  const job = {
    id: 7,
    run_id: Number(runId),
    run_attempt: Number(runAttempt),
    name: "Prepare Docker / Seal prepared Docker images",
    check_run_url: `https://api.github.com/repos/${repository}/check-runs/7`,
    status: "completed",
    conclusion: "success",
    head_sha: toolingSha,
  };
  const run = {
    id: Number(runId),
    run_attempt: Number(runAttempt),
    path: ".github/workflows/full-release-validation.yml",
    head_branch: "main",
    head_sha: toolingSha,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null as string | null,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    referenced_workflows: [
      {
        path: `${repository}/.github/workflows/docker-release-prepare.yml@${toolingSha}`,
        sha: toolingSha,
        ref: "refs/heads/main",
      },
    ],
  };
  const attemptRun = structuredClone(run);
  const readApi = (endpoint: string) => {
    if (endpoint.includes("/artifacts?")) {
      return { artifacts: artifacts.filter((artifact) => endpoint.includes(artifact.name)) };
    }
    if (endpoint.includes("/compare/")) {
      return { status: "identical" };
    }
    if (endpoint.endsWith("/actions/jobs/7")) {
      return job;
    }
    if (endpoint.includes("/jobs?")) {
      return {
        jobs: [
          job,
          {
            ...job,
            id: 8,
            check_run_url: `https://api.github.com/repos/${repository}/check-runs/8`,
          },
        ],
        total_count: 2,
      };
    }
    if (endpoint.endsWith(`/actions/runs/${runId}/attempts/${runAttempt}`)) {
      return attemptRun;
    }
    if (endpoint.endsWith(`/actions/runs/${runId}`)) {
      return run;
    }
    throw new Error(`Unexpected API read: ${endpoint}`);
  };
  for (const architecture of ["amd64", "arm64"]) {
    const images = [];
    for (const variant of includeBrowser ? ["default", "browser"] : ["default"]) {
      const directory = path.join(root, "payloads", `${artifactName}-${architecture}`, variant);
      const image = createLayout(directory, architecture, { version });
      const verified = await verifyDockerReleaseLayout({
        ...context,
        directory,
        architecture,
        expectedDigest: image.indexDigest,
      });
      images.push({ variant, ...verified, smoke: "success", attestations: "success" });
    }
    writeJson(path.join(root, "metadata", `${architecture}.json`), {
      ...context,
      architecture,
      images,
    });
  }
  const manifest = sealDockerRelease({
    metadataDirectory: path.join(root, "metadata"),
    context,
    checkRunId: "7",
    readApi,
  });
  return { root, manifest, run, attemptRun, job, artifacts, readApi };
}

async function createPublicationRetry(conclusion = "failure") {
  const fixture = await createPreparedRelease(false);
  const workflow = ".github/workflows/openclaw-release-publish.yml";
  fixture.manifest.producer.workflowRef = `${repository}/${workflow}@refs/heads/main`;
  fixture.run.path = fixture.attemptRun.path = workflow;
  fixture.attemptRun.status = "completed";
  fixture.attemptRun.conclusion = conclusion;
  fixture.run.run_attempt += 1;
  fixture.run.referenced_workflows = [];
  return {
    ...fixture,
    publisher: {
      publisherSha: toolingSha,
      publisherRunId: runId,
      publisherRunAttempt: String(fixture.run.run_attempt),
      readApi: fixture.readApi,
    },
  };
}

describe("prepared Docker publication", () => {
  it("binds a complete native build to exact immutable artifacts and its own seal job", async () => {
    const fixture = await createPreparedRelease();
    const manifest = verifyDockerReleaseProducer(fixture.manifest, {
      publisherSha: toolingSha,
      readApi: fixture.readApi,
    });
    expect(manifest.producer.jobId).toBe("7");
    expect(
      manifest.architectures.map((entry: { architecture: string }) => entry.architecture),
    ).toEqual(["amd64", "arm64"]);
    expect(
      manifest.architectures.flatMap((entry: { images: { variant: string }[] }) =>
        entry.images.map((image) => image.variant),
      ),
    ).toEqual(["default", "browser", "default", "browser"]);
    fixture.run.status = "completed";
    fixture.run.conclusion = "success";
    expect(
      verifyDockerReleaseProducer(manifest, { publisherSha: toolingSha, readApi: fixture.readApi }),
    ).toBe(manifest);
  });

  it.each(["failure", "cancelled", "timed_out"])(
    "reuses its successful preparation when retrying a %s publication attempt",
    async (conclusion) => {
      const fixture = await createPublicationRetry(conclusion);
      expect(verifyDockerReleaseProducer(fixture.manifest, fixture.publisher)).toBe(
        fixture.manifest,
      );
    },
  );

  it.each([
    "unrelated publisher",
    "stale publisher attempt",
    "different publisher source",
    "failed current parent",
    "changed historical source",
    "wrong historical attempt",
    "changed historical workflow",
    "missing historical preparation",
    "failed seal",
    "replaced artifact",
  ])("rejects a publication retry with %s", async (failure) => {
    const fixture = await createPublicationRetry();
    if (failure === "unrelated publisher") {
      fixture.publisher.publisherRunId = "200";
    }
    if (failure === "stale publisher attempt") {
      fixture.publisher.publisherRunAttempt = runAttempt;
    }
    if (failure === "different publisher source") {
      fixture.publisher.publisherSha = sourceSha;
    }
    if (failure === "failed current parent") {
      fixture.run.status = "completed";
      fixture.run.conclusion = "failure";
    }
    if (failure === "changed historical source") {
      fixture.attemptRun.head_sha = sourceSha;
    }
    if (failure === "wrong historical attempt") {
      fixture.attemptRun.run_attempt += 1;
    }
    if (failure === "changed historical workflow") {
      fixture.attemptRun.path = ".github/workflows/ci.yml";
    }
    if (failure === "missing historical preparation") {
      fixture.attemptRun.referenced_workflows = [];
    }
    if (failure === "failed seal") {
      fixture.job.conclusion = "failure";
    }
    if (failure === "replaced artifact") {
      fixture.artifacts[0]!.id += 100;
    }
    expect(() => verifyDockerReleaseProducer(fixture.manifest, fixture.publisher)).toThrow();
  });

  it("retains successful historical preparation for an unrelated publisher", async () => {
    const fixture = await createPublicationRetry("success");
    fixture.publisher.publisherRunId = "200";
    expect(verifyDockerReleaseProducer(fixture.manifest, fixture.publisher)).toBe(fixture.manifest);
  });

  it.each([
    "unfinished job",
    "failed parent",
    "unfinished historical attempt",
    "different tooling",
    "replaced artifact",
    "wrong workflow",
  ])("rejects %s evidence", async (failure) => {
    const fixture = await createPreparedRelease(false);
    if (failure === "unfinished job") {
      fixture.job.status = "in_progress";
    }
    if (failure === "failed parent") {
      fixture.run.status = "completed";
      fixture.run.conclusion = "failure";
    }
    if (failure === "unfinished historical attempt") {
      fixture.run.run_attempt += 1;
    }
    if (failure === "different tooling") {
      fixture.run.referenced_workflows[0]!.sha = sourceSha;
    }
    if (failure === "replaced artifact") {
      fixture.artifacts[0]!.id += 100;
    }
    if (failure === "wrong workflow") {
      fixture.run.path = ".github/workflows/ci.yml";
    }
    expect(() =>
      verifyDockerReleaseProducer(fixture.manifest, {
        publisherSha: toolingSha,
        readApi: fixture.readApi,
      }),
    ).toThrow();
  });

  it("preserves scheduled stable and extended-stable image refresh preparation", async () => {
    const fixture = await createPreparedRelease(false);
    fixture.manifest.producer.workflowRef = `${repository}/.github/workflows/docker-image-refresh.yml@refs/heads/main`;
    fixture.run.path = ".github/workflows/docker-image-refresh.yml";
    fixture.run.event = "schedule";
    expect(
      verifyDockerReleaseProducer(fixture.manifest, {
        publisherSha: toolingSha,
        readApi: fixture.readApi,
      }),
    ).toBe(fixture.manifest);
  });

  it("rejects missing provenance and mismatched source labels in actual OCI bytes", async () => {
    for (const options of [{ provenance: false }, { labelSha: toolingSha }]) {
      const directory = temporaryDirectory();
      const image = createLayout(directory, "amd64", options);
      await expect(
        verifyDockerReleaseLayout({
          directory,
          architecture: "amd64",
          sourceSha,
          version: "2026.8.1-beta.2",
          builtAt: "2026-09-01T00:00:00.000Z",
          expectedDigest: image.indexDigest,
        }),
      ).rejects.toThrow(/missing predicate|labels/);
    }
  });

  it("validates every payload before allowing the first registry mutation", async () => {
    const { root, manifest } = await createPreparedRelease();
    const arm = manifest.architectures[1];
    const digest = arm.images[0].configDigest;
    writeFileSync(
      path.join(root, "payloads", arm.artifact.name, "default", "blobs", "sha256", digest.slice(7)),
      "corrupt",
    );
    const execute = vi.fn();
    await expect(
      publishDockerRelease({
        manifest,
        payloadDirectory: path.join(root, "payloads"),
        images: ["ghcr.io/openclaw/openclaw"],
        execFileSyncImpl: execute,
        verifyTag: vi.fn(),
      }),
    ).rejects.toThrow("OCI blob size/type mismatch");
    expect(execute).not.toHaveBeenCalled();
  });

  it("copies preserved indexes to both registries and emits verified immutable mirror inputs", async () => {
    const { root, manifest } = await createPreparedRelease();
    const indexes = new Map<string, { digest: string; manifests: unknown[] }>();
    for (const entry of manifest.architectures) {
      for (const image of entry.images) {
        indexes.set(image.indexDigest, { digest: image.indexDigest, manifests: image.manifests });
      }
    }
    const tags = new Map<string, string>();
    const calls: string[][] = [];
    const execute = vi.fn((command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      if (command === "skopeo") {
        const directory = args[3]!.slice(4);
        const descriptor = JSON.parse(readFileSync(path.join(directory, "index.json"), "utf8"))
          .manifests[0];
        tags.set(args[4]!.slice("docker://".length), descriptor.digest);
        return "";
      }
      if (args[2] === "create") {
        const refs = args.filter((arg) => arg.includes("@sha256:"));
        let digest = refs[0]!.split("@")[1]!;
        if (refs.length > 1) {
          const descriptors = refs.flatMap((ref) => indexes.get(ref.split("@")[1]!)!.manifests);
          digest = `sha256:${createHash("sha256").update(JSON.stringify(descriptors)).digest("hex")}`;
          indexes.set(digest, { digest, manifests: descriptors });
        }
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] === "--tag") {
            tags.set(args[index + 1]!, digest);
          }
        }
        return "";
      }
      if (args.includes("--format")) {
        return JSON.stringify({ digest: tags.get(args[3]!) });
      }
      const digest = args[4]!.split("@")[1]!;
      const index = indexes.get(digest);
      if (index) {
        return JSON.stringify({
          schemaVersion: 2,
          mediaType: indexMediaType,
          manifests: index.manifests,
        });
      }
      for (const entry of manifest.architectures) {
        for (const image of entry.images) {
          const descriptor = image.manifests.find(
            (candidate: { digest: string }) => candidate.digest === digest,
          );
          if (descriptor) {
            return readFileSync(
              path.join(
                root,
                "payloads",
                entry.artifact.name,
                image.variant,
                "blobs",
                "sha256",
                digest.slice(7),
              ),
              "utf8",
            );
          }
        }
      }
      throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
    });
    const verifyTag = vi.fn();
    const promote = vi.fn();
    const output = await publishDockerRelease({
      manifest,
      payloadDirectory: path.join(root, "payloads"),
      images: ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"],
      execFileSyncImpl: execute,
      verifyTag,
      promote,
    });
    expect(verifyTag).toHaveBeenCalledExactlyOnceWith(manifest);
    expect(calls.filter((call) => call[0] === "skopeo")).toHaveLength(8);
    expect(
      calls
        .filter((call) => call[0] === "skopeo")
        .every((call) => call[2] === "--all" && call[3] === "--preserve-digests"),
    ).toBe(true);
    expect(tags.size).toBe(18);
    expect([...tags.keys()].every((tag) => tag.includes("2026.8.1-beta.2-r20260901"))).toBe(true);
    expect(output.split("\n")).toEqual(
      ["default", "slim", "browser"].map(
        (variant) =>
          `${variant}=${tags.get(`ghcr.io/openclaw/openclaw:2026.8.1-beta.2-r20260901${variant === "default" ? "" : `-${variant}`}`)}`,
      ),
    );
    expect(promote).not.toHaveBeenCalled();
  });

  it("refuses a copy that cannot preserve its original digest", async () => {
    const { root, manifest } = await createPreparedRelease(false);
    const execute = vi.fn((command: string) =>
      command === "skopeo" ? "" : JSON.stringify({ digest: `sha256:${"f".repeat(64)}` }),
    );
    await expect(
      publishDockerRelease({
        manifest,
        payloadDirectory: path.join(root, "payloads"),
        images: ["ghcr.io/openclaw/openclaw"],
        execFileSyncImpl: execute,
        verifyTag: vi.fn(),
      }),
    ).rejects.toThrow("did not preserve");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["2026.8.1", "v2026.8.1"],
    ["2026.8.1", "v2026.8.1-2"],
    ["2026.8.1-2", "v2026.8.1-2"],
  ] as const)("seals package %s for exactly release %s", async (packageVersion, tag) => {
    const policy = validateDockerReleaseIdentity({ tag, sourceSha, packageVersion });
    expect(policy.channel).toBe("stable");
    expect(policy.version).toBe(tag.slice(1));
    const { manifest } = await createPreparedRelease(false, policy.version);
    const expected = {
      repository,
      sourceSha,
      tag,
      imageTagSuffix: manifest.imageTagSuffix,
      artifactName: manifest.artifactName,
      runId,
      runAttempt,
    };
    expect(validateDockerReleaseManifest(manifest, expected)).toBe(manifest);
    for (const otherTag of ["v2026.8.1", "v2026.8.1-2", "v2026.8.1-3"].filter(
      (candidate) => candidate !== tag,
    )) {
      expect(() => validateDockerReleaseManifest(manifest, { ...expected, tag: otherTag })).toThrow(
        "does not match the release",
      );
    }
  });

  it("rejects a correction for another package base or an unsupported release train", () => {
    for (const [packageVersion, tag] of [
      ["2026.8.1", "v2026.8.11-2"],
      ["2026.8.1-2", "v2026.8.1-3"],
    ] as const) {
      expect(() => validateDockerReleaseIdentity({ tag, sourceSha, packageVersion })).toThrow(
        "does not match release tag",
      );
    }
    expect(() =>
      validateDockerReleaseIdentity({
        tag: "v2026.8.1-alpha.2",
        sourceSha,
        packageVersion: "2026.8.1-alpha.2",
      }),
    ).toThrow("alpha");
  });

  it("requires the Release SHA's own prepared evidence and preserves historical preparation", async () => {
    const { manifest } = await createPreparedRelease(false);
    const prepared = {
      preparedRunId: runId,
      preparedRunAttempt: runAttempt,
      preparedArtifactName: manifest.artifactName,
      preparedManifestSha256: "c".repeat(64),
    };
    const full = {
      runId,
      runAttempt: Number(runAttempt),
      targetSha: sourceSha,
      publicationArtifacts: { docker: prepared },
    };
    expect(
      preparedDockerEvidenceFromFullRelease({ manifest: full, sourceSha, runId, runAttempt }),
    ).toBe(prepared);
    expect(
      preparedDockerEvidenceFromFullRelease({ manifest: {}, sourceSha, runId, runAttempt }),
    ).toBeNull();
    expect(() =>
      preparedDockerEvidenceFromFullRelease({
        manifest: full,
        sourceSha: toolingSha,
        runId,
        runAttempt,
      }),
    ).toThrow("selected full release");
    prepared.preparedRunAttempt = "1";
    expect(() =>
      preparedDockerEvidenceFromFullRelease({ manifest: full, sourceSha, runId, runAttempt }),
    ).toThrow("incomplete or stale");
    expect(() =>
      validateDockerReleaseManifest(manifest, {
        repository,
        sourceSha: toolingSha,
        tag: manifest.tag,
        imageTagSuffix: manifest.imageTagSuffix,
        artifactName: manifest.artifactName,
        runId,
        runAttempt,
      }),
    ).toThrow("does not match");
  });

  it("prepares both native architectures with one release identity and smokes before sealing", () => {
    const prepare = parse(readFileSync(".github/workflows/docker-release-prepare.yml", "utf8"));
    const build = prepare.jobs.build;
    const steps = build.steps as {
      id?: string;
      uses?: string;
      run?: string;
      if?: string;
      with?: Record<string, unknown>;
    }[];
    expect(build.strategy.matrix.include).toEqual([
      { architecture: "amd64", runner: "ubuntu-24.04" },
      { architecture: "arm64", runner: "ubuntu-24.04-arm" },
    ]);
    const builders = steps.filter((step) => step.uses?.startsWith("docker/build-push-action@"));
    expect(builders).toHaveLength(2);
    for (const step of builders) {
      expect(step.with).toMatchObject({
        context: "source",
        platforms: "linux/${{ matrix.architecture }}",
        push: false,
        sbom: true,
        provenance: "mode=max",
      });
      expect(String(step.with?.["build-args"]).split("\n")).toEqual(
        expect.arrayContaining([
          "GIT_COMMIT=${{ inputs.release_sha }}",
          "OPENCLAW_BUILD_TIMESTAMP=${{ needs.resolve.outputs.built_at }}",
          "OPENCLAW_DOCKER_BUILD_VERSION=${{ needs.resolve.outputs.version }}",
          "OPENCLAW_EXTENSIONS=diagnostics-otel,codex",
        ]),
      );
      expect(String(step.with?.labels).split("\n")).toEqual(
        expect.arrayContaining([
          "org.opencontainers.image.revision=${{ inputs.release_sha }}",
          "org.opencontainers.image.version=${{ needs.resolve.outputs.version }}",
          "org.opencontainers.image.created=${{ needs.resolve.outputs.built_at }}",
        ]),
      );
    }
    const browser = steps.find((step) => step.id === "build-browser");
    expect(browser?.if).toBe("${{ needs.resolve.outputs.include_browser == 'true' }}");
    expect(String(browser?.with?.["build-args"]).split("\n")).toContain(
      "OPENCLAW_INSTALL_BROWSER=1",
    );
    const smoke = steps.findIndex((step) =>
      step.run?.includes("docker-release-artifacts.mjs prepare"),
    );
    expect(smoke).toBeGreaterThan(-1);
    expect(
      steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@")),
    ).toBeGreaterThan(smoke);
    expect(prepare.jobs.seal.needs).toContain("build");
  });

  it("keeps preparation unable to publish and serializes the single approved writer", () => {
    const prepare = parse(readFileSync(".github/workflows/docker-release-prepare.yml", "utf8"));
    const publish = parse(readFileSync(".github/workflows/docker-release.yml", "utf8"));
    expect(prepare.on.workflow_call.secrets).toBeUndefined();
    expect(prepare.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(prepare.jobs) as {
      permissions?: Record<string, string>;
      environment?: string;
      concurrency?: unknown;
      steps?: { uses?: string; with?: Record<string, unknown> }[];
    }[]) {
      expect(
        Object.values(job.permissions ?? {}).every((permission) => permission === "read"),
      ).toBe(true);
      expect(job.environment).toBeUndefined();
      expect(job.concurrency).toBeUndefined();
      expect(job.steps?.some((step) => step.uses?.startsWith("docker/login-action@"))).toBe(false);
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("docker/build-push-action@")) {
          expect(step.with).toMatchObject({ push: false, sbom: true, provenance: "mode=max" });
        }
      }
    }
    expect(publish.jobs.prepare.uses).toBe("./.github/workflows/docker-release-prepare.yml");
    expect(publish.jobs.prepare.secrets).toBeUndefined();
    expect(publish.concurrency).toBeUndefined();
    expect(publish.jobs.publish.environment).toBe("docker-release");
    expect(publish.jobs.publish.concurrency).toEqual({
      group: "docker-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(
      Object.entries(publish.jobs)
        .filter(
          ([, job]) =>
            (job as { permissions?: { packages?: string } }).permissions?.packages === "write",
        )
        .map(([name]) => name),
    ).toEqual(["publish"]);
  });
});
