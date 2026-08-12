export * from "./subagent-announce-delivery.js";

type QueueMessageOptions =
  import("../../embedded-agent-runner/runs.js").EmbeddedAgentQueueMessageOptions;
type QueueMessageOutcome =
  import("../../embedded-agent-runner/runs.js").EmbeddedAgentQueueMessageOutcome;
type RuntimeDeliveryDeps =
  import("./subagent-announce-delivery.runtime.js").SubagentAnnounceDeliveryDeps;
type DeliveryDeps = Omit<
  RuntimeDeliveryDeps,
  "getRequesterSessionActivity" | "queueEmbeddedAgentMessageWithOutcome"
> & {
  getRequesterSessionActivity: (
    requesterSessionKey: string,
    requesterAgentId?: string,
  ) => {
    sessionId?: string;
    isActive: boolean;
  };
  queueEmbeddedAgentMessageWithOutcome: (
    sessionId: string,
    text: string,
    options?: QueueMessageOptions,
  ) => QueueMessageOutcome | Promise<QueueMessageOutcome>;
};

type Testing = {
  setDepsForTest(overrides?: Partial<DeliveryDeps>): void;
  hasAnnounceSendEvidence(error: unknown): boolean;
  hasWriterClaimReboundAnnounceError(error: unknown): boolean;
  isWriterClaimReboundAnnounceError(error: unknown): boolean;
};

function getTesting(): Testing {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentAnnounceDeliveryTestApi")
  ] as Testing;
}

export const testing: Testing = {
  setDepsForTest: (overrides) => getTesting().setDepsForTest(overrides),
  hasAnnounceSendEvidence: (error) => getTesting().hasAnnounceSendEvidence(error),
  hasWriterClaimReboundAnnounceError: (error) =>
    getTesting().hasWriterClaimReboundAnnounceError(error),
  isWriterClaimReboundAnnounceError: (error) =>
    getTesting().isWriterClaimReboundAnnounceError(error),
};
