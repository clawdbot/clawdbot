import { MatrixEventEvent, Preset, type MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import type { Direction } from "matrix-js-sdk/lib/models/event-timeline.js";
import { formatMatrixErrorReason } from "../errors.js";
import { MatrixClientBase } from "./client-base.js";
import { matrixEventToRaw, parseMxc } from "./event-helpers.js";
import { noop } from "./logger.js";
import type { HttpMethod, QueryParams } from "./transport.js";
import type { MatrixRawEvent, MatrixRelationsPage, MessageEventContent } from "./types.js";

function isUnsupportedAuthenticatedMediaEndpointError(err: unknown): boolean {
  const statusCode = (err as { statusCode?: number })?.statusCode;
  if (statusCode === 404 || statusCode === 405 || statusCode === 501) {
    return true;
  }
  const message = formatMatrixErrorReason(err);
  return (
    message.includes("m_unrecognized") ||
    message.includes("unrecognized request") ||
    message.includes("method not allowed") ||
    message.includes("not implemented")
  );
}

export abstract class MatrixClientCore extends MatrixClientBase {
  async getUserId(): Promise<string> {
    const fromClient = this.client.getUserId();
    if (fromClient) {
      this.selfUserId = fromClient;
      return fromClient;
    }
    if (this.selfUserId) {
      return this.selfUserId;
    }
    const whoami = (await this.doRequest("GET", "/_matrix/client/v3/account/whoami")) as {
      user_id?: string;
    };
    const resolved = whoami.user_id?.trim();
    if (!resolved) {
      throw new Error("Matrix whoami did not return user_id");
    }
    this.selfUserId = resolved;
    return resolved;
  }

  async getJoinedRooms(): Promise<string[]> {
    const joined = (await this.doRequest("GET", "/_matrix/client/v3/joined_rooms")) as {
      joined_rooms?: unknown;
    };
    return Array.isArray(joined.joined_rooms) ? joined.joined_rooms : [];
  }

  async getJoinedRoomMembers(roomId: string): Promise<string[]> {
    const members = await this.client.getJoinedRoomMembers(roomId);
    const joined = members?.joined;
    if (!joined || typeof joined !== "object") {
      return [];
    }
    return Object.keys(joined);
  }

  hasSyncedJoinedRoomMember(roomId: string, userId: string): boolean {
    return this.client.getRoom(roomId)?.getMember(userId)?.membership === "join";
  }

  async getRoomStateEvent(
    roomId: string,
    eventType: string,
    stateKey = "",
  ): Promise<Record<string, unknown>> {
    const state = await this.client.getStateEvent(roomId, eventType, stateKey);
    return (state ?? {}) as Record<string, unknown>;
  }

  async getAccountData(eventType: string): Promise<Record<string, unknown> | undefined> {
    return (
      ((await this.client.getAccountDataFromServer(eventType as never)) as Record<
        string,
        unknown
      > | null) ?? undefined
    );
  }

  async setAccountData(eventType: string, content: Record<string, unknown>): Promise<void> {
    await this.client.setAccountData(eventType as never, content as never);
    await this.refreshDmCache().catch(noop);
  }

  async resolveRoom(aliasOrRoomId: string): Promise<string | null> {
    if (aliasOrRoomId.startsWith("!")) {
      return aliasOrRoomId;
    }
    if (!aliasOrRoomId.startsWith("#")) {
      return aliasOrRoomId;
    }
    try {
      const resolved = await this.client.getRoomIdForAlias(aliasOrRoomId);
      return resolved.room_id ?? null;
    } catch {
      return null;
    }
  }

  async createDirectRoom(
    remoteUserId: string,
    opts: { encrypted?: boolean } = {},
  ): Promise<string> {
    const initialState = opts.encrypted
      ? [
          {
            type: "m.room.encryption",
            state_key: "",
            content: {
              algorithm: "m.megolm.v1.aes-sha2",
            },
          },
        ]
      : undefined;
    const result = await this.client.createRoom({
      invite: [remoteUserId],
      is_direct: true,
      preset: Preset.TrustedPrivateChat,
      initial_state: initialState,
    });
    return result.room_id;
  }

  async sendMessage(roomId: string, content: MessageEventContent): Promise<string> {
    return await this.runSerializedRoomSend(roomId, async () => {
      const sent = await this.client.sendMessage(roomId, content as never);
      return sent.event_id;
    });
  }

  async sendEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    return await this.runSerializedRoomSend(roomId, async () => {
      const sent = await this.client.sendEvent(roomId, eventType as never, content as never);
      return sent.event_id;
    });
  }

  // Keep outbound room events ordered when multiple plugin paths emit
  // messages/reactions/polls into the same Matrix room concurrently.
  private async runSerializedRoomSend<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    return await this.sendQueue.enqueue(roomId, task);
  }

  async sendStateEvent(
    roomId: string,
    eventType: string,
    stateKey: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const sent = await this.client.sendStateEvent(
      roomId,
      eventType as never,
      content as never,
      stateKey,
    );
    return sent.event_id;
  }

  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<string> {
    const sent = await this.client.redactEvent(
      roomId,
      eventId,
      undefined,
      reason?.trim() ? { reason } : undefined,
    );
    return sent.event_id;
  }

  async doRequest(
    method: HttpMethod,
    endpoint: string,
    qs?: QueryParams,
    body?: unknown,
    opts?: { allowAbsoluteEndpoint?: boolean },
  ): Promise<unknown> {
    return await this.httpClient.requestJson({
      method,
      endpoint,
      qs,
      body,
      timeoutMs: this.localTimeoutMs,
      allowAbsoluteEndpoint: opts?.allowAbsoluteEndpoint,
    });
  }

  async getUserProfile(userId: string): Promise<{ displayname?: string; avatar_url?: string }> {
    return await this.client.getProfileInfo(userId);
  }

  async setDisplayName(displayName: string): Promise<void> {
    await this.client.setDisplayName(displayName);
  }

  async setAvatarUrl(avatarUrl: string): Promise<void> {
    await this.client.setAvatarUrl(avatarUrl);
  }

  async joinRoom(roomId: string): Promise<void> {
    await this.client.joinRoom(roomId);
  }

  mxcToHttp(mxcUrl: string): string | null {
    return this.client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, true, false, true);
  }

  async downloadContent(
    mxcUrl: string,
    opts: {
      allowRemote?: boolean;
      maxBytes?: number;
      readIdleTimeoutMs?: number;
    } = {},
  ): Promise<Buffer> {
    const parsed = parseMxc(mxcUrl);
    if (!parsed) {
      throw new Error(`Invalid Matrix content URI: ${mxcUrl}`);
    }
    const encodedServer = encodeURIComponent(parsed.server);
    const encodedMediaId = encodeURIComponent(parsed.mediaId);
    const request = async (endpoint: string): Promise<Buffer> =>
      await this.httpClient.requestRaw({
        method: "GET",
        endpoint,
        qs: { allow_remote: opts.allowRemote ?? true },
        timeoutMs: this.localTimeoutMs,
        maxBytes: opts.maxBytes,
        readIdleTimeoutMs: opts.readIdleTimeoutMs,
      });

    const authenticatedEndpoint = `/_matrix/client/v1/media/download/${encodedServer}/${encodedMediaId}`;
    try {
      return await request(authenticatedEndpoint);
    } catch (err) {
      if (!isUnsupportedAuthenticatedMediaEndpointError(err)) {
        throw err;
      }
    }

    const legacyEndpoint = `/_matrix/media/v3/download/${encodedServer}/${encodedMediaId}`;
    return await request(legacyEndpoint);
  }

  async uploadContent(file: Buffer, contentType?: string, filename?: string): Promise<string> {
    const uploaded = await this.client.uploadContent(new Uint8Array(file), {
      type: contentType || "application/octet-stream",
      name: filename,
      includeFilename: Boolean(filename),
    });
    return uploaded.content_uri;
  }

  async getEvent(roomId: string, eventId: string): Promise<Record<string, unknown>> {
    const rawEvent = (await this.client.fetchRoomEvent(roomId, eventId)) as Record<string, unknown>;
    if (rawEvent.type !== "m.room.encrypted") {
      return rawEvent;
    }

    const mapper = this.client.getEventMapper();
    const event = mapper(rawEvent);
    let decryptedEvent: MatrixEvent | undefined;
    const onDecrypted = (candidate: MatrixEvent) => {
      decryptedEvent = candidate;
    };
    event.once(MatrixEventEvent.Decrypted, onDecrypted);
    try {
      await this.client.decryptEventIfNeeded(event);
    } finally {
      event.off(MatrixEventEvent.Decrypted, onDecrypted);
    }
    return matrixEventToRaw(decryptedEvent ?? event);
  }

  async getRelations(
    roomId: string,
    eventId: string,
    relationType: string | null,
    eventType?: string | null,
    opts: {
      dir?: Direction;
      from?: string;
      limit?: number;
    } = {},
  ): Promise<MatrixRelationsPage> {
    const result = await this.client.relations(roomId, eventId, relationType, eventType, opts);
    return {
      originalEvent: result.originalEvent ? matrixEventToRaw(result.originalEvent) : null,
      events: result.events.map((event) => matrixEventToRaw(event)),
      nextBatch: result.nextBatch ?? null,
      prevBatch: result.prevBatch ?? null,
    };
  }

  async hydrateEvents(
    roomId: string,
    events: Array<Record<string, unknown>>,
  ): Promise<MatrixRawEvent[]> {
    if (events.length === 0) {
      return [];
    }

    const mapper = this.client.getEventMapper();
    const mappedEvents = events.map((event) =>
      mapper({
        room_id: roomId,
        ...event,
      }),
    );
    await Promise.all(mappedEvents.map((event) => this.client.decryptEventIfNeeded(event)));
    return mappedEvents.map((event) => matrixEventToRaw(event));
  }

  async setTyping(roomId: string, typing: boolean, timeoutMs: number): Promise<void> {
    await this.client.sendTyping(roomId, typing, timeoutMs);
  }

  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    await this.httpClient.requestJson({
      method: "POST",
      endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(
        eventId,
      )}`,
      body: {},
      timeoutMs: this.localTimeoutMs,
    });
  }
}
