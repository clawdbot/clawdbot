import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createVercelContainerRegistryPublishPlan,
  publishVercelContainerRegistryImages,
} from "../../scripts/vercel-container-registry-publish.mjs";

const sourceImage = "ghcr.io/openclaw/openclaw";
const targetImage = "vcr.vercel.com/openclaw-foundation/clawd-bot/openclaw";
const digest = `sha256:${"1".repeat(64)}`;
const changedDigest = `sha256:${"2".repeat(64)}`;

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
  jobs?: Record<string, WorkflowJob>;
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

describe("Vercel Container Registry publishing", () => {
  it.each([
    ["stable", "2026.7.2"],
    ["extended-stable", "2026.6.33"],
    ["beta", "2026.7.2-beta.1"],
  ])("plans the full immutable %s image set", (channel, version) => {
    const plan = createVercelContainerRegistryPublishPlan({
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

  it("rejects tagged image names", () => {
    expect(() =>
      createVercelContainerRegistryPublishPlan({
        sourceImage: `${sourceImage}:latest`,
        targetImage,
        version: "2026.7.2",
      }),
    ).toThrow("untagged container image name");
  });

  it("resolves every source before the first registry write", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      return digest;
    });

    publishVercelContainerRegistryImages(
      { sourceImage, targetImage, version: "2026.7.2" },
      { execFileSyncImpl, log: () => {} },
    );

    const firstCopy = calls.findIndex((args) => args[1] === "copy");
    expect(firstCopy).toBe(9);
    expect(calls.slice(0, firstCopy).every((args) => args[1] === "digest")).toBe(true);
    expect(calls.filter((args) => args[1] === "copy")).toHaveLength(9);
    expect(calls[firstCopy]).toEqual([
      "image",
      "copy",
      "--force-recursive",
      `${sourceImage}@${digest}`,
      `${targetImage}:2026.7.2`,
    ]);
  });

  it("fails before writing when an immutable source is missing", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 4) {
        throw new Error("manifest unknown");
      }
      return digest;
    });

    expect(() =>
      publishVercelContainerRegistryImages(
        { sourceImage, targetImage, version: "2026.7.2" },
        { execFileSyncImpl, log: () => {} },
      ),
    ).toThrow("manifest unknown");
    expect(calls.some((args) => args[1] === "copy")).toBe(false);
  });

  it("fails when VCR does not preserve the source manifest digest", () => {
    let copySeen = false;
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args[1] === "copy") {
        copySeen = true;
        return "";
      }
      if (copySeen && args.at(-1)?.startsWith(targetImage)) {
        return changedDigest;
      }
      return digest;
    });

    expect(() =>
      publishVercelContainerRegistryImages(
        { sourceImage, targetImage, version: "2026.7.2" },
        { execFileSyncImpl, log: () => {} },
      ),
    ).toThrow(`resolved to ${changedDigest}, expected ${digest}`);
  });

  it("wires every Docker release channel and branch-proof publication through one reusable workflow", () => {
    const reusable = readWorkflow(".github/workflows/vercel-container-registry-publish.yml");
    const dockerRelease = readWorkflow(".github/workflows/docker-release.yml");
    const manualPromotion = readWorkflow(".github/workflows/docker-channel-promote.yml");
    const reusablePublish = requireJob(reusable, "publish");
    const releasePublish = requireJob(dockerRelease, "publish-vcr");
    const manualResolve = requireJob(manualPromotion, "resolve");
    const manualApproval = requireJob(manualPromotion, "approve");
    const manualVcrPublish = requireJob(manualPromotion, "publish_vcr");

    expect(releasePublish.needs).toEqual(["resolve_release_policy", "verify-attestations"]);
    expect(releasePublish.if).not.toContain("outputs.channel != 'beta'");
    expect(releasePublish.uses).toBe("./.github/workflows/vercel-container-registry-publish.yml");
    expect(releasePublish.secrets).toEqual({
      VERCEL_TOKEN: "${{ secrets.VERCEL_TOKEN }}",
    });

    const validateDispatch = manualResolve.steps?.find(
      (step) => step.name === "Validate dispatch source",
    );
    const resolvePolicy = manualResolve.steps?.find(
      (step) => step.name === "Resolve release channel policy",
    );
    expect(validateDispatch?.run).toContain('"${PUBLISH_TARGET}" == "docker-channel"');
    expect(resolvePolicy?.run).not.toContain("Expected a final stable or extended-stable");
    expect(resolvePolicy?.run).toContain(
      '"${channel}" == "beta" && "${PUBLISH_TARGET}" == "docker-channel"',
    );
    expect(manualApproval.environment).toBe("docker-release");
    expect(manualVcrPublish.needs).toEqual(["resolve", "approve"]);
    expect(manualVcrPublish.if).toBe("${{ needs.resolve.outputs.publish_target == 'vercel' }}");
    expect(manualVcrPublish.uses).toBe("./.github/workflows/vercel-container-registry-publish.yml");

    expect(reusablePublish.steps?.find((step) => step.name === "Install regctl")?.uses).toBe(
      "regclient/actions/regctl-installer@1b705e32d40851370799ea5814e83d0a5f6a70dc",
    );
    expect(
      reusablePublish.steps?.find(
        (step) => step.name === "Authenticate Docker to Vercel Container Registry",
      )?.run,
    ).toContain("vercel@${VERCEL_CLI_VERSION}");
    expect(
      reusablePublish.steps?.find(
        (step) => step.name === "Promote and verify Vercel channel aliases",
      )?.run,
    ).toContain('[[ "${channel}" == "beta" ]]');
    expect(
      reusablePublish.steps?.find((step) => step.name === "Run custom-image Sandbox smoke")?.run,
    ).toContain("sandbox run \\\n");
  });
});
