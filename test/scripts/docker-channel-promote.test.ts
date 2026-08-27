import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

function requireStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step?.run) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return step;
}

function runWorkflowStep(step: WorkflowStep, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["-c", step.run!], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// Workflow steps use bash 4+ builtins (mapfile); CI truth is Linux bash 5,
// while stock macOS ships bash 3.2. Skip execution-backed cases there.
const bashRunsWorkflowSteps =
  process.platform !== "win32" &&
  spawnSync("bash", ["-c", "type mapfile"], { encoding: "utf8" }).status === 0;

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

  it("threads a rebuild suffix through sources without changing channel aliases", () => {
    expect(
      createDockerChannelPromotionPlan({
        version: "2026.7.1-2",
        imageTagSuffix: "-r20260820",
        images: images.slice(0, 1),
      }),
    ).toEqual({
      channel: "stable",
      promotions: [
        {
          image: images[0],
          sourceRef: `${images[0]}:2026.7.1-2-r20260820`,
          targetRefs: [`${images[0]}:latest`, `${images[0]}:main`],
        },
        {
          image: images[0],
          sourceRef: `${images[0]}:2026.7.1-2-r20260820-slim`,
          targetRefs: [`${images[0]}:slim`, `${images[0]}:main-slim`],
        },
        {
          image: images[0],
          sourceRef: `${images[0]}:2026.7.1-2-r20260820-browser`,
          targetRefs: [`${images[0]}:latest-browser`, `${images[0]}:main-browser`],
        },
      ],
      version: "2026.7.1-2",
    });
  });

  it("keeps an explicit empty suffix identical to the plain release plan", () => {
    expect(
      createDockerChannelPromotionPlan({
        version: "2026.6.33",
        imageTagSuffix: "",
        images,
      }),
    ).toEqual(createDockerChannelPromotionPlan({ version: "2026.6.33", images }));
  });

  it("keeps suffixed extended-stable sources on dedicated aliases", () => {
    const plan = createDockerChannelPromotionPlan({
      version: "2026.6.34",
      imageTagSuffix: "-r20260820",
      images: images.slice(0, 1),
    });

    expect(plan.promotions.map(({ sourceRef, targetRefs }) => ({ sourceRef, targetRefs }))).toEqual(
      [
        {
          sourceRef: `${images[0]}:2026.6.34-r20260820`,
          targetRefs: [`${images[0]}:extended-stable`],
        },
        {
          sourceRef: `${images[0]}:2026.6.34-r20260820-slim`,
          targetRefs: [`${images[0]}:extended-stable-slim`],
        },
        {
          sourceRef: `${images[0]}:2026.6.34-r20260820-browser`,
          targetRefs: [`${images[0]}:extended-stable-browser`],
        },
      ],
    );
  });

  it.each(["r20260820", "-r2026082", "-r202608200", "-r20260820-extra"])(
    "rejects malformed rebuild suffix %s",
    (imageTagSuffix) => {
      expect(() =>
        createDockerChannelPromotionPlan({
          version: "2026.7.1",
          imageTagSuffix,
          images: images.slice(0, 1),
        }),
      ).toThrow("Invalid Docker image tag suffix");
    },
  );

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
        {
          version: "2026.6.33",
          imageTagSuffix: "-r20260820",
          images: images.slice(0, 1),
        },
        { execFileSyncImpl, verifyAttestationsImpl: skipAttestationVerification },
      ),
    ).toThrow(
      "Refusing to move ghcr.io/openclaw/openclaw:extended-stable backward from 2026.6.34 to 2026.6.33",
    );
    expect(execFileSyncImpl.mock.calls[0]?.[1]).toContain(
      "ghcr.io/openclaw/openclaw:2026.6.33-r20260820",
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

  it("does not expose an attestation bypass", () => {
    const source = readFileSync("scripts/docker-channel-promote.mjs", "utf8");
    expect(source).not.toContain("attestation-policy");
    expect(source).not.toContain("attestationPolicy");
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

  it.skipIf(process.platform === "win32")(
    "threads empty and dated suffixes through every release image ref",
    () => {
      const workflow = readWorkflow(".github/workflows/docker-release.yml");
      const resolveCases = [
        {
          job: "build-amd64",
          step: "Resolve image tags (amd64)",
          expected: ["-amd64", "-slim-amd64", "-browser-amd64"],
        },
        {
          job: "build-arm64",
          step: "Resolve image tags (arm64)",
          expected: ["-arm64", "-slim-arm64", "-browser-arm64"],
        },
        {
          job: "create-manifest",
          step: "Resolve manifest tags",
          expected: ["", "-slim", "-browser"],
        },
        {
          job: "verify-attestations",
          step: "Resolve image refs",
          expected: [
            "",
            "-slim",
            "-browser",
            "-amd64",
            "-slim-amd64",
            "-browser-amd64",
            "-arm64",
            "-slim-arm64",
            "-browser-arm64",
          ],
        },
      ] as const;

      for (const imageTagSuffix of ["", "-r20260820"]) {
        const imageVersion = `2026.7.1-2${imageTagSuffix}`;
        for (const testCase of resolveCases) {
          const root = mkdtempSync(path.join(tmpdir(), "openclaw-docker-release-refs-"));
          try {
            const outputPath = path.join(root, "github-output");
            writeFileSync(outputPath, "", "utf8");
            const result = runWorkflowStep(
              requireStep(requireJob(workflow, testCase.job), testCase.step),
              {
                DOCKERHUB_IMAGE: "docker.io/openclaw/openclaw",
                GHCR_IMAGE: "ghcr.io/openclaw/openclaw",
                GITHUB_OUTPUT: outputPath,
                IMAGE_TAG_SUFFIX: imageTagSuffix,
                SOURCE_REF: "refs/tags/v2026.7.1-2",
              },
            );
            expect(result.status, `${testCase.step}: ${result.stderr}`).toBe(0);
            const output = readFileSync(outputPath, "utf8");
            for (const suffix of testCase.expected) {
              expect(output, `${testCase.step}: ${suffix}`).toContain(
                `ghcr.io/openclaw/openclaw:${imageVersion}${suffix}`,
              );
              expect(output, `${testCase.step}: ${suffix}`).toContain(
                `docker.io/openclaw/openclaw:${imageVersion}${suffix}`,
              );
            }
            if (imageTagSuffix === "") {
              expect(output).not.toContain("-r20260820");
            }
          } finally {
            rmSync(root, { force: true, recursive: true });
          }
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts only empty or dated rebuild suffix workflow inputs",
    () => {
      const workflow = readWorkflow(".github/workflows/docker-release.yml");
      const validate = requireStep(
        requireJob(workflow, "validate_release_identity"),
        "Validate immutable tag and SHA inputs",
      );
      for (const imageTagSuffix of ["", "-r20260820"]) {
        const result = runWorkflowStep(validate, {
          IMAGE_TAG_SUFFIX: imageTagSuffix,
          RELEASE_SHA: "a".repeat(40),
          RELEASE_TAG: "v2026.7.1-2",
        });
        expect(result.status, result.stderr).toBe(0);
      }
      const invalid = runWorkflowStep(validate, {
        IMAGE_TAG_SUFFIX: "-r2026082",
        RELEASE_SHA: "a".repeat(40),
        RELEASE_TAG: "v2026.7.1-2",
      });
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toContain("Invalid Docker image tag suffix");
    },
  );

  it.runIf(bashRunsWorkflowSteps)(
    "uses suffixed per-arch sources for Docker Hub manifests and VCR verification",
    () => {
      const workflow = readWorkflow(".github/workflows/docker-release.yml");
      const vcrWorkflow = readWorkflow(".github/workflows/vercel-container-registry-publish.yml");
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-docker-release-sources-"));
      try {
        const dockerCalls = path.join(root, "docker-calls");
        const nodeCalls = path.join(root, "node-calls");
        const outputPath = path.join(root, "github-output");
        const defaultDigest = `sha256:${"a".repeat(64)}`;
        const slimDigest = `sha256:${"b".repeat(64)}`;
        const browserDigest = `sha256:${"c".repeat(64)}`;
        writeFileSync(outputPath, "", "utf8");
        writeFileSync(
          path.join(root, "docker"),
          `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
case "$4" in
  *-browser) digest="${browserDigest}" ;;
  *-slim) digest="${slimDigest}" ;;
  *) digest="${defaultDigest}" ;;
esac
printf '{"digest":"%s"}\\n' "$digest"
`,
          "utf8",
        );
        writeFileSync(
          path.join(root, "node"),
          '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" >> "$NODE_CALLS"\n',
          "utf8",
        );
        chmodSync(path.join(root, "docker"), 0o755);
        chmodSync(path.join(root, "node"), 0o755);
        // Keep the fake tools together on PATH without shadowing jq.
        writeFileSync(path.join(root, "docker-calls"), "", "utf8");
        writeFileSync(nodeCalls, "", "utf8");

        const manifest = runWorkflowStep(
          requireStep(requireJob(workflow, "create-manifest"), "Create and push manifest"),
          {
            AMD64_BROWSER_DIGEST: "ghcr.io/openclaw/openclaw@sha256:3",
            AMD64_DIGEST: "ghcr.io/openclaw/openclaw@sha256:1",
            ARM64_BROWSER_DIGEST: "ghcr.io/openclaw/openclaw@sha256:4",
            ARM64_DIGEST: "ghcr.io/openclaw/openclaw@sha256:2",
            BROWSER_TAGS: "ghcr.io/openclaw/openclaw:2026.7.1-2-r20260820-browser",
            DOCKERHUB_BROWSER_TAGS: "docker.io/openclaw/openclaw:2026.7.1-2-r20260820-browser",
            DOCKERHUB_IMAGE: "docker.io/openclaw/openclaw",
            DOCKERHUB_TAGS:
              "docker.io/openclaw/openclaw:2026.7.1-2-r20260820\ndocker.io/openclaw/openclaw:2026.7.1-2-r20260820-slim",
            DOCKER_CALLS: dockerCalls,
            IMAGE_TAG_SUFFIX: "-r20260820",
            PATH: `${root}:${process.env.PATH ?? ""}`,
            SOURCE_REF: "refs/tags/v2026.7.1-2",
            TAGS: "ghcr.io/openclaw/openclaw:2026.7.1-2-r20260820\nghcr.io/openclaw/openclaw:2026.7.1-2-r20260820-slim",
          },
        );
        expect(manifest.status, manifest.stderr).toBe(0);
        const manifestCalls = readFileSync(dockerCalls, "utf8");
        expect(manifestCalls).toContain("docker.io/openclaw/openclaw:2026.7.1-2-r20260820-amd64");
        expect(manifestCalls).toContain(
          "docker.io/openclaw/openclaw:2026.7.1-2-r20260820-browser-arm64",
        );

        writeFileSync(dockerCalls, "", "utf8");
        const vcr = runWorkflowStep(
          requireStep(
            requireJob(workflow, "verify-attestations"),
            "Resolve and verify immutable VCR source refs",
          ),
          {
            DOCKER_CALLS: dockerCalls,
            GHCR_IMAGE: "ghcr.io/openclaw/openclaw",
            GITHUB_OUTPUT: outputPath,
            IMAGE_TAG_SUFFIX: "-r20260820",
            INCLUDE_BROWSER: "true",
            NODE_CALLS: nodeCalls,
            PATH: `${root}:${process.env.PATH ?? ""}`,
            VERSION: "2026.7.1-2",
          },
        );
        expect(vcr.status, vcr.stderr).toBe(0);
        const vcrCalls = readFileSync(dockerCalls, "utf8");
        expect(vcrCalls).toContain("ghcr.io/openclaw/openclaw:2026.7.1-2-r20260820 ");
        expect(vcrCalls).toContain("ghcr.io/openclaw/openclaw:2026.7.1-2-r20260820-slim");
        expect(vcrCalls).toContain("ghcr.io/openclaw/openclaw:2026.7.1-2-r20260820-browser");

        const sourceDigests = [
          `default=${defaultDigest}`,
          `slim=${slimDigest}`,
          `browser=${browserDigest}`,
        ];
        const githubOutput = readFileSync(outputPath, "utf8");
        expect(githubOutput.trim().split("\n")).toEqual(["value<<EOF", ...sourceDigests, "EOF"]);
        expect(githubOutput).not.toContain("ghcr.io");
        expect(githubOutput).not.toContain("openclaw/openclaw");

        const immutableRefs = sourceDigests.map((entry) =>
          entry.replace("=", "=ghcr.io/openclaw/openclaw@"),
        );
        expect(readFileSync(nodeCalls, "utf8").trim().split("\n")).toEqual([
          "scripts/verify-docker-attestations.mjs",
          "--platform",
          "linux/amd64",
          "--platform",
          "linux/arm64",
          ...immutableRefs.map((entry) => entry.split("=")[1]),
        ]);

        writeFileSync(nodeCalls, "", "utf8");
        const consumer = runWorkflowStep(
          requireStep(
            requireJob(vcrWorkflow, "publish"),
            "Copy and verify immutable release images",
          ),
          {
            INCLUDE_BROWSER: "true",
            NODE_CALLS: nodeCalls,
            PATH: `${root}:${process.env.PATH ?? ""}`,
            SOURCE_DIGESTS: sourceDigests.join("\n"),
            SOURCE_IMAGE: "ghcr.io/openclaw/openclaw",
            TARGET_IMAGE: "vcr.vercel.com/openclaw-foundation/openclaw/openclaw",
            VERSION: "2026.7.1-2",
          },
        );
        expect(consumer.status, consumer.stderr).toBe(0);
        expect(readFileSync(nodeCalls, "utf8").trim().split("\n")).toEqual([
          "scripts/vercel-container-registry-publish.mjs",
          "--version",
          "2026.7.1-2",
          ...immutableRefs.flatMap((ref) => ["--source-ref", ref]),
          "--target-image",
          "vcr.vercel.com/openclaw-foundation/openclaw/openclaw",
          "--include-browser",
        ]);

        const recoveryValidation = requireStep(
          requireJob(vcrWorkflow, "validate_recovery"),
          "Require a main-branch recovery dispatch",
        );
        const deniedRecovery = runWorkflowStep(recoveryValidation, {
          WORKFLOW_REF: "refs/heads/recovery-test",
        });
        expect(deniedRecovery.status).toBe(1);
        expect(deniedRecovery.stderr).toContain(
          "::error::Vercel registry recovery must be dispatched from main; got refs/heads/recovery-test.",
        );
        const mainRecovery = runWorkflowStep(recoveryValidation, {
          WORKFLOW_REF: "refs/heads/main",
        });
        expect(mainRecovery.status, mainRecovery.stderr).toBe(0);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("uses the digest-bound promotion path for releases and approved repairs", () => {
    const workflow = readWorkflow(".github/workflows/docker-channel-promote.yml");
    const releaseWorkflow = readWorkflow(".github/workflows/docker-release.yml");
    const createManifest = requireJob(releaseWorkflow, "create-manifest");
    const verifyAttestations = requireJob(releaseWorkflow, "verify-attestations");
    const resolve = requireJob(workflow, "resolve");
    const approve = requireJob(workflow, "approve");
    const promote = requireJob(workflow, "promote");

    expect(releaseWorkflow.concurrency).toEqual({
      group: "docker-release-publish",
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
      "${{ needs.resolve_release_policy.outputs.channel != 'beta' }}",
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
