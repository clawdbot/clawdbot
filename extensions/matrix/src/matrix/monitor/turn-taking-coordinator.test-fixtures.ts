import { vi } from "vitest";
import {
  MATRIX_PREVIEW_PROTOCOL_KEY,
  type MatrixOpenClawPreviewMarker,
} from "../preview-protocol.js";
import type { MatrixRawEvent } from "../sdk.js";

const completionMocks = vi.hoisted(() => ({
  complete: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/simple-completion-runtime", () => ({
  prepareSimpleCompletionModelForAgent: completionMocks.prepare,
  completeWithPreparedSimpleCompletionModel: completionMocks.complete,
  extractAssistantText: (value: { text?: string }) => value.text ?? "",
}));

vi.mock("../accounts.js", () => ({
  listMatrixAccountIds: () => ["alpha", "beta", "gamma"],
  resolveMatrixAccount: ({ accountId }: { accountId: string }) => ({
    accountId,
    enabled: accountId !== "disabled",
    configured: accountId !== "unconfigured",
  }),
  resolveMatrixAccountUserId: ({ accountId }: { accountId: string }) => `@${accountId}:example.org`,
}));

const coordinatorModule = await import("./turn-taking-coordinator.js");

export const createMatrixTurnTakingCoordinator =
  coordinatorModule.createMatrixTurnTakingCoordinator;
export const MATRIX_ACTIVE_PREVIEW_TTL_MS = coordinatorModule.MATRIX_ACTIVE_PREVIEW_TTL_MS;
export const MATRIX_TERMINAL_REPLAY_TTL_MS = coordinatorModule.MATRIX_TERMINAL_REPLAY_TTL_MS;

export type { MatrixOpenClawPreviewMarker, MatrixRawEvent };

export function getTurnTakingCoordinatorCompletionMocks() {
  return completionMocks;
}

function createCore() {
  return {
    channel: { routing: { resolveAgentRoute: vi.fn() } },
    agent: {
      resolveAgentIdentity: (_cfg: unknown, agentId: string) => ({ name: agentId.toUpperCase() }),
    },
  } as never;
}

export function register(
  coordinator: ReturnType<typeof createMatrixTurnTakingCoordinator>,
  params: {
    accountId: string;
    userId: string;
    getJoinedRoomMembers: ReturnType<typeof vi.fn>;
    getEvent?: ReturnType<typeof vi.fn>;
    getRelations?: ReturnType<typeof vi.fn>;
    prepareAccess?: NonNullable<
      Parameters<
        ReturnType<typeof createMatrixTurnTakingCoordinator>["registerMonitor"]
      >[0]["prepareAccess"]
    >;
  },
) {
  return coordinator.registerMonitor({
    accountId: params.accountId,
    userId: params.userId,
    homeserver: "https://matrix.example.org",
    client: {
      getJoinedRoomMembers: params.getJoinedRoomMembers,
      getEvent: params.getEvent ?? vi.fn(),
      getRelations: params.getRelations ?? vi.fn(),
    } as never,
    core: createCore(),
    log: vi.fn(),
    prepareAccess:
      params.prepareAccess ??
      (async () => ({
        agentId: `agent-${params.accountId}`,
        canParticipate: true,
        isDirectMessage: false,
        includesContext: () => true,
      })),
  });
}

export const baseMarker: MatrixOpenClawPreviewMarker = {
  v: 1,
  responseId: "response-1",
  triggerEventId: "$trigger",
  state: "in-progress",
  revision: 0,
  kind: "answer",
};

export function protocolRoot(
  marker = baseMarker,
  eventId = "$root",
  body = "partial",
): MatrixRawEvent {
  return {
    event_id: eventId,
    sender: "@alpha:example.org",
    type: "m.room.message",
    origin_server_ts: Date.now(),
    content: { msgtype: "m.text", body, [MATRIX_PREVIEW_PROTOCOL_KEY]: marker },
  };
}

export function protocolEdit(
  marker: MatrixOpenClawPreviewMarker,
  eventId = "$edit",
  body = "final",
  originalEventId = "$root",
): MatrixRawEvent {
  return {
    event_id: eventId,
    sender: "@alpha:example.org",
    type: "m.room.message",
    origin_server_ts: Date.now(),
    content: {
      msgtype: "m.text",
      body: `* ${body}`,
      [MATRIX_PREVIEW_PROTOCOL_KEY]: marker,
      "m.new_content": {
        msgtype: "m.text",
        body,
        [MATRIX_PREVIEW_PROTOCOL_KEY]: marker,
      },
      "m.relates_to": { rel_type: "m.replace", event_id: originalEventId },
    },
  };
}

export function resetTurnTakingCoordinatorTestMocks(): void {
  completionMocks.prepare.mockReset();
  completionMocks.complete.mockReset();
  completionMocks.prepare.mockResolvedValue({
    model: { provider: "openai", id: "gpt-5.6-luna" },
    auth: { apiKey: "test" },
    selection: { provider: "openai", modelId: "gpt-5.6-luna" },
  });
}
