import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

type QaCoverageScenarioSummary = {
  id: string;
  title: string;
  sourcePath: string;
  theme: string;
  surfaces: string[];
  risk: string;
};

type QaCoverageIntent = "primary" | "secondary";

type QaCoverageScenarioReference = QaCoverageScenarioSummary & {
  intent: QaCoverageIntent;
};

type QaCoverageFeatureSummary = {
  id: string;
  scenarios: QaCoverageScenarioReference[];
};

type QaCoverageInventory = {
  scenarioCount: number;
  coverageIdCount: number;
  primaryCoverageIdCount: number;
  secondaryCoverageIdCount: number;
  features: QaCoverageFeatureSummary[];
  overlappingCoverage: QaCoverageFeatureSummary[];
  missingCoverage: QaCoverageScenarioSummary[];
  byTheme: Record<string, QaCoverageFeatureSummary[]>;
  bySurface: Record<string, QaCoverageFeatureSummary[]>;
};

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

function sortFeatures(features: readonly QaCoverageFeatureSummary[]) {
  return features.toSorted((left, right) => left.id.localeCompare(right.id));
}

export function buildQaCoverageInventory(
  scenarios: readonly QaSeedScenarioWithSource[],
): QaCoverageInventory {
  const byCoverageId = new Map<string, QaCoverageFeatureSummary>();
  const primaryCoverageIds = new Set<string>();
  const secondaryCoverageIds = new Set<string>();
  const missingCoverage: QaCoverageScenarioSummary[] = [];

  const addCoverage = (
    scenario: QaSeedScenarioWithSource,
    coverageIds: readonly string[] | undefined,
    intent: QaCoverageIntent,
  ) => {
    const summary = summarizeScenario(scenario);
    for (const coverageId of coverageIds ?? []) {
      const feature = byCoverageId.get(coverageId) ?? {
        id: coverageId,
        scenarios: [],
      };
      feature.scenarios.push({ ...summary, intent });
      byCoverageId.set(coverageId, feature);
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
    addCoverage(scenario, scenario.coverage.primary, "primary");
    addCoverage(scenario, scenario.coverage.secondary, "secondary");
  }

  const features = sortFeatures([...byCoverageId.values()]);
  const overlappingCoverage = features.filter((feature) => feature.scenarios.length > 1);
  const byTheme: Record<string, QaCoverageFeatureSummary[]> = {};
  const bySurface: Record<string, QaCoverageFeatureSummary[]> = {};

  for (const feature of features) {
    const themes = new Set(feature.scenarios.map((scenario) => scenario.theme));
    for (const theme of themes) {
      byTheme[theme] ??= [];
      byTheme[theme].push({
        ...feature,
        scenarios: feature.scenarios.filter((scenario) => scenario.theme === theme),
      });
    }
    const surfaces = new Set(feature.scenarios.flatMap((scenario) => scenario.surfaces));
    for (const surface of surfaces) {
      bySurface[surface] ??= [];
      bySurface[surface].push({
        ...feature,
        scenarios: feature.scenarios.filter((scenario) => scenario.surfaces.includes(surface)),
      });
    }
  }

  return {
    scenarioCount: scenarios.length,
    coverageIdCount: features.length,
    primaryCoverageIdCount: primaryCoverageIds.size,
    secondaryCoverageIdCount: secondaryCoverageIds.size,
    features,
    overlappingCoverage,
    missingCoverage,
    byTheme,
    bySurface,
  };
}

function pushFeatureLines(lines: string[], features: readonly QaCoverageFeatureSummary[]) {
  for (const feature of sortFeatures(features)) {
    const scenarios = feature.scenarios
      .map((scenario) => `${scenario.intent}: ${scenario.id} (${scenario.sourcePath})`)
      .join(", ");
    lines.push(`- ${feature.id}: ${scenarios}`);
  }
}

export function renderQaCoverageMarkdownReport(inventory: QaCoverageInventory): string {
  const lines: string[] = [
    "# QA Coverage Inventory",
    "",
    `- Scenarios: ${inventory.scenarioCount}`,
    `- Coverage IDs: ${inventory.coverageIdCount}`,
    `- Primary coverage IDs: ${inventory.primaryCoverageIdCount}`,
    `- Secondary coverage IDs: ${inventory.secondaryCoverageIdCount}`,
    `- Overlapping coverage IDs: ${inventory.overlappingCoverage.length}`,
    `- Missing coverage metadata: ${inventory.missingCoverage.length}`,
    "",
    "## By Theme",
    "",
  ];

  for (const theme of Object.keys(inventory.byTheme).toSorted()) {
    lines.push(`### ${theme}`, "");
    pushFeatureLines(lines, inventory.byTheme[theme] ?? []);
    lines.push("");
  }

  lines.push("## By Surface", "");
  for (const surface of Object.keys(inventory.bySurface).toSorted()) {
    lines.push(`### ${surface}`, "");
    pushFeatureLines(lines, inventory.bySurface[surface] ?? []);
    lines.push("");
  }

  if (inventory.overlappingCoverage.length > 0) {
    lines.push("## Overlap", "");
    pushFeatureLines(lines, inventory.overlappingCoverage);
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
