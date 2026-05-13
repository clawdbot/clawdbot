import { describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "../client.js";
import type { MatrixClient } from "../sdk.js";
import type { MatrixVerificationSummary } from "../sdk/verification-manager.js";
import { registerMatrixMonitorEvents } from "./events.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

type RoomEventListener = (roomId: string, event: MatrixRawEvent) => void;
type FailedDecryptListener = (roomId: string, event: MatrixRawEvent, error: Error) => Promise<void>;
type VerificationSummaryListener = (summary: MatrixVerificationSummary) => void;

function getSentNoticeBody(sendMessage: ReturnType<typeof vi.fn>, index = 0): string {
  const calls = sendMessage.mock.calls as unknown[][];
  return getSentNoticeBodyFromCall(calls[index] ?? []);
}

function getSentNoticeBodyFromCall(call: unknown[]): string {
  const payload = (call[1] ?? {}) as { body?: string };
  return payload.body ?? "";
}

function getSentNoticeBodies(sendMessage: ReturnType<typeof vi.fn>): string[] {
  return (sendMessage.mock.calls as unknown[][]).map(getSentNoticeBodyFromCall);
}

function expectBodiesContain(bodies: string[], text: string) {
  expect(bodies.join("\n")).toContain(text);
}

function expectBodiesExclude(bodies: string[], text: string) {
  expect(bodies.join("\n")).not.toContain(text);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectWarnContextFields(
  logger: { warn: ReturnType<typeof vi.fn> },
  callIndex: number,
  message: string,
  fields: Record<string, unknown>,
) {
  const call = logger.warn.mock.calls[callIndex - 1] as unknown[];
  expect(call?.[0]).toBe(message);
  expectRecordFields(requireRecord(call?.[1], "logger warning context"), fields);
}

function createHarness(params?: {
  cfg?: CoreConfig;
  accountId?: string;
  authEncryption?: boolean;
  cryptoAvailable?: boolean;
  selfUserId?: string;
  selfUserIdError?: Error;
  startupMs?: number;
  startupGraceMs?: number;
  getHealthySyncSinceMs?: () => number | undefined;
  allowFrom?: string[];
  dmEnabled?: boolean;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  storeAllowFrom?: string[];
  accountDataByType?: Record<string, unknown>;
  joinedMembersByRoom?: Record<string, string[]>;
  getJoinedRoomsError?: Error;
  memberStateByRoomUser?: Record<string, Record<string, { is_direct?: boolean }>>;
  verifications?: Array<{
    id: string;
    transactionId?: string;
    roomId?: string;
    otherUserId: string;
    updatedAt?: string;
    completed?: boolean;
    pending?: boolean;
    phase?: number;
    phaseName?: string;
    sas?: {
      decimal?: [number, number, number];
      emoji?: Array<[string, string]>;
    };
  }>;
  ensureVerificationDmTracked?: () => Promise<{
    id: string;
    transactionId?: string;
    roomId?: string;
    otherUserId: string;
    updatedAt?: string;
    completed?: boolean;
    pending?: boolean;
    phase?: number;
    phaseName?: string;
    sas?: {
      decimal?: [number, number, number];
      emoji?: Array<[string, string]>;
    };
  } | null>;
  sasNoticeRetryDelayMs?: number;
}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const pendingTasks = new Set<Promise<void>>();
  const runDetachedTask = vi.fn((_label: string, task: () => Promise<void>) => {
    const promise = Promise.resolve()
      .then(task)
      .catch((error) => {
        throw error;
      })
      .finally(() => {
        pendingTasks.delete(promise);
      });
    pendingTasks.add(promise);
    return promise;
  });
  const flushTasks = async () => {
    while (pendingTasks.size > 0) {
      await Promise.all(Array.from(pendingTasks));
    }
  };
  const onRoomMessage = vi.fn(async () => {});
  const listVerifications = vi.fn(async () => params?.verifications ?? []);
  const ensureVerificationDmTracked = vi.fn(
    params?.ensureVerificationDmTracked ?? (async () => null),
  );
  const sendMessage = vi.fn(async (_roomId: string, _payload: { body?: string }) => "$notice");
  const invalidateRoom = vi.fn();
  const rememberInvite = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const formatNativeDependencyHint = vi.fn(() => "install hint");
  const logVerboseMessage = vi.fn();
  const readStoreAllowFrom = vi.fn(async () => params?.storeAllowFrom ?? []);
  const client = {
    on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      listeners.set(eventName, listener);
      return client;
    }),
    sendMessage,
    getUserId: vi.fn(async () => {
      if (params?.selfUserIdError) {
        throw params.selfUserIdError;
      }
      return params?.selfUserId ?? "@bot:example.org";
    }),
    getJoinedRoomMembers: vi.fn(
      async (roomId: string) =>
        params?.joinedMembersByRoom?.[roomId] ?? ["@bot:example.org", "@alice:example.org"],
    ),
    getJoinedRooms: vi.fn(async () =>
      params?.getJoinedRoomsError
        ? await Promise.reject(params.getJoinedRoomsError)
        : Object.keys(params?.joinedMembersByRoom ?? {}).length > 0
          ? Object.keys(params?.joinedMembersByRoom ?? {})
          : ["!room:example.org"],
    ),
    getAccountData: vi.fn(
      async (eventType: string) =>
        (params?.accountDataByType?.[eventType] as Record<string, unknown> | undefined) ??
        undefined,
    ),
    getRoomStateEvent: vi.fn(
      async (roomId: string, _eventType: string, stateKey: string) =>
        params?.memberStateByRoomUser?.[roomId]?.[stateKey] ?? {},
    ),
    ...(params?.cryptoAvailable === false
      ? {}
      : {
          crypto: {
            listVerifications,
            ensureVerificationDmTracked,
          },
        }),
  } as unknown as MatrixClient;

  const dmPolicy = params?.dmPolicy ?? "open";
  const allowFrom = params?.allowFrom ?? (dmPolicy === "open" ? ["*"] : []);

  registerMatrixMonitorEvents({
    cfg: params?.cfg ?? { channels: { matrix: {} } },
    client,
    auth: {
      accountId: params?.accountId ?? "default",
      encryption: params?.authEncryption ?? true,
    } as MatrixAuth,
    allowFrom,
    dmEnabled: params?.dmEnabled ?? true,
    dmPolicy,
    readStoreAllowFrom,
    directTracker: {
      invalidateRoom,
      rememberInvite,
    },
    logVerboseMessage,
    warnedEncryptedRooms: new Set<string>(),
    warnedCryptoMissingRooms: new Set<string>(),
    logger,
    startupGraceMs: params?.startupGraceMs,
    getHealthySyncSinceMs:
      params?.getHealthySyncSinceMs ??
      (typeof params?.startupMs === "number" ? () => params.startupMs : undefined),
    formatNativeDependencyHint,
    onRoomMessage,
    runDetachedTask,
    sasNoticeRetryDelayMs: params?.sasNoticeRetryDelayMs ?? 0,
  });

  const roomEventListener = listeners.get("room.event") as RoomEventListener | undefined;
  if (!roomEventListener) {
    throw new Error("room.event listener was not registered");
  }

  return {
    onRoomMessage,
    sendMessage,
    invalidateRoom,
    rememberInvite,
    roomEventListener,
    listVerifications,
    readStoreAllowFrom,
    logger,
    formatNativeDependencyHint,
    logVerboseMessage,
    flushTasks,
    runDetachedTask,
    roomMessageListener: listeners.get("room.message") as RoomEventListener | undefined,
    roomDecryptedEventListener: listeners.get("room.decrypted_event") as
      | RoomEventListener
      | undefined,
    failedDecryptListener: listeners.get("room.failed_decryption") as
      | FailedDecryptListener
      | undefined,
    verificationSummaryListener: listeners.get("verification.summary") as
      | VerificationSummaryListener
      | undefined,
    roomInviteListener: listeners.get("room.invite") as RoomEventListener | undefined,
    roomJoinListener: listeners.get("room.join") as RoomEventListener | undefined,
  };
}

describe("registerMatrixMonitorEvents verification routing", () => {
  it("does not repost historical verification completions during startup catch-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T13:10:00.000Z"));
    try {
      const { sendMessage, roomEventListener } = createHarness();

      roomEventListener("!room:example.org", {
        event_id: "$done-old",
        sender: "@alice:example.org",
        type: "m.key.verification.done",
        origin_server_ts: Date.now() - 10 * 60 * 1000,
        content: {
          "m.relates_to": { event_id: "$req-old" },
        },
      });

      await vi.runAllTimersAsync();
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still posts fresh verification completions", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness();

    roomEventListener("!room:example.org", {
      event_id: "$done-fresh",
      sender: "@alice:example.org",
      type: "m.key.verification.done",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req-fresh" },
      },
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(getSentNoticeBody(sendMessage)).toContain(
      "Matrix verification completed with @alice:example.org.",
    );
  });

  it("forwards reaction room events into the shared room handler", async () => {
    const { onRoomMessage, sendMessage, roomEventListener, flushTasks } = createHarness();

    roomEventListener("!room:example.org", {
      event_id: "$reaction1",
      sender: "@alice:example.org",
      type: EventType.Reaction,
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: "$msg1",
          key: "👍",
        },
      },
    });

    await flushTasks();
    const roomMessageCalls = onRoomMessage.mock.calls as unknown[][];
    expect(roomMessageCalls[0]?.[0]).toBe("!room:example.org");
    expectRecordFields(requireRecord(roomMessageCalls[0]?.[1], "reaction event"), {
      event_id: "$reaction1",
      type: EventType.Reaction,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("invalidates direct-room membership cache on room member events", () => {
    const { invalidateRoom, roomEventListener } = createHarness();

    roomEventListener("!room:example.org", {
      event_id: "$member1",
      sender: "@alice:example.org",
      state_key: "@mallory:example.org",
      type: EventType.RoomMember,
      origin_server_ts: Date.now(),
      content: {
        membership: "join",
      },
    });

    expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("remembers invite provenance on room invites", () => {
    const { invalidateRoom, rememberInvite, roomInviteListener } = createHarness();
    if (!roomInviteListener) {
      throw new Error("room.invite listener was not registered");
    }

    roomInviteListener("!room:example.org", {
      event_id: "$invite1",
      sender: "@alice:example.org",
      type: EventType.RoomMember,
      origin_server_ts: Date.now(),
      content: {
        membership: "invite",
        is_direct: true,
      },
      state_key: "@bot:example.org",
    });

    expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
    expect(rememberInvite).toHaveBeenCalledWith("!room:example.org", "@alice:example.org");
  });

  it("ignores lifecycle-only invite events emitted with self sender ids", () => {
    const { invalidateRoom, rememberInvite, roomInviteListener } = createHarness();
    if (!roomInviteListener) {
      throw new Error("room.invite listener was not registered");
    }

    roomInviteListener("!room:example.org", {
      event_id: "$invite-self",
      sender: "@bot:example.org",
      type: EventType.RoomMember,
      origin_server_ts: Date.now(),
      content: {
        membership: "invite",
      },
      state_key: "@bot:example.org",
    });

    expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
    expect(rememberInvite).not.toHaveBeenCalled();
  });

  it("remembers invite provenance even when Matrix omits the direct invite hint", () => {
    const { invalidateRoom, rememberInvite, roomInviteListener } = createHarness();
    if (!roomInviteListener) {
      throw new Error("room.invite listener was not registered");
    }

    roomInviteListener("!room:example.org", {
      event_id: "$invite-group",
      sender: "@alice:example.org",
      type: EventType.RoomMember,
      origin_server_ts: Date.now(),
      content: {
        membership: "invite",
      },
      state_key: "@bot:example.org",
    });

    expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
    expect(rememberInvite).toHaveBeenCalledWith("!room:example.org", "@alice:example.org");
  });

  it("does not synthesize invite provenance from room joins", () => {
    const { invalidateRoom, rememberInvite, roomJoinListener } = createHarness();
    if (!roomJoinListener) {
      throw new Error("room.join listener was not registered");
    }

    roomJoinListener("!room:example.org", {
      event_id: "$join1",
      sender: "@bot:example.org",
      type: EventType.RoomMember,
      origin_server_ts: Date.now(),
      content: {
        membership: "join",
      },
      state_key: "@bot:example.org",
    });

    expect(invalidateRoom).toHaveBeenCalledWith("!room:example.org");
    expect(rememberInvite).not.toHaveBeenCalled();
  });

  it("posts verification request notices directly into the room", async () => {
    const { onRoomMessage, sendMessage, roomMessageListener, flushTasks } = createHarness();
    if (!roomMessageListener) {
      throw new Error("room.message listener was not registered");
    }
    roomMessageListener("!room:example.org", {
      event_id: "$req1",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.key.verification.request",
        body: "verification request",
      },
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(onRoomMessage).not.toHaveBeenCalled();
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification request received from @alice:example.org.");
    expect(body).toContain('Open "Verify by emoji"');
  });

  it("routes late-decrypted room messages through the normal room handler", async () => {
    const { onRoomMessage, roomDecryptedEventListener, flushTasks } = createHarness();
    if (!roomDecryptedEventListener) {
      throw new Error("room.decrypted_event listener was not registered");
    }
    const event: MatrixRawEvent = {
      event_id: "$decrypted1",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "@bot late decrypt trigger",
      },
    };

    roomDecryptedEventListener("!room:example.org", event);

    await flushTasks();
    expect(onRoomMessage).toHaveBeenCalledTimes(1);
    expect(onRoomMessage).toHaveBeenCalledWith("!room:example.org", event);
  });

  it("blocks verification request notices when dmPolicy pairing would block the sender", async () => {
    const { onRoomMessage, sendMessage, roomMessageListener, logVerboseMessage, flushTasks } =
      createHarness({
        dmPolicy: "pairing",
      });
    if (!roomMessageListener) {
      throw new Error("room.message listener was not registered");
    }

    roomMessageListener("!room:example.org", {
      event_id: "$req-pairing-blocked",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.key.verification.request",
        body: "verification request",
      },
    });

    await flushTasks();
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "matrix: blocked verification sender @alice:example.org (dmPolicy=pairing)",
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onRoomMessage).not.toHaveBeenCalled();
  });

  it("allows verification notices for pairing-authorized DM senders from the allow store", async () => {
    const { sendMessage, roomMessageListener, readStoreAllowFrom, flushTasks } = createHarness({
      dmPolicy: "pairing",
      storeAllowFrom: ["@alice:example.org"],
    });
    if (!roomMessageListener) {
      throw new Error("room.message listener was not registered");
    }

    roomMessageListener("!room:example.org", {
      event_id: "$req-pairing-allowed",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.key.verification.request",
        body: "verification request",
      },
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(readStoreAllowFrom).toHaveBeenCalled();
  });

  it("does not consult the allow store when dmPolicy is open", async () => {
    const { sendMessage, roomMessageListener, readStoreAllowFrom, flushTasks } = createHarness({
      dmPolicy: "open",
    });
    if (!roomMessageListener) {
      throw new Error("room.message listener was not registered");
    }

    roomMessageListener("!room:example.org", {
      event_id: "$req-open-policy",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.key.verification.request",
        body: "verification request",
      },
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(readStoreAllowFrom).not.toHaveBeenCalled();
  });

  it("blocks verification notices when Matrix DMs are disabled", async () => {
    const { sendMessage, roomMessageListener, logVerboseMessage, flushTasks } = createHarness({
      dmEnabled: false,
    });
    if (!roomMessageListener) {
      throw new Error("room.message listener was not registered");
    }

    roomMessageListener("!room:example.org", {
      event_id: "$req-dm-disabled",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.key.verification.request",
        body: "verification request",
      },
    });

    await flushTasks();
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "matrix: blocked verification sender @alice:example.org (dmPolicy=open, dmEnabled=false)",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("posts ready-stage guidance for emoji verification", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness();
    roomEventListener("!room:example.org", {
      event_id: "$ready-1",
      sender: "@alice:example.org",
      type: "m.key.verification.ready",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req-ready-1" },
      },
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification is ready with @alice:example.org.");
    expect(body).toContain('Choose "Verify by emoji"');
  });

  it("posts SAS emoji/decimal details when verification summaries expose them", async () => {
    const {
      sendMessage,
      roomEventListener,
      listVerifications: _listVerifications,
      flushTasks,
    } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications: [
        {
          id: "verification-1",
          transactionId: "$different-flow-id",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
          otherUserId: "@alice:example.org",
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
        },
      ],
    });

    roomEventListener("!dm:example.org", {
      event_id: "$start2",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req2" },
      },
    });

    await flushTasks();
    const bodies = getSentNoticeBodies(sendMessage);
    expectBodiesContain(bodies, "SAS emoji:");
    expectBodiesContain(bodies, "SAS decimal: 6158 1986 3513");
  });

  it("rehydrates an in-progress DM verification before resolving SAS notices", async () => {
    const verifications: Array<{
      id: string;
      transactionId?: string;
      roomId?: string;
      otherUserId: string;
      updatedAt?: string;
      completed?: boolean;
      pending?: boolean;
      phase?: number;
      phaseName?: string;
      sas?: {
        decimal?: [number, number, number];
        emoji?: Array<[string, string]>;
      };
    }> = [];
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications,
      ensureVerificationDmTracked: async () => {
        verifications.splice(0, verifications.length, {
          id: "verification-rehydrated",
          transactionId: "$req-hydrated",
          roomId: "!dm:example.org",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
          phase: 3,
          phaseName: "started",
          pending: true,
          sas: {
            decimal: [2468, 1357, 9753],
            emoji: [
              ["🔔", "Bell"],
              ["📁", "Folder"],
              ["🐴", "Horse"],
            ],
          },
        });
        return verifications[0] ?? null;
      },
    });

    roomEventListener("!dm:example.org", {
      event_id: "$start-hydrated",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req-hydrated" },
      },
    });

    await flushTasks();
    expect(
      getSentNoticeBodies(sendMessage).some((body) => body.includes("SAS decimal: 2468 1357 9753")),
    ).toBe(true);
  });

  it("posts SAS notices directly from verification summary updates", async () => {
    const { sendMessage, verificationSummaryListener, flushTasks } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
    });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    verificationSummaryListener({
      id: "verification-direct",
      roomId: "!dm:example.org",
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      phase: 3,
      phaseName: "started",
      pending: true,
      methods: ["m.sas.v1"],
      canAccept: false,
      hasSas: true,
      sas: {
        decimal: [6158, 1986, 3513],
        emoji: [
          ["🎁", "Gift"],
          ["🌍", "Globe"],
          ["🐴", "Horse"],
        ],
      },
      hasReciprocateQr: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification SAS with @alice:example.org:");
    expect(body).toContain("SAS decimal: 6158 1986 3513");
  });

  it("blocks summary SAS notices when dmPolicy allowlist would block the sender", async () => {
    const { sendMessage, verificationSummaryListener, logVerboseMessage, flushTasks } =
      createHarness({
        dmPolicy: "allowlist",
        joinedMembersByRoom: {
          "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
        },
      });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    verificationSummaryListener({
      id: "verification-blocked-summary",
      roomId: "!dm:example.org",
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      phase: 3,
      phaseName: "started",
      pending: true,
      methods: ["m.sas.v1"],
      canAccept: false,
      hasSas: true,
      sas: {
        decimal: [6158, 1986, 3513],
        emoji: [
          ["🎁", "Gift"],
          ["🌍", "Globe"],
          ["🐴", "Horse"],
        ],
      },
      hasReciprocateQr: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await flushTasks();
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "matrix: blocked verification sender @alice:example.org (dmPolicy=allowlist)",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("posts SAS notices from summary updates using the room mapped by earlier flow events", async () => {
    const { sendMessage, roomEventListener, verificationSummaryListener, flushTasks } =
      createHarness({
        joinedMembersByRoom: {
          "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
        },
      });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    roomEventListener("!dm:example.org", {
      event_id: "$start-mapped",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        transaction_id: "txn-mapped-room",
        "m.relates_to": { event_id: "$req-mapped" },
      },
    });

    verificationSummaryListener({
      id: "verification-mapped",
      transactionId: "txn-mapped-room",
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      phase: 3,
      phaseName: "started",
      pending: true,
      methods: ["m.sas.v1"],
      canAccept: false,
      hasSas: true,
      sas: {
        decimal: [1111, 2222, 3333],
        emoji: [
          ["🚀", "Rocket"],
          ["🦋", "Butterfly"],
          ["📕", "Book"],
        ],
      },
      hasReciprocateQr: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await flushTasks();
    expect(
      getSentNoticeBodies(sendMessage).some((body) => body.includes("SAS decimal: 1111 2222 3333")),
    ).toBe(true);
  });

  it("posts SAS notices from summary updates using the active strict DM when room mapping is missing", async () => {
    const { sendMessage, verificationSummaryListener, flushTasks } = createHarness({
      joinedMembersByRoom: {
        "!dm-active:example.org": ["@alice:example.org", "@bot:example.org"],
      },
    });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    verificationSummaryListener({
      id: "verification-unmapped",
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      phase: 3,
      phaseName: "started",
      pending: true,
      methods: ["m.sas.v1"],
      canAccept: false,
      hasSas: true,
      sas: {
        decimal: [4321, 8765, 2109],
        emoji: [
          ["🚀", "Rocket"],
          ["🦋", "Butterfly"],
          ["📕", "Book"],
        ],
      },
      hasReciprocateQr: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const roomId = ((sendMessage.mock.calls as unknown[][])[0]?.[0] ?? "") as string;
    const body = getSentNoticeBody(sendMessage, 0);
    expect(roomId).toBe("!dm-active:example.org");
    expect(body).toContain("SAS decimal: 4321 8765 2109");
  });

  it("prefers the canonical active DM over the most recent verification room for unmapped SAS summaries", async () => {
    const { sendMessage, roomEventListener, verificationSummaryListener, flushTasks } =
      createHarness({
        joinedMembersByRoom: {
          "!dm-active:example.org": ["@alice:example.org", "@bot:example.org"],
          "!dm-current:example.org": ["@alice:example.org", "@bot:example.org"],
        },
      });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    roomEventListener("!dm-current:example.org", {
      event_id: "$start-current",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req-current" },
      },
    });

    await flushTasks();
    expect(
      getSentNoticeBodies(sendMessage).some((body) =>
        body.includes("Matrix verification started with"),
      ),
    ).toBe(true);

    verificationSummaryListener({
      id: "verification-current-room",
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      phase: 3,
      phaseName: "started",
      pending: true,
      methods: ["m.sas.v1"],
      canAccept: false,
      hasSas: true,
      sas: {
        decimal: [2468, 1357, 9753],
        emoji: [
          ["🔔", "Bell"],
          ["📁", "Folder"],
          ["🐴", "Horse"],
        ],
      },
      hasReciprocateQr: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await flushTasks();
    expect(
      getSentNoticeBodies(sendMessage).some((body) => body.includes("SAS decimal: 2468 1357 9753")),
    ).toBe(true);
    const calls = sendMessage.mock.calls as unknown[][];
    const sasCall = calls.find((call) =>
      getSentNoticeBodyFromCall(call).includes("SAS decimal: 2468 1357 9753"),
    );
    expect((sasCall?.[0] ?? "") as string).toBe("!dm-active:example.org");
  });

  it("retries SAS notice lookup when start arrives before SAS payload is available", async () => {
    vi.useFakeTimers();
    const verifications: Array<{
      id: string;
      transactionId?: string;
      otherUserId: string;
      updatedAt?: string;
      sas?: {
        decimal?: [number, number, number];
        emoji?: Array<[string, string]>;
      };
    }> = [
      {
        id: "verification-race",
        transactionId: "$req-race",
        updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
        otherUserId: "@alice:example.org",
      },
    ];
    const { sendMessage, roomEventListener } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications,
      sasNoticeRetryDelayMs: 750,
    });

    try {
      roomEventListener("!dm:example.org", {
        event_id: "$start-race",
        sender: "@alice:example.org",
        type: "m.key.verification.start",
        origin_server_ts: Date.now(),
        content: {
          "m.relates_to": { event_id: "$req-race" },
        },
      });

      await vi.advanceTimersByTimeAsync(500);
      verifications[0] = {
        ...verifications[0],
        sas: {
          decimal: [1234, 5678, 9012],
          emoji: [
            ["🚀", "Rocket"],
            ["🦋", "Butterfly"],
            ["📕", "Book"],
          ],
        },
      };
      await vi.advanceTimersByTimeAsync(500);

      await vi.waitFor(() => {
        const bodies = getSentNoticeBodies(sendMessage);
        expectBodiesContain(bodies, "SAS emoji:");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores verification notices in unrelated non-DM rooms", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: {
        "!group:example.org": ["@alice:example.org", "@bot:example.org", "@ops:example.org"],
      },
      verifications: [
        {
          id: "verification-2",
          transactionId: "$different-flow-id",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
        },
      ],
    });

    roomEventListener("!group:example.org", {
      event_id: "$start-group",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req-group" },
      },
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(0);
  });

  it("routes unmapped verification summaries to the room marked direct in member state", async () => {
    const { sendMessage, verificationSummaryListener, flushTasks } = createHarness({
      joinedMembersByRoom: {
        "!fallback:example.org": ["@alice:example.org", "@bot:example.org"],
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      memberStateByRoomUser: {
        "!dm:example.org": {
          "@bot:example.org": { is_direct: true },
        },
      },
    });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    verificationSummaryListener({
      id: "verification-explicit-room",
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      phase: 3,
      phaseName: "started",
      pending: true,
      methods: ["m.sas.v1"],
      canAccept: false,
      hasSas: true,
      sas: {
        decimal: [6158, 1986, 3513],
        emoji: [
          ["🎁", "Gift"],
          ["🌍", "Globe"],
          ["🐴", "Horse"],
        ],
      },
      hasReciprocateQr: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((sendMessage.mock.calls as unknown[][])[0]?.[0]).toBe("!dm:example.org");
  });

  it("prefers the active direct room over a stale remembered strict room for unmapped summaries", async () => {
    const { sendMessage, roomEventListener, verificationSummaryListener, flushTasks } =
      createHarness({
        joinedMembersByRoom: {
          "!fallback:example.org": ["@alice:example.org", "@bot:example.org"],
          "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
        },
        memberStateByRoomUser: {
          "!dm:example.org": {
            "@bot:example.org": { is_direct: true },
          },
        },
      });
    if (!verificationSummaryListener) {
      throw new Error("verification.summary listener was not registered");
    }

    roomEventListener("!fallback:example.org", {
      event_id: "$start-fallback",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req-fallback" },
      },
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    sendMessage.mockClear();

    verificationSummaryListener({
      id: "verification-stale-room",
      otherUserId: "@alice:example.org",
      isSelfVerification: false,
      initiatedByMe: false,
      phase: 3,
      phaseName: "started",
      pending: true,
      methods: ["m.sas.v1"],
      canAccept: false,
      hasSas: true,
      sas: {
        decimal: [6158, 1986, 3513],
        emoji: [
          ["🎁", "Gift"],
          ["🌍", "Globe"],
          ["🐴", "Horse"],
        ],
      },
      hasReciprocateQr: false,
      completed: false,
      createdAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
      updatedAt: new Date("2026-02-25T21:42:55.000Z").toISOString(),
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((sendMessage.mock.calls as unknown[][])[0]?.[0]).toBe("!dm:example.org");
  });

  it("does not emit duplicate SAS notices for the same verification payload", async () => {
    const { sendMessage, roomEventListener, listVerifications, flushTasks } = createHarness({
      verifications: [
        {
          id: "verification-3",
          transactionId: "$req3",
          otherUserId: "@alice:example.org",
          sas: {
            decimal: [1111, 2222, 3333],
            emoji: [
              ["🚀", "Rocket"],
              ["🦋", "Butterfly"],
              ["📕", "Book"],
            ],
          },
        },
      ],
    });

    roomEventListener("!room:example.org", {
      event_id: "$start3",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req3" },
      },
    });
    await flushTasks();
    expect(sendMessage.mock.calls.length).toBeGreaterThan(0);

    roomEventListener("!room:example.org", {
      event_id: "$key3",
      sender: "@alice:example.org",
      type: "m.key.verification.key",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req3" },
      },
    });
    await flushTasks();
    expect(listVerifications).toHaveBeenCalledTimes(2);

    const sasBodies = getSentNoticeBodies(sendMessage).filter((body) =>
      body.includes("SAS emoji:"),
    );
    expect(sasBodies).toHaveLength(1);
  });

  it("ignores cancelled verification flows when DM fallback resolves SAS notices", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications: [
        {
          id: "verification-old-cancelled",
          transactionId: "$old-flow",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
          phaseName: "cancelled",
          phase: 4,
          pending: false,
          sas: {
            decimal: [1111, 2222, 3333],
            emoji: [
              ["🚀", "Rocket"],
              ["🦋", "Butterfly"],
              ["📕", "Book"],
            ],
          },
        },
        {
          id: "verification-new-active",
          transactionId: "$different-flow-id",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:43:54.000Z").toISOString(),
          phaseName: "started",
          phase: 3,
          pending: true,
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
        },
      ],
    });

    roomEventListener("!dm:example.org", {
      event_id: "$start-active",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req-active" },
      },
    });

    await flushTasks();
    const bodies = getSentNoticeBodies(sendMessage);
    expectBodiesContain(bodies, "SAS decimal: 6158 1986 3513");
    expectBodiesExclude(bodies, "SAS decimal: 1111 2222 3333");
  });

  it("preserves strict-room SAS fallback when active DM inspection cannot resolve a room", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      getJoinedRoomsError: new Error("temporary joined-room lookup failure"),
      verifications: [
        {
          id: "verification-active",
          transactionId: "$different-flow-id",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:43:54.000Z").toISOString(),
          phaseName: "started",
          phase: 3,
          pending: true,
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
        },
      ],
    });

    roomEventListener("!dm:example.org", {
      event_id: "$start-active",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req-active" },
      },
    });

    await flushTasks();
    expect(
      getSentNoticeBodies(sendMessage).some((body) => body.includes("SAS decimal: 6158 1986 3513")),
    ).toBe(true);
  });

  it("prefers the active verification for the current DM when multiple active summaries exist", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: {
        "!dm-current:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications: [
        {
          id: "verification-other-room",
          roomId: "!dm-other:example.org",
          transactionId: "$different-flow-other",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:44:54.000Z").toISOString(),
          phaseName: "started",
          phase: 3,
          pending: true,
          sas: {
            decimal: [1111, 2222, 3333],
            emoji: [
              ["🚀", "Rocket"],
              ["🦋", "Butterfly"],
              ["📕", "Book"],
            ],
          },
        },
        {
          id: "verification-current-room",
          roomId: "!dm-current:example.org",
          transactionId: "$different-flow-current",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:43:54.000Z").toISOString(),
          phaseName: "started",
          phase: 3,
          pending: true,
          sas: {
            decimal: [6158, 1986, 3513],
            emoji: [
              ["🎁", "Gift"],
              ["🌍", "Globe"],
              ["🐴", "Horse"],
            ],
          },
        },
      ],
    });

    roomEventListener("!dm-current:example.org", {
      event_id: "$start-room-scoped",
      sender: "@alice:example.org",
      type: "m.key.verification.start",
      origin_server_ts: Date.now(),
      content: {
        "m.relates_to": { event_id: "$req-room-scoped" },
      },
    });

    await flushTasks();
    const bodies = getSentNoticeBodies(sendMessage);
    expectBodiesContain(bodies, "SAS decimal: 6158 1986 3513");
    expectBodiesExclude(bodies, "SAS decimal: 1111 2222 3333");
  });

  it("does not emit SAS notices for cancelled verification events", async () => {
    const { sendMessage, roomEventListener, flushTasks } = createHarness({
      joinedMembersByRoom: {
        "!dm:example.org": ["@alice:example.org", "@bot:example.org"],
      },
      verifications: [
        {
          id: "verification-cancelled",
          transactionId: "$req-cancelled",
          otherUserId: "@alice:example.org",
          updatedAt: new Date("2026-02-25T21:42:54.000Z").toISOString(),
          phaseName: "cancelled",
          phase: 4,
          pending: false,
          sas: {
            decimal: [1111, 2222, 3333],
            emoji: [
              ["🚀", "Rocket"],
              ["🦋", "Butterfly"],
              ["📕", "Book"],
            ],
          },
        },
      ],
    });

    roomEventListener("!dm:example.org", {
      event_id: "$cancelled-1",
      sender: "@alice:example.org",
      type: "m.key.verification.cancel",
      origin_server_ts: Date.now(),
      content: {
        code: "m.mismatched_sas",
        reason: "The SAS did not match.",
        "m.relates_to": { event_id: "$req-cancelled" },
      },
    });

    await flushTasks();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const body = getSentNoticeBody(sendMessage, 0);
    expect(body).toContain("Matrix verification cancelled by @alice:example.org");
    expect(body).not.toContain("SAS decimal:");
  });

  it("warns once when encrypted events arrive without Matrix encryption enabled", () => {
    const { logger, roomEventListener } = createHarness({
      authEncryption: false,
    });

    roomEventListener("!room:example.org", {
      event_id: "$enc1",
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
      origin_server_ts: Date.now(),
      content: {},
    });
    roomEventListener("!room:example.org", {
      event_id: "$enc2",
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
      origin_server_ts: Date.now(),
      content: {},
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encrypted event received without encryption enabled; set channels.matrix.encryption=true and verify the device to decrypt",
      { roomId: "!room:example.org" },
    );
  });

  it("uses the active Matrix account path in encrypted-event warnings", () => {
    const { logger, roomEventListener } = createHarness({
      accountId: "ops",
      authEncryption: false,
      cfg: {
        channels: {
          matrix: {
            accounts: {
              ops: {},
            },
          },
        },
      },
    });

    roomEventListener("!room:example.org", {
      event_id: "$enc1",
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
      origin_server_ts: Date.now(),
      content: {},
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encrypted event received without encryption enabled; set channels.matrix.accounts.ops.encryption=true and verify the device to decrypt",
      { roomId: "!room:example.org" },
    );
  });

  it("warns once when crypto bindings are unavailable for encrypted rooms", () => {
    const { formatNativeDependencyHint, logger, roomEventListener } = createHarness({
      authEncryption: true,
      cryptoAvailable: false,
    });

    roomEventListener("!room:example.org", {
      event_id: "$enc1",
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
      origin_server_ts: Date.now(),
      content: {},
    });
    roomEventListener("!room:example.org", {
      event_id: "$enc2",
      sender: "@alice:example.org",
      type: EventType.RoomMessageEncrypted,
      origin_server_ts: Date.now(),
      content: {},
    });

    expect(formatNativeDependencyHint).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix: encryption enabled but crypto is unavailable; install hint",
      { roomId: "!room:example.org" },
    );
  });

  it("adds self-device guidance when decrypt failures come from the same Matrix user", async () => {
    const { logger, failedDecryptListener } = createHarness({
      accountId: "ops",
      selfUserId: "@gumadeiras:matrix.example.org",
    });
    if (!failedDecryptListener) {
      throw new Error("room.failed_decryption listener was not registered");
    }

    await failedDecryptListener(
      "!room:example.org",
      {
        event_id: "$enc-self",
        sender: "@gumadeiras:matrix.example.org",
        type: EventType.RoomMessageEncrypted,
        origin_server_ts: Date.now(),
        content: {},
      },
      new Error("The sender's device has not sent us the keys for this message."),
    );

    expectWarnContextFields(logger, 1, "Failed to decrypt message", {
      roomId: "!room:example.org",
      eventId: "$enc-self",
      sender: "@gumadeiras:matrix.example.org",
      senderMatchesOwnUser: true,
    });
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      "matrix: failed to decrypt a message from this same Matrix user. This usually means another Matrix device did not share the room key, or another OpenClaw runtime is using the same account. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
      {
        roomId: "!room:example.org",
        eventId: "$enc-self",
        sender: "@gumadeiras:matrix.example.org",
      },
    );
  });

  it("does not add self-device guidance for decrypt failures from another sender", async () => {
    const { logger, failedDecryptListener } = createHarness({
      accountId: "ops",
      selfUserId: "@gumadeiras:matrix.example.org",
    });
    if (!failedDecryptListener) {
      throw new Error("room.failed_decryption listener was not registered");
    }

    await failedDecryptListener(
      "!room:example.org",
      {
        event_id: "$enc-other",
        sender: "@alice:matrix.example.org",
        type: EventType.RoomMessageEncrypted,
        origin_server_ts: Date.now(),
        content: {},
      },
      new Error("The sender's device has not sent us the keys for this message."),
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expectWarnContextFields(logger, 1, "Failed to decrypt message", {
      roomId: "!room:example.org",
      eventId: "$enc-other",
      sender: "@alice:matrix.example.org",
      senderMatchesOwnUser: false,
    });
  });

  it("classifies repeated fresh post-healthy-sync decrypt failures separately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T16:21:00.000Z"));
    try {
      const healthySyncSinceMs = Date.now() - 60_000;
      const { logger, failedDecryptListener } = createHarness({
        accountId: "ops",
        getHealthySyncSinceMs: () => healthySyncSinceMs,
      });
      if (!failedDecryptListener) {
        throw new Error("room.failed_decryption listener was not registered");
      }

      for (const [index, roomId] of [
        "!room-a:example.org",
        "!room-b:example.org",
        "!room-c:example.org",
      ].entries()) {
        await failedDecryptListener(
          roomId,
          {
            event_id: `$enc-fresh-${index + 1}`,
            sender: `@alice${index + 1}:matrix.example.org`,
            type: EventType.RoomMessageEncrypted,
            origin_server_ts: Date.now() - 1_000 * (index + 1),
            content: {},
          },
          new Error("The sender's device has not sent us the keys for this message."),
        );
      }

      expectWarnContextFields(logger, 1, "Failed to decrypt fresh post-healthy-sync message", {
        eventId: "$enc-fresh-1",
        freshAfterHealthySync: true,
        postHealthySyncFailureCount: 1,
      });
      expectWarnContextFields(logger, 2, "Failed to decrypt fresh post-healthy-sync message", {
        eventId: "$enc-fresh-2",
        freshAfterHealthySync: true,
        postHealthySyncFailureCount: 2,
      });
      expectWarnContextFields(logger, 3, "Failed to decrypt fresh post-healthy-sync message", {
        eventId: "$enc-fresh-3",
        freshAfterHealthySync: true,
        postHealthySyncFailureCount: 3,
      });
      expectWarnContextFields(
        logger,
        4,
        "matrix: repeated fresh encrypted messages are still failing to decrypt after Matrix resumed healthy sync. This device may still be missing new room keys. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
        {
          failureCount: 3,
          roomCount: 3,
          senderCount: 3,
          rooms: ["!room-a:example.org", "!room-b:example.org", "!room-c:example.org"],
          sampleEventIds: ["$enc-fresh-1", "$enc-fresh-2", "$enc-fresh-3"],
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps decrypt failures before healthy sync on the generic warning path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T16:21:00.000Z"));
    try {
      let healthySyncSinceMs: number | undefined;
      const { logger, failedDecryptListener } = createHarness({
        accountId: "ops",
        getHealthySyncSinceMs: () => healthySyncSinceMs,
      });
      if (!failedDecryptListener) {
        throw new Error("room.failed_decryption listener was not registered");
      }

      await failedDecryptListener(
        "!room:example.org",
        {
          event_id: "$enc-old",
          sender: "@alice:matrix.example.org",
          type: EventType.RoomMessageEncrypted,
          origin_server_ts: Date.now() - 5 * 60_000,
          content: {},
        },
        new Error("The sender's device has not sent us the keys for this message."),
      );

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expectWarnContextFields(logger, 1, "Failed to decrypt message", {
        eventId: "$enc-old",
        freshAfterHealthySync: false,
      });

      healthySyncSinceMs = Date.now();

      await failedDecryptListener(
        "!room:example.org",
        {
          event_id: "$enc-fresh-after-ready",
          sender: "@alice:matrix.example.org",
          type: EventType.RoomMessageEncrypted,
          origin_server_ts: Date.now() + 1,
          content: {},
        },
        new Error("The sender's device has not sent us the keys for this message."),
      );

      expectWarnContextFields(logger, 2, "Failed to decrypt fresh post-healthy-sync message", {
        eventId: "$enc-fresh-after-ready",
        freshAfterHealthySync: true,
        postHealthySyncFailureCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-emits the aggregate warning for a new failure wave after the window clears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T16:21:00.000Z"));
    try {
      const healthySyncSinceMs = Date.now() - 60_000;
      const { logger, failedDecryptListener } = createHarness({
        accountId: "ops",
        getHealthySyncSinceMs: () => healthySyncSinceMs,
      });
      if (!failedDecryptListener) {
        throw new Error("room.failed_decryption listener was not registered");
      }

      for (const wave of [1, 2]) {
        for (const index of [1, 2, 3]) {
          await failedDecryptListener(
            `!room-${wave}-${index}:example.org`,
            {
              event_id: `$enc-wave-${wave}-${index}`,
              sender: `@alice${wave}${index}:matrix.example.org`,
              type: EventType.RoomMessageEncrypted,
              origin_server_ts: Date.now() - index * 1_000,
              content: {},
            },
            new Error("The sender's device has not sent us the keys for this message."),
          );
        }

        if (wave === 1) {
          await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
        }
      }

      expectWarnContextFields(
        logger,
        4,
        "matrix: repeated fresh encrypted messages are still failing to decrypt after Matrix resumed healthy sync. This device may still be missing new room keys. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
        {
          sampleEventIds: ["$enc-wave-1-1", "$enc-wave-1-2", "$enc-wave-1-3"],
        },
      );
      expectWarnContextFields(
        logger,
        8,
        "matrix: repeated fresh encrypted messages are still failing to decrypt after Matrix resumed healthy sync. This device may still be missing new room keys. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
        {
          sampleEventIds: ["$enc-wave-2-1", "$enc-wave-2-2", "$enc-wave-2-3"],
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets tracked failures when healthy sync restarts before the old window expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T16:21:00.000Z"));
    try {
      let healthySyncSinceMs = Date.now() - 60_000;
      const { logger, failedDecryptListener } = createHarness({
        accountId: "ops",
        getHealthySyncSinceMs: () => healthySyncSinceMs,
      });
      if (!failedDecryptListener) {
        throw new Error("room.failed_decryption listener was not registered");
      }

      for (const index of [1, 2, 3]) {
        await failedDecryptListener(
          `!room-first-${index}:example.org`,
          {
            event_id: `$enc-first-${index}`,
            sender: `@alice-first-${index}:matrix.example.org`,
            type: EventType.RoomMessageEncrypted,
            origin_server_ts: Date.now() - index * 1_000,
            content: {},
          },
          new Error("The sender's device has not sent us the keys for this message."),
        );
      }

      healthySyncSinceMs = Date.now();

      for (const index of [1, 2, 3]) {
        await failedDecryptListener(
          `!room-second-${index}:example.org`,
          {
            event_id: `$enc-second-${index}`,
            sender: `@alice-second-${index}:matrix.example.org`,
            type: EventType.RoomMessageEncrypted,
            origin_server_ts: Date.now() + index,
            content: {},
          },
          new Error("The sender's device has not sent us the keys for this message."),
        );
      }

      expectWarnContextFields(logger, 5, "Failed to decrypt fresh post-healthy-sync message", {
        eventId: "$enc-second-1",
        freshAfterHealthySync: true,
        postHealthySyncFailureCount: 1,
      });
      expectWarnContextFields(logger, 6, "Failed to decrypt fresh post-healthy-sync message", {
        eventId: "$enc-second-2",
        freshAfterHealthySync: true,
        postHealthySyncFailureCount: 2,
      });
      expectWarnContextFields(logger, 7, "Failed to decrypt fresh post-healthy-sync message", {
        eventId: "$enc-second-3",
        freshAfterHealthySync: true,
        postHealthySyncFailureCount: 3,
      });
      expectWarnContextFields(
        logger,
        8,
        "matrix: repeated fresh encrypted messages are still failing to decrypt after Matrix resumed healthy sync. This device may still be missing new room keys. Check 'openclaw matrix verify status --verbose --account ops' and 'openclaw matrix devices list --account ops'.",
        {
          sampleEventIds: ["$enc-second-1", "$enc-second-2", "$enc-second-3"],
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs decrypt guidance when getUserId fails during lookup", async () => {
    const { logger, logVerboseMessage, failedDecryptListener } = createHarness({
      accountId: "ops",
      selfUserIdError: new Error("lookup failed"),
    });
    if (!failedDecryptListener) {
      throw new Error("room.failed_decryption listener was not registered");
    }

    await expect(
      failedDecryptListener(
        "!room:example.org",
        {
          event_id: "$enc-lookup-fail",
          sender: "@gumadeiras:matrix.example.org",
          type: EventType.RoomMessageEncrypted,
          origin_server_ts: Date.now(),
          content: {},
        },
        new Error("The sender's device has not sent us the keys for this message."),
      ),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expectWarnContextFields(logger, 1, "Failed to decrypt message", {
      roomId: "!room:example.org",
      eventId: "$enc-lookup-fail",
      senderMatchesOwnUser: false,
    });
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "matrix: failed resolving self user id for decrypt warning: Error: lookup failed",
    );
  });
});
