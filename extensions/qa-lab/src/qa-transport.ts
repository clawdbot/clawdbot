// Qa Lab plugin module implements qa transport behavior.
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import type { QaProviderMode } from "./model-selection.js";
import { extractQaFailureReplyText } from "./reply-failure.js";
import type {
  QaBusEditMessageInput,
  QaBusEvent,
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
  QaBusReadMessageInput,
  QaBusSearchMessagesInput,
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
  isolatedWorkers?: boolean;
};

export type QaTransportGatewayConfig = Pick<OpenClawConfig, "channels" | "messages">;

export type QaTransportPolicy = NonNullable<
  Parameters<NonNullable<QaRunnerCliRegistration["adapterFactory"]>["create"]>[0]["adapterOptions"]
>["transportPolicy"];

export type QaTransportState = {
  reset: () => void | Promise<void>;
  getSnapshot: () => QaBusStateSnapshot;
  addInboundMessage: (input: QaBusInboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
  addOutboundMessage: (input: QaBusOutboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
  editMessage?: (input: QaBusEditMessageInput) => QaBusMessage | Promise<QaBusMessage>;
  readMessage: (
    input: QaBusReadMessageInput,
  ) => QaBusMessage | null | undefined | Promise<QaBusMessage | null | undefined>;
  searchMessages: (input: QaBusSearchMessagesInput) => QaBusMessage[] | Promise<QaBusMessage[]>;
  waitFor: (input: QaBusWaitForInput) => Promise<unknown>;
};

type QaTransportFailureCursorSpace = "all" | "outbound";

type QaTransportFailureAssertionOptions = {
  sinceIndex?: number;
  cursorSpace?: QaTransportFailureCursorSpace;
};

export type QaTransportOutboundMatch = {
  conversation?: QaBusInboundMessageInput["conversation"];
  senderId?: string;
  sinceIndex?: number;
  textIncludes?: string;
  threadId?: string;
  timeoutMs?: number;
};

export type QaTransportWaitForNoOutboundInput = {
  quietMs?: number;
  sinceIndex?: number;
};

export type QaTransportOutboundEvent = {
  cursor: number;
  kind: "sent" | "edited" | "deleted";
  message: QaBusMessage;
};

export type QaTransportOutboundSequenceMatch = {
  conversationId?: string;
  finalSettleMs?: number;
  finalTextIncludes: string;
  minimumPreviewEvents?: number;
  sinceCursor?: number;
  threadId?: string;
  timeoutMs?: number;
};

export type QaTransportOutboundSequence = {
  events: QaTransportOutboundEvent[];
  final: QaBusMessage;
};

export type QaTransportNativeCommandInput = Omit<
  QaBusInboundMessageInput,
  "nativeCommand" | "text"
> & {
  command: string;
};

export async function waitForQaTransportCondition<T>(
  check: () => T | Promise<T | null | undefined> | null | undefined,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const pollIntervalMs = resolveTimerTimeoutMs(intervalMs, 100, 0);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value !== null && value !== undefined) {
      return value;
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
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

function assertNoFailureReplies(
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
        const value = await check();
        assertNoFailureReplies(state, {
          sinceIndex,
          cursorSpace: "all",
        });
        return value;
      },
      timeoutMs,
      intervalMs,
    );
  };
}

type QaTransportAdapterDefinition = Awaited<
  ReturnType<NonNullable<QaRunnerCliRegistration["adapterFactory"]>["create"]>
>;

export type QaTransportAdapter = Omit<
  QaTransportAdapterDefinition,
  "assertTransportHealthy" | "resetTransport"
> & {
  state: QaTransportState;
  reset: () => Promise<void>;
  waitForNoOutbound: (input?: QaTransportWaitForNoOutboundInput) => Promise<void>;
  waitForOutbound: (input: QaTransportOutboundMatch) => Promise<QaBusMessage>;
  waitForCondition: <T>(
    check: () => T | Promise<T | null | undefined> | null | undefined,
    timeoutMs?: number,
    intervalMs?: number,
  ) => Promise<T>;
};

export abstract class QaStateBackedTransportAdapter implements QaTransportAdapter {
  readonly id: string;
  readonly label: string;
  readonly accountId: string;
  readonly requiredPluginIds: readonly string[];
  readonly supportedActions: readonly QaTransportActionName[];
  readonly state: QaTransportState;
  readonly waitForCondition: QaTransportAdapter["waitForCondition"];
  private readonly assertTransportHealthy: () => void;

  constructor(params: {
    id: string;
    label: string;
    accountId: string;
    requiredPluginIds: readonly string[];
    supportedActions?: readonly QaTransportActionName[];
    state: QaTransportState;
    assertTransportHealthy?: () => void;
  }) {
    this.id = params.id;
    this.label = params.label;
    this.accountId = params.accountId;
    this.requiredPluginIds = params.requiredPluginIds;
    this.supportedActions = params.supportedActions ?? [];
    this.state = params.state;
    this.assertTransportHealthy = params.assertTransportHealthy ?? (() => undefined);
    const waitForCondition = createFailureAwareTransportWaitForCondition(this.state);
    this.waitForCondition = async (check, timeoutMs, intervalMs) =>
      await waitForCondition(
        async () => {
          this.assertTransportHealthy();
          return await check();
        },
        timeoutMs,
        intervalMs,
      );
  }

  abstract createGatewayConfig: (params: { baseUrl: string }) => QaTransportGatewayConfig;
  abstract waitReady: (params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) => Promise<void>;
  abstract buildAgentDelivery: (params: { target: string }) => {
    channel: string;
    to?: string;
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

  async reset() {
    this.assertTransportHealthy();
    await this.state.reset();
  }

  async sendInbound(input: QaBusInboundMessageInput) {
    return await this.state.addInboundMessage(input);
  }

  async waitForNoOutbound(input: QaTransportWaitForNoOutboundInput = {}) {
    this.assertTransportHealthy();
    const quietMs = resolveTimerTimeoutMs(input.quietMs, 1_200, 0);
    await sleep(quietMs);
    this.assertTransportHealthy();
    assertNoFailureReplies(this.state, {
      sinceIndex: input.sinceIndex,
      cursorSpace: "outbound",
    });
    const observed = this.outboundSince(input.sinceIndex);
    if (observed.length > 0) {
      const summary = observed.map((message) => `${message.id}:${message.text}`).join("\n");
      throw new Error(`expected no outbound messages for ${quietMs}ms, saw:\n${summary}`);
    }
  }

  async waitForOutbound(input: QaTransportOutboundMatch) {
    return await waitForQaTransportCondition(() => {
      this.assertTransportHealthy();
      assertNoFailureReplies(this.state, {
        sinceIndex: input.sinceIndex,
        cursorSpace: "outbound",
      });
      return this.outboundSince(input.sinceIndex).find((message) => {
        if (input.conversation && message.conversation.id !== input.conversation.id) {
          return false;
        }
        if (input.conversation && message.conversation.kind !== input.conversation.kind) {
          return false;
        }
        if (input.senderId && message.senderId !== input.senderId) {
          return false;
        }
        if (input.threadId && message.threadId !== input.threadId) {
          return false;
        }
        return !input.textIncludes || message.text.includes(input.textIncludes);
      });
    }, input.timeoutMs);
  }

  private outboundSince(sinceIndex = 0) {
    return this.state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound")
      .slice(sinceIndex);
  }
}

export function createQaStateBackedTransportAdapter(
  state: QaTransportState,
  params: QaTransportAdapterDefinition,
): QaTransportAdapter {
  const adapter = new (class extends QaStateBackedTransportAdapter {
    createGatewayConfig = params.createGatewayConfig;
    waitReady = params.waitReady;
    buildAgentDelivery = params.buildAgentDelivery;
    handleAction = params.handleAction;
    createReportNotes = params.createReportNotes;

    override sendInbound = params.sendInbound;

    override async reset() {
      await params.resetTransport?.();
      await super.reset();
    }
  })({
    id: params.id,
    label: params.label,
    accountId: params.accountId,
    requiredPluginIds: params.requiredPluginIds,
    supportedActions: params.supportedActions,
    state,
    assertTransportHealthy: params.assertTransportHealthy,
  });
  Object.assign(adapter, {
    ...(params.sendNativeCommand ? { sendNativeCommand: params.sendNativeCommand } : {}),
    waitForOutboundSequence:
      params.waitForOutboundSequence ??
      (async (input: QaTransportOutboundSequenceMatch) =>
        await waitForQaTransportOutboundSequence({
          input,
          readEvents: () => {
            params.assertTransportHealthy?.();
            return state.getSnapshot().events;
          },
        })),
    ...(params.createRuntimeEnvPatch
      ? { createRuntimeEnvPatch: params.createRuntimeEnvPatch }
      : {}),
    ...(params.cleanup ? { cleanup: params.cleanup } : {}),
  });
  return adapter;
}

function normalizeQaBusOutboundEvent(event: QaBusEvent): QaTransportOutboundEvent | null {
  switch (event.kind) {
    case "outbound-message":
      return { cursor: event.cursor, kind: "sent", message: event.message };
    case "message-edited":
      return { cursor: event.cursor, kind: "edited", message: event.message };
    case "message-deleted":
      return { cursor: event.cursor, kind: "deleted", message: event.message };
    default:
      return null;
  }
}

function isQaTransportOutboundEvent(
  event: QaBusEvent | QaTransportOutboundEvent,
): event is QaTransportOutboundEvent {
  return event.kind === "sent" || event.kind === "edited" || event.kind === "deleted";
}

export async function waitForQaTransportOutboundSequence(params: {
  input: QaTransportOutboundSequenceMatch;
  readEvents: () =>
    | readonly (QaBusEvent | QaTransportOutboundEvent)[]
    | Promise<readonly (QaBusEvent | QaTransportOutboundEvent)[]>;
}): Promise<QaTransportOutboundSequence> {
  const minimumPreviewEvents = params.input.minimumPreviewEvents ?? 1;
  const finalSettleMs = params.input.finalSettleMs ?? 300;
  let stableCursor: number | null = null;
  let stableSince = 0;
  return await waitForQaTransportCondition(async () => {
    const events = (await params.readEvents())
      .filter((event) => event.cursor > (params.input.sinceCursor ?? 0))
      .map((event) =>
        isQaTransportOutboundEvent(event) ? event : normalizeQaBusOutboundEvent(event),
      )
      .filter((event): event is QaTransportOutboundEvent => event !== null)
      .filter(({ message }) => {
        if (
          params.input.conversationId &&
          message.conversation.id !== params.input.conversationId
        ) {
          return false;
        }
        return !params.input.threadId || message.threadId === params.input.threadId;
      });
    const finalIndex = events.findLastIndex(
      ({ kind, message }) =>
        kind !== "deleted" && message.text.includes(params.input.finalTextIncludes),
    );
    if (finalIndex < 0) {
      return undefined;
    }
    const candidate = events[finalIndex];
    if (!candidate) {
      return undefined;
    }
    const sequenceEvents = events.filter(({ message }) => message.id === candidate.message.id);
    const latest = sequenceEvents.at(-1);
    if (
      !latest ||
      latest.kind === "deleted" ||
      !latest.message.text.includes(params.input.finalTextIncludes)
    ) {
      stableCursor = null;
      return undefined;
    }
    const previewEvents = sequenceEvents.filter(
      ({ cursor, kind, message }) =>
        cursor < candidate.cursor &&
        kind !== "deleted" &&
        !message.text.includes(params.input.finalTextIncludes),
    );
    if (previewEvents.length < minimumPreviewEvents) {
      return undefined;
    }
    if (stableCursor !== latest.cursor) {
      stableCursor = latest.cursor;
      stableSince = Date.now();
      return finalSettleMs === 0 ? { events: sequenceEvents, final: latest.message } : undefined;
    }
    if (Date.now() - stableSince < finalSettleMs) {
      return undefined;
    }
    return {
      events: sequenceEvents,
      final: latest.message,
    };
  }, params.input.timeoutMs);
}
