import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { chatHandlers } from "./chat.js";
import {
  mockDeletedAgentSession,
  resetDeletedAgentSessionMocks,
} from "./deleted-agent-guard.test-helpers.js";
import type { RespondFn } from "./types.js";

describe("chat.send deleted-agent guard", () => {
  beforeEach(() => {
    resetDeletedAgentSessionMocks();
  });

  it("rejects keys belonging to a deleted agent", async () => {
    const orphanKey = mockDeletedAgentSession();

    const respond = vi.fn() as unknown as RespondFn;

    await chatHandlers["chat.send"]({
      req: { id: "req-1" } as never,
      params: { sessionKey: orphanKey, message: "hi", idempotencyKey: "run-1" },
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Agent "deleted-agent" no longer exists in configuration',
    });
  });
});
