import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createVercelContainerRegistryPublishPlan,
  promoteVercelContainerRegistryAliases,
  publishVercelContainerRegistryImages,
} from "../../scripts/vercel-container-registry-publish.mjs";

const sourceImage = "ghcr.io/openclaw/openclaw";
const targetImage = "vcr.vercel.com/openclaw-foundation/openclaw/openclaw";
const amd64Digest = `sha256:${"1".repeat(64)}`;
const arm64Digest = `sha256:${"2".repeat(64)}`;
const attestationDigest = `sha256:${"3".repeat(64)}`;
const changedDigest = `sha256:${"4".repeat(64)}`;
const cleanIndexDigest = `sha256:${"5".repeat(64)}`;
const defaultSourceDigest = `sha256:${"6".repeat(64)}`;
const slimSourceDigest = `sha256:${"7".repeat(64)}`;
const browserSourceDigest = `sha256:${"8".repeat(64)}`;
const immutableSourceRefs = [
  `default=${sourceImage}@${defaultSourceDigest}`,
  `slim=${sourceImage}@${slimSourceDigest}`,
  `browser=${sourceImage}@${browserSourceDigest}`,
];
const imageIndexMediaType = "application/vnd.oci.image.index.v1+json";
const imageManifestMediaType = "application/vnd.oci.image.manifest.v1+json";

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  "continue-on-error"?: boolean;
  environment?: string;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  secrets?: Record<string, string>;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
  uses?: string;
  with?: Record<string, string>;
};

type Workflow = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: {
      inputs?: Record<string, { required?: boolean; type?: string }>;
      outputs?: Record<string, { description?: string; value?: string }>;
    };
  };
};

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function requireJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (!job) {
    throw new Error(`Missing workflow job: ${name}`);
  }
  return job;
}

function indexManifest(architectures: Array<"amd64" | "arm64">, includeAttestations = true) {
  const manifests = architectures.flatMap((architecture) => {
    const digest = architecture === "amd64" ? amd64Digest : arm64Digest;
    const image = {
      digest,
      mediaType: imageManifestMediaType,
      platform: { architecture, os: "linux" },
    };
    if (!includeAttestations) {
      return [image];
    }
    return [
      image,
      {
        annotations: {
          "vnd.docker.reference.digest": digest,
          "vnd.docker.reference.type": "attestation-manifest",
        },
        digest: attestationDigest,
        mediaType: imageManifestMediaType,
        platform: { architecture: "unknown", os: "unknown" },
      },
    ];
  });
  return JSON.stringify({ manifests, mediaType: imageIndexMediaType });
}

function architectureForRef(ref: string): "amd64" | "arm64" | undefined {
  if (ref.endsWith("-amd64")) {
    return "amd64";
  }
  if (ref.endsWith("-arm64")) {
    return "arm64";
  }
  return undefined;
}

function requireCommandRef(args: string[]): string {
  const ref = args[3];
  if (!ref) {
    throw new Error(`Expected an imagetools image reference in ${JSON.stringify(args)}.`);
  }
  return ref;
}

function imageConfig(version: string) {
  return JSON.stringify({
    config: { Labels: { "org.opencontainers.image.version": version } },
  });
}

function publishParams(version: string, includeBrowser: boolean) {
  return {
    includeBrowser,
    sourceRefs: includeBrowser ? immutableSourceRefs : immutableSourceRefs.slice(0, 2),
    targetImage,
    version,
  };
}

function successfulExecutor(
  calls: string[][],
  options: {
    changedTargetRef?: string;
    currentAliasVersion?: string;
    version?: string;
  } = {},
) {
  const version = options.version ?? "2026.7.2";
  return vi.fn((_command: string, args: string[]) => {
    calls.push(args);
    if (args[2] === "create") {
      return "";
    }
    const ref = requireCommandRef(args);
    if (args.at(-1)?.includes(".Image")) {
      return imageConfig(ref.includes("@") ? version : (options.currentAliasVersion ?? version));
    }
    if (ref.startsWith(sourceImage)) {
      const architecture = architectureForRef(ref);
      return indexManifest(architecture ? [architecture] : ["amd64", "arm64"]);
    }
    if (args.at(-1) === "--raw") {
      return indexManifest(["amd64", "arm64"], false);
    }
    const architecture = architectureForRef(ref);
    const expectedDigest = architecture === "arm64" ? arm64Digest : amd64Digest;
    return JSON.stringify({
      digest:
        ref === options.changedTargetRef
          ? changedDigest
          : architecture
            ? expectedDigest
            : cleanIndexDigest,
      mediaType: architecture ? imageManifestMediaType : imageIndexMediaType,
    });
  });
}

describe("Vercel Container Registry publishing", () => {
  it.each([
    ["stable", "2026.7.2"],
    ["extended-stable", "2026.6.33"],
    ["beta", "2026.7.2-beta.1"],
  ])("plans the full immutable %s image set", (channel, version) => {
    const plan = createVercelContainerRegistryPublishPlan({
      includeBrowser: true,
      sourceImage,
      targetImage,
      version,
    });

    expect(plan.channel).toBe(channel);
    expect(plan.readinessTags).toEqual([version, `${version}-slim`, `${version}-browser`]);
    expect(plan.copies.map((copy) => copy.targetTag)).toEqual([
      version,
      `${version}-amd64`,
      `${version}-arm64`,
      `${version}-slim`,
      `${version}-slim-amd64`,
      `${version}-slim-arm64`,
      `${version}-browser`,
      `${version}-browser-amd64`,
      `${version}-browser-arm64`,
    ]);
  });

  it("omits browser images when the tagged Docker release did not build them", () => {
    const plan = createVercelContainerRegistryPublishPlan({
      includeBrowser: false,
      sourceImage,
      targetImage,
      version: "2026.7.2",
    });

    expect(plan.readinessTags).toEqual(["2026.7.2", "2026.7.2-slim"]);
    expect(plan.copies.map((copy) => copy.targetTag)).toEqual([
      "2026.7.2",
      "2026.7.2-amd64",
      "2026.7.2-arm64",
      "2026.7.2-slim",
      "2026.7.2-slim-amd64",
      "2026.7.2-slim-arm64",
    ]);
  });

  it("rejects tagged image names", () => {
    expect(() =>
      createVercelContainerRegistryPublishPlan({
        includeBrowser: true,
        sourceImage: `${sourceImage}:latest`,
        targetImage,
        version: "2026.7.2",
      }),
    ).toThrow("untagged container image name");
  });

  it("resolves every source before the first registry write", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = successfulExecutor(calls);

    publishVercelContainerRegistryImages(publishParams("2026.7.2", true), {
      execFileSyncImpl,
      log: () => {},
    });

    const firstCreate = calls.findIndex((args) => args[2] === "create");
    expect(firstCreate).toBe(3);
    expect(calls.slice(0, firstCreate).every((args) => args[2] === "inspect")).toBe(true);
    expect(
      calls
        .slice(0, firstCreate)
        .map((args) => requireCommandRef(args))
        .every((ref) => ref.includes("@sha256:")),
    ).toBe(true);
    expect(calls.filter((args) => args[2] === "create")).toHaveLength(9);
    expect(calls[firstCreate]).toEqual([
      "buildx",
      "imagetools",
      "create",
      "--progress",
      "plain",
      "--tag",
      `${targetImage}:2026.7.2`,
      `${sourceImage}@${amd64Digest}`,
      `${sourceImage}@${arm64Digest}`,
    ]);
    expect(
      calls.find((args) => args[2] === "inspect" && args[3] === `${targetImage}:2026.7.2-amd64`),
    ).toEqual([
      "buildx",
      "imagetools",
      "inspect",
      `${targetImage}:2026.7.2-amd64`,
      "--format",
      "{{json .Manifest}}",
    ]);
  });

  it("fails before writing when an immutable source is missing", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 2) {
        throw new Error("manifest unknown");
      }
      const architecture = architectureForRef(requireCommandRef(args));
      return indexManifest(architecture ? [architecture] : ["amd64", "arm64"]);
    });

    expect(() =>
      publishVercelContainerRegistryImages(publishParams("2026.7.2", true), {
        execFileSyncImpl,
        log: () => {},
      }),
    ).toThrow("manifest unknown");
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it("fails when VCR does not preserve a source platform manifest digest", () => {
    const calls: string[][] = [];
    const changedTargetRef = `${targetImage}:2026.7.2-amd64`;
    const execFileSyncImpl = successfulExecutor(calls, { changedTargetRef });

    expect(() =>
      publishVercelContainerRegistryImages(publishParams("2026.7.2", true), {
        execFileSyncImpl,
        log: () => {},
      }),
    ).toThrow(`${changedTargetRef} resolved to ${changedDigest}, expected ${amd64Digest}`);
  });

  it("requires every selected source variant to be an immutable digest ref", () => {
    expect(() =>
      publishVercelContainerRegistryImages(
        {
          ...publishParams("2026.7.2", true),
          sourceRefs: [
            `default=${sourceImage}:2026.7.2`,
            `slim=${sourceImage}@${slimSourceDigest}`,
            `browser=${sourceImage}@${browserSourceDigest}`,
          ],
        },
        { execFileSyncImpl: vi.fn(), log: () => {} },
      ),
    ).toThrow("untagged container image name");

    expect(() =>
      publishVercelContainerRegistryImages(
        {
          ...publishParams("2026.7.2", true),
          sourceRefs: immutableSourceRefs.slice(0, 2),
        },
        { execFileSyncImpl: vi.fn(), log: () => {} },
      ),
    ).toThrow("Missing immutable VCR source ref for browser");
  });

  it("promotes VCR aliases from the verified clean indexes", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = successfulExecutor(calls);

    publishVercelContainerRegistryImages(publishParams("2026.7.2", false), {
      execFileSyncImpl,
      log: () => {},
    });
    promoteVercelContainerRegistryAliases(
      {
        includeBrowser: false,
        targetImage,
        version: "2026.7.2",
      },
      { execFileSyncImpl, log: () => {} },
    );

    expect(calls.filter((args) => args[2] === "create").slice(-2)).toEqual([
      [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        "--tag",
        `${targetImage}:latest`,
        "--tag",
        `${targetImage}:main`,
        `${targetImage}@${cleanIndexDigest}`,
      ],
      [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        "--tag",
        `${targetImage}:slim`,
        "--tag",
        `${targetImage}:main-slim`,
        `${targetImage}@${cleanIndexDigest}`,
      ],
    ]);
  });

  it("refuses to move a VCR channel alias backward", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = successfulExecutor(calls, {
      currentAliasVersion: "2026.7.3",
    });

    expect(() =>
      promoteVercelContainerRegistryAliases(
        {
          includeBrowser: false,
          targetImage,
          version: "2026.7.2",
        },
        { execFileSyncImpl, log: () => {} },
      ),
    ).toThrow(`Refusing to move ${targetImage}:latest backward from 2026.7.3 to 2026.7.2`);
    expect(
      calls.some((args) => args[2] === "create" && args.includes(`${targetImage}:latest`)),
    ).toBe(false);
  });

  it("isolates best-effort VCR publication from Docker and GitHub release finalization", () => {
    const reusable = readWorkflow(".github/workflows/vercel-container-registry-publish.yml");
    const dockerRelease = readWorkflow(".github/workflows/docker-release.yml");
    const releaseWorkflow = readWorkflow(".github/workflows/openclaw-release-publish.yml");
    const manualPromotion = readWorkflow(".github/workflows/docker-channel-promote.yml");
    const reusablePublish = requireJob(reusable, "publish");
    const releasePublish = requireJob(releaseWorkflow, "publish_vcr");
    const finalizeRelease = requireJob(releaseWorkflow, "finalize_github_release");
    const verifyAttestations = requireJob(dockerRelease, "verify-attestations");
    const manualResolve = requireJob(manualPromotion, "resolve");
    const manualApproval = requireJob(manualPromotion, "approve");

    expect(dockerRelease.concurrency).toEqual({
      group: "docker-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(reusable.concurrency).toEqual({
      group: "vcr-release-publish",
      "cancel-in-progress": false,
    });
    expect(dockerRelease.jobs?.["publish-vcr"]).toBeUndefined();
    expect(releasePublish.needs).toEqual(["publish_docker"]);
    expect(releasePublish.if).not.toContain("beta");
    expect(releasePublish.uses).toBe("./.github/workflows/vercel-container-registry-publish.yml");
    expect(releasePublish.with).toMatchObject({
      include_browser: "${{ needs.publish_docker.outputs.include_browser == 'true' }}",
      source_refs: "${{ needs.publish_docker.outputs.vcr_source_refs }}",
      version: "${{ needs.publish_docker.outputs.version }}",
    });
    expect(releasePublish.secrets).toEqual({
      VERCEL_TOKEN: "${{ secrets.VERCEL_TOKEN }}",
    });
    expect(finalizeRelease.needs).toEqual(["publish", "publish_docker"]);
    expect(finalizeRelease.if).not.toContain("publish_vcr");
    expect(reusablePublish["continue-on-error"]).toBe(true);
    expect(reusablePublish["timeout-minutes"]).toBe(30);

    const validateDispatch = manualResolve.steps?.find((step) =>
      step.name?.includes("main-branch dispatch"),
    );
    const resolvePolicy = manualResolve.steps?.find(
      (step) => step.name === "Resolve release channel policy",
    );
    expect(validateDispatch?.run).toContain('"${WORKFLOW_REF}" != "refs/heads/main"');
    expect(resolvePolicy?.run).toContain("Expected a final stable or extended-stable");
    expect(manualApproval.environment).toBe("docker-release");
    expect(JSON.stringify(manualPromotion)).not.toContain("VERCEL_TOKEN");
    expect(JSON.stringify(manualPromotion)).not.toContain("vercel-container-registry-publish.yml");

    const reusableCallers = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .filter((name) =>
        readFileSync(`.github/workflows/${name}`, "utf8").includes(
          "uses: ./.github/workflows/vercel-container-registry-publish.yml",
        ),
      );
    expect(reusableCallers).toEqual(["openclaw-release-publish.yml"]);
    expect(reusable.on?.workflow_call?.inputs?.include_browser).toEqual({
      description: "Whether the tagged Docker release includes browser images",
      required: true,
      type: "boolean",
    });
    expect(reusable.on?.workflow_call?.inputs?.source_refs).toEqual({
      description: "Newline-delimited alias=immutable-ref entries verified by the caller",
      required: true,
      type: "string",
    });
    expect(verifyAttestations.outputs?.vcr_source_refs).toBe(
      "${{ steps.vcr_source_refs.outputs.value }}",
    );
    expect(dockerRelease.on?.workflow_call?.outputs).toMatchObject({
      include_browser: {
        value: "${{ jobs.create-manifest.outputs.browser_supported }}",
      },
      vcr_source_refs: {
        value: "${{ jobs.verify-attestations.outputs.vcr_source_refs }}",
      },
      version: {
        value: "${{ jobs.resolve_release_policy.outputs.version }}",
      },
    });
    const immutableSourceStep = verifyAttestations.steps?.find(
      (step) => step.name === "Resolve and verify immutable VCR source refs",
    );
    expect(immutableSourceStep?.run).toContain("docker buildx imagetools inspect");
    expect(immutableSourceStep?.run).toContain("${GHCR_IMAGE}@${digest}");
    expect(immutableSourceStep?.run).toContain("verify-docker-attestations.mjs");

    expect(reusablePublish.steps?.find((step) => step.name === "Set up Docker Builder")?.uses).toBe(
      "docker/setup-buildx-action@d7f5e7f509e45cec5c76c4d5afdd7de93d0b3df5",
    );
    const materializeVercel = reusablePublish.steps?.find(
      (step) => step.name === "Materialize locked Vercel CLI",
    );
    expect(materializeVercel?.run).toContain("scripts/materialize-vercel-cli.sh");
    const authenticateVercel = reusablePublish.steps?.find(
      (step) => step.name === "Authenticate Docker to Vercel Container Registry",
    );
    expect(authenticateVercel?.env?.VERCEL_CLI).toBe("${{ steps.vercel_cli.outputs.cli }}");
    expect(authenticateVercel?.run).toContain('"${VERCEL_CLI}" vcr login docker');
    expect(JSON.stringify(reusablePublish)).not.toContain("npx --yes");
    expect(JSON.stringify(reusablePublish)).not.toContain("docker-channel-promote.mjs");
    const copyIndex = reusablePublish.steps?.findIndex(
      (step) => step.name === "Copy and verify immutable release images",
    );
    const smokeIndex = reusablePublish.steps?.findIndex(
      (step) => step.name === "Run custom-image Sandbox smoke",
    );
    const promoteIndex = reusablePublish.steps?.findIndex(
      (step) => step.name === "Promote and verify channel aliases",
    );
    expect(copyIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(copyIndex ?? -1);
    expect(promoteIndex).toBeGreaterThan(smokeIndex ?? -1);
    const smokeRun = reusablePublish.steps?.[smokeIndex ?? -1]?.run ?? "";
    expect(smokeRun).toContain("sandbox run \\\n");
    expect(smokeRun).toContain("image_not_ready");
    expect(smokeRun).toContain("retry_deadline");
  });

  it("pins the complete Vercel CLI dependency closure", () => {
    const packageJson = JSON.parse(
      readFileSync(".github/release/vercel-cli/package.json", "utf8"),
    ) as { dependencies?: Record<string, string> };
    const packageLock = JSON.parse(
      readFileSync(".github/release/vercel-cli/package-lock.json", "utf8"),
    ) as {
      lockfileVersion?: number;
      packages?: Record<string, { integrity?: string; version?: string }>;
    };
    const materialize = readFileSync("scripts/materialize-vercel-cli.sh", "utf8");

    expect(packageJson.dependencies).toEqual({ vercel: "58.4.4" });
    expect(packageLock.lockfileVersion).toBe(3);
    expect(packageLock.packages?.["node_modules/vercel"]).toMatchObject({
      integrity:
        "sha512-Mv1807Ptxhy6cQne5xV/2dD+bUGYRtpV3sLVPXEW115RBN6K/ssuvOww8eNfdGucFH9C+p5ccQF07XSyAvBPLQ==",
      version: "58.4.4",
    });
    expect(materialize).toContain(
      'expected_lock_sha256="db00a6dd0cab114931bc2b5a09c5a0556020c3652381019e2f817cc0426e782c"',
    );
    expect(materialize).toContain("npm ci \\\n");
    expect(materialize).toContain("--ignore-scripts");
  });
});
