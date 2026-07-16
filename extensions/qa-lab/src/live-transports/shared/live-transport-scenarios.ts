// Qa Lab plugin module implements live transport scenarios behavior.
import {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  collectLiveTransportStandardScenarioCoverage,
  findMissingLiveTransportStandardScenarios,
  type LiveTransportScenarioDefinition,
  type LiveTransportStandardScenarioId,
} from "openclaw/plugin-sdk/qa-live-transport-scenarios";

export {
  collectLiveTransportStandardScenarioCoverage,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
} from "openclaw/plugin-sdk/qa-live-transport-scenarios";

type LiveTransportCoverageMember = {
  scenarioId?: string;
  standardId: LiveTransportStandardScenarioId;
};

type LiveTransportCoverageLane = {
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

const LIVE_TRANSPORT_COVERAGE_LANES: readonly LiveTransportCoverageLane[] = [
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
    ],
  },
  {
    transportId: "telegram",
    commandName: "telegram",
    members: [
      { standardId: "canary", scenarioId: "channel-canary" },
      { standardId: "help-command", scenarioId: "telegram-help-command" },
      { standardId: "mention-gating", scenarioId: "channel-mention-gating" },
    ],
  },
  {
    transportId: "whatsapp",
    commandName: "whatsapp",
    members: [
      { standardId: "canary", scenarioId: "whatsapp-canary" },
      { standardId: "mention-gating", scenarioId: "whatsapp-mention-gating" },
      { standardId: "top-level-reply-shape", scenarioId: "whatsapp-top-level-reply-shape" },
      { standardId: "restart-resume", scenarioId: "whatsapp-restart-resume" },
      { standardId: "help-command", scenarioId: "whatsapp-help-command" },
      { standardId: "quote-reply", scenarioId: "whatsapp-reply-to-message" },
      { standardId: "quote-reply", scenarioId: "whatsapp-group-reply-to-message" },
      { standardId: "reaction-observation", scenarioId: "whatsapp-status-reactions" },
      { standardId: "allowlist-block", scenarioId: "whatsapp-group-allowlist-block" },
    ],
  },
] as const;

export function buildLiveTransportCoverageLaneSummaries(
  lanes: readonly LiveTransportCoverageLane[] = LIVE_TRANSPORT_COVERAGE_LANES,
): LiveTransportCoverageLaneSummary[] {
  return lanes
    .map((lane) => {
      const scenarios: LiveTransportScenarioDefinition[] = lane.members.map((member) => ({
        id: member.scenarioId ?? `${lane.transportId}:${member.standardId}`,
        standardId: member.standardId,
        timeoutMs: 0,
        title: member.standardId,
      }));
      const standardScenarioIds = collectLiveTransportStandardScenarioCoverage({ scenarios });
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
