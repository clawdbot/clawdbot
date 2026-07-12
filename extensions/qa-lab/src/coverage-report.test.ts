// Qa Lab tests cover coverage report plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  buildQaCoverageInventory,
  findQaScenarioMatches,
  renderQaCoverageMarkdownReport,
  renderQaScenarioMatchesMarkdownReport,
} from "./coverage-report.js";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { buildQaScorecardTaxonomyReport, type QaMaturityTaxonomy } from "./scorecard-taxonomy.js";

const TEST_EXECUTABLE_CATEGORY_ID = "agent-runtime-and-provider-execution.agent-turn-execution";
const TEST_EXECUTABLE_COVERAGE_ID = "channels.dm";
const TEST_BROWSER_CATEGORY_ID = "browser-control-ui-and-webchat.browser-ui";
const TEST_BROWSER_COVERAGE_ID = "ui.control";
const TEST_WEBCHAT_COVERAGE_ID = "ui.webchat";
const DOTTED_COVERAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

function testMaturityTaxonomy(params?: {
  categoryId?: string;
  coverageIds?: readonly string[];
  featureCoverageIds?: readonly (readonly string[])[];
  includeAllCategories?: boolean;
  includeArchivedSurface?: boolean;
  profileCategoryIds?: readonly string[];
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
        categoryIds: [
          ...(params?.includeAllCategories ? [] : (params?.profileCategoryIds ?? [categoryId])),
        ],
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
            features: (
              params?.featureCoverageIds ??
              (params?.coverageIds ?? [TEST_EXECUTABLE_COVERAGE_ID]).map((coverageId) => [
                coverageId,
              ])
            ).map((coverageIds) => ({
              name: coverageIds.join(" + "),
              coverageIds: [...coverageIds],
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
                  features: [{ name: "legacy.feature", coverageIds: ["legacy.feature"] }],
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
    expect(inventory.liveTransportLanes.map((lane) => lane.transportId)).toEqual([
      "discord",
      "slack",
      "telegram",
      "whatsapp",
    ]);
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
      ["docker-podman-hosting.container-setup", "qa/scenarios/runtime/compose-setup.yaml"],
      [
        "docker-podman-hosting.image-release-and-validation",
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
      categoryIds: expect.arrayContaining([
        "browser-automation-and-exec-sandbox-tools.tool-invocation-and-execution",
      ]),
    });
    expect(inventory.scorecardTaxonomy.categoryCount).toBeGreaterThan(200);
    expect(inventory.scorecardTaxonomy.requiredCategoryCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.requiredCategoryCount).toBeLessThanOrEqual(
      inventory.scorecardTaxonomy.categoryCount,
    );
    expect(inventory.scorecardTaxonomy.requiredCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.fulfilledCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.coverageIdFulfillmentPercent).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.evidenceRefCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.scenarioCoverageIdCount).toBeGreaterThan(0);
    expect(inventory.scorecardTaxonomy.unknownCoverageIdCount).toBe(0);
    expect(
      inventory.scorecardTaxonomy.categories
        .flatMap((category) => category.coverageIds)
        .every((coverageId) => DOTTED_COVERAGE_ID_PATTERN.test(coverageId)),
    ).toBe(true);
    expect(inventory.scorecardTaxonomy.validationIssues.length).toBeGreaterThan(0);
    expect(
      inventory.scorecardTaxonomy.validationIssues.some((issue) =>
        issue.code.endsWith("not-found"),
      ),
    ).toBe(false);
    expect(
      inventory.scorecardTaxonomy.validationIssues.some(
        (issue) => issue.code === "coverage-id-missing-primary-evidence",
      ),
    ).toBe(true);
    expect(
      inventory.scorecardTaxonomy.categories.find(
        (category) => category.id === TEST_BROWSER_CATEGORY_ID,
      )?.evidence,
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
    expect(personalPack?.coverageIds).toContain("personal.redaction");
    expect(observabilityPack?.missingScenarioIds).toStrictEqual([]);
    expect(observabilityPack?.scenarioIds).toEqual(["otel-trace-smoke", "docker-prometheus-smoke"]);
    expect(observabilityPack?.coverageIds).toContain("telemetry.prometheus");
    expect(
      expectDefined(inventory.byTheme.memory, "memory QA theme").map((coverage) => coverage.id),
    ).toContain("memory.recall");
    expect(
      expectDefined(inventory.bySurface.memory, "memory QA surface").map((coverage) => coverage.id),
    ).toContain("memory.recall");
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
            sourcePath: "extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts",
          },
        ],
      }),
    ).toThrow(
      "duplicate qa scenario id(s): test-scenario (qa/scenarios/test/test-scenario.yaml, extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts)",
    );
  });

  it("renders a compact markdown inventory", () => {
    const report = renderQaCoverageMarkdownReport(
      buildQaCoverageInventory(readQaScenarioPack().scenarios),
    );

    expect(report).toContain("# QA Coverage Inventory");
    expect(report).toContain("- Missing coverage metadata: 0");
    expect(report).toContain("- Overlapping coverage IDs:");
    expect(report).toContain("memory.recall");
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
    expect(report).toContain("## Live Transport Lanes");
    expect(report).toContain(
      "- telegram (telegram): canary: always-on, help-command: telegram-help-command, mention-gating: telegram-mention-gating; missing baseline: allowlist-block, top-level-reply-shape, restart-resume",
    );
    expect(report).toContain("## Scorecard Taxonomy");
    expect(report).toContain("- Taxonomy: taxonomy.yaml");
    expect(report).toContain("- Fulfilled taxonomy categories:");
    expect(report).toContain("- Fulfilled taxonomy coverage IDs:");
    expect(report).toContain("- Evidence refs:");
    expect(report).toContain("- Scenario coverage IDs:");
    expect(report).toContain(
      "- browser-automation-and-exec-sandbox-tools.tool-invocation-and-execution (browser-automation-and-exec-sandbox-tools / Tool Invocation and Execution; partial): profiles: all, release, smoke-ci; coverage IDs:",
    );
    expect(report).toContain("primary:playwright:ui/src/e2e/chat-flow.e2e.test.ts (ui.control)");
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

  it("includes required channel driver flags in scenario match commands", () => {
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

  it("reports missing taxonomy coverage refs without treating them as fulfilled", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy(),
      repoRoot: process.cwd(),
      scenarios: [
        scenarioWithCoverage({
          primary: ["agent-runtime-and-provider-execution.agent-turn-execution.missing-coverage"],
        }),
      ],
    });

    expect(report.fulfilledCoverageIdCount).toBe(0);
    expect(report.categories[0]?.coverageStatus).toBe("missing");
    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "coverage-id-not-found",
      "coverage-id-missing-primary-evidence",
      "profile-category-missing-evidence",
    ]);
  });

  it("uses explicit native test evidence as coverage fulfillment", () => {
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
    expect(report.fulfilledCategoryCount).toBe(1);
    expect(report.fulfilledCoverageIdCount).toBe(1);
    expect(report.categories[0]?.coverageStatus).toBe("covered");
    expect(report.categories[0]?.scenarioRefs).toStrictEqual([
      "qa/scenarios/ui/control-ui-chat-flow-playwright.yaml",
    ]);
    expect(report.categories[0]?.evidence).toStrictEqual([
      {
        coverageId: TEST_BROWSER_COVERAGE_ID,
        kind: "playwright",
        path: "ui/src/e2e/chat-flow.e2e.test.ts",
        role: "primary",
        scenarioRefs: ["qa/scenarios/ui/control-ui-chat-flow-playwright.yaml"],
      },
    ]);
  });

  it("counts partial coverage IDs proportionately for taxonomy fulfillment", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy({
        featureCoverageIds: [[TEST_EXECUTABLE_COVERAGE_ID, TEST_WEBCHAT_COVERAGE_ID]],
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

    expect(report.fulfilledCategoryCount).toBe(0);
    expect(report.requiredCoverageIdCount).toBe(2);
    expect(report.fulfilledCoverageIdCount).toBe(1);
    expect(report.coverageIdFulfillmentPercent).toBe(50);
    expect(report.categories[0]?.coverageStatus).toBe("partial");
    expect(report.categories[0]?.fulfilledCoverageIds).toStrictEqual([TEST_EXECUTABLE_COVERAGE_ID]);
    expect(report.validationIssues).toContainEqual(
      expect.objectContaining({
        code: "coverage-id-missing-primary-evidence",
        ref: TEST_WEBCHAT_COVERAGE_ID,
      }),
    );
  });

  it("counts each required taxonomy coverage ID once across categories", () => {
    const taxonomy: QaMaturityTaxonomy = {
      ...testMaturityTaxonomy(),
      profiles: [
        {
          id: "release",
          description: "Test release profile.",
          includeAllCategories: false,
          channelDriver: "qa-channel",
          categoryIds: [
            "agent-runtime-and-provider-execution.agent-turn-execution",
            "agent-runtime-and-provider-execution.tool-execution-controls",
          ],
        },
      ],
      surfaces: [
        {
          id: "agent-runtime-and-provider-execution",
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
                  name: "shared plus unique",
                  coverageIds: [TEST_EXECUTABLE_COVERAGE_ID, TEST_WEBCHAT_COVERAGE_ID],
                },
              ],
            },
            {
              id: "tool-execution-controls",
              name: "Tool Execution Controls",
              category_note: "tool-execution-controls.md",
              docs: [],
              search_anchors: [],
              features: [
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
    const report = buildQaScorecardTaxonomyReport({
      taxonomy,
      repoRoot: process.cwd(),
      scenarios: [
        scenarioWithCoverage({
          primary: [TEST_EXECUTABLE_COVERAGE_ID],
          secondary: [TEST_WEBCHAT_COVERAGE_ID],
          sourcePath: "qa/scenarios/channels/dm-chat-baseline.yaml",
        }),
      ],
    });

    expect(report.requiredCoverageIdCount).toBe(2);
    expect(report.fulfilledCoverageIdCount).toBe(1);
    expect(report.coverageIdFulfillmentPercent).toBe(50);
  });

  it("uses script producer evidence as coverage fulfillment", () => {
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
    expect(report.fulfilledCategoryCount).toBe(1);
    expect(report.fulfilledCoverageIdCount).toBe(1);
    expect(report.categories[0]?.evidence).toStrictEqual([
      {
        coverageId: TEST_BROWSER_COVERAGE_ID,
        kind: "script",
        path: "scripts/check-no-conflict-markers.mjs",
        role: "primary",
        scenarioRefs: ["qa/scenarios/ui/script-evidence-producer.yaml"],
      },
    ]);
  });

  it("reports profile membership refs missing from taxonomy categories", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy({
        profileCategoryIds: ["missing.category"],
      }),
      repoRoot: process.cwd(),
      scenarios: [],
    });

    expect(report.validationIssues.map((issue) => issue.code)).toContain(
      "profile-category-ref-not-found",
    );
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

  it("reports profile categories missing primary coverage evidence", () => {
    const report = buildQaScorecardTaxonomyReport({
      taxonomy: testMaturityTaxonomy(),
      repoRoot: process.cwd(),
      scenarios: [],
    });

    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "coverage-id-missing-primary-evidence",
      "profile-category-missing-evidence",
    ]);
  });

  it("reports native test evidence refs outside the repository", () => {
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
      "evidence-ref-not-found",
      "coverage-id-missing-primary-evidence",
      "profile-category-missing-evidence",
    ]);
  });

  it("uses scenario coverage metadata as runnable scenario evidence", () => {
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
    expect(report.categories[0]?.evidence).toStrictEqual([
      {
        coverageId: TEST_EXECUTABLE_COVERAGE_ID,
        kind: "qa-scenario",
        path: null,
        role: "primary",
        scenarioRefs: ["qa/scenarios/channels/dm-chat-baseline.yaml"],
      },
    ]);
  });

  it("counts secondary scenario metadata as evidence but not fulfillment", () => {
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

    expect(report.fulfilledCoverageIdCount).toBe(0);
    expect(report.categories[0]?.coverageStatus).toBe("partial");
    expect(report.validationIssues.map((issue) => issue.code)).toEqual([
      "coverage-id-not-found",
      "coverage-id-missing-primary-evidence",
      "profile-category-missing-evidence",
    ]);
  });
});
