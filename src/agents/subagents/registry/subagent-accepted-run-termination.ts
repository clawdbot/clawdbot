import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type AcceptedRunTermination = NonNullable<SubagentRunRecord["acceptedRunTermination"]>;

export function isSameAcceptedRunTermination(
  current: AcceptedRunTermination | undefined,
  expected: AcceptedRunTermination,
): current is AcceptedRunTermination {
  return (
    current?.gatewayRunId === expected.gatewayRunId &&
    current.kind === expected.kind &&
    current.lifecycleGeneration === expected.lifecycleGeneration &&
    current.expectedSessionId === expected.expectedSessionId &&
    current.expectedLifecycleRevision === expected.expectedLifecycleRevision
  );
}
