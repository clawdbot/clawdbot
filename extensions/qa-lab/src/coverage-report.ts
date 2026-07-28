// Qa Lab plugin module implements coverage report behavior.
import { normalizeStringEntriesLower } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QA_SCENARIO_PACKS, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  readQaScorecardTaxonomyReport,
  type QaScorecardTaxonomyReport,
} from "./scorecard-taxonomy.js";

type QaCoverageScenarioSummary = {
  id: string;
  title: string;
  sourcePath: string;
  theme: string;
  surfaces: string[];
  risk: string;
};

type QaScenarioSearchMatch = QaCoverageScenarioSummary & {
  channel?: string;
  coverageIds: string[];
  docsRefs: string[];
  codeRefs: string[];
  executionKind: QaSeedScenarioWithSource["execution"]["kind"];
  executionPath?: string;
  runtimePairLane?: string;
  requiredProviderMode?: string;
  requiredProvider?: string;
  requiredModel?: string;
};

type QaCoverageIntent = "primary" | "secondary";

type QaCoverageScenarioReference = QaCoverageScenarioSummary & {
  intent: QaCoverageIntent;
};

type QaCoverageIdSummary = {
  id: string;
  scenarios: QaCoverageScenarioReference[];
};

type QaCoverageScenarioPackSummary = {
  id: string;
  title: string;
  scenarioIds: string[];
  coverageIds: string[];
  missingScenarioIds: string[];
};

type QaCoverageInventory = {
  scenarioCount: number;
  coverageIdCount: number;
  primaryCoverageIdCount: number;
  secondaryCoverageIdCount: number;
  coverageIds: QaCoverageIdSummary[];
  overlappingCoverage: QaCoverageIdSummary[];
  missingCoverage: QaCoverageScenarioSummary[];
  byTheme: Record<string, QaCoverageIdSummary[]>;
  bySurface: Record<string, QaCoverageIdSummary[]>;
  scenarioPacks: QaCoverageScenarioPackSummary[];
  scorecardTaxonomy: QaScorecardTaxonomyReport;
};

function assertUniqueQaScenarioIds(
  scenarios: readonly QaSeedScenarioWithSource[],
  nonYamlScenarios: readonly { id: string; sourcePath: string }[],
): void {
  const sourcePathsById = new Map<string, string[]>();
  for (const { id, sourcePath } of [...scenarios, ...nonYamlScenarios]) {
    const sourcePaths = sourcePathsById.get(id) ?? [];
    sourcePaths.push(sourcePath);
    sourcePathsById.set(id, sourcePaths);
  }
  const duplicates = [...sourcePathsById.entries()]
    .filter(([, sourcePaths]) => sourcePaths.length > 1)
    .toSorted(([left], [right]) => left.localeCompare(right));
  if (duplicates.length > 0) {
    const details = duplicates
      .map(([id, sourcePaths]) => `${id} (${sourcePaths.join(", ")})`)
      .join("; ");
    throw new Error(`duplicate qa scenario id(s): ${details}`);
  }
}

function scenarioTheme(sourcePath: string) {
  const parts = sourcePath.split("/");
  return parts[2] ?? "unknown";
}

function scenarioSurfaces(scenario: QaSeedScenarioWithSource) {
  return scenario.surfaces && scenario.surfaces.length > 0 ? scenario.surfaces : [scenario.surface];
}

function scenarioRisk(scenario: QaSeedScenarioWithSource) {
  return scenario.risk ?? scenario.riskLevel ?? "unassigned";
}

function summarizeScenario(scenario: QaSeedScenarioWithSource): QaCoverageScenarioSummary {
  return {
    id: scenario.id,
    title: scenario.title,
    sourcePath: scenario.sourcePath,
    theme: scenarioTheme(scenario.sourcePath),
    surfaces: scenarioSurfaces(scenario),
    risk: scenarioRisk(scenario),
  };
}

function normalizeSearchText(value: string) {
  return value.toLowerCase();
}

function tokenizeScenarioSearchQuery(query: string) {
  return normalizeStringEntriesLower(query.split(/\s+/u));
}

function scenarioSearchText(scenario: QaSeedScenarioWithSource) {
  const config = scenario.execution.config ?? {};
  return normalizeSearchText(
    [
      scenario.id,
      scenario.title,
      scenario.sourcePath,
      scenario.surface,
      ...(scenario.surfaces ?? []),
      scenario.category ?? "",
      scenario.runtimePairLane ?? "",
      scenario.risk ?? "",
      scenario.riskLevel ?? "",
      scenario.objective,
      ...scenario.successCriteria,
      ...(scenario.capabilities ?? []),
      ...(scenario.plugins ?? []),
      ...(scenario.docsRefs ?? []),
      ...(scenario.codeRefs ?? []),
      ...(scenario.coverage?.primary ?? []),
      ...(scenario.coverage?.secondary ?? []),
      ...Object.entries(config).flatMap(([key, value]) => [
        key,
        typeof value === "string" ? value : "",
      ]),
    ].join("\n"),
  );
}

function stringifyConfigValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function summarizeScenarioSearchMatch(scenario: QaSeedScenarioWithSource): QaScenarioSearchMatch {
  const config = scenario.execution.config ?? {};
  return {
    ...summarizeScenario(scenario),
    coverageIds: [
      ...(scenario.coverage?.primary ?? []),
      ...(scenario.coverage?.secondary ?? []),
    ].toSorted((left, right) => left.localeCompare(right)),
    docsRefs: [...(scenario.docsRefs ?? [])],
    codeRefs: [...(scenario.codeRefs ?? [])],
    executionKind: scenario.execution.kind,
    channel: scenario.execution.channel,
    ...(scenario.execution.kind !== "flow" ? { executionPath: scenario.execution.path } : {}),
    runtimePairLane: scenario.runtimePairLane,
    requiredProviderMode: stringifyConfigValue(config.requiredProviderMode),
    requiredProvider: stringifyConfigValue(config.requiredProvider),
    requiredModel: stringifyConfigValue(config.requiredModel),
  };
}

export function findQaScenarioMatches(
  scenarios: readonly QaSeedScenarioWithSource[],
  query: string,
) {
  const tokens = tokenizeScenarioSearchQuery(query);
  if (tokens.length === 0) {
    return [];
  }
  return scenarios
    .filter((scenario) => {
      const haystack = scenarioSearchText(scenario);
      return tokens.every((token) => haystack.includes(token));
    })
    .map(summarizeScenarioSearchMatch)
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function sortCoverageIds(coverageIds: readonly QaCoverageIdSummary[]) {
  return coverageIds.toSorted((left, right) => left.id.localeCompare(right.id));
}

function buildScenarioPackSummaries(
  scenarios: readonly QaSeedScenarioWithSource[],
): QaCoverageScenarioPackSummary[] {
  const scenariosById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return QA_SCENARIO_PACKS.map((pack) => {
    const coverageIds = new Set<string>();
    const missingScenarioIds: string[] = [];
    for (const scenarioId of pack.scenarioIds) {
      const scenario = scenariosById.get(scenarioId);
      if (!scenario) {
        missingScenarioIds.push(scenarioId);
        continue;
      }
      for (const coverageId of [
        ...(scenario.coverage?.primary ?? []),
        ...(scenario.coverage?.secondary ?? []),
      ]) {
        coverageIds.add(coverageId);
      }
    }
    return {
      id: pack.id,
      title: pack.title,
      scenarioIds: [...pack.scenarioIds],
      coverageIds: [...coverageIds].toSorted(),
      missingScenarioIds,
    };
  }).toSorted((left, right) => left.id.localeCompare(right.id));
}

export function buildQaCoverageInventory(
  scenarios: readonly QaSeedScenarioWithSource[],
  params?: { nonYamlScenarios?: readonly { id: string; sourcePath: string }[] },
): QaCoverageInventory {
  assertUniqueQaScenarioIds(scenarios, params?.nonYamlScenarios ?? []);
  const byCoverageId = new Map<string, QaCoverageIdSummary>();
  const primaryCoverageIds = new Set<string>();
  const secondaryCoverageIds = new Set<string>();
  const missingCoverage: QaCoverageScenarioSummary[] = [];

  const addFeatureCoverage = (
    scenario: QaSeedScenarioWithSource,
    coverageIds: readonly string[] | undefined,
    intent: QaCoverageIntent,
  ) => {
    const summary = summarizeScenario(scenario);
    for (const coverageId of coverageIds ?? []) {
      const coverage = byCoverageId.get(coverageId) ?? {
        id: coverageId,
        scenarios: [],
      };
      coverage.scenarios.push({ ...summary, intent });
      byCoverageId.set(coverageId, coverage);
      if (intent === "primary") {
        primaryCoverageIds.add(coverageId);
      } else {
        secondaryCoverageIds.add(coverageId);
      }
    }
  };

  for (const scenario of scenarios) {
    if (!scenario.coverage) {
      missingCoverage.push(summarizeScenario(scenario));
      continue;
    }
    addFeatureCoverage(scenario, scenario.coverage.primary, "primary");
    addFeatureCoverage(scenario, scenario.coverage.secondary, "secondary");
  }

  const coverageIds = sortCoverageIds([...byCoverageId.values()]);
  const overlappingCoverage = coverageIds.filter((coverage) => coverage.scenarios.length > 1);
  const byTheme: Record<string, QaCoverageIdSummary[]> = {};
  const bySurface: Record<string, QaCoverageIdSummary[]> = {};

  for (const coverage of coverageIds) {
    const themes = new Set(coverage.scenarios.map((scenario) => scenario.theme));
    for (const theme of themes) {
      byTheme[theme] ??= [];
      byTheme[theme].push({
        ...coverage,
        scenarios: coverage.scenarios.filter((scenario) => scenario.theme === theme),
      });
    }
    const surfaces = new Set(coverage.scenarios.flatMap((scenario) => scenario.surfaces));
    for (const surface of surfaces) {
      bySurface[surface] ??= [];
      bySurface[surface].push({
        ...coverage,
        scenarios: coverage.scenarios.filter((scenario) => scenario.surfaces.includes(surface)),
      });
    }
  }

  return {
    scenarioCount: scenarios.length,
    coverageIdCount: coverageIds.length,
    primaryCoverageIdCount: primaryCoverageIds.size,
    secondaryCoverageIdCount: secondaryCoverageIds.size,
    coverageIds,
    overlappingCoverage,
    missingCoverage,
    byTheme,
    bySurface,
    scenarioPacks: buildScenarioPackSummaries(scenarios),
    scorecardTaxonomy: readQaScorecardTaxonomyReport(scenarios),
  };
}

function pushCoverageIdLines(lines: string[], coverageIds: readonly QaCoverageIdSummary[]) {
  for (const coverage of sortCoverageIds(coverageIds)) {
    const scenarios = coverage.scenarios
      .map((scenario) => `${scenario.intent}: ${scenario.id} (${scenario.sourcePath})`)
      .join(", ");
    lines.push(`- ${coverage.id}: ${scenarios}`);
  }
}

function pushScenarioPackLines(lines: string[], packs: readonly QaCoverageScenarioPackSummary[]) {
  for (const pack of packs) {
    const missing =
      pack.missingScenarioIds.length > 0 ? pack.missingScenarioIds.join(", ") : "none";
    lines.push(
      `- ${pack.id} (${pack.title}): ${pack.scenarioIds.length} scenarios; coverage IDs: ${pack.coverageIds.join(", ")}; missing scenarios: ${missing}`,
    );
    lines.push(`  - scenarios: ${pack.scenarioIds.join(", ")}`);
  }
}

function pushScorecardTaxonomyLines(lines: string[], report: QaScorecardTaxonomyReport) {
  lines.push("## Scorecard Taxonomy", "");
  lines.push(`- Taxonomy: ${report.taxonomyPath ?? "missing"}`);
  lines.push(`- Categories: ${report.categoryCount}`);
  lines.push(`- Profiles: ${report.profileCount}`);
  lines.push(
    `- Inventoried taxonomy categories: ${report.inventoriedCategoryCount}/${report.requiredCategoryCount} (${report.categoryInventoryPercent}%)`,
  );
  lines.push(
    `- Inventoried taxonomy coverage IDs: ${report.inventoriedCoverageIdCount}/${report.requiredCoverageIdCount} (${report.coverageIdInventoryPercent}%)`,
  );
  lines.push(`- Inventory refs: ${report.inventoryRefCount}`);
  lines.push(`- Scenario coverage IDs: ${report.scenarioCoverageIdCount}`);
  lines.push(`- Unknown scenario coverage IDs: ${report.unknownCoverageIdCount}`);
  lines.push(`- Validation warnings: ${report.validationIssueCount}`, "");

  if (report.profiles.length > 0) {
    lines.push("### Profiles", "");
    for (const profile of report.profiles) {
      const categories = profile.categoryIds.length > 0 ? profile.categoryIds.join(", ") : "none";
      lines.push(`- ${profile.id}: ${profile.categoryIds.length} categories; ${categories}`);
    }
    lines.push("");
  }

  if (report.categories.length > 0) {
    lines.push("### Category Inventory", "");
    for (const category of report.categories) {
      const coverageIds =
        category.coverageIds.length > 0 ? category.coverageIds.join(", ") : "none";
      const inventoryRefs =
        category.inventoryRefs.length > 0
          ? category.inventoryRefs
              .map((ref) => {
                const target = ref.path ?? (ref.scenarioRefs.join("|") || "discovered");
                return `${ref.role}:${ref.kind}:${target} (${ref.coverageId})`;
              })
              .join(", ")
          : "none";
      const profiles = category.profiles.length > 0 ? category.profiles.join(", ") : "none";
      lines.push(
        `- ${category.id} (${category.taxonomySurfaceId} / ${category.taxonomyCategoryName}; ${category.inventoryStatus}): profiles: ${profiles}; coverage IDs: ${coverageIds}; inventory refs: ${inventoryRefs}`,
      );
    }
    lines.push("");
  }

  if (report.validationIssues.length > 0) {
    lines.push("### Validation Warnings", "");
    for (const issue of report.validationIssues) {
      const category = issue.categoryId ? `${issue.categoryId}: ` : "";
      lines.push(`- ${issue.code}: ${category}${issue.message}`);
    }
    lines.push("");
  }

  if (report.unknownCoverageIds.length > 0) {
    lines.push("### Unknown Scenario Coverage IDs", "");
    lines.push(report.unknownCoverageIds.join(", "));
    lines.push("");
  }
}

export function renderQaCoverageMarkdownReport(inventory: QaCoverageInventory): string {
  const lines: string[] = [
    "# QA Coverage Inventory",
    "",
    `- Scenarios: ${inventory.scenarioCount}`,
    `- Taxonomy coverage IDs: ${inventory.coverageIdCount}`,
    `- Primary coverage IDs: ${inventory.primaryCoverageIdCount}`,
    `- Secondary coverage IDs: ${inventory.secondaryCoverageIdCount}`,
    `- Overlapping coverage IDs: ${inventory.overlappingCoverage.length}`,
    `- Missing coverage metadata: ${inventory.missingCoverage.length}`,
    "",
  ];

  if (inventory.scenarioPacks.length > 0) {
    lines.push("## Scenario Packs", "");
    pushScenarioPackLines(lines, inventory.scenarioPacks);
    lines.push("");
  }

  lines.push("## By Theme", "");
  for (const theme of Object.keys(inventory.byTheme).toSorted()) {
    lines.push(`### ${theme}`, "");
    pushCoverageIdLines(lines, inventory.byTheme[theme] ?? []);
    lines.push("");
  }

  lines.push("## By Surface", "");
  for (const surface of Object.keys(inventory.bySurface).toSorted()) {
    lines.push(`### ${surface}`, "");
    pushCoverageIdLines(lines, inventory.bySurface[surface] ?? []);
    lines.push("");
  }

  pushScorecardTaxonomyLines(lines, inventory.scorecardTaxonomy);

  if (inventory.overlappingCoverage.length > 0) {
    lines.push("## Overlap", "");
    pushCoverageIdLines(lines, inventory.overlappingCoverage);
    lines.push("");
  }

  if (inventory.missingCoverage.length > 0) {
    lines.push("## Missing Metadata", "");
    for (const scenario of inventory.missingCoverage.toSorted((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      lines.push(`- ${scenario.id}: ${scenario.sourcePath}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatOptionalScenarioMetadata(match: QaScenarioSearchMatch) {
  const metadata = [
    match.runtimePairLane ? `runtimePairLane=${match.runtimePairLane}` : "",
    match.requiredProviderMode ? `providerMode=${match.requiredProviderMode}` : "",
    match.requiredProvider ? `provider=${match.requiredProvider}` : "",
    match.requiredModel ? `model=${match.requiredModel}` : "",
  ].filter(Boolean);
  return metadata.length > 0 ? metadata.join("; ") : "none";
}

function uniqueScenarioValues(values: (string | undefined)[]) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function formatSuiteCommand(matches: readonly QaScenarioSearchMatch[]) {
  const scenarioArgs = matches.map((match) => `--scenario ${match.id}`).join(" ");
  const channels = uniqueScenarioValues(matches.map((match) => match.channel));
  const [channel] = channels;
  const selectedDriver = channels.length === 1 && channel !== "qa-channel" ? "live" : undefined;
  const driverArg = selectedDriver ? ` --channel-driver ${selectedDriver}` : "";
  const channelArg = driverArg && channel ? ` --channel ${channel}` : "";
  return `pnpm openclaw qa suite${driverArg}${channelArg} ${scenarioArgs}`;
}

function scenarioMatchCommandGroups(matches: readonly QaScenarioSearchMatch[]) {
  const groups = new Map<string, QaScenarioSearchMatch[]>();
  for (const match of matches) {
    const key = JSON.stringify([match.executionKind, match.channel]);
    const group = groups.get(key) ?? [];
    group.push(match);
    groups.set(key, group);
  }
  const executionOrder: QaScenarioSearchMatch["executionKind"][] = [
    "flow",
    "script",
    "vitest",
    "playwright",
  ];
  return [...groups.values()]
    .toSorted(
      (left, right) =>
        executionOrder.indexOf(left[0]!.executionKind) -
        executionOrder.indexOf(right[0]!.executionKind),
    )
    .map((group) => ({ executionKind: group[0]!.executionKind, matches: group }));
}

export function renderQaScenarioMatchesMarkdownReport(params: {
  query: string;
  matches: readonly QaScenarioSearchMatch[];
}) {
  const commandGroups = scenarioMatchCommandGroups(params.matches);
  const lines = [
    "# QA Scenario Matches",
    "",
    `- Query: ${params.query}`,
    `- Matches: ${params.matches.length}`,
  ];

  if (commandGroups.length === 1) {
    const group = commandGroups[0];
    if (group) {
      lines.push(`- Suite command: \`${formatSuiteCommand(group.matches)}\``);
    }
  } else if (commandGroups.length > 1) {
    lines.push("- Suite commands:");
    for (const group of commandGroups) {
      lines.push(`  - ${group.executionKind}: \`${formatSuiteCommand(group.matches)}\``);
    }
  }
  lines.push("");

  if (params.matches.length === 0) {
    lines.push("No QA scenarios matched the query.", "");
    return lines.join("\n");
  }

  for (const match of params.matches) {
    lines.push(`- ${match.id}: ${match.title}`);
    lines.push(`  - source: ${match.sourcePath}`);
    lines.push(`  - surface: ${match.surfaces.join(", ")}`);
    lines.push(
      match.executionKind === "flow"
        ? "  - execution: flow"
        : `  - execution: ${match.executionKind} ${match.executionPath ?? "missing"}`,
    );
    lines.push(`  - coverage IDs: ${match.coverageIds.join(", ") || "none"}`);
    lines.push(`  - live requirements: ${formatOptionalScenarioMetadata(match)}`);
    if (match.codeRefs.length > 0) {
      lines.push(`  - code refs: ${match.codeRefs.join(", ")}`);
    }
    if (match.docsRefs.length > 0) {
      lines.push(`  - docs refs: ${match.docsRefs.join(", ")}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
