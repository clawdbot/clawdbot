import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: vi.fn(),
  };
});

import { loadSessionEntry } from "../session-utils.js";
import { prepareAgentRequestRouting } from "./agent-request-routing.js";

describe("prepareAgentRequestRouting", () => {
  beforeEach(() => {
    vi.mocked(loadSessionEntry)
      .mockReset()
      .mockReturnValue({
        cfg: { agents: { list: [{ id: "main" }] } },
        storePath: "/tmp/sessions.json",
        store: {},
        entry: {
          sessionId: "session-1",
          updatedAt: 1,
        },
        canonicalKey: "agent:main:main",
        storeKeys: ["agent:main:main"],
        legacyKey: undefined,
      });
  });

  it("reuses one session load and carries target discovery through the request", async () => {
    const respond = vi.fn();
    const result = await prepareAgentRequestRouting({
      request: {
        message: "hello",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
      cfg: { agents: { list: [{ id: "main" }] } },
      isRawModelRun: false,
      runId: "run-1",
      agentDedupeKeys: [],
      context: {
        dedupe: new Map(),
        logGateway: { info: vi.fn() },
      },
      respond,
      reserveDedupe: vi.fn(),
      clearDedupe: vi.fn(),
    } as never);

    expect(result?.preAttachmentSession).toEqual({
      canonicalKey: "agent:main:main",
      sessionId: "session-1",
    });
    expect(result?.sessionStoreDiscoveryCache).toBeInstanceOf(Map);
    expect(loadSessionEntry).toHaveBeenCalledTimes(1);
    expect(loadSessionEntry).toHaveBeenCalledWith("agent:main:main", {
      agentId: "main",
      clone: false,
      targetDiscoveryCache: result?.sessionStoreDiscoveryCache,
    });
    expect(respond).not.toHaveBeenCalled();
  });
});
