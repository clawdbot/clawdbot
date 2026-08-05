import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const matrixDriverId = "@driver:matrix.test";
const primaryRoomId = "!primary:matrix.test";
const secondaryRoomId = "!secondary:matrix.test";
const sharedSessionKey = `agent:qa:matrix:direct:${matrixDriverId}`;

type MatrixScenarioId = "dm-per-room-session" | "dm-shared-session";

function createMatrixSessionEntry(
  sessionId: string,
  roomId: string,
  updatedAt: number,
  nativeDirectUserId = matrixDriverId,
) {
  return {
    sessionId,
    updatedAt,
    chatType: "direct",
    delivery: {
      kind: "external",
      route: {
        channel: "matrix",
        accountId: "sut",
        target: {
          to: `room:${roomId}`,
          chatType: "direct",
        },
      },
      context: {
        channel: "matrix",
        to: `room:${roomId}`,
        accountId: "sut",
      },
      origin: {
        provider: "matrix",
        surface: "matrix",
        accountId: "sut",
        chatType: "direct",
        from: `matrix:${nativeDirectUserId}`,
        to: `room:${roomId}`,
        nativeChannelId: roomId,
        nativeDirectUserId,
      },
    },
  };
}

async function runMatrixSessionScenario(params: {
  scenarioId: MatrixScenarioId;
  sharedSessionIdentity: boolean;
  sharedSessionKey?: boolean;
  sharedTranscriptId?: boolean;
  returnedSenderId?: string;
  secondaryNativeSenderId?: string;
}) {
  const scenario = readQaScenarioById(params.scenarioId);
  const config = scenario.execution.config as {
    primaryConversationId: string;
    secondaryConversationId: string;
    primaryMarker: string;
    secondaryMarker: string;
  };
  const state = createQaBusState();
  const usesSharedSessionKey = params.sharedSessionKey ?? params.sharedSessionIdentity;
  const usesSharedTranscriptId = params.sharedTranscriptId ?? params.sharedSessionIdentity;
  const primarySessionKey = usesSharedSessionKey
    ? sharedSessionKey
    : `agent:qa:matrix:channel:${primaryRoomId}`;
  const secondarySessionKey = usesSharedSessionKey
    ? sharedSessionKey
    : `agent:qa:matrix:channel:${secondaryRoomId}`;
  const primarySessionId = "matrix-session-primary";
  const secondarySessionId = usesSharedTranscriptId ? primarySessionId : "matrix-session-secondary";

  const readRawQaSessionStore = vi.fn(async () => {
    const inboundMessages = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "inbound");
    if (inboundMessages.length === 0) {
      return {};
    }
    if (inboundMessages.length === 1) {
      return {
        [primarySessionKey]: createMatrixSessionEntry(primarySessionId, primaryRoomId, 1),
      };
    }
    if (usesSharedSessionKey) {
      return {
        [sharedSessionKey]: createMatrixSessionEntry(
          secondarySessionId,
          secondaryRoomId,
          2,
          params.secondaryNativeSenderId,
        ),
      };
    }
    return {
      [primarySessionKey]: createMatrixSessionEntry(primarySessionId, primaryRoomId, 1),
      [secondarySessionKey]: createMatrixSessionEntry(
        secondarySessionId,
        secondaryRoomId,
        2,
        params.secondaryNativeSenderId,
      ),
    };
  });

  let outboundWaitCount = 0;
  const transport = {
    id: "matrix",
    accountId: "sut",
    state,
    reset: async () => {
      state.reset();
    },
    sendInbound: async (input: Parameters<typeof state.addInboundMessage>[0]) =>
      state.addInboundMessage({
        ...input,
        accountId: "sut",
        senderId: params.returnedSenderId ?? matrixDriverId,
      }),
    waitForOutbound: async (input: {
      conversation?: { id: string; kind: string };
      sinceIndex?: number;
      textIncludes?: string;
      timeoutMs?: number;
    }) => {
      outboundWaitCount += 1;
      if (outboundWaitCount === 1) {
        state.addOutboundMessage({
          accountId: "sut",
          to: `dm:${config.primaryConversationId}`,
          text: config.primaryMarker,
        });
      } else if (outboundWaitCount === 2) {
        if (params.scenarioId === "dm-shared-session") {
          state.addOutboundMessage({
            accountId: "sut",
            to: `dm:${config.secondaryConversationId}`,
            text: "This Matrix DM is sharing a session with another room. Set channels.matrix.dm.sessionScope to per-room to isolate it.",
          });
        }
        state.addOutboundMessage({
          accountId: "sut",
          to: `dm:${config.secondaryConversationId}`,
          text: config.secondaryMarker,
        });
      }
      const match = state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound")
        .slice(input.sinceIndex ?? 0)
        .find(
          (message) =>
            (!input.conversation || message.conversation.id === input.conversation.id) &&
            (!input.conversation || message.conversation.kind === input.conversation.kind) &&
            (!input.textIncludes || message.text.includes(input.textIncludes)),
        );
      if (!match) {
        throw new Error(`timed out after ${input.timeoutMs}ms waiting for Matrix outbound marker`);
      }
      return match;
    },
  };

  return await runLoadedScenarioFlow(params.scenarioId, {
    state,
    api: {
      env: {
        providerMode: "mock-openai",
        gateway: { tempRoot: "/qa-matrix-session-identity" },
      },
      transport,
      readRawQaSessionStore,
    },
  });
}

describe("Matrix DM scenario session identity evidence", () => {
  it.each([
    { lane: "live", returnedSenderId: matrixDriverId },
    { lane: "crabline", returnedSenderId: "driver" },
  ])(
    "accepts distinct room-owned sessions on the $lane Matrix lane",
    async ({ returnedSenderId }) => {
      await expect(
        runMatrixSessionScenario({
          scenarioId: "dm-per-room-session",
          sharedSessionIdentity: false,
          returnedSenderId,
        }),
      ).resolves.toMatchObject({ status: "pass" });
    },
  );

  it("rejects a shared session in per-room mode even when both replies and notice policy pass", async () => {
    await expect(
      runMatrixSessionScenario({
        scenarioId: "dm-per-room-session",
        sharedSessionIdentity: true,
      }),
    ).rejects.toThrow(/session|room|isolat|shared/i);
  });

  it("rejects a reused per-room session key even when its transcript id rotates", async () => {
    await expect(
      runMatrixSessionScenario({
        scenarioId: "dm-per-room-session",
        sharedSessionIdentity: false,
        sharedSessionKey: true,
        sharedTranscriptId: false,
      }),
    ).rejects.toThrow(/session|room|isolat|shared/i);
  });

  it.each([
    { lane: "live", returnedSenderId: matrixDriverId },
    { lane: "crabline", returnedSenderId: "driver" },
  ])(
    "accepts one shared user-owned session on the $lane Matrix lane",
    async ({ returnedSenderId }) => {
      await expect(
        runMatrixSessionScenario({
          scenarioId: "dm-shared-session",
          sharedSessionIdentity: true,
          returnedSenderId,
        }),
      ).resolves.toMatchObject({ status: "pass" });
    },
  );

  it("rejects separate sessions in shared mode even when the expected notice is emitted", async () => {
    await expect(
      runMatrixSessionScenario({
        scenarioId: "dm-shared-session",
        sharedSessionIdentity: false,
      }),
    ).rejects.toThrow(/session|room|isolat|shared/i);
  });

  it("rejects distinct shared-mode session keys even when they alias one transcript id", async () => {
    await expect(
      runMatrixSessionScenario({
        scenarioId: "dm-shared-session",
        sharedSessionIdentity: true,
        sharedSessionKey: false,
        sharedTranscriptId: true,
      }),
    ).rejects.toThrow(/session|room|isolat|shared/i);
  });

  it.each([
    { scenarioId: "dm-per-room-session" as const, sharedSessionIdentity: false },
    { scenarioId: "dm-shared-session" as const, sharedSessionIdentity: true },
  ])("rejects a different persisted Matrix sender in $scenarioId", async (scenario) => {
    await expect(
      runMatrixSessionScenario({
        ...scenario,
        returnedSenderId: "driver",
        secondaryNativeSenderId: "@intruder:matrix.test",
      }),
    ).rejects.toThrow(/session|room|isolat|shared/i);
  });
});
