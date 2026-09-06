// Covers message-action cross-context policy, markers, and presentation
// decoration behavior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMessageAction } from "./message-action-runner.js";
import {
  createMessageActionContextFixture,
  runDryAction,
  runDrySend,
  workspaceConfig,
} from "./message-action-runner.test-support.js";

const contextFixture = createMessageActionContextFixture();
const { handleWorkspaceAction } = contextFixture;

describe("runMessageAction context isolation", () => {
  beforeEach(() => contextFixture.setup());
  afterEach(() => contextFixture.cleanup());
  it.each([
    {
      name: "a channel id passed as channel",
      actionParams: { channel: "C_TARGET" },
      expectedError: 'Unknown channel "c_target"',
    },
    {
      name: "targets passed instead of target",
      actionParams: { targets: ["C_TARGET"] },
      expectedError: "Action read requires a target.",
    },
    {
      name: "an empty targets array",
      actionParams: { targets: [] },
      expectedError: "Action read requires a target.",
    },
  ])("rejects read with $name before plugin dispatch", async ({ actionParams, expectedError }) => {
    await expect(
      runMessageAction({
        cfg: workspaceConfig,
        action: "read",
        params: actionParams,
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelId: "C_CURRENT",
          currentChannelProvider: "workspace",
        },
        dryRun: false,
      }),
    ).rejects.toThrow(expectedError);
    expect(handleWorkspaceAction).not.toHaveBeenCalled();
  });
  it.each([
    {
      name: "send",
      run: (abortSignal: AbortSignal) =>
        runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "#C12345678",
            message: "hi",
          },
          abortSignal,
        }),
    },
    {
      name: "broadcast",
      run: (abortSignal: AbortSignal) =>
        runDryAction({
          cfg: workspaceConfig,
          action: "broadcast",
          actionParams: {
            targets: ["channel:C12345678"],
            channel: "workspace",
            message: "hi",
          },
          abortSignal,
        }),
    },
  ])("aborts $name when abortSignal is already aborted", async ({ run }) => {
    const controller = new AbortController();
    controller.abort();
    let rejection: unknown;
    try {
      await run(controller.signal);
    } catch (error) {
      rejection = error;
    }
    expect((rejection as { name?: unknown }).name).toBe("AbortError");
  });
});
