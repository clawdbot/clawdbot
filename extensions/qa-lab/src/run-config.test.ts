// Qa Lab tests cover run config plugin behavior.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { defaultQaRuntimeModelForMode, resolveQaRuntimeModelPair } = vi.hoisted(() => ({
  defaultQaRuntimeModelForMode:
    vi.fn<(mode: string, options?: { alternate?: boolean }) => string>(),
  resolveQaRuntimeModelPair: vi.fn(),
}));

vi.mock("./model-selection.runtime.js", () => ({
  defaultQaRuntimeModelForMode,
  resolveQaRuntimeModelPair,
}));
import { defaultQaModelForMode as defaultQaProviderModelForMode } from "./model-selection.js";
import {
  resolveQaRunProfileExecutionSelection,
  resolveQaRunProfileMembership,
} from "./profile-planning.js";
import { resolveQaLiveFrontierAlternateModel } from "./providers/live-frontier/model-selection.runtime.js";
import {
  createIdleQaRunnerSnapshot,
  createQaRunOutputDir,
  normalizeQaRunSelection,
  resolveQaLabRunPlan,
  type QaProviderModeInput,
} from "./run-config.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import {
  readQaScorecardTaxonomyReport,
  type QaScorecardTaxonomyReport,
} from "./scorecard-taxonomy.js";

function resolveMockQaRuntimeModelPair(params: {
  providerMode: string;
  primaryModel?: string;
  alternateModel?: string;
  resolveDefaultModel?: (mode: string, alternate?: boolean) => string;
}) {
  const resolveDefaultModel =
    params.resolveDefaultModel ??
    ((mode: string, alternate = false) =>
      defaultQaRuntimeModelForMode(mode, alternate ? { alternate: true } : undefined));
  const primaryModel = params.primaryModel?.trim() || resolveDefaultModel(params.providerMode);
  const alternateModel =
    params.alternateModel?.trim() ||
    (params.providerMode === "live-frontier"
      ? (resolveQaLiveFrontierAlternateModel(primaryModel) ??
        resolveDefaultModel(params.providerMode, true))
      : resolveDefaultModel(params.providerMode, true));
  return { primaryModel, alternateModel };
}

const profiles: QaScorecardTaxonomyReport["profiles"] = [
  {
    id: "smoke-ci",
    evidenceMode: "slim",
    channelDriver: "crabline",
    categoryIds: [],
    coverageIds: [],
    scenarioRefs: [],
  },
  {
    id: "release",
    evidenceMode: "full",
    channelDriver: "live",
    categoryIds: [],
    coverageIds: [],
    scenarioRefs: [],
  },
  {
    id: "all",
    evidenceMode: "full",
    channelDriver: "live",
    categoryIds: [],
    coverageIds: [],
    scenarioRefs: [],
  },
];

const scenarios = [
  {
    id: "dm-chat-baseline",
    title: "DM baseline",
    surface: "dm",
    objective: "test DM",
    successCriteria: ["reply"],
    execution: { kind: "flow" as const },
  },
  {
    id: "thread-lifecycle",
    title: "Thread lifecycle",
    surface: "thread",
    objective: "test thread",
    successCriteria: ["thread reply"],
    execution: { kind: "flow" as const },
  },
  {
    id: "control-ui-chat-flow-playwright",
    title: "Control UI Playwright",
    surface: "control-ui",
    objective: "test Control UI",
    successCriteria: ["playwright pass"],
    execution: {
      kind: "playwright" as const,
      path: "ui/src/e2e/chat-flow.e2e.test.ts",
    },
  },
];

describe("qa run config", () => {
  beforeEach(() => {
    defaultQaRuntimeModelForMode.mockImplementation(
      (mode: string, options?: { alternate?: boolean }) =>
        defaultQaProviderModelForMode(mode as QaProviderModeInput, options),
    );
    resolveQaRuntimeModelPair.mockImplementation(resolveMockQaRuntimeModelPair);
  });

  it("creates a canonical smoke-profile request without copying profile membership", () => {
    const expected = {
      profile: "smoke-ci",
      channel: null,
      channelDriver: "crabline",
      evidenceMode: "slim",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      fastMode: false,
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: null,
    } as const;
    expect(normalizeQaRunSelection({}, scenarios, profiles)).toEqual(expected);
    expect(normalizeQaRunSelection({ profile: null }, scenarios, profiles)).toEqual(expected);
  });

  it("normalizes live selections and deduplicates scenario ids", () => {
    expect(
      normalizeQaRunSelection(
        {
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.6-luna",
          alternateModel: "",
          fastMode: false,
          scenarioIds: ["thread-lifecycle", "thread-lifecycle"],
        },
        scenarios,
        profiles,
      ),
    ).toEqual({
      profile: "all",
      channel: null,
      channelDriver: "live",
      evidenceMode: "full",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-sol",
      fastMode: true,
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["thread-lifecycle"],
    });
  });

  it("applies the canonical profile execution defaults to explicit scenario requests", () => {
    expect(
      normalizeQaRunSelection(
        { profile: "all", scenarioIds: ["thread-lifecycle"] },
        scenarios,
        profiles,
      ),
    ).toMatchObject({
      profile: "all",
      channelDriver: "live",
      evidenceMode: "full",
      scenarioIds: ["thread-lifecycle"],
    });
    expect(
      normalizeQaRunSelection({ scenarioIds: ["thread-lifecycle"] }, scenarios, profiles),
    ).toMatchObject({
      profile: "all",
      channelDriver: "live",
      evidenceMode: "full",
      scenarioIds: ["thread-lifecycle"],
    });
  });

  it("rejects removed provider compatibility names", () => {
    expect(() =>
      normalizeQaRunSelection(
        {
          providerMode: "live-openai",
        },
        scenarios,
        profiles,
      ),
    ).toThrow("unknown QA provider mode: live-openai");
  });

  it("keeps implicit profile membership server-owned and rejects an explicit empty selection", () => {
    const snapshot = createIdleQaRunnerSnapshot(profiles);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.selection.scenarioIds).toBeNull();
    expect(snapshot.plan).toBeNull();
    expect(() => normalizeQaRunSelection({ scenarioIds: [] }, scenarios, profiles)).toThrow(
      "scenarioIds must be a non-empty array",
    );
  });

  it("preserves explicit non-flow scenarios for the mixed-kind suite planner", () => {
    expect(
      normalizeQaRunSelection(
        {
          scenarioIds: ["control-ui-chat-flow-playwright", "thread-lifecycle"],
        },
        scenarios,
        profiles,
      ).scenarioIds,
    ).toEqual(["control-ui-chat-flow-playwright", "thread-lifecycle"]);
  });

  it("fails closed on unknown explicit scenario ids", () => {
    expect(() =>
      normalizeQaRunSelection(
        {
          scenarioIds: ["thread-lifecycle", "missing"],
        },
        scenarios,
        profiles,
      ),
    ).toThrow("unknown QA scenario id(s): missing");
  });

  it("fails closed on malformed explicit profiles", () => {
    for (const profile of [false, ""] as const) {
      expect(() =>
        normalizeQaRunSelection(
          {
            profile,
            scenarioIds: ["thread-lifecycle"],
          },
          scenarios,
          profiles,
        ),
      ).toThrow("QA runner profile must be a non-empty string");
    }
  });

  it("normalizes the channel driver independently from the provider lane", () => {
    expect(
      normalizeQaRunSelection(
        {
          channelDriver: "crabline",
          providerMode: "live-frontier",
          scenarioIds: ["dm-chat-baseline"],
        },
        scenarios,
        profiles,
      ),
    ).toMatchObject({ channelDriver: "crabline", providerMode: "live-frontier" });
    expect(
      normalizeQaRunSelection(
        {
          channelDriver: "live",
          providerMode: "mock-openai",
          scenarioIds: ["dm-chat-baseline"],
        },
        scenarios,
        profiles,
      ),
    ).toMatchObject({ channelDriver: "live", providerMode: "mock-openai" });
  });

  it("normalizes every server-owned control-plane axis", () => {
    expect(
      normalizeQaRunSelection(
        {
          profile: "all",
          channel: " Telegram ",
          channelDriver: "crabline",
          evidenceMode: "slim",
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.6-luna",
          runtimePair: ["openclaw", "codex"],
          runtimePairLane: "extended",
          scenarioIds: ["dm-chat-baseline"],
        },
        scenarios,
        profiles,
      ),
    ).toMatchObject({
      profile: "all",
      channel: "telegram",
      channelDriver: "crabline",
      evidenceMode: "slim",
      providerMode: "live-frontier",
      runtimePair: ["openclaw", "codex"],
      runtimePairLane: "extended",
      scenarioIds: ["dm-chat-baseline"],
    });
  });

  it("rejects a reversed runtime pair instead of silently changing its order", () => {
    expect(() =>
      normalizeQaRunSelection(
        {
          runtimePair: ["codex", "openclaw"],
        },
        scenarios,
        profiles,
      ),
    ).toThrow('runtimePair must be ["openclaw", "codex"]');
  });

  it("shares implicit profile membership and eligibility with the canonical profile planner", () => {
    const catalog = readQaScenarioPack();
    const scorecardReport = readQaScorecardTaxonomyReport(catalog.scenarios);
    const selection = normalizeQaRunSelection({}, catalog.scenarios, scorecardReport.profiles);
    const membership = resolveQaRunProfileMembership(
      { profile: selection.profile },
      { scenarios: catalog.scenarios, scorecardReport },
    );
    const expected = resolveQaRunProfileExecutionSelection({
      scenarios: membership.selectedScenarios,
      providerMode: selection.providerMode,
      primaryModel: selection.primaryModel,
      channelDriver: selection.channelDriver,
      channel: selection.channel,
    });

    const plan = resolveQaLabRunPlan({ selection, scenarios: catalog.scenarios, scorecardReport });

    expect(plan.status).toBe("ready");
    expect(plan.selectedScenarios.map((scenario) => scenario.id)).toEqual(
      expected.selectedScenarios.map((scenario) => scenario.id),
    );
  });

  it("keeps portable thread scenarios in unpinned live profiles", () => {
    const catalog = readQaScenarioPack();
    const scenarioIds = new Set(["thread-follow-up", "thread-isolation"]);
    const selected = catalog.scenarios.filter((scenario) => scenarioIds.has(scenario.id));

    const execution = resolveQaRunProfileExecutionSelection({
      scenarios: selected,
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      channelDriver: "live",
    });

    expect(execution.selectedScenarios.map((scenario) => scenario.id)).toEqual([
      "thread-follow-up",
      "thread-isolation",
    ]);
    expect(execution.excludedScenarios).toEqual([]);
  });

  it("selects a supported declared transport for portable live scenarios", () => {
    const catalog = readQaScenarioPack();
    const scenario = catalog.scenarios.find((entry) => entry.id === "thread-follow-up");
    if (!scenario) {
      throw new Error("thread-follow-up scenario is missing from the QA catalog");
    }

    const execution = resolveQaRunProfileExecutionSelection({
      scenarios: [scenario],
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      channelDriver: "live",
      supportsChannel: (channel) => channel === "matrix",
    });

    expect(execution.selectedScenarios).toEqual([scenario]);
    expect(execution.excludedScenarios).toEqual([]);
  });

  it("keeps portable threads but excludes module flows from Crabline plans", () => {
    const catalog = readQaScenarioPack();
    const scenarioIds = new Set([
      "matrix-approval-channel-target-both",
      "matrix-approval-deny-reaction",
      "matrix-approval-exec-metadata-chunked",
      "matrix-approval-exec-metadata-single-event",
      "matrix-approval-plugin-metadata-single-event",
      "matrix-approval-thread-target",
      "matrix-mxid-prefixed-command-block",
      "slack-codex-approval-exec-native",
      "slack-codex-approval-plugin-native",
      "thread-follow-up",
      "thread-isolation",
    ]);
    const selected = catalog.scenarios.filter((scenario) => scenarioIds.has(scenario.id));

    const execution = resolveQaRunProfileExecutionSelection({
      scenarios: selected,
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      channelDriver: "crabline",
      defaultChannel: "telegram",
      supportsChannel: () => true,
    });

    expect(execution.selectedScenarios.map((scenario) => scenario.id).toSorted()).toEqual([
      "thread-follow-up",
      "thread-isolation",
    ]);
    expect(
      Object.fromEntries(
        execution.excludedScenarios.map(({ scenario, reasons }) => [scenario.id, reasons]),
      ),
    ).toEqual({
      "matrix-approval-channel-target-both": [
        "module flow unsupported by implementation=crabline:matrix",
      ],
      "matrix-approval-deny-reaction": [
        "module flow unsupported by implementation=crabline:matrix",
      ],
      "matrix-approval-exec-metadata-chunked": [
        "module flow unsupported by implementation=crabline:matrix",
      ],
      "matrix-approval-exec-metadata-single-event": [
        "module flow unsupported by implementation=crabline:matrix",
      ],
      "matrix-approval-plugin-metadata-single-event": [
        "module flow unsupported by implementation=crabline:matrix",
      ],
      "matrix-approval-thread-target": [
        "module flow unsupported by implementation=crabline:matrix",
      ],
      "matrix-mxid-prefixed-command-block": [
        "module flow unsupported by implementation=crabline:matrix",
      ],
      "slack-codex-approval-exec-native": [
        "module flow unsupported by implementation=crabline:slack",
      ],
      "slack-codex-approval-plugin-native": [
        "module flow unsupported by implementation=crabline:slack",
      ],
    });
  });

  it("resolves mixed execution kinds and reports runtime-pair-lane exclusions", () => {
    const catalog = readQaScenarioPack();
    const scorecardReport = readQaScorecardTaxonomyReport(catalog.scenarios);
    const mixedSelection = normalizeQaRunSelection(
      {
        profile: "all",
        channelDriver: "qa-channel",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );
    const mixedPlan = resolveQaLabRunPlan({
      selection: mixedSelection,
      scenarios: catalog.scenarios,
      scorecardReport,
    });
    expect(mixedPlan.status).toBe("ready");
    expect(mixedPlan.executionKinds).toEqual(["flow", "playwright"]);

    const pairSelection = normalizeQaRunSelection(
      {
        profile: "all",
        channelDriver: "qa-channel",
        providerMode: "mock-openai",
        runtimePair: ["openclaw", "codex"],
        runtimePairLane: "core",
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );
    const pairPlan = resolveQaLabRunPlan({
      selection: pairSelection,
      scenarios: catalog.scenarios,
      scorecardReport,
    });
    expect(pairPlan.status).toBe("ready");
    expect(pairPlan.selectedScenarios.map((scenario) => scenario.id)).toContain(
      "runtime-first-hour-20-turn",
    );
    expect(pairPlan.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: "codex-plugin-cold-install",
          reasons: ["runtimePair requires execution.kind=flow"],
        }),
      ]),
    );
  });

  it("validates explicit runtime-pair-lane selections without expanding them", () => {
    const catalog = readQaScenarioPack();
    const scorecardReport = readQaScorecardTaxonomyReport(catalog.scenarios);
    const selectedId = "runtime-first-hour-20-turn";
    const selection = normalizeQaRunSelection(
      {
        profile: "all",
        channelDriver: "qa-channel",
        providerMode: "mock-openai",
        runtimePair: ["openclaw", "codex"],
        runtimePairLane: "core",
        scenarioIds: [selectedId],
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );

    const plan = resolveQaLabRunPlan({ selection, scenarios: catalog.scenarios, scorecardReport });

    expect(plan.status).toBe("ready");
    expect(plan.selectedScenarios.map((scenario) => scenario.id)).toEqual([selectedId]);

    const outsideLaneSelection = normalizeQaRunSelection(
      {
        profile: "all",
        channelDriver: "qa-channel",
        providerMode: "mock-openai",
        runtimePairLane: "core",
        scenarioIds: ["dm-chat-baseline"],
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );
    const outsideLanePlan = resolveQaLabRunPlan({
      selection: outsideLaneSelection,
      scenarios: catalog.scenarios,
      scorecardReport,
    });
    expect(outsideLanePlan.status).toBe("invalid");
    expect(outsideLanePlan.selectedScenarios).toEqual([]);
    expect(outsideLanePlan.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: "dm-chat-baseline",
          reasons: ["runtimePairLane=core"],
        }),
      ]),
    );
  });

  it("does not apply live-adapter eligibility to non-flow executions", () => {
    const catalog = readQaScenarioPack();
    const scorecardReport = readQaScorecardTaxonomyReport(catalog.scenarios);
    const selection = normalizeQaRunSelection(
      {
        profile: "all",
        channelDriver: "live",
        providerMode: "live-frontier",
        scenarioIds: ["browser-talk-start-stop"],
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );

    const plan = resolveQaLabRunPlan({
      selection,
      scenarios: catalog.scenarios,
      scorecardReport,
      supportsChannel: () => false,
    });

    expect(plan.status).toBe("ready");
    expect(plan.selectedScenarios).toEqual([
      expect.objectContaining({
        id: "browser-talk-start-stop",
        effectiveChannel: null,
      }),
    ]);
  });

  it("preserves canonical unresolved live dispatch and rejects unsupported driver channels", () => {
    const catalog = readQaScenarioPack();
    const scorecardReport = readQaScorecardTaxonomyReport(catalog.scenarios);
    const liveSelection = normalizeQaRunSelection(
      {
        profile: "all",
        channelDriver: "live",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline"],
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );
    const unresolvedLivePlan = resolveQaLabRunPlan({
      selection: liveSelection,
      scenarios: catalog.scenarios,
      scorecardReport,
      supportsChannel: () => true,
    });
    expect(unresolvedLivePlan.status).toBe("ready");
    expect(unresolvedLivePlan.selectedScenarios).toEqual([
      expect.objectContaining({ id: "dm-chat-baseline", effectiveChannel: null }),
    ]);

    const crablineSelection = normalizeQaRunSelection(
      {
        profile: "all",
        channel: "qa-channel",
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline"],
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );
    const unsupportedCrablinePlan = resolveQaLabRunPlan({
      selection: crablineSelection,
      scenarios: catalog.scenarios,
      scorecardReport,
      defaultChannel: "telegram",
      supportsChannel: (channel) => channel === "telegram",
    });
    expect(unsupportedCrablinePlan.status).toBe("invalid");
    expect(unsupportedCrablinePlan.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: "dm-chat-baseline",
          reasons: ["unsupported crabline channel=qa-channel"],
        }),
      ]),
    );
  });

  it("selects only scenarios that declare an explicit external channel", () => {
    const catalog = readQaScenarioPack();
    const scorecardReport = readQaScorecardTaxonomyReport(catalog.scenarios);
    const selection = normalizeQaRunSelection(
      {
        profile: "all",
        channel: "discord",
        channelDriver: "crabline",
        providerMode: "mock-openai",
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );

    const plan = resolveQaLabRunPlan({
      selection,
      scenarios: catalog.scenarios,
      scorecardReport,
      defaultChannel: "discord",
      supportsChannel: (channel) => channel === "discord",
    });

    expect(plan.status).toBe("ready");
    expect(plan.selectedScenarios.map((scenario) => scenario.id)).toEqual([
      "discord-crabline-roundtrip",
    ]);
    expect(plan.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenarioId: "compaction-retry-mutating-tool",
          reasons: ["does not declare channel discord"],
        }),
      ]),
    );
  });

  it("rejects an explicit scenario that does not declare the external channel", () => {
    const catalog = readQaScenarioPack();
    const scorecardReport = readQaScorecardTaxonomyReport(catalog.scenarios);
    const selection = normalizeQaRunSelection(
      {
        profile: "all",
        channel: "discord",
        channelDriver: "crabline",
        providerMode: "mock-openai",
        scenarioIds: ["compaction-retry-mutating-tool"],
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );

    const plan = resolveQaLabRunPlan({
      selection,
      scenarios: catalog.scenarios,
      scorecardReport,
      defaultChannel: "discord",
      supportsChannel: (channel) => channel === "discord",
    });

    expect(plan.status).toBe("invalid");
    expect(plan.errors).toContain(
      "Explicit QA scenario selection is not runnable: compaction-retry-mutating-tool (does not declare channel discord).",
    );
  });

  it("fails closed when an explicit scenario conflicts with execution.channel", () => {
    const catalog = readQaScenarioPack();
    const scorecardReport = readQaScorecardTaxonomyReport(catalog.scenarios);
    const scenario = catalog.scenarios.find(
      (entry) => entry.execution.channel && entry.execution.channel !== "qa-channel",
    );
    expect(scenario).toBeDefined();
    const selection = normalizeQaRunSelection(
      {
        profile: "all",
        channelDriver: "qa-channel",
        providerMode: "live-frontier",
        scenarioIds: [scenario!.id],
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );

    const plan = resolveQaLabRunPlan({ selection, scenarios: catalog.scenarios, scorecardReport });

    expect(plan.status).toBe("invalid");
    expect(plan.exclusions).toEqual(
      expect.arrayContaining([expect.objectContaining({ scenarioId: scenario!.id })]),
    );
    expect(plan.errors.join(" ")).toContain("Explicit QA scenario selection is not runnable");
  });

  it("returns an invalid resolved plan for a qa-channel execution override", () => {
    const catalog = readQaScenarioPack();
    const scorecardReport = readQaScorecardTaxonomyReport(catalog.scenarios);
    const selection = normalizeQaRunSelection(
      {
        profile: "all",
        channel: "telegram",
        channelDriver: "qa-channel",
        providerMode: "mock-openai",
        scenarioIds: ["dm-chat-baseline"],
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );

    const plan = resolveQaLabRunPlan({
      selection,
      scenarios: catalog.scenarios,
      scorecardReport,
      defaultChannel: "qa-channel",
    });

    expect(plan.status).toBe("invalid");
    expect(plan.errors).toContain(
      "An execution channel requires channelDriver=crabline or channelDriver=live.",
    );
    expect(plan.selectedScenarios).toEqual([
      expect.objectContaining({ id: "dm-chat-baseline", effectiveChannel: "qa-channel" }),
    ]);
  });

  it("distinguishes declared constraints from the suite-resolved effective channel", () => {
    const catalog = readQaScenarioPack();
    const scorecardReport = readQaScorecardTaxonomyReport(catalog.scenarios);
    const selection = normalizeQaRunSelection(
      {
        profile: "all",
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      },
      catalog.scenarios,
      scorecardReport.profiles,
    );

    const plan = resolveQaLabRunPlan({
      selection,
      scenarios: catalog.scenarios,
      scorecardReport,
      defaultChannel: "telegram",
    });

    expect(plan.selectedScenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "dm-chat-baseline",
          declaredChannel: null,
          effectiveChannel: "telegram",
        }),
        expect.objectContaining({
          id: "browser-talk-start-stop",
          declaredChannel: null,
          effectiveChannel: null,
        }),
      ]),
    );
  });

  it("rejects malformed requests and unknown channel drivers", () => {
    expect(() => normalizeQaRunSelection(null, scenarios, profiles)).toThrow(
      "request must be a JSON object",
    );
    expect(() =>
      normalizeQaRunSelection({ channelDriver: "renamed-cli-policy" }, scenarios, profiles),
    ).toThrow("unknown QA channel driver: renamed-cli-policy");
  });

  it("keeps idle snapshots on static defaults so startup does not inspect auth profiles", () => {
    defaultQaRuntimeModelForMode.mockReturnValue("openai/gpt-5.6-luna");
    defaultQaRuntimeModelForMode.mockClear();

    const selection = createIdleQaRunnerSnapshot(profiles).selection;
    expect(selection.providerMode).toBe("mock-openai");
    expect(selection.primaryModel).toBe("mock-openai/gpt-5.6-luna");
    expect(selection.alternateModel).toBe("mock-openai/gpt-5.6-luna-alt");
    expect(defaultQaRuntimeModelForMode).not.toHaveBeenCalled();
  });

  it("fails closed when required canonical profiles are missing", () => {
    const profilesWithoutSmoke = profiles.filter((profile) => profile.id !== "smoke-ci");
    const profilesWithoutAll = profiles.filter((profile) => profile.id !== "all");

    expect(() => createIdleQaRunnerSnapshot(profilesWithoutSmoke)).toThrow(
      "profile table does not define required profile: smoke-ci",
    );
    expect(() => normalizeQaRunSelection({}, scenarios, profilesWithoutSmoke)).toThrow(
      "profile table does not define required profile: smoke-ci",
    );
    expect(() =>
      normalizeQaRunSelection({ scenarioIds: ["dm-chat-baseline"] }, scenarios, profilesWithoutAll),
    ).toThrow("unknown QA run profile: all");
  });

  it("normalizes aimock selections", () => {
    expect(
      normalizeQaRunSelection(
        {
          providerMode: "aimock",
          primaryModel: "",
          alternateModel: "",
          scenarioIds: ["dm-chat-baseline"],
        },
        scenarios,
        profiles,
      ),
    ).toEqual({
      profile: "all",
      channel: null,
      channelDriver: "live",
      evidenceMode: "full",
      providerMode: "aimock",
      primaryModel: "aimock/gpt-5.6-luna",
      alternateModel: "aimock/gpt-5.6-luna-alt",
      fastMode: false,
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });
  });

  it("anchors generated run output dirs under the provided repo root", () => {
    const repoRoot = path.resolve("/tmp/openclaw-repo");
    const outputDir = createQaRunOutputDir(repoRoot);
    expect(outputDir.startsWith(path.join(repoRoot, ".artifacts", "qa-e2e", "lab-"))).toBe(true);
  });

  it("keeps generated run output dirs unique within the same millisecond", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-23T07:30:00.000Z"));
      const repoRoot = path.resolve("/tmp/openclaw-repo");
      const first = createQaRunOutputDir(repoRoot);
      const second = createQaRunOutputDir(repoRoot);

      expect(first).not.toBe(second);
      expect(path.basename(first)).toMatch(/^lab-2026-06-23-073000000Z-[0-9a-f]{8}$/u);
      expect(path.basename(second)).toMatch(/^lab-2026-06-23-073000000Z-[0-9a-f]{8}$/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the Codex OAuth default when the runtime resolver says it is available", () => {
    defaultQaRuntimeModelForMode.mockImplementation((mode, options) => {
      if (mode === "live-frontier" && !options?.alternate) {
        return "openai/gpt-5.6-luna";
      }
      return defaultQaProviderModelForMode(mode as QaProviderModeInput, options);
    });

    expect(normalizeQaRunSelection({ profile: "release" }, scenarios, profiles)).toEqual({
      profile: "release",
      channel: null,
      channelDriver: "live",
      evidenceMode: "full",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-sol",
      fastMode: true,
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: null,
    });
  });
});
