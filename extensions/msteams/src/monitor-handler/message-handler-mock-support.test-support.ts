// Msteams plugin module implements message handler mock support support behavior.
import { vi } from "vitest";
import { getMSTeamsTestRuntimeState } from "../monitor-handler.test-helpers.js";

export function getRuntimeApiMockState() {
  return getMSTeamsTestRuntimeState();
}

vi.mock("../reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    replyOptions: {},
  }),
}));
