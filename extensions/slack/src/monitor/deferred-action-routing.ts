// Slack plugin module owns workspace-qualified routing for deferred actions.
import type { SlackTargetKind } from "../target-parsing.js";
import type { SlackEventScope } from "./event-scope.js";

type SlackDeferredActionTarget = {
  peerId: string;
  target: string;
};

export function resolveSlackDeferredActionTarget(params: {
  eventScope?: SlackEventScope;
  kind: SlackTargetKind;
  id: string;
}): SlackDeferredActionTarget {
  if (!params.id) {
    throw new Error("Slack deferred action is missing a target ID");
  }
  if (!params.eventScope) {
    return { peerId: params.id, target: `${params.kind}:${params.id}` };
  }
  const target = `team:${encodeURIComponent(params.eventScope.teamId)}:${params.kind}:${encodeURIComponent(params.id)}`;
  return { peerId: target, target };
}
