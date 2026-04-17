import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MatrixQaObservedEvent } from "./events.js";
import { requestMatrixJson, type MatrixQaFetchLike } from "./request.js";
import {
  createMatrixQaRoomObserver,
  primeMatrixQaRoom,
  waitForMatrixQaRoomEvent,
  waitForOptionalMatrixQaRoomEvent,
  type MatrixQaRoomObserver,
  type MatrixQaRoomEventWaitResult,
} from "./sync.js";
import {
  findMatrixQaProvisionedRoom,
  type MatrixQaParticipantRole,
  type MatrixQaProvisionedTopology,
  type MatrixQaTopologyRoomSpec,
  type MatrixQaTopologySpec,
} from "./topology.js";

export type { MatrixQaObservedEvent } from "./events.js";
export type { MatrixQaRoomEventWaitResult, MatrixQaRoomObserver } from "./sync.js";

type MatrixQaAuthStage = "m.login.dummy" | "m.login.registration_token";

type MatrixQaRegisterResponse = {
  access_token?: string;
  device_id?: string;
  user_id?: string;
};

type MatrixQaLoginResponse = MatrixQaRegisterResponse;

type MatrixQaRoomCreateResponse = {
  room_id?: string;
};

type MatrixQaSendMessageContent = {
  body: string;
  format?: "org.matrix.custom.html";
  formatted_body?: string;
  "m.new_content"?: MatrixQaSendMessageContent;
  "m.mentions"?: {
    user_ids?: string[];
  };
  "m.relates_to"?:
    | {
        rel_type: "m.thread";
        event_id: string;
        is_falling_back: true;
        "m.in_reply_to": {
          event_id: string;
        };
      }
    | {
        rel_type: "m.replace";
        event_id: string;
      };
  msgtype: "m.text";
};

type MatrixQaMediaMessageType = "m.audio" | "m.file" | "m.image" | "m.video";

type MatrixQaSendMediaMessageContent = Omit<MatrixQaSendMessageContent, "msgtype"> & {
  filename?: string;
  info?: {
    mimetype?: string;
    size?: number;
  };
  msgtype: MatrixQaMediaMessageType;
  url: string;
};

type MatrixQaSendReactionContent = {
  "m.relates_to": {
    event_id: string;
    key: string;
    rel_type: "m.annotation";
  };
};

type MatrixQaRoomInitialState = Array<{
  content: Record<string, unknown>;
  state_key: string;
  type: string;
}>;

type MatrixQaUiaaResponse = {
  completed?: string[];
  flows?: Array<{ stages?: string[] }>;
  session?: string;
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
  topology: MatrixQaProvisionedTopology;
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

function buildMatrixReplacementRelation(targetEventId: string) {
  const normalizedTargetEventId = targetEventId.trim();
  if (!normalizedTargetEventId) {
    throw new Error("Matrix replacement requires a target event id");
  }
  return {
    "m.relates_to": {
      rel_type: "m.replace" as const,
      event_id: normalizedTargetEventId,
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

function buildMatrixQaRoomInitialState(encrypted?: boolean): MatrixQaRoomInitialState {
  const initialState: MatrixQaRoomInitialState = [
    {
      type: "m.room.history_visibility",
      state_key: "",
      content: { history_visibility: "joined" },
    },
  ];
  if (encrypted === true) {
    initialState.push({
      type: "m.room.encryption",
      state_key: "",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    });
  }
  return initialState;
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

export function buildMatrixQaMessageContent(params: {
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

function buildMatrixQaReplacementMessageContent(params: {
  body: string;
  mentionUserIds?: string[];
  targetEventId: string;
}): MatrixQaSendMessageContent {
  const newContent = buildMatrixQaMessageContent({
    body: params.body,
    mentionUserIds: params.mentionUserIds,
  });
  return {
    body: `* ${params.body}`,
    msgtype: "m.text",
    "m.new_content": newContent,
    ...buildMatrixReplacementRelation(params.targetEventId),
  };
}

function resolveMatrixQaMediaMsgtype(params: {
  contentType?: string;
  kind?: "audio" | "file" | "image" | "video";
}): MatrixQaMediaMessageType {
  if (params.kind === "audio" || params.contentType?.startsWith("audio/")) {
    return "m.audio";
  }
  if (params.kind === "video" || params.contentType?.startsWith("video/")) {
    return "m.video";
  }
  if (params.kind === "image" || params.contentType?.startsWith("image/")) {
    return "m.image";
  }
  return "m.file";
}

function buildMatrixQaMediaMessageContent(params: {
  body?: string;
  contentType?: string;
  fileName?: string;
  kind?: "audio" | "file" | "image" | "video";
  mentionUserIds?: string[];
  replyToEventId?: string;
  size: number;
  threadRootEventId?: string;
  url: string;
}): MatrixQaSendMediaMessageContent {
  const normalizedBody = params.body?.trim() || params.fileName?.trim() || "(file)";
  const content = buildMatrixQaMessageContent({
    body: normalizedBody,
    mentionUserIds: params.mentionUserIds,
    replyToEventId: params.replyToEventId,
    threadRootEventId: params.threadRootEventId,
  });
  return {
    ...content,
    filename: params.fileName?.trim() || undefined,
    info: {
      ...(params.contentType ? { mimetype: params.contentType } : {}),
      size: params.size,
    },
    msgtype: resolveMatrixQaMediaMsgtype({
      contentType: params.contentType,
      kind: params.kind,
    }),
    url: params.url,
  };
}

async function uploadMatrixQaContent(params: {
  accessToken?: string;
  baseUrl: string;
  buffer: Buffer;
  contentType?: string;
  fetchImpl: MatrixQaFetchLike;
  fileName?: string;
}) {
  const url = new URL("/_matrix/media/v3/upload", params.baseUrl);
  const fileName = params.fileName?.trim();
  if (fileName) {
    url.searchParams.set("filename", fileName);
  }
  const uploadBody: Uint8Array<ArrayBuffer> =
    params.buffer.buffer instanceof ArrayBuffer
      ? new Uint8Array(params.buffer.buffer, params.buffer.byteOffset, params.buffer.byteLength)
      : Uint8Array.from(params.buffer);
  const response = await params.fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": params.contentType ?? "application/octet-stream",
      ...(params.accessToken ? { authorization: `Bearer ${params.accessToken}` } : {}),
    },
    body: uploadBody,
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    content_uri?: string;
    error?: string;
  };
  if (response.status !== 200) {
    throw new Error(body.error ?? `Matrix media upload failed with status ${response.status}`);
  }
  const contentUri = body.content_uri?.trim();
  if (!contentUri) {
    throw new Error("Matrix media upload did not return content_uri.");
  }
  return contentUri;
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

function resolveMatrixQaLoginUser(params: { localpart?: string; userId?: string }) {
  const user = params.userId?.trim() || params.localpart?.trim();
  if (!user) {
    throw new Error("Matrix password login requires a localpart or userId.");
  }
  return user;
}

export function createMatrixQaClient(params: {
  accessToken?: string;
  baseUrl: string;
  fetchImpl?: MatrixQaFetchLike;
  syncObserver?: MatrixQaRoomObserver;
}) {
  const fetchImpl = params.fetchImpl ?? fetch;
  const syncObserver = params.syncObserver;
  const sendEvent = async (opts: { body: unknown; endpoint: string; errorLabel: string }) => {
    const result = await requestMatrixJson<{ event_id?: string }>({
      accessToken: params.accessToken,
      baseUrl: params.baseUrl,
      body: opts.body,
      endpoint: opts.endpoint,
      fetchImpl,
      method: "PUT",
    });
    const eventId = result.body.event_id?.trim();
    if (!eventId) {
      throw new Error(`Matrix ${opts.errorLabel} did not return event_id.`);
    }
    return eventId;
  };

  return {
    async createPrivateRoom(opts: {
      encrypted?: boolean;
      inviteUserIds: string[];
      isDirect?: boolean;
      name: string;
    }) {
      const result = await requestMatrixJson<MatrixQaRoomCreateResponse>({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        body: {
          creation_content: { "m.federate": false },
          initial_state: buildMatrixQaRoomInitialState(opts.encrypted),
          invite: opts.inviteUserIds,
          is_direct: opts.isDirect === true,
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
      if (syncObserver) {
        return await syncObserver.prime();
      }
      return await primeMatrixQaRoom({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        fetchImpl,
      });
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
    async loginWithPassword(opts: {
      deviceName: string;
      localpart?: string;
      password: string;
      userId?: string;
    }) {
      const result = await requestMatrixJson<MatrixQaLoginResponse>({
        baseUrl: params.baseUrl,
        body: {
          type: "m.login.password",
          identifier: {
            type: "m.id.user",
            user: resolveMatrixQaLoginUser(opts),
          },
          initial_device_display_name: opts.deviceName,
          password: opts.password,
        },
        endpoint: "/_matrix/client/v3/login",
        fetchImpl,
        method: "POST",
        timeoutMs: 30_000,
      });
      return buildRegisteredAccount({
        localpart: opts.localpart ?? opts.userId ?? "",
        password: opts.password,
        response: result.body,
      });
    },
    async sendTextMessage(opts: {
      body: string;
      mentionUserIds?: string[];
      replyToEventId?: string;
      roomId: string;
      threadRootEventId?: string;
    }) {
      const txnId = randomUUID();
      return await sendEvent({
        body: buildMatrixQaMessageContent(opts),
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        errorLabel: "sendMessage",
      });
    },
    async sendReplacementMessage(opts: {
      body: string;
      mentionUserIds?: string[];
      roomId: string;
      targetEventId: string;
    }) {
      const txnId = randomUUID();
      return await sendEvent({
        body: buildMatrixQaReplacementMessageContent(opts),
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        errorLabel: "sendReplacementMessage",
      });
    },
    async sendMediaMessage(opts: {
      body?: string;
      buffer: Buffer;
      contentType?: string;
      fileName?: string;
      kind?: "audio" | "file" | "image" | "video";
      mentionUserIds?: string[];
      replyToEventId?: string;
      roomId: string;
      threadRootEventId?: string;
    }) {
      const contentUri = await uploadMatrixQaContent({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        buffer: opts.buffer,
        contentType: opts.contentType,
        fetchImpl,
        fileName: opts.fileName,
      });
      const txnId = randomUUID();
      return await sendEvent({
        body: buildMatrixQaMediaMessageContent({
          body: opts.body,
          contentType: opts.contentType,
          fileName: opts.fileName,
          kind: opts.kind,
          mentionUserIds: opts.mentionUserIds,
          replyToEventId: opts.replyToEventId,
          size: opts.buffer.byteLength,
          threadRootEventId: opts.threadRootEventId,
          url: contentUri,
        }),
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        errorLabel: "sendMediaMessage",
      });
    },
    async redactEvent(opts: { eventId: string; reason?: string; roomId: string }) {
      const txnId = randomUUID();
      const reason = opts.reason?.trim();
      return await sendEvent({
        body: reason ? { reason } : {},
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/redact/${encodeURIComponent(opts.eventId)}/${encodeURIComponent(txnId)}`,
        errorLabel: "redactEvent",
      });
    },
    async sendReaction(opts: { emoji: string; messageId: string; roomId: string }) {
      const txnId = randomUUID();
      return await sendEvent({
        body: buildMatrixReactionRelation(opts.messageId, opts.emoji),
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/m.reaction/${encodeURIComponent(txnId)}`,
        errorLabel: "sendReaction",
      });
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
    async inviteUserToRoom(opts: { roomId: string; userId: string }) {
      await requestMatrixJson<Record<string, never>>({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        body: {
          user_id: opts.userId,
        },
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/invite`,
        fetchImpl,
        method: "POST",
      });
    },
    async kickUserFromRoom(opts: { reason?: string; roomId: string; userId: string }) {
      await requestMatrixJson<Record<string, never>>({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        body: {
          user_id: opts.userId,
          ...(opts.reason?.trim() ? { reason: opts.reason.trim() } : {}),
        },
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/kick`,
        fetchImpl,
        method: "POST",
      });
    },
    async leaveRoom(roomId: string) {
      await requestMatrixJson<Record<string, never>>({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        body: {},
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
        fetchImpl,
        method: "POST",
      });
    },
    waitForOptionalRoomEvent(opts: {
      observedEvents: MatrixQaObservedEvent[];
      predicate: (event: MatrixQaObservedEvent) => boolean;
      roomId: string;
      since?: string;
      timeoutMs: number;
    }) {
      if (syncObserver) {
        return syncObserver.waitForOptionalRoomEvent({
          predicate: opts.predicate,
          roomId: opts.roomId,
          timeoutMs: opts.timeoutMs,
        });
      }
      return waitForOptionalMatrixQaRoomEvent({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        fetchImpl,
        ...opts,
      });
    },
    async waitForRoomEvent(opts: {
      observedEvents: MatrixQaObservedEvent[];
      predicate: (event: MatrixQaObservedEvent) => boolean;
      roomId: string;
      since?: string;
      timeoutMs: number;
    }) {
      if (syncObserver) {
        return await syncObserver.waitForRoomEvent({
          predicate: opts.predicate,
          roomId: opts.roomId,
          timeoutMs: opts.timeoutMs,
        });
      }
      return await waitForMatrixQaRoomEvent({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
        fetchImpl,
        ...opts,
      });
    },
  };
}

async function joinRoomWithRetry(params: {
  accessToken: string;
  baseUrl: string;
  fetchImpl?: MatrixQaFetchLike;
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
      await sleep(300 * attempt);
    }
  }
  throw new Error(`Matrix join retry failed: ${formatErrorMessage(lastError)}`);
}

function resolveProvisionedRoomRequireMention(room: MatrixQaTopologyRoomSpec) {
  return room.kind === "group" ? room.requireMention !== false : false;
}

function resolveTopologyMemberAccounts(
  accounts: Record<MatrixQaParticipantRole, MatrixQaRegisteredAccount>,
  memberRoles: MatrixQaParticipantRole[],
) {
  const uniqueRoles = [...new Set(memberRoles)];
  if (uniqueRoles.length === 0) {
    throw new Error("Matrix QA room provisioning requires at least one member");
  }
  return uniqueRoles.map((role) => ({
    role,
    account: accounts[role],
  }));
}

async function provisionMatrixQaTopology(params: {
  accounts: Record<MatrixQaParticipantRole, MatrixQaRegisteredAccount>;
  baseUrl: string;
  fetchImpl?: MatrixQaFetchLike;
  spec: MatrixQaTopologySpec;
}): Promise<MatrixQaProvisionedTopology> {
  const rooms = [];

  for (const room of params.spec.rooms) {
    const members = resolveTopologyMemberAccounts(params.accounts, room.members);
    const creator = members[0];
    const invitees = members.slice(1);
    const creatorClient = createMatrixQaClient({
      accessToken: creator.account.accessToken,
      baseUrl: params.baseUrl,
      fetchImpl: params.fetchImpl,
    });
    const roomId = await creatorClient.createPrivateRoom({
      encrypted: room.encrypted === true,
      inviteUserIds: invitees.map((entry) => entry.account.userId),
      isDirect: room.kind === "dm",
      name: room.name,
    });
    await Promise.all(
      invitees.map((invitee) =>
        joinRoomWithRetry({
          accessToken: invitee.account.accessToken,
          baseUrl: params.baseUrl,
          fetchImpl: params.fetchImpl,
          roomId,
        }),
      ),
    );
    rooms.push({
      encrypted: room.encrypted === true,
      key: room.key,
      kind: room.kind,
      memberRoles: members.map((entry) => entry.role),
      memberUserIds: members.map((entry) => entry.account.userId),
      name: room.name,
      requireMention: resolveProvisionedRoomRequireMention(room),
      roomId,
    });
  }

  const defaultRoom = findMatrixQaProvisionedRoom(
    {
      defaultRoomId: "",
      defaultRoomKey: params.spec.defaultRoomKey,
      rooms,
    },
    params.spec.defaultRoomKey,
  );

  return {
    defaultRoomId: defaultRoom.roomId,
    defaultRoomKey: params.spec.defaultRoomKey,
    rooms,
  };
}

export async function provisionMatrixQaRoom(params: {
  baseUrl: string;
  fetchImpl?: MatrixQaFetchLike;
  topology?: MatrixQaTopologySpec;
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
  const [driver, sut, observer] = await Promise.all([
    anonClient.registerWithToken({
      deviceName: "OpenClaw Matrix QA Driver",
      localpart: params.driverLocalpart,
      password: `driver-${randomUUID()}`,
      registrationToken: params.registrationToken,
    }),
    anonClient.registerWithToken({
      deviceName: "OpenClaw Matrix QA SUT",
      localpart: params.sutLocalpart,
      password: `sut-${randomUUID()}`,
      registrationToken: params.registrationToken,
    }),
    anonClient.registerWithToken({
      deviceName: "OpenClaw Matrix QA Observer",
      localpart: params.observerLocalpart,
      password: `observer-${randomUUID()}`,
      registrationToken: params.registrationToken,
    }),
  ]);
  const topology = await provisionMatrixQaTopology({
    accounts: {
      driver,
      observer,
      sut,
    },
    baseUrl: params.baseUrl,
    fetchImpl: params.fetchImpl,
    spec:
      params.topology ??
      ({
        defaultRoomKey: "main",
        rooms: [
          {
            key: "main",
            kind: "group",
            members: ["driver", "observer", "sut"],
            name: params.roomName,
            requireMention: true,
          },
        ],
      } satisfies MatrixQaTopologySpec),
  });
  return {
    driver,
    observer,
    roomId: topology.defaultRoomId,
    sut,
    topology,
  } satisfies MatrixQaProvisionResult;
}

export const __testing = {
  buildMatrixQaMessageContent,
  buildMatrixQaReplacementMessageContent,
  buildMatrixReactionRelation,
  buildMatrixReplacementRelation,
  buildMatrixThreadRelation,
  createMatrixQaRoomObserver,
  resolveNextRegistrationAuth,
};
