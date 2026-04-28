import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";

const {
  loadConfigMock,
  loadCombinedSessionStoreForGatewayMock,
  resolveGatewaySessionStoreTargetMock,
  resolveSessionTranscriptCandidatesMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({ session: {} })),
  loadCombinedSessionStoreForGatewayMock: vi.fn(),
  resolveGatewaySessionStoreTargetMock: vi.fn(),
  resolveSessionTranscriptCandidatesMock: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));

vi.mock("./session-utils.js", () => ({
  loadCombinedSessionStoreForGateway: loadCombinedSessionStoreForGatewayMock,
  resolveGatewaySessionStoreTarget: resolveGatewaySessionStoreTargetMock,
  resolveSessionTranscriptCandidates: resolveSessionTranscriptCandidatesMock,
}));

import {
  clearSessionTranscriptKeyCacheForTests,
  resolveSessionKeyForTranscriptFile,
} from "./session-transcript-key.js";

describe("resolveSessionKeyForTranscriptFile", () => {
  const now = 1_700_000_000_000;

  beforeEach(() => {
    clearSessionTranscriptKeyCacheForTests();
    loadConfigMock.mockClear();
    loadCombinedSessionStoreForGatewayMock.mockReset();
    resolveGatewaySessionStoreTargetMock.mockReset();
    resolveSessionTranscriptCandidatesMock.mockReset();
    resolveGatewaySessionStoreTargetMock.mockImplementation(({ key }: { key: string }) => ({
      agentId: "main",
      storePath: "/tmp/sessions.json",
      canonicalKey: key,
      storeKeys: [key],
    }));
  });

  it("reuses the cached session key for repeat transcript lookups", () => {
    const store = {
      "agent:main:one": { sessionId: "sess-1", updatedAt: now },
      "agent:main:two": { sessionId: "sess-2", updatedAt: now },
    } satisfies Record<string, SessionEntry>;
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store,
    });
    resolveSessionTranscriptCandidatesMock.mockImplementation((sessionId: string) => {
      if (sessionId === "sess-1") {
        return ["/tmp/one.jsonl"];
      }
      if (sessionId === "sess-2") {
        return ["/tmp/two.jsonl"];
      }
      return [];
    });

    expect(resolveSessionKeyForTranscriptFile("/tmp/two.jsonl")).toBe("agent:main:two");
    expect(resolveSessionTranscriptCandidatesMock).toHaveBeenCalledTimes(2);

    expect(resolveSessionKeyForTranscriptFile("/tmp/two.jsonl")).toBe("agent:main:two");
    expect(resolveSessionTranscriptCandidatesMock).toHaveBeenCalledTimes(3);
  });

  it("drops stale cached mappings and falls back to the current store contents", () => {
    let store: Record<string, SessionEntry> = {
      "agent:main:alpha": { sessionId: "sess-alpha", updatedAt: now },
      "agent:main:beta": { sessionId: "sess-beta", updatedAt: now },
    };
    loadCombinedSessionStoreForGatewayMock.mockImplementation(() => ({
      storePath: "(multiple)",
      store,
    }));
    resolveSessionTranscriptCandidatesMock.mockImplementation(
      (sessionId: string, _storePath?: string, sessionFile?: string) => {
        if (sessionId === "sess-alpha") {
          return ["/tmp/alpha.jsonl"];
        }
        if (sessionId === "sess-beta") {
          return sessionFile ? [sessionFile] : ["/tmp/shared.jsonl"];
        }
        if (sessionId === "sess-alpha-2") {
          return ["/tmp/shared.jsonl"];
        }
        return [];
      },
    );

    expect(resolveSessionKeyForTranscriptFile("/tmp/shared.jsonl")).toBe("agent:main:beta");

    store = {
      "agent:main:alpha": { sessionId: "sess-alpha-2", updatedAt: now + 1 },
      "agent:main:beta": {
        sessionId: "sess-beta",
        updatedAt: now + 1,
        sessionFile: "/tmp/beta.jsonl",
      },
    };

    expect(resolveSessionKeyForTranscriptFile("/tmp/shared.jsonl")).toBe("agent:main:alpha");
  });

  it("returns undefined for blank transcript paths", () => {
    expect(resolveSessionKeyForTranscriptFile("   ")).toBeUndefined();
    expect(loadCombinedSessionStoreForGatewayMock).not.toHaveBeenCalled();
  });

  it("prefers the deterministic session key when duplicate sessionIds share a transcript path", () => {
    const store = {
      "agent:other:main": { sessionId: "run-dup", updatedAt: now + 1 },
      "agent:main:acp:run-dup": { sessionId: "run-dup", updatedAt: now },
    } satisfies Record<string, SessionEntry>;
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store,
    });
    resolveSessionTranscriptCandidatesMock.mockReturnValue(["/tmp/shared.jsonl"]);

    expect(resolveSessionKeyForTranscriptFile("/tmp/shared.jsonl")).toBe("agent:main:acp:run-dup");
  });

  it("prefers the freshest matching session when different sessionIds share a transcript path", () => {
    const store = {
      "agent:main:older": { sessionId: "sess-old", updatedAt: now },
      "agent:main:newer": { sessionId: "sess-new", updatedAt: now + 10 },
    } satisfies Record<string, SessionEntry>;
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store,
    });
    resolveSessionTranscriptCandidatesMock.mockReturnValue(["/tmp/shared.jsonl"]);

    expect(resolveSessionKeyForTranscriptFile("/tmp/shared.jsonl")).toBe("agent:main:newer");
  });

  it("evicts oldest entry when cache exceeds 256 entries (#63643)", () => {
    // Fill cache with 256 unique transcript paths
    for (let i = 0; i < 256; i++) {
      const sessionKey = `agent:main:session-${i}`;
      const transcriptPath = `/tmp/session-${i}.jsonl`;
      const store = {
        [sessionKey]: { sessionId: `sid-${i}`, updatedAt: now + i },
      } satisfies Record<string, SessionEntry>;
      loadCombinedSessionStoreForGatewayMock.mockReturnValue({
        storePath: "(multiple)",
        store,
      });
      resolveSessionTranscriptCandidatesMock.mockReturnValue([transcriptPath]);
      resolveSessionKeyForTranscriptFile(transcriptPath);
    }

    // Now add the 257th — should evict session-0
    const overflowKey = "agent:main:session-overflow";
    const overflowPath = "/tmp/session-overflow.jsonl";
    const overflowStore = {
      [overflowKey]: { sessionId: "sid-overflow", updatedAt: now + 999 },
    } satisfies Record<string, SessionEntry>;
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: overflowStore,
    });
    resolveSessionTranscriptCandidatesMock.mockReturnValue([overflowPath]);
    expect(resolveSessionKeyForTranscriptFile(overflowPath)).toBe(overflowKey);

    // session-0 should have been evicted from cache — next lookup will
    // re-resolve from the store (returns undefined since store was mocked
    // with only the overflow entry).
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: overflowStore,
    });
    resolveSessionTranscriptCandidatesMock.mockReturnValue([]);
    expect(resolveSessionKeyForTranscriptFile("/tmp/session-0.jsonl")).toBeUndefined();
  });
});
