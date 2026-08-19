import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  invokeSessionDispatch,
  invokeSessionMove,
  invokeSessionReclaim,
  makeDispatchTestContext,
  makeFailedPlacement,
  makeReclaimedPlacement,
  makeSessionTarget,
} from "./sessions-dispatch.test-support.js";
import type { SessionMutationAuthorization } from "./types.js";

const mocks = getDispatchTestMocks();
const activePlacement = (): WorkerSessionPlacementRecord => ({
  ...makeReclaimedPlacement(),
  state: "active",
  recoveryError: null,
  terminalReason: null,
  terminalAtMs: null,
});

describe("placement session authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockReturnValue(
      makeSessionTarget({
        sessionId,
        agentRuntimeOverride: "openclaw",
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
  });

  it("rejects queued placement mutations after session participation is revoked", async () => {
    const scenarios = [
      {
        name: "dispatch",
        placement: undefined,
        invoke: (
          context: ReturnType<typeof makeDispatchTestContext>,
          authorization: SessionMutationAuthorization,
        ) => invokeSessionDispatch(context, { profileId: "test" }, authorization),
        service: (afterWait: (authorize?: () => void) => Promise<void>) => ({
          dispatch: vi.fn(async (_request, _onTransition, authorize?: () => void) => {
            await afterWait(authorize);
            return activePlacement();
          }),
        }),
      },
      {
        name: "move",
        placement: activePlacement(),
        invoke: (
          context: ReturnType<typeof makeDispatchTestContext>,
          authorization: SessionMutationAuthorization,
        ) =>
          invokeSessionMove(
            context,
            {
              expected: { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 },
              target: { kind: "gateway" },
            },
            authorization,
          ),
        service: (afterWait: (authorize?: () => void) => Promise<void>) => ({
          dispatch: vi.fn(),
          move: vi.fn(async (_request, _onTransition, authorize?: () => void) => {
            await afterWait(authorize);
            return { state: "local" as const, generation: 5 };
          }),
        }),
      },
      ...(["active", "failed"] as const).map((state) => ({
        name: `${state} reclaim`,
        placement:
          state === "active"
            ? activePlacement()
            : { ...makeFailedPlacement(), environmentId: null },
        invoke: (
          context: ReturnType<typeof makeDispatchTestContext>,
          authorization: SessionMutationAuthorization,
        ) => invokeSessionReclaim(context, authorization),
        service: (afterWait: (authorize?: () => void) => Promise<void>) => ({
          dispatch: vi.fn(),
          reclaim: vi.fn(async (_request, authorize?: () => void) => {
            await afterWait(authorize);
            return makeReclaimedPlacement();
          }),
        }),
      })),
    ];

    for (const scenario of scenarios) {
      let participating = true;
      const authorizationError = new SessionMutationAuthorizationChangedError(
        errorShape(ErrorCodes.INVALID_REQUEST, "session participation changed"),
      );
      const authorization: SessionMutationAuthorization = {
        assertCurrent: () => {
          if (!participating) {
            throw authorizationError;
          }
        },
        assertTargetCurrent: vi.fn(),
      };
      const operationStarted = createDeferredCore();
      const releaseOperation = createDeferredCore();
      const durableTransition = vi.fn();
      const afterWait = async (authorize?: () => void) => {
        operationStarted.resolve();
        await releaseOperation.promise;
        authorize?.();
        durableTransition();
      };
      const context = makeDispatchTestContext({
        workerPlacementDispatchService: scenario.service(afterWait) as never,
        workerSessionPlacementService: {
          getMany: () => new Map(scenario.placement ? [[sessionId, scenario.placement]] : []),
        },
      });

      const operation = scenario.invoke(context, authorization);
      await operationStarted.promise;
      participating = false;
      releaseOperation.resolve();

      await expect(operation, scenario.name).rejects.toBe(authorizationError);
      expect(durableTransition, scenario.name).not.toHaveBeenCalled();
    }
  });
});
