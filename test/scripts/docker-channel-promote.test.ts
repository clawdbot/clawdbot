import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createDockerChannelPromotionPlan,
  promoteDockerChannel,
} from "../../scripts/docker-channel-promote.mjs";

const images = ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"];
const digest = `sha256:${"1".repeat(64)}`;
const changedDigest = `sha256:${"2".repeat(64)}`;

function imageConfig(version: string): string {
  return JSON.stringify({
    config: { Labels: { "org.opencontainers.image.version": version } },
  });
}

function createDockerMock(params: {
  candidateVersion: string;
  currentVersion?: string;
  wrongTargetDigest?: string;
}) {
  const targetDigests = new Map<string, string>();
  return vi.fn((_command: string, args: string[]) => {
    if (args[2] === "inspect") {
      const ref = args[3]!;
      if (args.at(-1)?.includes(".Image")) {
        return imageConfig(ref.includes("@") ? params.candidateVersion : params.currentVersion!);
      }
      if (params.wrongTargetDigest && ref.includes(":extended-stable")) {
        return JSON.stringify({ digest: params.wrongTargetDigest });
      }
      return JSON.stringify({ digest: targetDigests.get(ref) ?? digest });
    }
    const sourceDigest = args.at(-1)!.split("@")[1]!;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--tag") {
        targetDigests.set(args[index + 1]!, sourceDigest);
      }
    }
    return "";
  });
}

const skipAttestationVerification = () => {};

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | string>;
};

type WorkflowJob = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
  environment?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
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

describe("Docker channel promotion", () => {
  it("plans every extended-stable image variant in both registries", () => {
    expect(createDockerChannelPromotionPlan({ version: "2026.6.33", images })).toEqual({
      channel: "extended-stable",
      promotions: images.flatMap((image) => [
        {
          image,
          sourceRef: `${image}:2026.6.33`,
          targetRefs: [`${image}:extended-stable`],
        },
        {
          image,
          sourceRef: `${image}:2026.6.33-slim`,
          targetRefs: [`${image}:extended-stable-slim`],
        },
        {
          image,
          sourceRef: `${image}:2026.6.33-browser`,
          targetRefs: [`${image}:extended-stable-browser`],
        },
      ]),
      version: "2026.6.33",
    });
  });

  it("preflights every source before moving and verifying aliases", () => {
    const calls: string[][] = [];
    const docker = createDockerMock({
      candidateVersion: "2026.6.33",
      currentVersion: "2026.6.33",
    });
    const execFileSyncImpl = vi.fn((command: string, args: string[]) => {
      calls.push(args);
      return docker(command, args);
    });
    const verifyAttestationsImpl = vi.fn();

    promoteDockerChannel(
      { version: "2026.6.33", images },
      { execFileSyncImpl, verifyAttestationsImpl },
    );

    const firstCreate = calls.findIndex((args) => args[2] === "create");
    expect(firstCreate).toBe(30);
    expect(calls.slice(0, firstCreate).every((args) => args[2] === "inspect")).toBe(true);
    expect(calls.filter((args) => args[2] === "create")).toHaveLength(6);
    expect(verifyAttestationsImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        imageRefs: [
          `ghcr.io/openclaw/openclaw@${digest}`,
          `ghcr.io/openclaw/openclaw@${digest}`,
          `ghcr.io/openclaw/openclaw@${digest}`,
          `docker.io/openclaw/openclaw@${digest}`,
          `docker.io/openclaw/openclaw@${digest}`,
          `docker.io/openclaw/openclaw@${digest}`,
        ],
        requiredPlatforms: [
          { architecture: "amd64", os: "linux", variant: undefined },
          { architecture: "arm64", os: "linux", variant: undefined },
        ],
      }),
    );
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "docker",
      [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        "--tag",
        "ghcr.io/openclaw/openclaw:extended-stable",
        `ghcr.io/openclaw/openclaw@${digest}`,
      ],
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  it("fails without mutating when any version-specific source is missing", () => {
    const calls: string[][] = [];
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 3) {
        throw new Error("missing manifest");
      }
      return JSON.stringify({ digest });
    });

    expect(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow("missing manifest");
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it("fails when a promoted alias does not match its version-specific source", () => {
    const execFileSyncImpl = createDockerMock({
      candidateVersion: "2026.6.33",
      currentVersion: "2026.6.33",
      wrongTargetDigest: changedDigest,
    });

    expect(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow(`resolved to ${changedDigest}, expected ${digest}`);
  });

  it("refuses automatic channel rollback before writing aliases", () => {
    const execFileSyncImpl = createDockerMock({
      candidateVersion: "2026.6.33",
      currentVersion: "2026.6.34",
    });

    expect(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images: images.slice(0, 1) },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow(
      "Refusing to move ghcr.io/openclaw/openclaw:extended-stable backward from 2026.6.34 to 2026.6.33",
    );
    expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(false);
  });

  it.each([
    ["same", "2026.6.33", "2026.6.33"],
    ["newer", "2026.6.34", "2026.6.33"],
  ])("allows an automatic %s-version promotion", (_label, candidateVersion, currentVersion) => {
    const execFileSyncImpl = createDockerMock({ candidateVersion, currentVersion });

    promoteDockerChannel(
      { version: candidateVersion, images: images.slice(0, 1) },
      { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
    );

    expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(true);
  });

  it("allows an explicitly approved rollback", () => {
    const execFileSyncImpl = createDockerMock({
      candidateVersion: "2026.6.33",
      currentVersion: "2026.6.34",
    });

    promoteDockerChannel(
      { version: "2026.6.33", images: images.slice(0, 1) },
      {
        allowRollback: true,
        execFileSyncImpl,
        verifyAttestationsImpl: skipAttestationVerification,
      },
    );

    expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(true);
  });

  it("allows a first promotion when the target alias does not exist", () => {
    let created = false;
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args[2] === "create") {
        created = true;
        return "";
      }
      if (args.at(-1)?.includes(".Image")) {
        if (!args[3]!.includes("@") && !created) {
          const error = new Error("docker inspect failed");
          Object.assign(error, { stderr: `ERROR: ${args[3]}: not found` });
          throw error;
        }
        return imageConfig("2026.6.33");
      }
      return JSON.stringify({ digest });
    });

    promoteDockerChannel(
      { version: "2026.6.33", images: images.slice(0, 1) },
      { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
    );

    expect(created).toBe(true);
  });

  it("fails closed when an existing alias cannot be inspected", () => {
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.at(-1)?.includes(".Image") && !args[3]!.includes("@")) {
        const error = new Error("unauthorized: authentication required");
        Object.assign(error, { stderr: "denied: requested access to the resource is denied" });
        throw error;
      }
      if (args.at(-1)?.includes(".Image")) {
        return imageConfig("2026.6.33");
      }
      return JSON.stringify({ digest });
    });

    expect(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images: images.slice(0, 1) },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow("unauthorized");
    expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(false);
  });

  it("promotes the same digests whose attestations were verified", () => {
    let sourceDigest = digest;
    const targetDigests = new Map<string, string>();
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args[2] === "create") {
        const promotedDigest = args.at(-1)!.split("@")[1]!;
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] === "--tag") {
            targetDigests.set(args[index + 1]!, promotedDigest);
          }
        }
        return "";
      }
      if (args.at(-1)?.includes(".Image")) {
        return imageConfig("2026.6.33");
      }
      const ref = args[3]!;
      return JSON.stringify({ digest: targetDigests.get(ref) ?? sourceDigest });
    });
    const verifiedRefs: string[] = [];

    promoteDockerChannel(
      { version: "2026.6.33", images: images.slice(0, 1) },
      {
        execFileSyncImpl,
        verifyAttestationsImpl({ imageRefs }) {
          verifiedRefs.push(...imageRefs);
          sourceDigest = changedDigest;
        },
      },
    );

    expect(verifiedRefs).toEqual(Array(3).fill(`ghcr.io/openclaw/openclaw@${digest}`));
    expect(
      execFileSyncImpl.mock.calls
        .filter(([, args]) => args[2] === "create")
        .map(([, args]) => args.at(-1)),
    ).toEqual(Array(3).fill(`ghcr.io/openclaw/openclaw@${digest}`));
  });

  it("rejects a source whose version label does not match the requested release", () => {
    const execFileSyncImpl = createDockerMock({
      candidateVersion: "2026.6.34",
      currentVersion: "2026.6.33",
    });

    expect(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images: images.slice(0, 1) },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow(`ghcr.io/openclaw/openclaw@${digest} reports version 2026.6.34, expected 2026.6.33`);
  });

  it("rejects a source whose platform version labels disagree", () => {
    const execFileSyncImpl = vi.fn((_command: string, args: string[]) => {
      if (args.at(-1)?.includes(".Image")) {
        const version = args.at(-1)?.includes("linux/arm64") ? "2026.6.34" : "2026.6.33";
        return imageConfig(version);
      }
      return JSON.stringify({ digest });
    });

    expect(() =>
      promoteDockerChannel(
        { version: "2026.6.33", images: images.slice(0, 1) },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow("inconsistent platform versions: linux/amd64=2026.6.33, linux/arm64=2026.6.34");
    expect(execFileSyncImpl.mock.calls.some(([, args]) => args[2] === "create")).toBe(false);
  });

  it("rejects channels without moving aliases", () => {
    expect(() => createDockerChannelPromotionPlan({ version: "2026.7.2-beta.3", images })).toThrow(
      "no moving aliases",
    );
  });

  it("uses the digest-bound promotion path for releases and approved repairs", () => {
    const workflow = readWorkflow(".github/workflows/docker-channel-promote.yml");
    const releaseWorkflow = readWorkflow(".github/workflows/docker-release.yml");
    const createManifest = requireJob(releaseWorkflow, "create-manifest");
    const verifyAttestations = requireJob(releaseWorkflow, "verify-attestations");
    const resolve = requireJob(workflow, "resolve");
    const approve = requireJob(workflow, "approve");
    const promote = requireJob(workflow, "promote");

    expect(releaseWorkflow.concurrency).toEqual({
      group:
        "${{ github.event_name == 'workflow_dispatch' && format('docker-release-manual-{0}', inputs.tag) || 'docker-release-publish' }}",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(verifyAttestations.permissions).toEqual({ contents: "read", packages: "write" });

    const manifestTagStep = createManifest.steps?.find(
      (step) => step.name === "Resolve manifest tags",
    );
    expect(manifestTagStep?.run).not.toContain("alias");
    expect(manifestTagStep?.env).not.toHaveProperty("DEFAULT_ALIASES");

    const releaseSteps = verifyAttestations.steps ?? [];
    const resolveRefsStep = releaseSteps.find((step) => step.name === "Resolve image refs");
    expect(resolveRefsStep?.run).not.toContain("alias");
    expect(resolveRefsStep?.env).not.toHaveProperty("DEFAULT_ALIASES");
    const releaseAttestationIndex = releaseSteps.findIndex(
      (step) => step.name === "Verify Docker attestations",
    );
    const releasePromotionIndex = releaseSteps.findIndex(
      (step) => step.name === "Promote and verify channel aliases",
    );
    expect(releaseAttestationIndex).toBeGreaterThan(-1);
    expect(releasePromotionIndex).toBeGreaterThan(releaseAttestationIndex);
    expect(releaseSteps[releasePromotionIndex]?.if).toBe(
      "${{ github.event_name != 'workflow_dispatch' && needs.resolve_release_policy.outputs.channel != 'beta' }}",
    );
    expect(releaseSteps[releasePromotionIndex]?.run).toContain(
      "node scripts/docker-channel-promote.mjs",
    );
    expect(releaseSteps[releasePromotionIndex]?.run).not.toContain("--allow-rollback");
    expect(
      Object.values(releaseWorkflow.jobs ?? {}).flatMap((job) =>
        (job.steps ?? []).filter((step) => step.run?.includes("docker-channel-promote.mjs")),
      ),
    ).toHaveLength(1);

    expect(resolve.permissions).toEqual({ contents: "read" });
    expect(resolve.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual(
      expect.objectContaining({ ref: "${{ github.sha }}", "persist-credentials": false }),
    );
    expect(approve.needs).toBe("resolve");
    expect(approve.environment).toBe("docker-release");
    expect(approve.permissions).toEqual({});
    expect(promote.needs).toEqual(["resolve", "approve"]);
    expect(promote.permissions).toEqual({ contents: "read", packages: "write" });
    expect(promote.concurrency).toEqual({
      group: "docker-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(promote.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with).toEqual(
      expect.objectContaining({ ref: "${{ github.sha }}", "persist-credentials": false }),
    );

    const steps = promote.steps ?? [];
    const promotionIndex = steps.findIndex(
      (step) => step.name === "Promote and verify channel aliases",
    );
    expect(steps.some((step) => step.run?.includes("verify-docker-attestations.mjs"))).toBe(false);
    expect(promotionIndex).toBeGreaterThan(-1);
    expect(steps[promotionIndex]?.run).toContain("node scripts/docker-channel-promote.mjs");
    expect(steps[promotionIndex]?.run).toContain("--allow-rollback");

    const packageWriters = Object.entries(workflow.jobs ?? {}).filter(
      ([, job]) => job.permissions?.packages === "write",
    );
    expect(packageWriters.map(([name]) => name)).toEqual(["promote"]);
    expect(packageWriters[0]?.[1].needs).toContain("approve");
  });
});
