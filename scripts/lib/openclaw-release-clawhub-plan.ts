// OpenClaw release ClawHub plan script supports release workflow routing.
import { resolve } from "node:path";
import {
  collectPluginClawHubReleasePlan,
  type PublishablePluginPackage,
} from "./plugin-clawhub-release.ts";
import {
  parsePluginReleaseSelection,
  parsePluginReleaseSelectionMode,
  type PluginReleaseSelectionMode,
} from "./plugin-npm-release.ts";

type ClawHubPlanPackage = Pick<PublishablePluginPackage, "packageName">;

type ClawHubDispatchInputs = Record<string, string>;

type ClawHubDispatchTarget = {
  workflow: "plugin-clawhub-release.yml" | "plugin-clawhub-new.yml";
  ref: string;
  shouldDispatch: boolean;
  packages: string[];
  inputs: ClawHubDispatchInputs;
};

type OpenClawReleaseClawHubPlanArgs = {
  bootstrapWorkflowRef: string;
  bootstrapWorkflowSha: string;
  releaseTag: string;
  releaseSha: string;
  releasePublishBranch: string;
  releasePublishRunAttempt: string;
  releasePublishRunId: string;
  pluginPublishScope: PluginReleaseSelectionMode;
  plugins: string[];
};

type OpenClawReleaseClawHubPlan = {
  bootstrapWorkflowSha: string;
  clawHubWorkflowRef: string;
  releasePublishBranch: string;
  normal: ClawHubDispatchTarget;
  bootstrap: ClawHubDispatchTarget;
  summary: {
    normalCount: number;
    bootstrapCount: number;
    missingTrustedPublisherCount: number;
    normalPlugins: string;
    bootstrapPlugins: string;
    missingTrustedPlugins: string;
  };
  verifier: {
    clawHubWorkflowRef: string;
  };
};

type OpenClawReleaseClawHubRuntimeStateArgs = {
  repository: string;
  waitForClawHub: boolean;
  forceSkipClawHub: boolean;
  normalRunId?: string;
  bootstrapRunId?: string;
  bootstrapCompleted: boolean;
};

type OpenClawReleaseClawHubRuntimeState = {
  verifierArgs: string[];
  proofLines: {
    normal: string;
    bootstrap: string;
  };
};

function requireArg(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function packageNames(packages: readonly ClawHubPlanPackage[]): string[] {
  return packages.map((plugin) => plugin.packageName);
}

function joinPackageNames(packages: readonly string[]): string {
  return packages.join(",");
}

function optionalArg(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireCommitSha(value: string | undefined, label: string): string {
  const sha = requireArg(value, label);
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error(`${label} must be a full 40-character lowercase commit SHA.`);
  }
  return sha;
}

function requireBootstrapWorkflowRef(value: string | undefined): string {
  const ref = requireArg(value, "--bootstrap-workflow-ref");
  if (ref !== "main" && !/^release-publish\/[a-f0-9]{12}-[1-9][0-9]*$/u.test(ref)) {
    throw new Error("--bootstrap-workflow-ref must be main or a SHA-pinned release-publish tag.");
  }
  return ref;
}

function requirePositiveInteger(value: string | undefined, label: string): string {
  const result = requireArg(value, label);
  if (!/^[1-9][0-9]*$/u.test(result)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return result;
}

function runUrl(repository: string, runId: string): string {
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

function assertNoPackageOverlap(
  normalPackages: readonly string[],
  bootstrapPackages: readonly string[],
) {
  const normalPackageSet = new Set(normalPackages);
  const overlap = bootstrapPackages.filter((packageName) => normalPackageSet.has(packageName));
  if (overlap.length > 0) {
    throw new Error(
      `ClawHub release plan routed package(s) to both normal and bootstrap workflows: ${overlap.join(", ")}.`,
    );
  }
}

function createDispatchTarget(params: {
  workflow: ClawHubDispatchTarget["workflow"];
  ref: string;
  packages: readonly string[];
  releasePublishRunId: string;
  releasePublishBranch: string;
  includePublishScope: boolean;
  bootstrapWorkflowSha?: string;
  releaseTag?: string;
  releasePublishRunAttempt?: string;
  targetRef?: string;
}): ClawHubDispatchTarget {
  if (params.packages.length === 0) {
    return {
      workflow: params.workflow,
      ref: params.ref,
      shouldDispatch: false,
      packages: [],
      inputs: {},
    };
  }

  const plugins = joinPackageNames(params.packages);
  return {
    workflow: params.workflow,
    ref: params.ref,
    shouldDispatch: true,
    packages: [...params.packages],
    inputs: {
      ...(params.includePublishScope ? { publish_scope: "selected" } : {}),
      ...(params.targetRef ? { ref: params.targetRef } : {}),
      ...(params.bootstrapWorkflowSha
        ? { bootstrap_workflow_sha: params.bootstrapWorkflowSha }
        : {}),
      ...(params.releaseTag ? { release_tag: params.releaseTag } : {}),
      ...(params.releasePublishRunAttempt
        ? { release_publish_run_attempt: params.releasePublishRunAttempt }
        : {}),
      plugins,
      release_publish_run_id: params.releasePublishRunId,
      release_publish_branch: params.releasePublishBranch,
    },
  };
}

export function buildOpenClawReleaseClawHubRuntimeState(
  args: OpenClawReleaseClawHubRuntimeStateArgs,
): OpenClawReleaseClawHubRuntimeState {
  const repository = requireArg(args.repository, "repository");
  const normalRunId = optionalArg(args.normalRunId);
  const bootstrapRunId = optionalArg(args.bootstrapRunId);

  const shouldIncludeNormalRun =
    !args.forceSkipClawHub && normalRunId !== undefined && args.waitForClawHub;
  const shouldIncludeBootstrapRun =
    !args.forceSkipClawHub && bootstrapRunId !== undefined && args.bootstrapCompleted;
  const shouldVerifyClawHubPackages =
    bootstrapRunId !== undefined &&
    args.bootstrapCompleted &&
    (normalRunId === undefined || args.waitForClawHub);
  const shouldSkipClawHubPackages =
    args.forceSkipClawHub || !(shouldIncludeNormalRun || shouldVerifyClawHubPackages);

  const verifierArgs = shouldSkipClawHubPackages ? ["--skip-clawhub"] : [];
  if (shouldIncludeNormalRun) {
    verifierArgs.push("--plugin-clawhub-run", normalRunId);
  }
  if (shouldIncludeBootstrapRun) {
    verifierArgs.push("--plugin-clawhub-bootstrap-run", bootstrapRunId);
  }

  let normalProofLine = "- plugin ClawHub publish: no normal OIDC candidates";
  if (normalRunId !== undefined && args.waitForClawHub) {
    normalProofLine = `- plugin ClawHub publish: ${runUrl(repository, normalRunId)}`;
  } else if (normalRunId !== undefined) {
    normalProofLine = `- plugin ClawHub publish: dispatched separately, not awaited by this proof: ${runUrl(repository, normalRunId)}`;
  }

  let bootstrapProofLine = "- plugin ClawHub bootstrap: not needed";
  if (bootstrapRunId !== undefined && (args.bootstrapCompleted || args.waitForClawHub)) {
    bootstrapProofLine = `- plugin ClawHub bootstrap: ${runUrl(repository, bootstrapRunId)}`;
  } else if (bootstrapRunId !== undefined) {
    bootstrapProofLine = `- plugin ClawHub bootstrap: dispatched separately, not awaited by this proof: ${runUrl(repository, bootstrapRunId)}`;
  }

  return {
    verifierArgs,
    proofLines: {
      normal: normalProofLine,
      bootstrap: bootstrapProofLine,
    },
  };
}

export function parseOpenClawReleaseClawHubPlanArgs(
  argv: string[],
): OpenClawReleaseClawHubPlanArgs {
  const values = [...argv];
  if (values[0] === "--") {
    values.shift();
  }

  let releaseTag: string | undefined;
  let releaseSha: string | undefined;
  let bootstrapWorkflowRef: string | undefined;
  let bootstrapWorkflowSha: string | undefined;
  let releasePublishBranch: string | undefined;
  let releasePublishRunAttempt: string | undefined;
  let releasePublishRunId: string | undefined;
  let pluginPublishScope: PluginReleaseSelectionMode | undefined;
  let plugins: string[] = [];
  let pluginsFlagProvided = false;

  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    const next = () => {
      const value = values[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--bootstrap-workflow-ref":
        bootstrapWorkflowRef = next();
        break;
      case "--bootstrap-workflow-sha":
        bootstrapWorkflowSha = next();
        break;
      case "--release-tag":
        releaseTag = next();
        break;
      case "--release-sha":
        releaseSha = next();
        break;
      case "--release-publish-branch":
        releasePublishBranch = next();
        break;
      case "--release-publish-run-attempt":
        releasePublishRunAttempt = next();
        break;
      case "--release-publish-run-id":
        releasePublishRunId = next();
        break;
      case "--plugin-publish-scope":
        pluginPublishScope = parsePluginReleaseSelectionMode(next());
        break;
      case "--plugins":
        plugins = parsePluginReleaseSelection(next());
        pluginsFlagProvided = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const resolvedPluginPublishScope = pluginPublishScope ?? "all-publishable";
  if (pluginsFlagProvided && plugins.length === 0) {
    throw new Error("--plugins must include at least one package name.");
  }
  if (resolvedPluginPublishScope === "selected" && !pluginsFlagProvided) {
    throw new Error("plugin-publish-scope=selected requires --plugins.");
  }
  if (resolvedPluginPublishScope === "all-publishable" && pluginsFlagProvided) {
    throw new Error("plugin-publish-scope=all-publishable must not be combined with --plugins.");
  }

  return {
    bootstrapWorkflowRef: requireBootstrapWorkflowRef(bootstrapWorkflowRef),
    bootstrapWorkflowSha: requireCommitSha(bootstrapWorkflowSha, "--bootstrap-workflow-sha"),
    releaseTag: requireArg(releaseTag, "--release-tag"),
    releaseSha: requireCommitSha(releaseSha, "--release-sha"),
    releasePublishBranch: requireArg(releasePublishBranch, "--release-publish-branch"),
    releasePublishRunAttempt: requirePositiveInteger(
      releasePublishRunAttempt,
      "--release-publish-run-attempt",
    ),
    releasePublishRunId: requireArg(releasePublishRunId, "--release-publish-run-id"),
    pluginPublishScope: resolvedPluginPublishScope,
    plugins,
  };
}

export async function buildOpenClawReleaseClawHubPlan(
  args: OpenClawReleaseClawHubPlanArgs,
  options: {
    rootDir?: string;
    fetchImpl?: typeof fetch;
    registryBaseUrl?: string;
  } = {},
): Promise<OpenClawReleaseClawHubPlan> {
  const bootstrapWorkflowRef = requireBootstrapWorkflowRef(args.bootstrapWorkflowRef);
  const bootstrapWorkflowSha = requireCommitSha(args.bootstrapWorkflowSha, "bootstrapWorkflowSha");
  const releaseTag = requireArg(args.releaseTag, "releaseTag");
  const releaseSha = requireCommitSha(args.releaseSha, "releaseSha");
  const releasePublishBranch = requireArg(args.releasePublishBranch, "releasePublishBranch");
  const releasePublishRunAttempt = requirePositiveInteger(
    args.releasePublishRunAttempt,
    "releasePublishRunAttempt",
  );
  const releasePublishRunId = requireArg(args.releasePublishRunId, "releasePublishRunId");
  const plan = await collectPluginClawHubReleasePlan({
    rootDir: options.rootDir ?? resolve("."),
    selection: args.plugins,
    selectionMode: args.pluginPublishScope,
    fetchImpl: options.fetchImpl,
    registryBaseUrl: options.registryBaseUrl,
  });

  const normalPackages = packageNames(plan.candidates);
  const bootstrapPackages = [
    ...packageNames(plan.bootstrapCandidates),
    ...packageNames(plan.missingTrustedPublisher),
  ];
  const missingTrustedPlugins = packageNames(plan.missingTrustedPublisher);
  assertNoPackageOverlap(normalPackages, bootstrapPackages);

  return {
    bootstrapWorkflowSha,
    clawHubWorkflowRef: releaseTag,
    releasePublishBranch,
    normal: createDispatchTarget({
      workflow: "plugin-clawhub-release.yml",
      ref: releaseTag,
      packages: normalPackages,
      releasePublishRunId,
      releasePublishBranch,
      includePublishScope: true,
    }),
    bootstrap: createDispatchTarget({
      workflow: "plugin-clawhub-new.yml",
      ref: bootstrapWorkflowRef,
      packages: bootstrapPackages,
      releasePublishRunId,
      releasePublishBranch,
      includePublishScope: false,
      bootstrapWorkflowSha,
      releaseTag,
      releasePublishRunAttempt,
      targetRef: releaseSha,
    }),
    summary: {
      normalCount: normalPackages.length,
      bootstrapCount: bootstrapPackages.length,
      missingTrustedPublisherCount: missingTrustedPlugins.length,
      normalPlugins: joinPackageNames(normalPackages),
      bootstrapPlugins: joinPackageNames(bootstrapPackages),
      missingTrustedPlugins: joinPackageNames(missingTrustedPlugins),
    },
    verifier: {
      clawHubWorkflowRef: releaseTag,
    },
  };
}
