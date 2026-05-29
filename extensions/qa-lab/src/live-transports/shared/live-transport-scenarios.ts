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

export type LiveTransportScenarioDefinition<TId extends string = string> = {
  id: TId;
  standardId?: LiveTransportStandardScenarioId;
  timeoutMs: number;
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
    if (!LIVE_TRANSPORT_STANDARD_SCENARIO_ID_SET.has(id)) {
      throw new Error(`unknown live transport standard scenario id: ${id}`);
    }
  }
}

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

export function findMissingLiveTransportStandardScenarios(params: {
  coveredStandardScenarioIds: readonly LiveTransportStandardScenarioId[];
  expectedStandardScenarioIds: readonly LiveTransportStandardScenarioId[];
}) {
  assertKnownStandardScenarioIds(params.coveredStandardScenarioIds);
  assertKnownStandardScenarioIds(params.expectedStandardScenarioIds);
  const covered = new Set(params.coveredStandardScenarioIds);
  return params.expectedStandardScenarioIds.filter((id) => !covered.has(id));
}

export type LiveTransportCoverageMember = {
  scenarioId?: string;
  standardId: LiveTransportStandardScenarioId;
};

export type LiveTransportCoverageLane = {
  commandName: string;
  members: readonly LiveTransportCoverageMember[];
  transportId: string;
};

export type LiveTransportCoverageLaneSummary = {
  baselineMissingStandardScenarioIds: LiveTransportStandardScenarioId[];
  commandName: string;
  memberCount: number;
  members: LiveTransportCoverageMember[];
  standardScenarioIds: LiveTransportStandardScenarioId[];
  transportId: string;
};

export const LIVE_TRANSPORT_COVERAGE_LANES: readonly LiveTransportCoverageLane[] = [
  {
    transportId: "discord",
    commandName: "discord",
    members: [
      { standardId: "canary", scenarioId: "discord-canary" },
      { standardId: "mention-gating", scenarioId: "discord-mention-gating" },
    ],
  },
  {
    transportId: "slack",
    commandName: "slack",
    members: [
      { standardId: "canary", scenarioId: "slack-canary" },
      { standardId: "mention-gating", scenarioId: "slack-mention-gating" },
      { standardId: "allowlist-block", scenarioId: "slack-allowlist-block" },
      { standardId: "top-level-reply-shape", scenarioId: "slack-top-level-reply-shape" },
      { standardId: "restart-resume", scenarioId: "slack-restart-resume" },
      { standardId: "thread-follow-up", scenarioId: "slack-thread-follow-up" },
      { standardId: "thread-isolation", scenarioId: "slack-thread-isolation" },
    ],
  },
  {
    transportId: "telegram",
    commandName: "telegram",
    members: [
      { standardId: "canary" },
      { standardId: "help-command", scenarioId: "telegram-help-command" },
      { standardId: "mention-gating", scenarioId: "telegram-mention-gating" },
    ],
  },
  {
    transportId: "whatsapp",
    commandName: "whatsapp",
    members: [
      { standardId: "canary", scenarioId: "whatsapp-canary" },
      { standardId: "allowlist-block", scenarioId: "whatsapp-pairing-block" },
      { standardId: "mention-gating", scenarioId: "whatsapp-mention-gating" },
    ],
  },
] as const;

export function buildLiveTransportCoverageLaneSummaries(
  lanes: readonly LiveTransportCoverageLane[] = LIVE_TRANSPORT_COVERAGE_LANES,
): LiveTransportCoverageLaneSummary[] {
  return lanes
    .map((lane) => {
      const standardScenarioIds = collectLiveTransportStandardScenarioCoverage({
        scenarios: lane.members.map((member) => ({
          id: member.scenarioId ?? `${lane.transportId}:${member.standardId}`,
          standardId: member.standardId,
          timeoutMs: 0,
          title: member.standardId,
        })),
      });
      return {
        baselineMissingStandardScenarioIds: findMissingLiveTransportStandardScenarios({
          coveredStandardScenarioIds: standardScenarioIds,
          expectedStandardScenarioIds: LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
        }),
        commandName: lane.commandName,
        memberCount: lane.members.length,
        members: [...lane.members],
        standardScenarioIds,
        transportId: lane.transportId,
      };
    })
    .toSorted((left, right) => left.transportId.localeCompare(right.transportId));
}
