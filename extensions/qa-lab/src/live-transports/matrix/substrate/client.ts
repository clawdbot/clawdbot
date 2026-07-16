// Qa Lab Matrix module implements client behavior.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { uniqueValues } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildMatrixQaMediaMessageContent,
  buildMatrixQaMessageContent,
  buildMatrixQaReplacementMessageContent,
  buildMatrixReactionRelation,
  resolveNextRegistrationAuth,
  type MatrixQaUiaaResponse,
} from "./client-message-content.js";
import type { MatrixQaObservedEvent } from "./events.js";
import { MATRIX_QA_JSON_MAX_BYTES, requestMatrixJson, type MatrixQaFetchLike } from "./request.js";
import {
  primeMatrixQaRoom,
  waitForMatrixQaRoomEvent,
  waitForOptionalMatrixQaRoomEvent,
  type MatrixQaRoomObserver,
} from "./sync.js";
import {
  findMatrixQaProvisionedRoom,
  type MatrixQaParticipantRole,
  type MatrixQaProvisionedTopology,
  type MatrixQaTopologyRoomSpec,
  type MatrixQaTopologySpec,
} from "./topology.js";

export type { MatrixQaRoomObserver } from "./sync.js";

type MatrixQaRegisterResponse = {
  access_token?: string;
  device_id?: string;
  user_id?: string;
};

type MatrixQaRoomCreateResponse = {
  room_id?: string;
};

type MatrixQaRoomInitialState = Array<{
  content: Record<string, unknown>;
  state_key: string;
  type: string;
}>;

type MatrixQaRegisteredAccount = {
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
  // Bound the media-upload response body before parsing, mirroring
  // `requestMatrixJson`. The overflow error is read *outside* the parse
  // try/catch so it fails closed (propagates) instead of being swallowed into
  // `{}`; malformed-but-in-bounds JSON still falls back to `{}` as before.
  const uploadBytes = await readResponseWithLimit(response, MATRIX_QA_JSON_MAX_BYTES, {
    onOverflow: ({ maxBytes }) => new Error(`Matrix homeserver response exceeds ${maxBytes} bytes`),
  });
  let body: { content_uri?: string; error?: string };
  try {
    body = JSON.parse(new TextDecoder().decode(uploadBytes)) as {
      content_uri?: string;
      error?: string;
    };
  } catch {
    body = {};
  }
  if (response.status !== 200) {
    throw new Error(body.error ?? `Matrix media upload failed with status ${response.status}`);
  }
  const contentUri = body.content_uri?.trim();
  if (!contentUri) {
    throw new Error("Matrix media upload did not return content_uri.");
  }
  return contentUri;
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
      const result = await requestMatrixJson<MatrixQaRegisterResponse>({
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
  const uniqueRoles = uniqueValues(memberRoles);
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
    const creator = expectDefined(members[0], "Matrix QA room creator");
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
