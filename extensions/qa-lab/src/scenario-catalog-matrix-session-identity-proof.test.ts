import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const matrixDriverId = "@driver:matrix.test";
const primaryRoomId = "!primary:matrix.test";
const secondaryRoomId = "!secondary:matrix.test";
const sharedSessionKey = `agent:qa:matrix:direct:${matrixDriverId}`;

type MatrixScenarioId = "dm-per-room-session" | "dm-shared-session";

function createMatrixSessionEntry(sessionId: string, roomId: string, updatedAt: number) {
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
        from: `matrix:${matrixDriverId}`,
        to: `room:${roomId}`,
        nativeChannelId: roomId,
        nativeDirectUserId: matrixDriverId,
      },
    },
  };
}

async function runMatrixSessionScenario(params: {
  scenarioId: MatrixScenarioId;
  sharedSessionIdentity: boolean;
}) {
  const scenario = readQaScenarioById(params.scenarioId);
  const config = scenario.execution.config as {
    primaryConversationId: string;
    secondaryConversationId: string;
    primaryMarker: string;
    secondaryMarker: string;
  };
  const state = createQaBusState();
  const primarySessionKey = params.sharedSessionIdentity
    ? sharedSessionKey
    : `agent:qa:matrix:channel:${primaryRoomId}`;
  const secondarySessionKey = params.sharedSessionIdentity
    ? sharedSessionKey
    : `agent:qa:matrix:channel:${secondaryRoomId}`;
  const primarySessionId = "matrix-session-primary";
  const secondarySessionId = params.sharedSessionIdentity
    ? primarySessionId
    : "matrix-session-secondary";

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
    if (params.sharedSessionIdentity) {
      return {
        [sharedSessionKey]: createMatrixSessionEntry(primarySessionId, secondaryRoomId, 2),
      };
    }
    return {
      [primarySessionKey]: createMatrixSessionEntry(primarySessionId, primaryRoomId, 1),
      [secondarySessionKey]: createMatrixSessionEntry(secondarySessionId, secondaryRoomId, 2),
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
        senderId: matrixDriverId,
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
  it("accepts distinct room-owned sessions when per-room replies have no shared notice", async () => {
    await expect(
      runMatrixSessionScenario({
        scenarioId: "dm-per-room-session",
        sharedSessionIdentity: false,
      }),
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("rejects a shared session in per-room mode even when both replies and notice policy pass", async () => {
    await expect(
      runMatrixSessionScenario({
        scenarioId: "dm-per-room-session",
        sharedSessionIdentity: true,
      }),
    ).rejects.toThrow(/session|room|isolat|shared/i);
  });

  it("accepts one shared user-owned session when both rooms receive the notice and replies", async () => {
    await expect(
      runMatrixSessionScenario({
        scenarioId: "dm-shared-session",
        sharedSessionIdentity: true,
      }),
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("rejects separate sessions in shared mode even when the expected notice is emitted", async () => {
    await expect(
      runMatrixSessionScenario({
        scenarioId: "dm-shared-session",
        sharedSessionIdentity: false,
      }),
    ).rejects.toThrow(/session|room|isolat|shared/i);
  });
});
