import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { QaProviderMode } from "./model-selection.js";
import { extractQaFailureReplyText } from "./reply-failure.js";
import type {
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
  QaBusSearchMessagesInput,
  QaBusReadMessageInput,
  QaBusStateSnapshot,
  QaBusWaitForInput,
} from "./runtime-api.js";

export type QaTransportGatewayClient = {
  call: (
    method: string,
    params?: unknown,
    options?: {
      timeoutMs?: number;
    },
  ) => Promise<unknown>;
};

export type QaTransportActionName = "delete" | "edit" | "react" | "thread-create";

export type QaTransportReportParams = {
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
};

export type QaTransportGatewayConfig = Pick<OpenClawConfig, "channels" | "messages">;

export type QaTransportState = {
  reset: () => void | Promise<void>;
  getSnapshot: () => QaBusStateSnapshot;
  addInboundMessage: (input: QaBusInboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
  addOutboundMessage: (input: QaBusOutboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
  readMessage: (
    input: QaBusReadMessageInput,
  ) => QaBusMessage | null | undefined | Promise<QaBusMessage | null | undefined>;
  searchMessages: (input: QaBusSearchMessagesInput) => QaBusMessage[] | Promise<QaBusMessage[]>;
  waitFor: (input: QaBusWaitForInput) => Promise<unknown>;
};

export type QaTransportFailureCursorSpace = "all" | "outbound";

export type QaTransportFailureAssertionOptions = {
  sinceIndex?: number;
  cursorSpace?: QaTransportFailureCursorSpace;
};

export type QaTransportCommonCapabilities = {
  sendInboundMessage: QaTransportState["addInboundMessage"];
  injectOutboundMessage: QaTransportState["addOutboundMessage"];
  waitForOutboundMessage: (input: QaBusWaitForInput) => Promise<unknown>;
  getNormalizedMessageState: () => QaBusStateSnapshot;
  resetNormalizedMessageState: () => Promise<void>;
  readNormalizedMessage: QaTransportState["readMessage"];
  executeGenericAction: (params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Promise<unknown>;
  waitForReady: (params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
  }) => Promise<void>;
  waitForCondition: <T>(
    check: () => T | Promise<T | null | undefined> | null | undefined,
    timeoutMs?: number,
    intervalMs?: number,
  ) => Promise<T>;
  assertNoFailureReplies: (options?: QaTransportFailureAssertionOptions) => void;
};

export async function waitForQaTransportCondition<T>(
  check: () => T | Promise<T | null | undefined> | null | undefined,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value !== null && value !== undefined) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

export function findFailureOutboundMessage(
  state: QaTransportState,
  options?: QaTransportFailureAssertionOptions,
) {
  const cursorSpace = options?.cursorSpace ?? "outbound";
  const observedMessages =
    cursorSpace === "all"
      ? state.getSnapshot().messages.slice(options?.sinceIndex ?? 0)
      : state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .slice(options?.sinceIndex ?? 0);
  return observedMessages.find(
    (message) =>
      message.direction === "outbound" && Boolean(extractQaFailureReplyText(message.text)),
  );
}

export function assertNoFailureReplies(
  state: QaTransportState,
  options?: QaTransportFailureAssertionOptions,
) {
  const failureMessage = findFailureOutboundMessage(state, options);
  if (failureMessage) {
    throw new Error(extractQaFailureReplyText(failureMessage.text) ?? failureMessage.text);
  }
}

export function createFailureAwareTransportWaitForCondition(state: QaTransportState) {
  return async function waitForTransportCondition<T>(
    check: () => T | Promise<T | null | undefined> | null | undefined,
    timeoutMs = 15_000,
    intervalMs = 100,
  ): Promise<T> {
    const sinceIndex = state.getSnapshot().messages.length;
    return await waitForQaTransportCondition(
      async () => {
        assertNoFailureReplies(state, {
          sinceIndex,
          cursorSpace: "all",
        });
        return await check();
      },
      timeoutMs,
      intervalMs,
    );
  };
}

export type QaTransportAdapter = {
  id: string;
  label: string;
  accountId: string;
  requiredPluginIds: readonly string[];
  state: QaTransportState;
  capabilities: QaTransportCommonCapabilities;
  createGatewayConfig: (params: { baseUrl: string }) => QaTransportGatewayConfig;
  waitReady: (params: { gateway: QaTransportGatewayClient; timeoutMs?: number }) => Promise<void>;
  buildAgentDelivery: (params: { target: string }) => {
    channel: string;
    replyChannel: string;
    replyTo: string;
  };
  handleAction: (params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Promise<unknown>;
  createReportNotes: (params: QaTransportReportParams) => string[];
};

export abstract class QaStateBackedTransportAdapter implements QaTransportAdapter {
  readonly id: string;
  readonly label: string;
  readonly accountId: string;
  readonly requiredPluginIds: readonly string[];
  readonly state: QaTransportState;
  readonly capabilities: QaTransportCommonCapabilities;

  protected constructor(params: {
    id: string;
    label: string;
    accountId: string;
    requiredPluginIds: readonly string[];
    state: QaTransportState;
  }) {
    this.id = params.id;
    this.label = params.label;
    this.accountId = params.accountId;
    this.requiredPluginIds = params.requiredPluginIds;
    this.state = params.state;
    this.capabilities = {
      sendInboundMessage: this.state.addInboundMessage.bind(this.state),
      injectOutboundMessage: this.state.addOutboundMessage.bind(this.state),
      waitForOutboundMessage: this.state.waitFor.bind(this.state),
      getNormalizedMessageState: this.state.getSnapshot.bind(this.state),
      resetNormalizedMessageState: async () => {
        await this.state.reset();
      },
      readNormalizedMessage: this.state.readMessage.bind(this.state),
      executeGenericAction: (params) => this.handleAction(params),
      waitForReady: (params) => this.waitReady(params),
      waitForCondition: createFailureAwareTransportWaitForCondition(this.state),
      assertNoFailureReplies: (options) => {
        assertNoFailureReplies(this.state, options);
      },
    };
  }

  abstract createGatewayConfig: (params: { baseUrl: string }) => QaTransportGatewayConfig;
  abstract waitReady: (params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
  }) => Promise<void>;
  abstract buildAgentDelivery: (params: { target: string }) => {
    channel: string;
    replyChannel: string;
    replyTo: string;
  };
  abstract handleAction: (params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Promise<unknown>;
  abstract createReportNotes: (params: QaTransportReportParams) => string[];
}
