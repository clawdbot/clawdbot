import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MatrixQaObservedEvent } from "./events.js";
import { requestMatrixJson, type MatrixQaFetchLike } from "./request.js";
import {
  primeMatrixQaRoom,
  waitForMatrixQaRoomEvent,
  waitForOptionalMatrixQaRoomEvent,
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
export type { MatrixQaRoomEventWaitResult } from "./sync.js";

type MatrixQaAuthStage = "m.login.dummy" | "m.login.registration_token";

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

export function createMatrixQaClient(params: {
  accessToken?: string;
  baseUrl: string;
  fetchImpl?: MatrixQaFetchLike;
}) {
  const fetchImpl = params.fetchImpl ?? fetch;

  return {
    async createPrivateRoom(opts: { inviteUserIds: string[]; isDirect?: boolean; name: string }) {
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
  const rooms = await Promise.all(
    params.spec.rooms.map(async (room) => {
      const members = resolveTopologyMemberAccounts(params.accounts, room.members);
      const creator = members[0];
      const invitees = members.slice(1);
      const creatorClient = createMatrixQaClient({
        accessToken: creator.account.accessToken,
        baseUrl: params.baseUrl,
        fetchImpl: params.fetchImpl,
      });
      const roomId = await creatorClient.createPrivateRoom({
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
      return {
        key: room.key,
        kind: room.kind,
        memberRoles: members.map((entry) => entry.role),
        memberUserIds: members.map((entry) => entry.account.userId),
        name: room.name,
        requireMention: resolveProvisionedRoomRequireMention(room),
        roomId,
      };
    }),
  );

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
  buildMatrixReactionRelation,
  buildMatrixThreadRelation,
  resolveNextRegistrationAuth,
};
