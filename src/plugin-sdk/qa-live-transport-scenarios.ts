/** Standard live-transport behavior buckets used to compare channel QA suites. */
export type LiveTransportStandardScenarioId =
  | "canary"
  | "mention-gating"
  | "allowlist-block"
  | "top-level-reply-shape"
  | "restart-resume"
  | "thread-follow-up"
  | "thread-isolation"
  | "reaction-observation"
  | "help-command";

/** Transport-specific live QA scenario with optional mapping to a standard behavior bucket. */
export type LiveTransportScenarioDefinition<TId extends string = string> = {
  /** Transport-specific scenario id accepted by CLI scenario filters. */
  id: TId;
  /** Optional standard coverage bucket this transport-specific scenario proves. */
  standardId?: LiveTransportStandardScenarioId;
  /** Per-scenario timeout for live transport execution. */
  timeoutMs: number;
  /** Human-readable label used in QA output. */
  title: string;
};

type LiveTransportStandardScenarioDefinition = {
  description: string;
  id: LiveTransportStandardScenarioId;
  title: string;
};

const LIVE_TRANSPORT_STANDARD_SCENARIOS: readonly LiveTransportStandardScenarioDefinition[] = [
  {
    id: "canary",
    title: "Transport canary",
    description: "The lane can trigger one known-good reply on the real transport.",
  },
  {
    id: "mention-gating",
    title: "Mention gating",
    description: "Messages without the required mention do not trigger a reply.",
  },
  {
    id: "allowlist-block",
    title: "Sender allowlist block",
    description: "Non-allowlisted senders do not trigger a reply.",
  },
  {
    id: "top-level-reply-shape",
    title: "Top-level reply shape",
    description: "Top-level replies stay top-level when the lane is configured that way.",
  },
  {
    id: "restart-resume",
    title: "Restart resume",
    description: "The lane still responds after a gateway restart.",
  },
  {
    id: "thread-follow-up",
    title: "Thread follow-up",
    description: "Threaded prompts receive threaded replies with the expected relation metadata.",
  },
  {
    id: "thread-isolation",
    title: "Thread isolation",
    description: "Fresh top-level prompts stay out of prior threads.",
  },
  {
    id: "reaction-observation",
    title: "Reaction observation",
    description: "Reaction events are observed and normalized correctly.",
  },
  {
    id: "help-command",
    title: "Help command",
    description: "The transport-specific help command path replies successfully.",
  },
] as const;

/** Minimum standard scenarios expected from baseline live transport suites. */
export const LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS: readonly LiveTransportStandardScenarioId[] =
  [
    "canary",
    "mention-gating",
    "allowlist-block",
    "top-level-reply-shape",
    "restart-resume",
  ] as const;

const LIVE_TRANSPORT_STANDARD_SCENARIO_ID_SET = new Set(
  LIVE_TRANSPORT_STANDARD_SCENARIOS.map((scenario) => scenario.id),
);

function assertKnownStandardScenarioIds(ids: readonly LiveTransportStandardScenarioId[]) {
  for (const id of ids) {
    // Keep typoed standard ids failing at suite-definition time instead of
    // silently weakening baseline coverage comparisons.
    if (!LIVE_TRANSPORT_STANDARD_SCENARIO_ID_SET.has(id)) {
      throw new Error(`unknown live transport standard scenario id: ${id}`);
    }
  }
}

/** Selects requested live transport scenarios and fails fast on unknown ids. */
export function selectLiveTransportScenarios<TDefinition extends { id: string }>(params: {
  ids?: string[];
  laneLabel: string;
  scenarios: readonly TDefinition[];
}) {
  if (!params.ids || params.ids.length === 0) {
    return [...params.scenarios];
  }
  const requested = new Set(params.ids);
  const selected = params.scenarios.filter((scenario) => params.ids?.includes(scenario.id));
  const missingIds = [...requested].filter(
    (id) => !selected.some((scenario) => scenario.id === id),
  );
  if (missingIds.length > 0) {
    throw new Error(`unknown ${params.laneLabel} QA scenario id(s): ${missingIds.join(", ")}`);
  }
  return selected;
}

/** Collects unique standard coverage ids from always-on coverage and scenario metadata. */
export function collectLiveTransportStandardScenarioCoverage<TId extends string>(params: {
  alwaysOnStandardScenarioIds?: readonly LiveTransportStandardScenarioId[];
  scenarios: readonly LiveTransportScenarioDefinition<TId>[];
}) {
  const coverage: LiveTransportStandardScenarioId[] = [];
  const seen = new Set<LiveTransportStandardScenarioId>();
  const append = (id: LiveTransportStandardScenarioId | undefined) => {
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    coverage.push(id);
  };

  assertKnownStandardScenarioIds(params.alwaysOnStandardScenarioIds ?? []);
  for (const id of params.alwaysOnStandardScenarioIds ?? []) {
    append(id);
  }
  for (const scenario of params.scenarios) {
    if (scenario.standardId) {
      assertKnownStandardScenarioIds([scenario.standardId]);
    }
    append(scenario.standardId);
  }
  return coverage;
}

/** Returns expected standard scenario ids that are not covered by the supplied suite. */
export function findMissingLiveTransportStandardScenarios(params: {
  coveredStandardScenarioIds: readonly LiveTransportStandardScenarioId[];
  expectedStandardScenarioIds: readonly LiveTransportStandardScenarioId[];
}) {
  assertKnownStandardScenarioIds(params.coveredStandardScenarioIds);
  assertKnownStandardScenarioIds(params.expectedStandardScenarioIds);
  const covered = new Set(params.coveredStandardScenarioIds);
  return params.expectedStandardScenarioIds.filter((id) => !covered.has(id));
}
