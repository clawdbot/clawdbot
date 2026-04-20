import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import type { RespondFn } from "./types.js";

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

import { chatHandlers } from "./chat.js";

describe("chat.send deleted-agent guard", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    resolveDeletedAgentIdFromSessionKeyMock.mockReset();
  });

  it("rejects keys belonging to a deleted agent", async () => {
    const orphanKey = "agent:deleted-agent:main";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: orphanKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-orphan" },
    });
    resolveDeletedAgentIdFromSessionKeyMock.mockReturnValue("deleted-agent");

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
