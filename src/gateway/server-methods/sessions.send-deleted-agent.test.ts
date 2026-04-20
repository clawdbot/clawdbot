import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const resolveDeletedAgentIdFromSessionKeyMock = vi.fn();

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
    resolveDeletedAgentIdFromSessionKey: (...args: unknown[]) =>
      resolveDeletedAgentIdFromSessionKeyMock(...args),
  };
});

import { sessionsHandlers } from "./sessions.js";

describe("sessions.send / sessions.steer deleted-agent guard", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    resolveDeletedAgentIdFromSessionKeyMock.mockReset();
  });

  for (const method of ["sessions.send", "sessions.steer"] as const) {
    it(`${method} rejects keys belonging to a deleted agent`, async () => {
      const orphanKey = "agent:deleted-agent:main";
      loadSessionEntryMock.mockReturnValue({
        cfg: {},
        canonicalKey: orphanKey,
        storePath: "/tmp/sessions.json",
        entry: { sessionId: "sess-orphan" },
      });
      resolveDeletedAgentIdFromSessionKeyMock.mockReturnValue("deleted-agent");

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
