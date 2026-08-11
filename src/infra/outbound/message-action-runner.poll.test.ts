// Covers message-action poll handling through plugin dispatch and core gateway
// poll fallback.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearMessageActionPollMocks,
  messageActionRunnerMocks as mocks,
  pollerConfig,
  resetMessageActionPollMocks,
  runPollAction,
} from "./message-action-runner.test-helpers.js";

describe("runMessageAction poll handling", () => {
  beforeEach(() => {
    resetMessageActionPollMocks();
  });

  afterEach(() => {
    clearMessageActionPollMocks();
  });
  it("requires at least two poll options", async () => {
    await expect(
      runPollAction({
        cfg: pollerConfig,
        actionParams: {
          channel: "poller",
          target: "poller:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza"],
        },
      }),
    ).rejects.toThrow(/pollOption requires at least two values/i);
    expect(mocks.executePollAction).toHaveBeenCalledTimes(1);
  });
});
