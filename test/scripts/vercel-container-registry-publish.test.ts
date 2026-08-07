import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createVercelContainerRegistryPublishPlan,
  publishVercelContainerRegistryImages,
} from "../../scripts/vercel-container-registry-publish.mjs";

const sourceImage = "ghcr.io/openclaw/openclaw";
const targetImage = "vcr.vercel.com/openclaw-foundation/clawd-bot/openclaw";
const amd64Digest = `sha256:${"1".repeat(64)}`;
const arm64Digest = `sha256:${"2".repeat(64)}`;
const attestationDigest = `sha256:${"3".repeat(64)}`;
const changedDigest = `sha256:${"4".repeat(64)}`;
const cleanIndexDigest = `sha256:${"5".repeat(64)}`;
const imageIndexMediaType = "application/vnd.oci.image.index.v1+json";
const imageManifestMediaType = "application/vnd.oci.image.manifest.v1+json";

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  environment?: string;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  secrets?: Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, string>;
};

type Workflow = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: {
      inputs?: Record<string, { required?: boolean; type?: string }>;
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

    publishVercelContainerRegistryImages(
      { includeBrowser: true, sourceImage, targetImage, version: "2026.7.2" },
      { execFileSyncImpl, log: () => {} },
    );

    const firstCreate = calls.findIndex((args) => args[2] === "create");
    expect(firstCreate).toBe(9);
    expect(calls.slice(0, firstCreate).every((args) => args[2] === "inspect")).toBe(true);
    expect(calls.filter((args) => args[2] === "create")).toHaveLength(12);
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
      if (calls.length === 4) {
        throw new Error("manifest unknown");
      }
      const architecture = architectureForRef(requireCommandRef(args));
      return indexManifest(architecture ? [architecture] : ["amd64", "arm64"]);
    });

    expect(() =>
      publishVercelContainerRegistryImages(
        { includeBrowser: true, sourceImage, targetImage, version: "2026.7.2" },
        { execFileSyncImpl, log: () => {} },
      ),
    ).toThrow("manifest unknown");
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it("fails when VCR does not preserve a source platform manifest digest", () => {
    const calls: string[][] = [];
    const changedTargetRef = `${targetImage}:2026.7.2-amd64`;
    const execFileSyncImpl = successfulExecutor(calls, { changedTargetRef });

    expect(() =>
      publishVercelContainerRegistryImages(
        { includeBrowser: true, sourceImage, targetImage, version: "2026.7.2" },
        { execFileSyncImpl, log: () => {} },
      ),
    ).toThrow(`${changedTargetRef} resolved to ${changedDigest}, expected ${amd64Digest}`);
  });

  it("promotes VCR aliases from the verified clean indexes", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = successfulExecutor(calls);

    publishVercelContainerRegistryImages(
      { includeBrowser: false, sourceImage, targetImage, version: "2026.7.2" },
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
      publishVercelContainerRegistryImages(
        { includeBrowser: false, sourceImage, targetImage, version: "2026.7.2" },
        { execFileSyncImpl, log: () => {} },
      ),
    ).toThrow(`Refusing to move ${targetImage}:latest backward from 2026.7.3 to 2026.7.2`);
    expect(
      calls.some((args) => args[2] === "create" && args.includes(`${targetImage}:latest`)),
    ).toBe(false);
  });

  it("uses production VCR credentials only from the serialized release workflow", () => {
    const reusable = readWorkflow(".github/workflows/vercel-container-registry-publish.yml");
    const dockerRelease = readWorkflow(".github/workflows/docker-release.yml");
    const manualPromotion = readWorkflow(".github/workflows/docker-channel-promote.yml");
    const reusablePublish = requireJob(reusable, "publish");
    const releasePublish = requireJob(dockerRelease, "publish-vcr");
    const manualResolve = requireJob(manualPromotion, "resolve");
    const manualApproval = requireJob(manualPromotion, "approve");

    expect(dockerRelease.concurrency).toEqual({
      group: "docker-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(releasePublish.needs).toEqual([
      "resolve_release_policy",
      "create-manifest",
      "verify-attestations",
    ]);
    expect(releasePublish.if).not.toContain("outputs.channel != 'beta'");
    expect(releasePublish.uses).toBe("./.github/workflows/vercel-container-registry-publish.yml");
    expect(releasePublish.with).toMatchObject({
      include_browser: "${{ needs.create-manifest.outputs.browser_supported == 'true' }}",
    });
    expect(releasePublish.secrets).toEqual({
      VERCEL_TOKEN: "${{ secrets.VERCEL_TOKEN }}",
    });

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
    expect(reusableCallers).toEqual(["docker-release.yml"]);
    expect(reusable.on?.workflow_call?.inputs?.include_browser).toEqual({
      description: "Whether the tagged Docker release includes browser images",
      required: true,
      type: "boolean",
    });

    expect(reusablePublish.steps?.find((step) => step.name === "Set up Docker Builder")?.uses).toBe(
      "docker/setup-buildx-action@d7f5e7f509e45cec5c76c4d5afdd7de93d0b3df5",
    );
    expect(
      reusablePublish.steps?.find(
        (step) => step.name === "Authenticate Docker to Vercel Container Registry",
      )?.run,
    ).toContain("vercel@${VERCEL_CLI_VERSION}");
    expect(JSON.stringify(reusablePublish)).not.toContain("docker-channel-promote.mjs");
    expect(
      reusablePublish.steps?.find((step) => step.name === "Run custom-image Sandbox smoke")?.run,
    ).toContain("sandbox run \\\n");
  });
});
