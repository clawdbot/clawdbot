export * from "./subagent-announce-delivery.js";

type QueueMessageOptions =
  import("./embedded-agent-runner/runs.js").EmbeddedAgentQueueMessageOptions;
type QueueMessageOutcome =
  import("./embedded-agent-runner/runs.js").EmbeddedAgentQueueMessageOutcome;
type DeliveryDeps = {
  callGateway: typeof import("./subagent-announce-delivery.runtime.js").callGateway;
  dispatchGatewayMethodInProcess: typeof import("./subagent-announce-delivery.runtime.js").dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof import("./subagent-announce-delivery.runtime.js").getRuntimeConfig;
  getRequesterSessionActivity: (requesterSessionKey: string) => {
    sessionId?: string;
    isActive: boolean;
  };
  isRequesterSessionAbandoned: (requesterSessionKey: string, sessionId?: string) => boolean;
  loadSessionEntry: typeof import("./subagent-announce-delivery.runtime.js").loadSessionEntry;
  loadRequesterSessionEntry: typeof import("./subagent-announce-delivery.js").loadRequesterSessionEntry;
  queueEmbeddedAgentMessageWithOutcome: (
    sessionId: string,
    text: string,
    options?: QueueMessageOptions,
  ) => QueueMessageOutcome | Promise<QueueMessageOutcome>;
  sendMessage: typeof import("./subagent-announce-delivery.runtime.js").sendMessage;
};

type Testing = {
  setDepsForTest(overrides?: Partial<DeliveryDeps>): void;
  hasAnnounceSendEvidence(error: unknown): boolean;
  hasSessionFileChangedAnnounceError(error: unknown): boolean;
  isSessionFileChangedAnnounceError(message: string): boolean;
};

function getTesting(): Testing {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentAnnounceDeliveryTestApi")
  ] as Testing;
}

export const testing: Testing = {
  setDepsForTest: (overrides) => getTesting().setDepsForTest(overrides),
  hasAnnounceSendEvidence: (error) => getTesting().hasAnnounceSendEvidence(error),
  hasSessionFileChangedAnnounceError: (error) =>
    getTesting().hasSessionFileChangedAnnounceError(error),
  isSessionFileChangedAnnounceError: (message) =>
    getTesting().isSessionFileChangedAnnounceError(message),
};
