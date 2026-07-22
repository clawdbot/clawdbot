// Qa Lab tests cover coverage report plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  buildQaCoverageInventory,
  findQaScenarioMatches,
  renderQaCoverageMarkdownReport,
  renderQaScenarioMatchesMarkdownReport,
} from "./coverage-report.js";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport, type QaMaturityTaxonomy } from "./scorecard-taxonomy.js";

const TEST_EXECUTABLE_CATEGORY_ID = "agent-runtime.agent-turn-execution";
const TEST_EXECUTABLE_COVERAGE_ID = "agent-runtime.dm";
const TEST_BROWSER_CATEGORY_ID = "control-ui.browser-ui";
const TEST_BROWSER_COVERAGE_ID = "control-ui.gateway-hosted-ui-control";
const TEST_WEBCHAT_COVERAGE_ID = "agent-runtime.webchat";
const TWO_PART_COVERAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

function buildQaScorecardTaxonomyReport(params: {
  taxonomy: QaMaturityTaxonomy;
  repoRoot: string;
  scenarios: readonly QaSeedScenarioWithSource[];
}) {
  expect(params.repoRoot).toBe(process.cwd());
  const parseSpy = vi.spyOn(YAML, "parse").mockReturnValueOnce(params.taxonomy);
  try {
    return readQaScorecardTaxonomyReport(params.scenarios);
  } finally {
    parseSpy.mockRestore();
  }
}

function testMaturityTaxonomy(params?: {
  categoryId?: string;
  coverageIds?: readonly string[];
  includeAllCategories?: boolean;
  includeArchivedSurface?: boolean;
}): QaMaturityTaxonomy {
  const categoryId = params?.categoryId ?? TEST_EXECUTABLE_CATEGORY_ID;
  const firstDot = categoryId.indexOf(".");
  const surfaceId = firstDot === -1 ? categoryId : categoryId.slice(0, firstDot);
  const categoryLocalId = firstDot === -1 ? categoryId : categoryId.slice(firstDot + 1);
  return {
    version: 1 as const,
    title: "Test taxonomy",
    levels: [],
    profiles: [
      {
        id: "smoke-ci",
        description: "Test smoke profile.",
        includeAllCategories: false,
        channelDriver: "crabline" as const,
        categoryIds: [categoryId],
      },
      {
        id: "release",
        description: "Test release profile.",
        includeAllCategories: params?.includeAllCategories ?? false,
        channelDriver: "qa-channel" as const,
        categoryIds: params?.includeAllCategories ? [] : [categoryId],
      },
    ],
    surfaces: [
      {
        id: surfaceId,
        name: "Test surface",
        family: "test",
        level: "experimental",
        categories: [
          {
            id: categoryLocalId,
            name: "Test category",
            category_note: "test-category.md",
            docs: [],
            search_anchors: [],
            features: (params?.coverageIds ?? [TEST_EXECUTABLE_COVERAGE_ID]).map((coverageId) => ({
              name: coverageId,
              coverageIds: [coverageId],
            })),
          },
        ],
      },
      ...(params?.includeArchivedSurface
        ? [
            {
              id: "archived-surface",
              name: "Archived surface",
              family: "test",
              level: "experimental",
              archived: true,
              categories: [
                {
                  id: "legacy-category",
                  name: "Legacy category",
                  category_note: "legacy-category.md",
                  docs: [],
                  search_anchors: [],
                  features: [
                    {
                      name: "Legacy feature",
                      coverageIds: ["archived-surface.legacy-feature"],
                    },
                  ],
                },
              ],
            },
          ]
        : []),
    ],
  };
}

function scenarioWithCoverage(params: {
  primary?: readonly string[];
  secondary?: readonly string[];
  sourcePath?: string;
  executionKind?: "flow" | "script" | "vitest" | "playwright";
  executionPath?: string;
}): QaSeedScenarioWithSource {
  const execution =
    params.executionKind === "script" ||
    params.executionKind === "vitest" ||
    params.executionKind === "playwright"
      ? {
          kind: params.executionKind,
          path: params.executionPath ?? "src/test.test.ts",
        }
      : {
          kind: "flow" as const,
          flow: {
            steps: [
              {
                name: "noop",
                actions: [{ set: "ok", value: true }],
              },
            ],
          },
        };
  return {
    id: "test-scenario",
    title: "Test scenario",
    surface: "test",
    coverage: {
      primary: [...(params.primary ?? [])],
      ...(params.secondary ? { secondary: [...params.secondary] } : {}),
    },
    objective: "Exercise test coverage.",
    successCriteria: ["Evidence is recorded."],
    sourcePath: params.sourcePath ?? "qa/scenarios/test/test-scenario.yaml",
    execution,
  };
}

describe("qa coverage report", () => {
  it("groups scenario coverage metadata by theme and surface", () => {
    const scenarios = readQaScenarioPack().scenarios;
    const inventory = buildQaCoverageInventory(scenarios);

    expect(inventory.scenarioCount).toBeGreaterThan(0);
    expect(inventory.coverageIdCount).toBeGreaterThan(0);
    expect(inventory.primaryCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.secondaryCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.overlappingCoverage.length).toBeGreaterThan(0);
    expect(inventory.missingCoverage).toStrictEqual([]);
    expect(inventory.scorecardTaxonomy.profileCount).toBe(3);
    expect(
      inventory.scorecardTaxonomy.profiles.find((profile) => profile.id === "smoke-ci"),
    ).toMatchObject({
      channelDriver: "crabline",
      evidenceMode: "slim",
    });
    expect(
      inventory.scorecardTaxonomy.profiles.find((profile) => profile.id === "release"),
    ).toMatchObject({
      channelDriver: "live",
    });
    for (const [categoryId, scenarioRef] of [
      ["containers.container-setup", "qa/scenarios/runtime/compose-setup.yaml"],
      [
        "containers.image-release-and-validation",
        "qa/scenarios/runtime/docker-package-install.yaml",
      ],
    ] as const) {
      const category = inventory.scorecardTaxonomy.categories.find(
        (entry) => entry.id === categoryId,
      );
      expect(category?.profiles).toContain("release");
      expect(category?.profiles).not.toContain("smoke-ci");
      expect(scenarios.find((scenario) => scenario.sourcePath === scenarioRef)?.category).toBe(
        categoryId,
      );
    }
    expect(
      inventory.scorecardTaxonomy.profiles.find((profile) => profile.id === "all"),
    ).toMatchObject({
      channelDriver: "live",
      categoryIds: expect.arrayContaining(["tools.tool-invocation-and-execution"]),
    });
    expect(inventory.scorecardTaxonomy.categoryCount).toBeGreaterThan(200);
    expect(inventory.scorecardTaxonomy.requiredCategoryCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.requiredCategoryCount).toBeLessThanOrEqual(
      inventory.scorecardTaxonomy.categoryCount,
    );
    expect(inventory.scorecardTaxonomy.requiredCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.inventoriedCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.coverageIdInventoryPercent).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.inventoryRefCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.scenarioCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.unknownCoverageIdCount).toBe(0);
    expect(
      inventory.scorecardTaxonomy.categories
        .flatMap((category) => category.coverageIds)
        .every((coverageId) => TWO_PART_COVERAGE_ID_PATTERN.test(coverageId)),
    ).toBe(true);
    expect(inventory.scorecardTaxonomy.validationIssues.length).toBeGreaterThan(0);
    expect(
      inventory.scorecardTaxonomy.validationIssues.some((issue) =>
        issue.code.endsWith("not-found"),
      ),
    ).toBe(false);
    expect(
      inventory.scorecardTaxonomy.validationIssues.some(
        (issue) => issue.code === "coverage-id-missing-primary-inventory",
      ),
    ).toBe(true);
    expect(
      inventory.scorecardTaxonomy.categories.find(
        (category) => category.id === TEST_BROWSER_CATEGORY_ID,
      )?.inventoryRefs,
    ).toContainEqual({
      coverageId: TEST_BROWSER_COVERAGE_ID,
      kind: "playwright",
      path: "ui/src/e2e/chat-flow.e2e.test.ts",
      role: "primary",
      scenarioRefs: ["qa/scenarios/ui/control-ui-chat-flow-playwright.yaml"],
    });
    expect(inventory.scenarioPacks.map((pack) => pack.id)).toEqual([
      "observability",
      "personal-agent",
    ]);
    const personalPack = inventory.scenarioPacks.find((pack) => pack.id === "personal-agent");
    const observabilityPack = inventory.scenarioPacks.find((pack) => pack.id === "observability");
    expect(personalPack?.missingScenarioIds).toStrictEqual([]);
    expect(personalPack?.scenarioIds).toContain("personal-share-safe-diagnostics-artifact");
    expect(personalPack?.coverageIds).toContain("security.redaction-personal-redaction");
    expect(observabilityPack?.missingScenarioIds).toStrictEqual([]);
    expect(observabilityPack?.scenarioIds).toEqual(["otel-trace-smoke", "docker-prometheus-smoke"]);
    expect(observabilityPack?.coverageIds).toContain("observability.prometheus");
    expect(
      expectDefined(inventory.byTheme.memory, "memory QA theme").map((coverage) => coverage.id),
    ).toContain("session-memory.memory-recall");
    expect(
      expectDefined(inventory.bySurface["session-memory"], "memory QA surface").map(
        (coverage) => coverage.id,
      ),
    ).toContain("session-memory.memory-recall");
  });

  it("rejects duplicate ownership across YAML and non-YAML catalogs", () => {
    const scenario = scenarioWithCoverage({
      primary: [TEST_EXECUTABLE_COVERAGE_ID],
      executionKind: "script",
      executionPath: "scripts/test-scenario.ts",
    });

    expect(() =>
      buildQaCoverageInventory([scenario], {
        nonYamlScenarios: [
          {
            id: scenario.id,
            sourcePath: "extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts",
          },
        ],
      }),
    ).toThrow(
      "duplicate qa scenario id(s): test-scenario (qa/scenarios/test/test-scenario.yaml, extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts)",
    );
  });

  it("renders a compact markdown inventory", () => {
    const report = renderQaCoverageMarkdownReport(
      buildQaCoverageInventory(readQaScenarioPack().scenarios),
    );

    expect(report).toContain("# QA Coverage Inventory");
    expect(report).toContain("- Missing coverage metadata: 0");
    expect(report).toContain("- Overlapping coverage IDs:");
    expect(report).toContain("session-memory.embedding-search-recall");
    expect(report).toContain("primary: memory-recall (qa/scenarios/memory/memory-recall.yaml)");
    expect(report).toContain("secondary: active-memory-preprompt-recall");
    expect(report).toContain("## Scenario Packs");
    expect(report).toContain(
      "- personal-agent (Personal Agent Benchmark Pack): 10 scenarios; coverage IDs:",
    );
    expect(report).toContain(
      "- observability (Observability Smoke Pack): 2 scenarios; coverage IDs:",
    );
    expect(report).toContain("otel-trace-smoke, docker-prometheus-smoke");
    expect(report).toContain("personal-share-safe-diagnostics-artifact");
    expect(report).toContain("## Scorecard Taxonomy");
    expect(report).toContain("- Taxonomy: taxonomy.yaml");
    expect(report).toContain("- Inventoried taxonomy categories:");
    expect(report).toContain("- Inventoried taxonomy coverage IDs:");
    expect(report).toContain("- Inventory refs:");
    expect(report).toContain("- Scenario coverage IDs:");
    expect(report).toContain(
      "- tools.tool-invocation-and-execution (tools / Tool Invocation and Execution; partial): profiles: all, release; coverage IDs:",
    );
    expect(report).toContain(
      "primary:playwright:ui/src/e2e/chat-flow.e2e.test.ts (control-ui.gateway-hosted-ui-control)",
    );
    expect(report).not.toContain("### Unknown Scenario Coverage IDs");
  });

  it("renders Playwright matches as qa suite targets", () => {
    const matches = findQaScenarioMatches(readQaScenarioPack().scenarios, "chat-flow.e2e");
    const report = renderQaScenarioMatchesMarkdownReport({
      query: "chat-flow.e2e",
      matches,
    });

    expect(report).toContain(
      "- Suite command: `pnpm openclaw qa suite --scenario control-ui-chat-flow-playwright`",
    );
    expect(report).toContain("  - execution: playwright ui/src/e2e/chat-flow.e2e.test.ts");
    expect(report).not.toContain("Native test refs");
  });

  it("includes a runnable channel driver choice in scenario match commands", () => {
    const matches = findQaScenarioMatches(
      readQaScenarioPack().scenarios,
      "whatsapp-access-control-group-disabled",
    );
    const report = renderQaScenarioMatchesMarkdownReport({
      query: "whatsapp-access-control-group-disabled",
      matches,
    });

    expect(report).toContain(
      "- Suite command: `pnpm openclaw qa suite --channel-driver live --channel whatsapp --scenario whatsapp-access-control-group-disabled`",
    );
  });

  it("keeps qa-channel scenario commands on the default driver", () => {
    const matches = findQaScenarioMatches(
      readQaScenarioPack().scenarios,
      "instruction-followthrough-repo-contract",
    );
    const report = renderQaScenarioMatchesMarkdownReport({
      query: "instruction-followthrough-repo-contract",
      matches,
    });

    expect(report).toContain(
      "- Suite command: `pnpm openclaw qa suite --scenario instruction-followthrough-repo-contract`",
    );
    expect(report).not.toContain("--channel-driver live --channel qa-channel");
  });

  it("uses the live lane as the coverage-report default for channel scenarios", () => {
    const matches = findQaScenarioMatches(readQaScenarioPack().scenarios, "dm-per-room-session");
    const report = renderQaScenarioMatchesMarkdownReport({
      query: "dm-per-room-session",
      matches,
    });

    expect(report).toContain(
      "- Suite command: `pnpm openclaw qa suite --channel-driver live --channel matrix --scenario dm-per-room-session`",
    );
  });

  it("splits flow commands across channel lanes", () => {
    const scenarios = readQaScenarioPack().scenarios;
    const matches = [
      ...findQaScenarioMatches(scenarios, "dm-per-room-session"),
      ...findQaScenarioMatches(scenarios, "whatsapp-access-control-group-disabled"),
    ];
    const report = renderQaScenarioMatchesMarkdownReport({ query: "channel lanes", matches });

    expect(report).toContain(
      "--channel-driver live --channel matrix --scenario dm-per-room-session",
    );
    expect(report).toContain(
      "--channel-driver live --channel whatsapp --scenario whatsapp-access-control-group-disabled",
    );
  });

  it("splits qa suite targets when matches mix execution kinds", () => {
    const playwrightExecutionPath = "ui/src/e2e/chat-flow.e2e.test.ts";
    const flowScenario = scenarioWithCoverage({
      primary: [TEST_EXECUTABLE_COVERAGE_ID],
    });
    const playwrightScenario = scenarioWithCoverage({
      primary: [TEST_BROWSER_COVERAGE_ID],
      executionKind: "playwright",
      executionPath: playwrightExecutionPath,
      sourcePath: "qa/scenarios/ui/control-ui-chat-flow-playwright.yaml",
    });
    const report = renderQaScenarioMatchesMarkdownReport({
      query: "mixed",
      matches: [
        {
          ...flowScenario,
          id: "flow-proof",
          theme: "test",
          surfaces: [flowScenario.surface],
          risk: "unassigned",
          coverageIds: [
            ...(flowScenario.coverage?.primary ?? []),
            ...(flowScenario.coverage?.secondary ?? []),
          ],
          docsRefs: [],
          codeRefs: [],
          executionKind: flowScenario.execution.kind,
        },
        {
          ...playwrightScenario,
          id: "playwright-proof",
          theme: "test",
          surfaces: [playwrightScenario.surface],
          risk: "unassigned",
          coverageIds: [
            ...(playwrightScenario.coverage?.primary ?? []),
            ...(playwrightScenario.coverage?.secondary ?? []),
          ],
          docsRefs: [],
          codeRefs: [],
          executionKind: playwrightScenario.execution.kind,
          executionPath: playwrightExecutionPath,
        },
      ],
    });

    expect(report).toContain("- Suite commands:");
    expect(report).toContain("  - flow: `pnpm openclaw qa suite --scenario flow-proof`");
    expect(report).toContain(
      "  - playwright: `pnpm openclaw qa suite --scenario playwright-proof`",
    );
  });

  it("reports missing taxonomy coverage refs without treating them as inventoried", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy(),
      repoRoot: process.cwd(),
      scenarios: [
        scenarioWithCoverage({
          primary: ["agents.missing-coverage"],
        }),
      ],
    });

    expect(report.inventoriedCoverageIdCount).toBe(0);
    expect(report.categories[0]?.inventoryStatus).toBe("missing");
    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "coverage-id-not-found",
      "coverage-id-missing-primary-inventory",
      "profile-category-missing-inventory",
    ]);
  });

  it("inventories explicit native test declarations", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy({
        categoryId: TEST_BROWSER_CATEGORY_ID,
        coverageIds: [TEST_BROWSER_COVERAGE_ID],
      }),
      repoRoot: process.cwd(),
      scenarios: [
        scenarioWithCoverage({
          primary: [TEST_BROWSER_COVERAGE_ID],
          sourcePath: "qa/scenarios/ui/control-ui-chat-flow-playwright.yaml",
          executionKind: "playwright",
          executionPath: "ui/src/e2e/chat-flow.e2e.test.ts",
        }),
      ],
    });

    expect(report.validationIssues).toStrictEqual([]);
    expect(report.inventoriedCategoryCount).toBe(1);
    expect(report.inventoriedCoverageIdCount).toBe(1);
    expect(report.categories[0]?.inventoryStatus).toBe("complete");
    expect(report.categories[0]?.scenarioRefs).toStrictEqual([
      "qa/scenarios/ui/control-ui-chat-flow-playwright.yaml",
    ]);
    expect(report.categories[0]?.inventoryRefs).toStrictEqual([
      {
        coverageId: TEST_BROWSER_COVERAGE_ID,
        kind: "playwright",
        path: "ui/src/e2e/chat-flow.e2e.test.ts",
        role: "primary",
        scenarioRefs: ["qa/scenarios/ui/control-ui-chat-flow-playwright.yaml"],
      },
    ]);
  });

  it("counts partial coverage IDs proportionately for taxonomy inventory", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy({
        coverageIds: [TEST_EXECUTABLE_COVERAGE_ID, TEST_WEBCHAT_COVERAGE_ID],
      }),
      repoRoot: process.cwd(),
      scenarios: [
        scenarioWithCoverage({
          primary: [TEST_EXECUTABLE_COVERAGE_ID],
          secondary: [TEST_WEBCHAT_COVERAGE_ID],
          sourcePath: "qa/scenarios/channels/dm-chat-baseline.yaml",
        }),
      ],
    });

    expect(report.inventoriedCategoryCount).toBe(0);
    expect(report.requiredCoverageIdCount).toBe(2);
    expect(report.inventoriedCoverageIdCount).toBe(1);
    expect(report.coverageIdInventoryPercent).toBe(50);
    expect(report.categories[0]?.inventoryStatus).toBe("partial");
    expect(report.categories[0]?.inventoriedCoverageIds).toStrictEqual([
      TEST_EXECUTABLE_COVERAGE_ID,
    ]);
    expect(report.validationIssues).toContainEqual(
      expect.objectContaining({
        code: "coverage-id-missing-primary-inventory",
        ref: TEST_WEBCHAT_COVERAGE_ID,
      }),
    );
  });

  it("rejects one coverage ID assigned to different exact features", () => {
    const taxonomy: QaMaturityTaxonomy = {
      ...testMaturityTaxonomy(),
      profiles: [
        {
          id: "release",
          description: "Test release profile.",
          includeAllCategories: false,
          channelDriver: "qa-channel",
          categoryIds: ["agent-runtime.agent-turn-execution"],
        },
      ],
      surfaces: [
        {
          id: "agent-runtime",
          name: "Agent Runtime",
          family: "test",
          level: "experimental",
          categories: [
            {
              id: "agent-turn-execution",
              name: "Agent Turn Execution",
              category_note: "agent-turn-execution.md",
              docs: [],
              search_anchors: [],
              features: [
                {
                  name: "shared",
                  coverageIds: [TEST_EXECUTABLE_COVERAGE_ID],
                },
                {
                  name: "shared",
                  coverageIds: [TEST_EXECUTABLE_COVERAGE_ID],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() =>
      buildQaScorecardTaxonomyReport({
        taxonomy,
        repoRoot: process.cwd(),
        scenarios: [],
      }),
    ).toThrow(
      `coverage ID ${TEST_EXECUTABLE_COVERAGE_ID} already belongs to agent-runtime.agent-turn-execution feature shared; coverage IDs must identify exactly one taxonomy feature`,
    );
  });

  it("requires one two-part ID owned by each exact taxonomy feature", () => {
    const taxonomy = testMaturityTaxonomy();
    const feature = expectDefined(
      taxonomy.surfaces[0]?.categories[0]?.features[0],
      "test taxonomy feature",
    );
    feature.coverageIds = [TEST_EXECUTABLE_COVERAGE_ID, TEST_WEBCHAT_COVERAGE_ID];

    expect(() =>
      buildQaScorecardTaxonomyReport({ taxonomy, repoRoot: process.cwd(), scenarios: [] }),
    ).toThrow("taxonomy features must define exactly one coverage ID");

    feature.coverageIds = ["agents.delivery.group"];
    expect(() =>
      buildQaScorecardTaxonomyReport({ taxonomy, repoRoot: process.cwd(), scenarios: [] }),
    ).toThrow("coverage ids must use exactly <surface-id>.<feature-id>");

    feature.coverageIds = [TEST_BROWSER_COVERAGE_ID];
    expect(() =>
      buildQaScorecardTaxonomyReport({ taxonomy, repoRoot: process.cwd(), scenarios: [] }),
    ).toThrow(`coverage ID ${TEST_BROWSER_COVERAGE_ID} must belong to surface agent-runtime`);
  });

  it("inventories script producer declarations", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy({
        categoryId: TEST_BROWSER_CATEGORY_ID,
        coverageIds: [TEST_BROWSER_COVERAGE_ID],
      }),
      repoRoot: process.cwd(),
      scenarios: [
        scenarioWithCoverage({
          primary: [TEST_BROWSER_COVERAGE_ID],
          sourcePath: "qa/scenarios/ui/script-evidence-producer.yaml",
          executionKind: "script",
          executionPath: "scripts/check-no-conflict-markers.mjs",
        }),
      ],
    });

    expect(report.validationIssues).toStrictEqual([]);
    expect(report.inventoriedCategoryCount).toBe(1);
    expect(report.inventoriedCoverageIdCount).toBe(1);
    expect(report.categories[0]?.inventoryRefs).toStrictEqual([
      {
        coverageId: TEST_BROWSER_COVERAGE_ID,
        kind: "script",
        path: "scripts/check-no-conflict-markers.mjs",
        role: "primary",
        scenarioRefs: ["qa/scenarios/ui/script-evidence-producer.yaml"],
      },
    ]);
  });

  it("resolves all-category profiles from taxonomy categories", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy({
        includeAllCategories: true,
        includeArchivedSurface: true,
      }),
      repoRoot: process.cwd(),
      scenarios: [],
    });

    expect(report.profiles.find((profile) => profile.id === "release")?.categoryIds).toStrictEqual([
      TEST_EXECUTABLE_CATEGORY_ID,
    ]);
    expect(report.requiredCategoryCount).toBe(1);
    expect(report.categoryCount).toBe(1);
    expect(report.profiles.find((profile) => profile.id === "release")?.categoryIds).not.toContain(
      "archived-surface.legacy-category",
    );
  });

  it("reports profile categories missing primary coverage inventory", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy(),
      repoRoot: process.cwd(),
      scenarios: [],
    });

    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "coverage-id-missing-primary-inventory",
      "profile-category-missing-inventory",
    ]);
  });

  it("reports native test inventory targets outside the repository", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy(),
      repoRoot: process.cwd(),
      scenarios: [
        scenarioWithCoverage({
          primary: [TEST_EXECUTABLE_COVERAGE_ID],
          executionKind: "playwright",
          executionPath: "../outside-openclaw.test.ts",
        }),
      ],
    });

    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "inventory-ref-not-found",
      "coverage-id-missing-primary-inventory",
      "profile-category-missing-inventory",
    ]);
  });

  it("inventories runnable scenario coverage metadata", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy(),
      repoRoot: process.cwd(),
      scenarios: [
        scenarioWithCoverage({
          primary: [TEST_EXECUTABLE_COVERAGE_ID],
          sourcePath: "qa/scenarios/channels/dm-chat-baseline.yaml",
        }),
      ],
    });

    expect(report.validationIssues).toStrictEqual([]);
    expect(report.categories[0]?.scenarioRefs).toStrictEqual([
      "qa/scenarios/channels/dm-chat-baseline.yaml",
    ]);
    expect(report.categories[0]?.inventoryRefs).toStrictEqual([
      {
        coverageId: TEST_EXECUTABLE_COVERAGE_ID,
        kind: "qa-scenario",
        path: null,
        role: "primary",
        scenarioRefs: ["qa/scenarios/channels/dm-chat-baseline.yaml"],
      },
    ]);
  });

  it("counts secondary scenario metadata as inventory but not primary inventory", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy(),
      repoRoot: process.cwd(),
      scenarios: [
        scenarioWithCoverage({
          primary: [TEST_WEBCHAT_COVERAGE_ID],
          secondary: [TEST_EXECUTABLE_COVERAGE_ID],
        }),
      ],
    });

    expect(report.inventoriedCoverageIdCount).toBe(0);
    expect(report.categories[0]?.inventoryStatus).toBe("partial");
    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "coverage-id-not-found",
      "coverage-id-missing-primary-inventory",
      "profile-category-missing-inventory",
    ]);
  });
});
