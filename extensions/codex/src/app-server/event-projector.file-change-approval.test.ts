import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  THREAD_ID,
  TURN_ID,
  createParams,
  createProjector,
  forCurrentTurn,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector file-change approval correlation", () => {
  it("isolates and consumes correlated file-change approval params", async () => {
    const projector = await createProjector(await createParams());
    const changes = [{ path: "src/correlated.ts", kind: { type: "update" } }];

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "fileChange",
          id: "patch-correlated",
          changes,
          status: "inProgress",
        },
      }),
    );

    expect(
      projector.takeFileChangeApprovalToolParams({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "patch-other",
      }),
    ).toBeUndefined();

    expect(
      projector.takeFileChangeApprovalToolParams({
        threadId: THREAD_ID,
        turnId: "turn-other",
        itemId: "patch-correlated",
      }),
    ).toBeUndefined();

    expect(
      projector.takeFileChangeApprovalToolParams({
        threadId: "thread-other",
        turnId: TURN_ID,
        itemId: "patch-correlated",
      }),
    ).toBeUndefined();

    const requestParams = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "patch-correlated",
    };

    expect(projector.takeFileChangeApprovalToolParams(requestParams)).toEqual({ changes });
    expect(projector.takeFileChangeApprovalToolParams(requestParams)).toBeUndefined();

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "fileChange",
          id: "patch-completed",
          changes,
          status: "inProgress",
        },
      }),
    );

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "fileChange",
          id: "patch-completed",
          changes,
          status: "completed",
        },
      }),
    );

    expect(
      projector.takeFileChangeApprovalToolParams({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "patch-completed",
      }),
    ).toBeUndefined();
  });
});
