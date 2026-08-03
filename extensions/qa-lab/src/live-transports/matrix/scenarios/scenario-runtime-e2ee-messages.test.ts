import { beforeEach, describe, expect, it, vi } from "vitest";
import { MATRIX_QA_SYNC_STATE_AFTER_FAULT_RULE_ID } from "./scenario-runtime-e2ee-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

const mocks = vi.hoisted(() => ({
  runMatrixQaE2eeTopLevelScenario: vi.fn(),
}));

vi.mock("./scenario-runtime-e2ee-room.js", () => ({
  buildMatrixE2eeReplyArtifact: vi.fn(),
  buildSyncStateAfterMissingEncryptionFaultRule: (accessToken: string) => ({
    id: "sync-state-after-missing-encryption",
    match: (request: { bearerToken?: string }) => request.bearerToken === accessToken,
  }),
  runMatrixQaE2eeTopLevelScenario: mocks.runMatrixQaE2eeTopLevelScenario,
  runMatrixQaE2eeTopLevelWithClient: vi.fn(),
  withMatrixQaE2eeDriver: vi.fn(),
  withMatrixQaIsolatedE2eeDriverRoom: vi.fn(),
}));

import { runMatrixQaE2eeStateAfterMissingEncryptionScenario } from "./scenario-runtime-e2ee-messages.js";

describe("runMatrixQaE2eeStateAfterMissingEncryptionScenario", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runMatrixQaE2eeTopLevelScenario.mockResolvedValue({
      driverEventId: "$driver",
      driverUserId: "@driver:matrix-qa.test",
      reply: {
        eventId: "$reply",
        sender: "@sut:matrix-qa.test",
        tokenMatched: true,
      },
      roomId: "!room:matrix-qa.test",
      roomKey: "state-after",
      since: "sync-1",
      token: "MATRIX_QA_E2EE_STATE_AFTER",
    });
  });

  it("restarts through an in-place rule without changing the canonical homeserver", async () => {
    const order: string[] = [];
    const remove = vi.fn(() => order.push("remove"));
    const installFaultRule = vi.fn(() => {
      order.push("install");
      return { hits: () => [], remove };
    });
    const restartGatewayAfterStateMutation = vi.fn(
      async (mutateState: (context: { stateDir: string }) => Promise<void>) => {
        order.push("restart");
        await mutateState({ stateDir: "/tmp/matrix-qa-state" });
      },
    );
    mocks.runMatrixQaE2eeTopLevelScenario.mockImplementationOnce(async () => {
      order.push("run");
      return {
        driverEventId: "$driver",
        driverUserId: "@driver:matrix-qa.test",
        reply: {
          eventId: "$reply",
          sender: "@sut:matrix-qa.test",
          tokenMatched: true,
        },
        roomId: "!room:matrix-qa.test",
        roomKey: "state-after",
        since: "sync-1",
        token: "MATRIX_QA_E2EE_STATE_AFTER",
      };
    });
    const context = {
      baseUrl: "http://127.0.0.1:28123",
      installFaultRule,
      restartGatewayAfterStateMutation,
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      timeoutMs: 30_000,
    } as unknown as MatrixQaScenarioContext;

    const result = await runMatrixQaE2eeStateAfterMissingEncryptionScenario(context);

    expect(order).toEqual(["install", "restart", "run", "remove"]);
    expect(restartGatewayAfterStateMutation).toHaveBeenCalledOnce();
    expect(installFaultRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: MATRIX_QA_SYNC_STATE_AFTER_FAULT_RULE_ID }),
    );
    expect(result.artifacts).toMatchObject({
      faultProxyBaseUrl: context.baseUrl,
      stateAfterFaultHitCount: 0,
      strippedSyncStateAfterParam: true,
    });
  });

  it("removes the in-place rule when the encrypted turn fails", async () => {
    const remove = vi.fn();
    mocks.runMatrixQaE2eeTopLevelScenario.mockRejectedValueOnce(new Error("turn failed"));
    const context = {
      baseUrl: "http://127.0.0.1:28123",
      installFaultRule: () => ({ hits: () => [], remove }),
      restartGatewayAfterStateMutation: async (
        mutateState: (context: { stateDir: string }) => Promise<void>,
      ) => {
        await mutateState({ stateDir: "/tmp/matrix-qa-state" });
      },
      sutAccessToken: "sut-token",
      timeoutMs: 30_000,
    } as unknown as MatrixQaScenarioContext;

    await expect(runMatrixQaE2eeStateAfterMissingEncryptionScenario(context)).rejects.toThrow(
      "turn failed",
    );
    expect(remove).toHaveBeenCalledOnce();
  });
});
