// Tests normalized session queue cleanup through the canonical lane resolver.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSessionQueues } from "./cleanup.js";

const followupQueueMocks = vi.hoisted(() => ({
  clearFollowupDrainCallback: vi.fn(),
  clearFollowupQueue: vi.fn(() => 2),
}));

const commandQueueMocks = vi.hoisted(() => ({
  clearCommandLane: vi.fn(() => 3),
}));

vi.mock("./drain.js", () => ({
  clearFollowupDrainCallback: followupQueueMocks.clearFollowupDrainCallback,
}));

vi.mock("./state.js", () => ({
  clearFollowupQueue: followupQueueMocks.clearFollowupQueue,
}));

vi.mock("../../../process/command-queue.js", () => ({
  clearCommandLane: commandQueueMocks.clearCommandLane,
}));

describe("clearSessionQueues", () => {
  afterEach(() => {
    followupQueueMocks.clearFollowupDrainCallback.mockReset();
    followupQueueMocks.clearFollowupQueue.mockReset().mockReturnValue(2);
    commandQueueMocks.clearCommandLane.mockReset().mockReturnValue(3);
  });

  it("clears each normalized key once using canonical session lanes", () => {
    const result = clearSessionQueues([
      " alpha ",
      undefined,
      "",
      " \t ",
      "alpha",
      " session:beta ",
      "session:beta",
    ]);

    expect(result).toEqual({
      followupCleared: 4,
      laneCleared: 6,
      keys: ["alpha", "session:beta"],
    });
    expect(followupQueueMocks.clearFollowupQueue.mock.calls).toEqual([["alpha"], ["session:beta"]]);
    expect(followupQueueMocks.clearFollowupDrainCallback.mock.calls).toEqual([
      ["alpha"],
      ["session:beta"],
    ]);
    expect(commandQueueMocks.clearCommandLane.mock.calls).toEqual([
      ["session:alpha"],
      ["session:beta"],
    ]);
  });
});
