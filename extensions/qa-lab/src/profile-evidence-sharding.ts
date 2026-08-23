// QA Lab owns bounded profile partitioning and canonical shard evidence aggregation.
import fs from "node:fs/promises";
import path from "node:path";
import { isCrablineServerChannel, OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/file-access-runtime";
import { extractErrorCode } from "openclaw/plugin-sdk/security-runtime";
import {
  mergeQaEvidenceSummaries,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { listLiveTransportQaAdapterFactories } from "./live-transports/cli.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./model-selection.js";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import {
  resolveQaRunProfileExecutionSelection,
  resolveQaRunProfileMembership,
} from "./profile-planning.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "./providers/index.js";
import {
  qaTransportSupportsModuleFlows,
  type QaTransportAdapterFactory,
} from "./qa-transport-registry.js";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScenarioExecutionCell } from "./scenario-lane.js";
import { attachQaProfileScorecardEvidenceToFile } from "./scorecard-evidence.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

const DEFAULT_QA_PROFILE_SHARD_COUNT = 8;
const MAX_QA_PROFILE_SHARD_COUNT = 32;

type QaProfileEvidenceShard = {
  id: string;
  categoryIds: string[];
  estimatedCost: number;
  scenarioIds: string[];
};

type QaProfileEvidenceShardPlan = {
  channelDriver: "qa-channel" | "crabline" | "live";
  profile: string;
  shards: QaProfileEvidenceShard[];
};

function resolveQaProfileEvidenceSelection(profile: string) {
  const scenarioPack = readQaScenarioPack();
  const scorecardReport = readQaScorecardTaxonomyReport(scenarioPack.scenarios);
  const membership = resolveQaRunProfileMembership(
    { profile },
    { scenarios: scenarioPack.scenarios, scorecardReport },
  );
  if (membership.categories.length === 0) {
    throw new Error(`QA profile ${profile} does not select any taxonomy categories.`);
  }
  const providerMode = normalizeQaProviderMode(
    profile === "smoke-ci" ? "mock-openai" : DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const primaryModel = defaultQaModelForMode(providerMode);
  const liveAdapterFactories =
    membership.profile.channelDriver === "live" ? listLiveTransportQaAdapterFactories() : undefined;
  const executionSelection = resolveQaRunProfileExecutionSelection({
    scenarios: membership.selectedScenarios,
    providerMode,
    primaryModel,
    channelDriver: membership.profile.channelDriver,
    defaultChannel:
      membership.profile.channelDriver === "crabline"
        ? OPENCLAW_CRABLINE_DEFAULT_CHANNEL
        : undefined,
    supportsChannel:
      membership.profile.channelDriver === "crabline" ? isCrablineServerChannel : undefined,
    resolveModuleFlowSupport:
      membership.profile.channelDriver === "live"
        ? (channel) =>
            channel
              ? qaTransportSupportsModuleFlows(liveAdapterFactories, {
                  channelId: channel,
                  driver: "live",
                })
              : false
        : undefined,
  });
  if (executionSelection.selectedScenarios.length === 0) {
    throw new Error(`QA profile ${profile} does not select any executable scenarios.`);
  }
  return { executionSelection, liveAdapterFactories, membership };
}

function estimateQaProfileScenarioCost(scenario: QaSeedScenarioWithSource) {
  if (scenario.execution.kind === "script") {
    const timeoutMinutes = Math.ceil((scenario.execution.timeoutMs ?? 0) / 60_000);
    return Math.max(8, Math.min(30, timeoutMinutes));
  }
  if (scenario.execution.kind === "playwright") {
    return 6;
  }
  return scenario.execution.kind === "flow" && scenario.execution.isolationReason ? 4 : 1;
}

function selectQaProfileScenarioCategory(
  scenario: QaSeedScenarioWithSource,
  categoryIds: readonly string[],
) {
  const declaredCategory = scenario.category?.trim();
  if (declaredCategory && categoryIds.includes(declaredCategory)) {
    return declaredCategory;
  }
  return categoryIds[0] ?? `uncategorized.${scenario.execution.kind}`;
}

function listQaProfileScenarioLiveChannels(scenario: QaSeedScenarioWithSource) {
  return (scenario.execution.channels ?? []).filter((candidate) => candidate !== "qa-channel");
}

function listExclusiveQaProfileChannels(
  scenario: QaSeedScenarioWithSource,
  factories: readonly QaTransportAdapterFactory[] | undefined,
) {
  return listQaProfileScenarioLiveChannels(scenario).filter((channelId) => {
    const factory = factories?.find((candidate) =>
      candidate.matches({ channelId, driver: "live" }),
    );
    return factory !== undefined && factory.isolatesInstances !== true;
  });
}

type QaProfileScenarioGroup = {
  categoryIds: Set<string>;
  key: string;
  scenarios: QaSeedScenarioWithSource[];
};

function buildQaProfileScenarioGroups(params: {
  categoriesByScenarioRef: ReadonlyMap<string, readonly string[]>;
  factories: readonly QaTransportAdapterFactory[] | undefined;
  scenarios: readonly QaSeedScenarioWithSource[];
}) {
  const affinityGroups: Array<{ channels: Set<string>; scenarios: QaSeedScenarioWithSource[] }> =
    [];
  const categoryGroups = new Map<string, QaSeedScenarioWithSource[]>();
  for (const scenario of params.scenarios) {
    const exclusiveChannels = listExclusiveQaProfileChannels(scenario, params.factories);
    if (exclusiveChannels.length === 0) {
      const categoryId = selectQaProfileScenarioCategory(
        scenario,
        params.categoriesByScenarioRef.get(scenario.sourcePath) ?? [],
      );
      const scenarios = categoryGroups.get(categoryId) ?? [];
      scenarios.push(scenario);
      categoryGroups.set(categoryId, scenarios);
      continue;
    }
    const connected = affinityGroups.filter((group) =>
      exclusiveChannels.some((channelId) => group.channels.has(channelId)),
    );
    const target = connected[0] ?? { channels: new Set<string>(), scenarios: [] };
    if (connected.length === 0) {
      affinityGroups.push(target);
    } else {
      for (const merged of connected.slice(1)) {
        merged.channels.forEach((channelId) => target.channels.add(channelId));
        target.scenarios.push(...merged.scenarios);
        affinityGroups.splice(affinityGroups.indexOf(merged), 1);
      }
    }
    exclusiveChannels.forEach((channelId) => target.channels.add(channelId));
    target.scenarios.push(scenario);
  }

  const buildGroup = (
    key: string,
    scenarios: QaSeedScenarioWithSource[],
  ): QaProfileScenarioGroup => ({
    categoryIds: new Set(
      scenarios.map((scenario) =>
        selectQaProfileScenarioCategory(
          scenario,
          params.categoriesByScenarioRef.get(scenario.sourcePath) ?? [],
        ),
      ),
    ),
    key,
    scenarios,
  });
  return [
    ...affinityGroups.map((group) =>
      buildGroup(`affinity:${[...group.channels].toSorted().join("+")}`, group.scenarios),
    ),
    ...[...categoryGroups].map(([categoryId, scenarios]) =>
      buildGroup(`category:${categoryId}`, scenarios),
    ),
  ];
}

export function createQaProfileEvidenceShardPlan(
  profile: string,
  shardCount = DEFAULT_QA_PROFILE_SHARD_COUNT,
): QaProfileEvidenceShardPlan {
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > MAX_QA_PROFILE_SHARD_COUNT) {
    throw new Error(`QA profile shard count must be between 1 and ${MAX_QA_PROFILE_SHARD_COUNT}.`);
  }
  const { executionSelection, liveAdapterFactories, membership } =
    resolveQaProfileEvidenceSelection(profile);
  const categoryIdsByScenarioRef = new Map<string, string[]>();
  for (const category of membership.categories) {
    for (const scenarioRef of category.scenarioRefs) {
      const categoryIds = categoryIdsByScenarioRef.get(scenarioRef) ?? [];
      categoryIds.push(category.id);
      categoryIdsByScenarioRef.set(scenarioRef, categoryIds);
    }
  }
  const scenarioGroups = buildQaProfileScenarioGroups({
    categoriesByScenarioRef: new Map(
      [...categoryIdsByScenarioRef].map(([scenarioRef, categoryIds]) => [
        scenarioRef,
        categoryIds.toSorted(),
      ]),
    ),
    factories: liveAdapterFactories,
    scenarios: executionSelection.selectedScenarios,
  });
  const resolvedShardCount = Math.min(shardCount, scenarioGroups.length);
  const shards: QaProfileEvidenceShard[] = Array.from(
    { length: resolvedShardCount },
    (_, index) => ({
      id: `shard-${String(index + 1).padStart(2, "0")}`,
      categoryIds: [],
      estimatedCost: 0,
      scenarioIds: [],
    }),
  );
  const groupsByDescendingCost = scenarioGroups
    .map((group) => ({
      categoryIds: group.categoryIds,
      estimatedCost: group.scenarios.reduce(
        (cost, scenario) => cost + estimateQaProfileScenarioCost(scenario),
        0,
      ),
      key: group.key,
      scenarios: group.scenarios,
    }))
    .toSorted(
      (left, right) =>
        right.estimatedCost - left.estimatedCost || left.key.localeCompare(right.key),
    );
  for (const group of groupsByDescendingCost) {
    const shard = shards.reduce((lightest, candidate) =>
      candidate.estimatedCost < lightest.estimatedCost ? candidate : lightest,
    );
    shard.categoryIds.push(...group.categoryIds);
    shard.estimatedCost += group.estimatedCost;
    shard.scenarioIds.push(...group.scenarios.map((scenario) => scenario.id));
  }
  for (const shard of shards) {
    shard.categoryIds = [...new Set(shard.categoryIds)].toSorted();
    shard.scenarioIds.sort();
  }
  return {
    channelDriver: membership.profile.channelDriver,
    profile: membership.profile.id,
    shards,
  };
}

function shardSignature(scenarioIds: readonly string[]) {
  return scenarioIds.toSorted().join("\u0000");
}

function toPublishedPath(filePath: string) {
  return filePath.split(path.sep).join("/");
}

async function resolveChildArtifactPath(params: {
  artifactPath: string;
  evidencePath: string;
  payloadRoot: string;
  shardId: string;
}) {
  const normalized = params.artifactPath.trim().replaceAll("\\", "/");
  if (normalized.includes("\0")) {
    throw new Error(`QA shard evidence ${params.evidencePath} declares an invalid artifact path.`);
  }
  const repoRootPrefix = "<repo-root>/";
  const explicitRepoRoot = normalized.startsWith(repoRootPrefix);
  const explicitArtifactsRoot = normalized.startsWith(".artifacts/");
  const sourcePath = explicitRepoRoot ? normalized.slice(repoRootPrefix.length) : normalized;
  if (path.win32.isAbsolute(sourcePath) && path.sep !== "\\") {
    throw new Error(
      `QA shard artifact ${JSON.stringify(params.artifactPath)} escapes downloaded payload ${params.payloadRoot}.`,
    );
  }
  const resolvePayloadFile = async (relativePath: string) => {
    const candidate = path.resolve(params.payloadRoot, relativePath);
    if (!isPathInside(params.payloadRoot, candidate)) {
      throw new Error(
        `QA shard artifact ${JSON.stringify(params.artifactPath)} escapes downloaded payload ${params.payloadRoot}.`,
      );
    }
    const realCandidate = await fs.realpath(candidate).catch(() => undefined);
    if (!realCandidate) {
      return undefined;
    }
    if (!isPathInside(params.payloadRoot, realCandidate)) {
      throw new Error(
        `QA shard artifact ${JSON.stringify(params.artifactPath)} escapes downloaded payload ${params.payloadRoot}.`,
      );
    }
    if (realCandidate !== candidate) {
      throw new Error(
        `QA shard artifact ${JSON.stringify(params.artifactPath)} traverses a symbolic link and cannot be preserved in the aggregate.`,
      );
    }
    if ((await fs.stat(realCandidate)).isFile()) {
      return toPublishedPath(path.relative(params.payloadRoot, candidate));
    }
    return undefined;
  };
  const directPath = await resolvePayloadFile(sourcePath);
  if (directPath) {
    return directPath;
  }
  if (explicitRepoRoot || explicitArtifactsRoot) {
    const shardMarker = `/${params.shardId}/`;
    const markerIndex = sourcePath.lastIndexOf(shardMarker);
    if (markerIndex >= 0) {
      const rebasedPath = await resolvePayloadFile(
        sourcePath.slice(markerIndex + shardMarker.length),
      );
      if (rebasedPath) {
        return rebasedPath;
      }
    }
  }
  throw new Error(
    `QA shard artifact ${JSON.stringify(params.artifactPath)} declared by ${params.evidencePath} was not found within downloaded payload ${params.payloadRoot}.`,
  );
}

async function assertShardDestinationAvailable(destination: string) {
  try {
    await fs.lstat(destination);
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`QA shard aggregate destination already exists: ${destination}`);
}

export async function aggregateQaProfileEvidenceShards(params: {
  evidencePaths: readonly string[];
  generatedAt: string;
  outputPath: string;
  profile: string;
  shardCount?: number;
}) {
  const outputPath = path.resolve(params.outputPath);
  const aggregateRoot = path.dirname(outputPath);
  const canonicalAggregateRoot = await canonicalPathFromExistingAncestor(aggregateRoot);
  const shardPlan = createQaProfileEvidenceShardPlan(params.profile, params.shardCount);
  if (params.evidencePaths.length !== shardPlan.shards.length) {
    throw new Error(
      `QA profile ${params.profile} requires ${shardPlan.shards.length} shard evidence files, received ${params.evidencePaths.length}.`,
    );
  }
  const expectedShardBySignature = new Map(
    shardPlan.shards.map((shard) => [shardSignature(shard.scenarioIds), shard]),
  );
  const seenShardIds = new Set<string>();
  const summaries: QaEvidenceSummaryJson[] = [];
  const expectedCells: QaScenarioExecutionCell[] = [];
  const observedCells: QaScenarioExecutionCell[] = [];
  const payloads: Array<{ destination: string; source: string }> = [];
  for (const evidencePath of params.evidencePaths) {
    const payloadRoot = await fs.realpath(path.dirname(path.resolve(evidencePath)));
    const resolvedEvidencePath = await fs.realpath(path.resolve(evidencePath));
    if (!isPathInside(payloadRoot, resolvedEvidencePath)) {
      throw new Error(`QA shard evidence ${evidencePath} escapes its downloaded payload.`);
    }
    const summary = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(resolvedEvidencePath, "utf8")),
    );
    if (summary.profile !== params.profile || !summary.profilePlan) {
      throw new Error(
        `QA shard evidence ${evidencePath} does not attest profile ${params.profile}.`,
      );
    }
    const childPlan = qaProfileEvidencePlan.attest(summary.profilePlan).plan;
    const shard = expectedShardBySignature.get(shardSignature(childPlan.selected));
    if (!shard || seenShardIds.has(shard.id)) {
      throw new Error(`QA shard evidence ${evidencePath} does not match one unique planned shard.`);
    }
    if (shardSignature(childPlan.membership) !== shardSignature(shard.scenarioIds)) {
      throw new Error(`QA shard evidence ${evidencePath} has unexpected profile membership.`);
    }
    const destination = path.join(aggregateRoot, "shards", shard.id);
    const canonicalDestination = await canonicalPathFromExistingAncestor(destination);
    if (!isPathInside(canonicalAggregateRoot, canonicalDestination)) {
      throw new Error(
        `QA shard aggregate destination ${destination} escapes aggregate root ${aggregateRoot}.`,
      );
    }
    if (isPathInside(payloadRoot, canonicalDestination)) {
      throw new Error(
        `QA shard aggregate destination ${destination} must not be inside downloaded payload ${payloadRoot}.`,
      );
    }
    await assertShardDestinationAvailable(destination);

    const rebasedSummary = structuredClone(summary);
    const resolvedArtifacts = new Map<string, string>();
    for (const entry of rebasedSummary.entries) {
      for (const artifact of entry.execution?.artifacts ?? []) {
        let relativePath = resolvedArtifacts.get(artifact.path);
        if (!relativePath) {
          relativePath = await resolveChildArtifactPath({
            artifactPath: artifact.path,
            evidencePath,
            payloadRoot,
            shardId: shard.id,
          });
          resolvedArtifacts.set(artifact.path, relativePath);
        }
        artifact.path = `shards/${shard.id}/${relativePath}`;
      }
    }
    seenShardIds.add(shard.id);
    summaries.push(rebasedSummary);
    payloads.push({ destination, source: payloadRoot });
    expectedCells.push(...childPlan.expectedCells);
    observedCells.push(...childPlan.observedCells);
  }

  await fs.mkdir(path.join(aggregateRoot, "shards"), { recursive: true });
  for (const payload of payloads) {
    await fs.cp(payload.source, payload.destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }

  const { executionSelection, membership } = resolveQaProfileEvidenceSelection(params.profile);
  const profilePlan = qaProfileEvidencePlan.build({
    profile: membership.profile.id,
    membershipScenarios: membership.selectedScenarios,
    selectedScenarios: executionSelection.selectedScenarios,
    excludedScenarios: executionSelection.excludedScenarios,
    expectedCells,
    observedCells,
  });
  const merged = mergeQaEvidenceSummaries({
    evidenceSummaries: summaries,
    generatedAt: params.generatedAt,
  });
  await fs.writeFile(outputPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await attachQaProfileScorecardEvidenceToFile({
    evidencePath: outputPath,
    evidenceMode: merged.evidenceMode,
    profile: membership.profile.id,
    profilePlan,
    filters: {},
    categories: membership.categories,
  });
  return validateQaEvidenceSummaryJson(JSON.parse(await fs.readFile(outputPath, "utf8")));
}
