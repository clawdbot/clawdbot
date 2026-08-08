type CloseoutStatus =
  | "recorded"
  | "queued"
  | "confirmed"
  | "uncertain"
  | "manually_confirmed"
  | "completed";

export type CloseoutRecord = {
  closeoutId: string;
  operationId: string;
  agentId: string;
  sourceSessionKey?: string;
  conversationRef: string;
  message: string;
  status: CloseoutStatus;
  attemptCount: number;
  channel?: string;
  messageId?: string;
  messageIdSource?: "platform" | "prepared";
  queueId?: string;
  lastError?: string;
  manualEvidence?: string;
  manualConfirmedBy?: string;
  manualConfirmedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type CloseoutTrackerStore = {
  get: (agentId: string, closeoutId: string) => Promise<CloseoutRecord | undefined>;
  create: (record: CloseoutRecord) => Promise<boolean>;
  put: (record: CloseoutRecord) => Promise<void>;
  list: (agentId: string, limit: number) => Promise<CloseoutRecord[]>;
};

export type ConversationSendResult = {
  status: "sent" | "queued" | "unknown" | "suppressed";
  conversationRef: string;
  channel: string;
  messageId?: string;
  messageIdSource?: "platform" | "prepared";
  queueId?: string;
};

export type ConversationSend = (params: {
  agentId: string;
  sourceSessionKey?: string;
  operationId: string;
  conversationRef: string;
  message: string;
}) => Promise<ConversationSendResult>;

type CloseoutTrackerInput = {
  closeoutId: string;
  agentId: string;
  sourceSessionKey?: string;
  conversationRef: string;
  message: string;
};

export type CloseoutTracker = {
  send: (input: CloseoutTrackerInput) => Promise<CloseoutRecord>;
  reconcile: (agentId: string, closeoutId: string) => Promise<CloseoutRecord>;
  confirm: (
    agentId: string,
    closeoutId: string,
    evidence: string,
    confirmedBy: string,
  ) => Promise<CloseoutRecord>;
  complete: (agentId: string, closeoutId: string) => Promise<CloseoutRecord>;
  get: (agentId: string, closeoutId: string) => Promise<CloseoutRecord | undefined>;
  list: (agentId: string, limit?: number) => Promise<CloseoutRecord[]>;
};

const MAX_CLOSEOUT_ID_LENGTH = 128;
const MAX_AGENT_ID_LENGTH = 128;
const MAX_SESSION_KEY_LENGTH = 512;
const MAX_CONVERSATION_REF_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 16_000;
const MAX_EVIDENCE_LENGTH = 2_000;
const MAX_CONFIRMER_LENGTH = 256;
const MAX_CHANNEL_LENGTH = 64;
const MAX_GATEWAY_ID_LENGTH = 512;

class InvalidGatewayResponseError extends Error {}

function requireText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function normalizeInput(input: CloseoutTrackerInput): CloseoutTrackerInput {
  return {
    closeoutId: requireText(input.closeoutId, "closeoutId", MAX_CLOSEOUT_ID_LENGTH),
    agentId: requireText(input.agentId, "agentId", MAX_AGENT_ID_LENGTH),
    ...(input.sourceSessionKey?.trim()
      ? {
          sourceSessionKey: requireText(
            input.sourceSessionKey,
            "sourceSessionKey",
            MAX_SESSION_KEY_LENGTH,
          ),
        }
      : {}),
    conversationRef: requireText(
      input.conversationRef,
      "conversationRef",
      MAX_CONVERSATION_REF_LENGTH,
    ),
    message: requireText(input.message, "message", MAX_MESSAGE_LENGTH),
  };
}

function normalizeOptionalGatewayText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidGatewayResponseError();
  }
  try {
    return requireText(value, field, maxLength);
  } catch {
    throw new InvalidGatewayResponseError();
  }
}

function normalizeGatewayResult(
  value: unknown,
  expectedConversationRef: string,
): ConversationSendResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidGatewayResponseError();
  }
  const result = value as Record<string, unknown>;
  const status = result.status;
  if (status !== "sent" && status !== "queued" && status !== "unknown" && status !== "suppressed") {
    throw new InvalidGatewayResponseError();
  }
  const conversationRef = normalizeOptionalGatewayText(
    result.conversationRef,
    "conversationRef",
    MAX_CONVERSATION_REF_LENGTH,
  );
  if (conversationRef !== expectedConversationRef) {
    throw new InvalidGatewayResponseError();
  }
  const channel = normalizeOptionalGatewayText(result.channel, "channel", MAX_CHANNEL_LENGTH);
  if (!channel) {
    throw new InvalidGatewayResponseError();
  }
  const messageId = normalizeOptionalGatewayText(
    result.messageId,
    "messageId",
    MAX_GATEWAY_ID_LENGTH,
  );
  const rawMessageIdSource = result.messageIdSource;
  if (
    rawMessageIdSource !== undefined &&
    rawMessageIdSource !== "platform" &&
    rawMessageIdSource !== "prepared"
  ) {
    throw new InvalidGatewayResponseError();
  }
  if (rawMessageIdSource && !messageId) {
    throw new InvalidGatewayResponseError();
  }
  const queueId = normalizeOptionalGatewayText(result.queueId, "queueId", MAX_GATEWAY_ID_LENGTH);
  return {
    status,
    conversationRef,
    channel,
    ...(messageId ? { messageId } : {}),
    ...(rawMessageIdSource ? { messageIdSource: rawMessageIdSource } : {}),
    ...(queueId ? { queueId } : {}),
  };
}

function hasSameInput(record: CloseoutRecord, input: CloseoutTrackerInput): boolean {
  return (
    record.agentId === input.agentId &&
    record.sourceSessionKey === input.sourceSessionKey &&
    record.conversationRef === input.conversationRef &&
    record.message === input.message
  );
}

function deliveryRequestError(): string {
  return "gateway_request_failed";
}

export function summarizeCloseoutRecord(record: CloseoutRecord) {
  return {
    closeoutId: record.closeoutId,
    operationId: record.operationId,
    status: record.status,
    attemptCount: record.attemptCount,
    ...(record.channel ? { channel: record.channel } : {}),
    ...(record.messageId ? { messageId: record.messageId } : {}),
    ...(record.messageIdSource ? { messageIdSource: record.messageIdSource } : {}),
    ...(record.queueId ? { queueId: record.queueId } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createCloseoutTracker(params: {
  store: CloseoutTrackerStore;
  send: ConversationSend;
  now?: () => number;
}): CloseoutTracker {
  const now = params.now ?? Date.now;
  const pendingByRecord = new Map<string, Promise<void>>();

  async function serializeRecordMutation<T>(
    agentId: string,
    closeoutId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([agentId, closeoutId]);
    const predecessor = pendingByRecord.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => current);
    pendingByRecord.set(key, tail);
    await predecessor.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (pendingByRecord.get(key) === tail) {
        pendingByRecord.delete(key);
      }
    }
  }

  async function requireRecord(agentId: string, closeoutId: string): Promise<CloseoutRecord> {
    const normalizedAgentId = requireText(agentId, "agentId", MAX_AGENT_ID_LENGTH);
    const normalizedId = requireText(closeoutId, "closeoutId", MAX_CLOSEOUT_ID_LENGTH);
    const record = await params.store.get(normalizedAgentId, normalizedId);
    if (!record) {
      throw new Error(`closeout ${normalizedId} was not found`);
    }
    return record;
  }

  async function persist(record: CloseoutRecord): Promise<CloseoutRecord> {
    await params.store.put(record);
    return record;
  }

  async function deliver(record: CloseoutRecord): Promise<CloseoutRecord> {
    if (
      record.status === "confirmed" ||
      record.status === "manually_confirmed" ||
      record.status === "completed"
    ) {
      return record;
    }

    const attemptCount = record.attemptCount + 1;
    const updatedAt = now();
    try {
      const result = normalizeGatewayResult(
        await params.send({
          agentId: record.agentId,
          ...(record.sourceSessionKey ? { sourceSessionKey: record.sourceSessionKey } : {}),
          operationId: record.operationId,
          conversationRef: record.conversationRef,
          message: record.message,
        }),
        record.conversationRef,
      );
      if (
        result.status === "sent" &&
        result.messageId?.trim() &&
        result.messageIdSource === "platform"
      ) {
        return await persist({
          ...record,
          status: "confirmed",
          attemptCount,
          channel: result.channel,
          messageId: result.messageId,
          messageIdSource: result.messageIdSource,
          ...(result.queueId ? { queueId: result.queueId } : {}),
          lastError: undefined,
          updatedAt,
        });
      }
      if (result.status === "queued") {
        return await persist({
          ...record,
          status: "queued",
          attemptCount,
          channel: result.channel,
          ...(result.messageId ? { messageId: result.messageId } : {}),
          ...(result.messageIdSource ? { messageIdSource: result.messageIdSource } : {}),
          ...(result.queueId ? { queueId: result.queueId } : {}),
          lastError: undefined,
          updatedAt,
        });
      }
      const lastError =
        result.status === "sent"
          ? "delivery reported sent without a platform receipt"
          : `delivery status is ${result.status}`;
      return await persist({
        ...record,
        status: "uncertain",
        attemptCount,
        channel: result.channel,
        ...(result.messageId ? { messageId: result.messageId } : {}),
        ...(result.messageIdSource ? { messageIdSource: result.messageIdSource } : {}),
        ...(result.queueId ? { queueId: result.queueId } : {}),
        lastError,
        updatedAt,
      });
    } catch (error) {
      return await persist({
        ...record,
        status: "uncertain",
        attemptCount,
        lastError:
          error instanceof InvalidGatewayResponseError
            ? "gateway_response_invalid"
            : deliveryRequestError(),
        updatedAt,
      });
    }
  }

  return {
    async send(input) {
      const normalized = normalizeInput(input);
      return await serializeRecordMutation(normalized.agentId, normalized.closeoutId, async () => {
        const createdAt = now();
        const initial: CloseoutRecord = {
          closeoutId: normalized.closeoutId,
          operationId: `closeout:${normalized.closeoutId}`,
          agentId: normalized.agentId,
          ...(normalized.sourceSessionKey ? { sourceSessionKey: normalized.sourceSessionKey } : {}),
          conversationRef: normalized.conversationRef,
          message: normalized.message,
          status: "recorded",
          attemptCount: 0,
          createdAt,
          updatedAt: createdAt,
        };
        const created = await params.store.create(initial);
        const record = created
          ? initial
          : await requireRecord(normalized.agentId, normalized.closeoutId);
        if (!hasSameInput(record, normalized)) {
          throw new Error(
            `closeout ${normalized.closeoutId} was already recorded with different input`,
          );
        }
        return await deliver(record);
      });
    },
    async reconcile(agentId, closeoutId) {
      const normalizedAgentId = requireText(agentId, "agentId", MAX_AGENT_ID_LENGTH);
      const normalizedId = requireText(closeoutId, "closeoutId", MAX_CLOSEOUT_ID_LENGTH);
      return await serializeRecordMutation(normalizedAgentId, normalizedId, async () =>
        deliver(await requireRecord(normalizedAgentId, normalizedId)),
      );
    },
    async confirm(agentId, closeoutId, evidence, confirmedBy) {
      const normalizedAgentId = requireText(agentId, "agentId", MAX_AGENT_ID_LENGTH);
      const normalizedId = requireText(closeoutId, "closeoutId", MAX_CLOSEOUT_ID_LENGTH);
      const manualEvidence = requireText(evidence, "evidence", MAX_EVIDENCE_LENGTH);
      const manualConfirmedBy = requireText(confirmedBy, "confirmedBy", MAX_CONFIRMER_LENGTH);
      return await serializeRecordMutation(normalizedAgentId, normalizedId, async () => {
        const record = await requireRecord(normalizedAgentId, normalizedId);
        if (
          record.status === "completed" ||
          record.status === "confirmed" ||
          record.status === "manually_confirmed"
        ) {
          return record;
        }
        const manualConfirmedAt = now();
        return await persist({
          ...record,
          status: "manually_confirmed",
          manualEvidence,
          manualConfirmedBy,
          manualConfirmedAt,
          lastError: undefined,
          updatedAt: manualConfirmedAt,
        });
      });
    },
    async complete(agentId, closeoutId) {
      const normalizedAgentId = requireText(agentId, "agentId", MAX_AGENT_ID_LENGTH);
      const normalizedId = requireText(closeoutId, "closeoutId", MAX_CLOSEOUT_ID_LENGTH);
      return await serializeRecordMutation(normalizedAgentId, normalizedId, async () => {
        const record = await requireRecord(normalizedAgentId, normalizedId);
        if (record.status === "completed") {
          return record;
        }
        if (record.status !== "confirmed" && record.status !== "manually_confirmed") {
          throw new Error(`closeout ${record.closeoutId} cannot complete from ${record.status}`);
        }
        return await persist({ ...record, status: "completed", updatedAt: now() });
      });
    },
    get(agentId, closeoutId) {
      return params.store.get(
        requireText(agentId, "agentId", MAX_AGENT_ID_LENGTH),
        requireText(closeoutId, "closeoutId", MAX_CLOSEOUT_ID_LENGTH),
      );
    },
    list(agentId, limit = 50) {
      const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
      return params.store.list(requireText(agentId, "agentId", MAX_AGENT_ID_LENGTH), boundedLimit);
    },
  };
}
