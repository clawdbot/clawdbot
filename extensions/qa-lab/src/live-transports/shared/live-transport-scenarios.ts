// Qa Lab plugin module implements live transport scenarios behavior.
import {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  collectLiveTransportStandardScenarioCoverage,
  findMissingLiveTransportStandardScenarios,
  type LiveTransportScenarioDefinition,
  type LiveTransportStandardScenarioId,
} from "openclaw/plugin-sdk/qa-live-transport-scenarios";

export {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  collectLiveTransportStandardScenarioCoverage,
  findMissingLiveTransportStandardScenarios,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
  type LiveTransportStandardScenarioId,
} from "openclaw/plugin-sdk/qa-live-transport-scenarios";

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
