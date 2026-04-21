import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import {
  mockDeletedAgentSession,
  resetDeletedAgentSessionMocks,
} from "./deleted-agent-guard.test-helpers.js";
import { sessionsHandlers } from "./sessions.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

describe("sessions.send / sessions.steer deleted-agent guard", () => {
  beforeEach(() => {
    resetDeletedAgentSessionMocks();
  });

  for (const method of ["sessions.send", "sessions.steer"] as const) {
    it(`${method} rejects keys belonging to a deleted agent`, async () => {
      const orphanKey = mockDeletedAgentSession();

      const respond = vi.fn() as unknown as RespondFn;
      const context = {
        chatAbortControllers: new Map(),
        broadcastToConnIds: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;

      await sessionsHandlers[method]({
        req: { id: "req-1" } as never,
        params: { key: orphanKey, message: "hi" },
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
      });

      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      });
    });
  }
});
