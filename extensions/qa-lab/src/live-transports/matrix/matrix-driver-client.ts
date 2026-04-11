import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

type FetchLike = typeof fetch;

type MatrixQaAuthStage = "m.login.dummy" | "m.login.registration_token";

type MatrixQaRequestResult<T> = {
  status: number;
  body: T;
};

type MatrixQaRegisterResponse = {
  access_token?: string;
  device_id?: string;
  user_id?: string;
};

type MatrixQaRoomCreateResponse = {
  room_id?: string;
};

type MatrixQaSendMessageContent = {
  body: string;
  format?: "org.matrix.custom.html";
  formatted_body?: string;
  "m.mentions"?: {
    user_ids?: string[];
  };
  "m.relates_to"?: {
    rel_type: "m.thread";
    event_id: string;
    is_falling_back: true;
    "m.in_reply_to": {
      event_id: string;
    };
  };
  msgtype: "m.text";
};

type MatrixQaSendReactionContent = {
  "m.relates_to": {
    event_id: string;
    key: string;
    rel_type: "m.annotation";
  };
};

type MatrixQaSyncResponse = {
  next_batch?: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: {
          events?: MatrixQaRoomEvent[];
        };
      }
    >;
  };
};

type MatrixQaUiaaResponse = {
  completed?: string[];
  flows?: Array<{ stages?: string[] }>;
  session?: string;
};

type MatrixQaRoomEvent = {
  content?: Record<string, unknown>;
  event_id?: string;
  origin_server_ts?: number;
  sender?: string;
  state_key?: string;
  type?: string;
};

export type MatrixQaObservedEvent = {
  roomId: string;
  eventId: string;
  sender?: string;
  stateKey?: string;
  type: string;
  originServerTs?: number;
  body?: string;
  formattedBody?: string;
  msgtype?: string;
  membership?: string;
  relatesTo?: {
    eventId?: string;
    inReplyToId?: string;
    isFallingBack?: boolean;
    relType?: string;
  };
  mentions?: {
    room?: boolean;
    userIds?: string[];
  };
  reaction?: {
    eventId?: string;
    key?: string;
  };
};

export type MatrixQaRegisteredAccount = {
  accessToken: string;
  deviceId?: string;
  localpart: string;
  password: string;
  userId: string;
};

export type MatrixQaProvisionResult = {
  driver: MatrixQaRegisteredAccount;
  observer: MatrixQaRegisteredAccount;
  roomId: string;
  sut: MatrixQaRegisteredAccount;
};

export type MatrixQaRoomEventWaitResult =
  | {
      event: MatrixQaObservedEvent;
      matched: true;
      since?: string;
    }
  | {
      matched: false;
      since?: string;
    };

function buildMatrixThreadRelation(threadRootEventId: string, replyToEventId?: string) {
  return {
    "m.relates_to": {
      rel_type: "m.thread" as const,
      event_id: threadRootEventId,
      is_falling_back: true as const,
      "m.in_reply_to": {
        event_id: replyToEventId?.trim() || threadRootEventId,
      },
    },
  };
}

function buildMatrixReactionRelation(
  messageId: string,
  emoji: string,
): MatrixQaSendReactionContent {
  const normalizedMessageId = messageId.trim();
  const normalizedEmoji = emoji.trim();
  if (!normalizedMessageId) {
    throw new Error("Matrix reaction requires a messageId");
  }
  if (!normalizedEmoji) {
    throw new Error("Matrix reaction requires an emoji");
  }
  return {
    "m.relates_to": {
      rel_type: "m.annotation",
      event_id: normalizedMessageId,
      key: normalizedEmoji,
    },
  };
}

function escapeMatrixHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function buildMatrixMentionLink(userId: string) {
  const href = `https://matrix.to/#/${encodeURIComponent(userId)}`;
  const label = escapeMatrixHtml(userId);
  return `<a href="${href}">${label}</a>`;
}

function buildMatrixQaMessageContent(params: {
  body: string;
  mentionUserIds?: string[];
  replyToEventId?: string;
  threadRootEventId?: string;
}): MatrixQaSendMessageContent {
  const body = params.body;
  const uniqueMentionUserIds = [...new Set(params.mentionUserIds?.filter(Boolean) ?? [])];
  const formattedParts: string[] = [];
  let cursor = 0;
  let usedFormattedMention = false;

  while (cursor < body.length) {
    let matchedUserId: string | null = null;
    for (const userId of uniqueMentionUserIds) {
      if (body.startsWith(userId, cursor)) {
        matchedUserId = userId;
        break;
      }
    }
    if (matchedUserId) {
      formattedParts.push(buildMatrixMentionLink(matchedUserId));
      cursor += matchedUserId.length;
      usedFormattedMention = true;
      continue;
    }
    formattedParts.push(escapeMatrixHtml(body[cursor] ?? ""));
    cursor += 1;
  }

  return {
    body,
    msgtype: "m.text",
    ...(usedFormattedMention
      ? {
          format: "org.matrix.custom.html" as const,
          formatted_body: formattedParts.join(""),
        }
      : {}),
    ...(uniqueMentionUserIds.length > 0
      ? { "m.mentions": { user_ids: uniqueMentionUserIds } }
      : {}),
    ...(params.threadRootEventId
      ? buildMatrixThreadRelation(params.threadRootEventId, params.replyToEventId)
      : {}),
  };
}

function normalizeMentionUserIds(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
}

export function normalizeMatrixQaObservedEvent(
  roomId: string,
  event: MatrixQaRoomEvent,
): MatrixQaObservedEvent | null {
  const eventId = event.event_id?.trim();
  const type = event.type?.trim();
  if (!eventId || !type) {
    return null;
  }
  const content = event.content ?? {};
  const relatesToRaw = content["m.relates_to"];
  const relatesTo =
    typeof relatesToRaw === "object" && relatesToRaw !== null
      ? (relatesToRaw as Record<string, unknown>)
      : null;
  const inReplyToRaw = relatesTo?.["m.in_reply_to"];
  const inReplyTo =
    typeof inReplyToRaw === "object" && inReplyToRaw !== null
      ? (inReplyToRaw as Record<string, unknown>)
      : null;
  const mentionsRaw = content["m.mentions"];
  const mentions =
    typeof mentionsRaw === "object" && mentionsRaw !== null
      ? (mentionsRaw as Record<string, unknown>)
      : null;
  const mentionUserIds = normalizeMentionUserIds(mentions?.user_ids);
  const reactionKey =
    type === "m.reaction" && typeof relatesTo?.key === "string" ? relatesTo.key : undefined;
  const reactionEventId =
    type === "m.reaction" && typeof relatesTo?.event_id === "string"
      ? relatesTo.event_id
      : undefined;

  return {
    roomId,
    eventId,
    sender: typeof event.sender === "string" ? event.sender : undefined,
    stateKey: typeof event.state_key === "string" ? event.state_key : undefined,
    type,
    originServerTs:
      typeof event.origin_server_ts === "number" ? Math.floor(event.origin_server_ts) : undefined,
    body: typeof content.body === "string" ? content.body : undefined,
    formattedBody: typeof content.formatted_body === "string" ? content.formatted_body : undefined,
    msgtype: typeof content.msgtype === "string" ? content.msgtype : undefined,
    membership: typeof content.membership === "string" ? content.membership : undefined,
    ...(relatesTo
      ? {
          relatesTo: {
            eventId: typeof relatesTo.event_id === "string" ? relatesTo.event_id : undefined,
            inReplyToId: typeof inReplyTo?.event_id === "string" ? inReplyTo.event_id : undefined,
            isFallingBack:
              typeof relatesTo.is_falling_back === "boolean"
                ? relatesTo.is_falling_back
                : undefined,
            relType: typeof relatesTo.rel_type === "string" ? relatesTo.rel_type : undefined,
          },
        }
      : {}),
    ...(mentions
      ? {
          mentions: {
            ...(mentions.room === true ? { room: true } : {}),
            ...(mentionUserIds ? { userIds: mentionUserIds } : {}),
          },
        }
      : {}),
    ...(reactionEventId || reactionKey
      ? {
          reaction: {
            ...(reactionEventId ? { eventId: reactionEventId } : {}),
            ...(reactionKey ? { key: reactionKey } : {}),
          },
        }
      : {}),
  };
}

export function resolveNextRegistrationAuth(params: {
  registrationToken: string;
  response: MatrixQaUiaaResponse;
}) {
  const session = params.response.session?.trim();
  if (!session) {
    throw new Error("Matrix registration UIAA response did not include a session id.");
  }

  const completed = new Set(
    (params.response.completed ?? []).filter(
      (stage): stage is MatrixQaAuthStage =>
        stage === "m.login.dummy" || stage === "m.login.registration_token",
    ),
  );
  const supportedStages = new Set<MatrixQaAuthStage>([
    "m.login.registration_token",
    "m.login.dummy",
  ]);

  for (const flow of params.response.flows ?? []) {
    const flowStages = flow.stages ?? [];
    if (
      flowStages.length === 0 ||
      flowStages.some((stage) => !supportedStages.has(stage as MatrixQaAuthStage))
    ) {
      continue;
    }
    const stages = flowStages as MatrixQaAuthStage[];
    const nextStage = stages.find((stage) => !completed.has(stage));
    if (!nextStage) {
      continue;
    }
    if (nextStage === "m.login.registration_token") {
      return {
        session,
        type: nextStage,
        token: params.registrationToken,
      };
    }
    return {
      session,
      type: nextStage,
    };
  }

  throw new Error(
    `Matrix registration requires unsupported auth stages: ${JSON.stringify(params.response.flows ?? [])}`,
  );
}

async function requestMatrixJson<T>(params: {
  accessToken?: string;
  baseUrl: string;
  body?: unknown;
  endpoint: string;
  fetchImpl: FetchLike;
  method: "GET" | "POST" | "PUT";
  okStatuses?: number[];
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}) {
  const url = new URL(params.endpoint, params.baseUrl);
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await params.fetchImpl(url, {
    method: params.method,
    headers: {
      accept: "application/json",
      ...(params.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(params.accessToken ? { authorization: `Bearer ${params.accessToken}` } : {}),
    },
    ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
    signal: AbortSignal.timeout(params.timeoutMs ?? 20_000),
  });
  let body: unknown = {};
  try {
    body = (await response.json()) as unknown;
  } catch {
    body = {};
  }
  const okStatuses = params.okStatuses ?? [200];
  if (!okStatuses.includes(response.status)) {
    const details =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `${params.method} ${params.endpoint} failed with status ${response.status}`;
    throw new Error(details);
  }
  return {
    status: response.status,
    body: body as T,
  } satisfies MatrixQaRequestResult<T>;
}

function buildRegisteredAccount(params: {
  localpart: string;
  password: string;
  response: MatrixQaRegisterResponse;
}) {
  const userId = params.response.user_id?.trim();
  const accessToken = params.response.access_token?.trim();
  if (!userId || !accessToken) {
    throw new Error("Matrix registration did not return both user_id and access_token.");
  }
  return {
    accessToken,
    deviceId: params.response.device_id?.trim() || undefined,
    localpart: params.localpart,
    password: params.password,
    userId,
  } satisfies MatrixQaRegisteredAccount;
}

export function createMatrixQaClient(params: {
  accessToken?: string;
  baseUrl: string;
  fetchImpl?: FetchLike;
}) {
  const fetchImpl = params.fetchImpl ?? fetch;

  async function waitForOptionalRoomEvent(opts: {
    observedEvents: MatrixQaObservedEvent[];
    predicate: (event: MatrixQaObservedEvent) => boolean;
    roomId: string;
    since?: string;
    timeoutMs: number;
  }): Promise<MatrixQaRoomEventWaitResult> {
    const startedAt = Date.now();
    let since = opts.since;
    while (Date.now() - startedAt < opts.timeoutMs) {
      const remainingMs = Math.max(1_000, opts.timeoutMs - (Date.now() - startedAt));
      const response = await requestMatrixJson<MatrixQaSyncResponse>({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        endpoint: "/_matrix/client/v3/sync",
        fetchImpl,
        method: "GET",
        query: {
          ...(since ? { since } : {}),
          timeout: Math.min(10_000, remainingMs),
        },
        timeoutMs: Math.min(15_000, remainingMs + 5_000),
      });
      since = response.body.next_batch?.trim() || since;
      const roomEvents = response.body.rooms?.join?.[opts.roomId]?.timeline?.events ?? [];
      let matchedEvent: MatrixQaObservedEvent | null = null;
      for (const event of roomEvents) {
        const normalized = normalizeMatrixQaObservedEvent(opts.roomId, event);
        if (!normalized) {
          continue;
        }
        opts.observedEvents.push(normalized);
        if (matchedEvent === null && opts.predicate(normalized)) {
          matchedEvent = normalized;
        }
      }
      if (matchedEvent) {
        return { event: matchedEvent, matched: true, since };
      }
    }
    return { matched: false, since };
  }

  return {
    async createPrivateRoom(opts: { inviteUserIds: string[]; name: string }) {
      const result = await requestMatrixJson<MatrixQaRoomCreateResponse>({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        body: {
          creation_content: { "m.federate": false },
          initial_state: [
            {
              type: "m.room.history_visibility",
              state_key: "",
              content: { history_visibility: "joined" },
            },
          ],
          invite: opts.inviteUserIds,
          is_direct: false,
          name: opts.name,
          preset: "private_chat",
        },
        endpoint: "/_matrix/client/v3/createRoom",
        fetchImpl,
        method: "POST",
      });
      const roomId = result.body.room_id?.trim();
      if (!roomId) {
        throw new Error("Matrix createRoom did not return room_id.");
      }
      return roomId;
    },
    async primeRoom() {
      const response = await requestMatrixJson<MatrixQaSyncResponse>({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        endpoint: "/_matrix/client/v3/sync",
        fetchImpl,
        method: "GET",
        query: { timeout: 0 },
      });
      return response.body.next_batch?.trim() || undefined;
    },
    async registerWithToken(opts: {
      deviceName: string;
      localpart: string;
      password: string;
      registrationToken: string;
    }) {
      let auth: Record<string, unknown> | undefined;
      const baseBody = {
        inhibit_login: false,
        initial_device_display_name: opts.deviceName,
        password: opts.password,
        username: opts.localpart,
      };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await requestMatrixJson<MatrixQaRegisterResponse | MatrixQaUiaaResponse>({
          baseUrl: params.baseUrl,
          body: {
            ...baseBody,
            ...(auth ? { auth } : {}),
          },
          endpoint: "/_matrix/client/v3/register",
          fetchImpl,
          method: "POST",
          okStatuses: [200, 401],
          timeoutMs: 30_000,
        });
        if (response.status === 200) {
          return buildRegisteredAccount({
            localpart: opts.localpart,
            password: opts.password,
            response: response.body as MatrixQaRegisterResponse,
          });
        }
        auth = resolveNextRegistrationAuth({
          registrationToken: opts.registrationToken,
          response: response.body as MatrixQaUiaaResponse,
        });
      }
      throw new Error(
        `Matrix registration for ${opts.localpart} did not complete after 4 attempts.`,
      );
    },
    async sendTextMessage(opts: {
      body: string;
      mentionUserIds?: string[];
      replyToEventId?: string;
      roomId: string;
      threadRootEventId?: string;
    }) {
      const txnId = randomUUID();
      const result = await requestMatrixJson<{ event_id?: string }>({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        body: buildMatrixQaMessageContent(opts),
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        fetchImpl,
        method: "PUT",
      });
      const eventId = result.body.event_id?.trim();
      if (!eventId) {
        throw new Error("Matrix sendMessage did not return event_id.");
      }
      return eventId;
    },
    async sendReaction(opts: { emoji: string; messageId: string; roomId: string }) {
      const txnId = randomUUID();
      const result = await requestMatrixJson<{ event_id?: string }>({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        body: buildMatrixReactionRelation(opts.messageId, opts.emoji),
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/m.reaction/${encodeURIComponent(txnId)}`,
        fetchImpl,
        method: "PUT",
      });
      const eventId = result.body.event_id?.trim();
      if (!eventId) {
        throw new Error("Matrix sendReaction did not return event_id.");
      }
      return eventId;
    },
    async joinRoom(roomId: string) {
      const result = await requestMatrixJson<{ room_id?: string }>({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        body: {},
        endpoint: `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
        fetchImpl,
        method: "POST",
      });
      return result.body.room_id?.trim() || roomId;
    },
    waitForOptionalRoomEvent,
    async waitForRoomEvent(opts: {
      observedEvents: MatrixQaObservedEvent[];
      predicate: (event: MatrixQaObservedEvent) => boolean;
      roomId: string;
      since?: string;
      timeoutMs: number;
    }) {
      const result = await waitForOptionalRoomEvent(opts);
      if (result.matched) {
        return { event: result.event, since: result.since };
      }
      throw new Error(`timed out after ${opts.timeoutMs}ms waiting for Matrix room event`);
    },
  };
}

async function joinRoomWithRetry(params: {
  accessToken: string;
  baseUrl: string;
  fetchImpl?: FetchLike;
  roomId: string;
}) {
  const client = createMatrixQaClient({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    fetchImpl: params.fetchImpl,
  });
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await client.joinRoom(params.roomId);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  throw new Error(`Matrix join retry failed: ${formatErrorMessage(lastError)}`);
}

export async function provisionMatrixQaRoom(params: {
  baseUrl: string;
  fetchImpl?: FetchLike;
  roomName: string;
  driverLocalpart: string;
  observerLocalpart: string;
  registrationToken: string;
  sutLocalpart: string;
}) {
  const anonClient = createMatrixQaClient({
    baseUrl: params.baseUrl,
    fetchImpl: params.fetchImpl,
  });
  const driver = await anonClient.registerWithToken({
    deviceName: "OpenClaw Matrix QA Driver",
    localpart: params.driverLocalpart,
    password: `driver-${randomUUID()}`,
    registrationToken: params.registrationToken,
  });
  const sut = await anonClient.registerWithToken({
    deviceName: "OpenClaw Matrix QA SUT",
    localpart: params.sutLocalpart,
    password: `sut-${randomUUID()}`,
    registrationToken: params.registrationToken,
  });
  const observer = await anonClient.registerWithToken({
    deviceName: "OpenClaw Matrix QA Observer",
    localpart: params.observerLocalpart,
    password: `observer-${randomUUID()}`,
    registrationToken: params.registrationToken,
  });
  const driverClient = createMatrixQaClient({
    accessToken: driver.accessToken,
    baseUrl: params.baseUrl,
    fetchImpl: params.fetchImpl,
  });
  const roomId = await driverClient.createPrivateRoom({
    inviteUserIds: [sut.userId, observer.userId],
    name: params.roomName,
  });
  await joinRoomWithRetry({
    accessToken: sut.accessToken,
    baseUrl: params.baseUrl,
    fetchImpl: params.fetchImpl,
    roomId,
  });
  await joinRoomWithRetry({
    accessToken: observer.accessToken,
    baseUrl: params.baseUrl,
    fetchImpl: params.fetchImpl,
    roomId,
  });
  return {
    driver,
    observer,
    roomId,
    sut,
  } satisfies MatrixQaProvisionResult;
}

export const __testing = {
  buildMatrixQaMessageContent,
  buildMatrixReactionRelation,
  buildMatrixThreadRelation,
  normalizeMatrixQaObservedEvent,
  resolveNextRegistrationAuth,
};
