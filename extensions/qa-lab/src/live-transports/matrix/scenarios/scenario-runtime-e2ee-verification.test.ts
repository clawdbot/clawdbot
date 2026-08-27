import { beforeEach, describe, expect, it, vi } from "vitest";
import { MATRIX_QA_E2EE_VERIFICATION_DM_ROOM_KEY } from "./scenario-contract.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

const mocks = vi.hoisted(() => ({
  resolveMatrixQaScenarioRoomId: vi.fn(),
  withMatrixQaE2eeDriverAndObserver: vi.fn(),
}));

vi.mock("./scenario-contract.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveMatrixQaScenarioRoomId: mocks.resolveMatrixQaScenarioRoomId,
}));

vi.mock("./scenario-runtime-e2ee-shared.js", async (importOriginal) => ({
  ...(await importOriginal()),
  withMatrixQaE2eeDriverAndObserver: mocks.withMatrixQaE2eeDriverAndObserver,
}));

import { runMatrixQaE2eeDmSasVerificationScenario } from "./scenario-runtime-e2ee-verification.js";

function createContext(): MatrixQaScenarioContext {
  return {
    driverPassword: "driver-password",
    observerPassword: "observer-password",
  } as MatrixQaScenarioContext;
}

beforeEach(() => {
  mocks.resolveMatrixQaScenarioRoomId.mockReset();
  mocks.withMatrixQaE2eeDriverAndObserver.mockReset();
});

describe("runMatrixQaE2eeDmSasVerificationScenario", () => {
  it("requires authoritative readiness for the resolved verification DM", async () => {
    const roomId = "!verification:matrix-qa.test";
    const context = createContext();
    const execution = { artifacts: {}, details: "verification not started" };
    mocks.resolveMatrixQaScenarioRoomId.mockReturnValue(roomId);
    mocks.withMatrixQaE2eeDriverAndObserver.mockResolvedValue(execution);

    await expect(runMatrixQaE2eeDmSasVerificationScenario(context)).resolves.toBe(execution);

    expect(mocks.resolveMatrixQaScenarioRoomId).toHaveBeenCalledWith(
      context,
      MATRIX_QA_E2EE_VERIFICATION_DM_ROOM_KEY,
    );
    expect(mocks.withMatrixQaE2eeDriverAndObserver).toHaveBeenCalledOnce();
    const [forwardedContext, scenarioId, run, options] =
      mocks.withMatrixQaE2eeDriverAndObserver.mock.calls[0]!;
    expect(forwardedContext).toBe(context);
    expect(scenarioId).toBe("matrix-e2ee-dm-sas-verification");
    expect(run).toEqual(expect.any(Function));
    expect(options).toEqual({ readyRoomIds: [roomId] });
  });
});
