// Session transcript hit tests cover builtin transcript paths and key resolution.
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  extractTranscriptIdentityFromSessionsMemoryHit,
  extractTranscriptStemFromSessionsMemoryHit,
  formatSessionTranscriptMemoryHitKey,
  loadCombinedSessionStoreForGateway,
  parseSessionTranscriptMemoryHitKey,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  resolveTranscriptStemToSessionKeys,
} from "./session-transcript-hit.js";

const loadGatewaySessionStore = vi.hoisted(() => vi.fn());
vi.mock("../config/sessions/combined-store-gateway.js", () => ({
  loadCombinedSessionStoreForGatewayCore: loadGatewaySessionStore,
}));

it("filters incognito rows from the plugin cross-session store view", () => {
  loadGatewaySessionStore.mockReturnValue({
    storePath: "(multiple)",
    store: {
      "agent:main:dashboard:visible": { sessionId: "visible", updatedAt: 1 },
      "agent:main:dashboard:incognito-private": {
        incognito: true,
        sessionId: "private",
        updatedAt: 2,
      },
    },
  });

  expect(loadCombinedSessionStoreForGateway({}).store).toEqual({
    "agent:main:dashboard:visible": { sessionId: "visible", updatedAt: 1 },
  });
});

describe("extractTranscriptIdentityFromSessionsMemoryHit", () => {
  it("extracts builtin live and archived transcript identities", () => {
    expect(extractTranscriptStemFromSessionsMemoryHit("sessions/abc-uuid.jsonl")).toBe("abc-uuid");
    expect(
      extractTranscriptIdentityFromSessionsMemoryHit(
        "sessions/main/deleted-uuid.jsonl.deleted.2026-02-16T22-27-33.000Z",
      ),
    ).toEqual({
      stem: "deleted-uuid",
      ownerAgentId: "main",
      archived: true,
    });
  });

  it("rejects paths outside the builtin transcript format", () => {
    expect(extractTranscriptStemFromSessionsMemoryHit("sessions/note.md")).toBeNull();
    expect(
      extractTranscriptStemFromSessionsMemoryHit("sessions/weird.jsonl.backup.2026-01-01.zst"),
    ).toBeNull();
  });
});

describe("resolveTranscriptStemToSessionKeys", () => {
  const baseEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
    sessionId: "stem-a",
    updatedAt: 1,
    ...overrides,
  });

  it("returns every non-incognito key with an exact session identity", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:s1": baseEntry(),
      "agent:peer:s2": baseEntry(),
      "agent:main:dashboard:incognito-private": baseEntry({ incognito: true }),
    };

    expect(resolveTranscriptStemToSessionKeys({ store, stem: "stem-a" }).toSorted()).toEqual([
      "agent:main:s1",
      "agent:peer:s2",
    ]);
  });

  it("falls back to archived owner metadata after the live row is removed", () => {
    expect(
      resolveTranscriptStemToSessionKeys({
        store: {},
        stem: "deleted-stem",
        archivedOwnerAgentId: "main",
      }),
    ).toEqual(["agent:main:deleted-stem"]);
  });
});

describe("session transcript memory hit key compatibility exports", () => {
  it("keeps hit-subpath memory helpers off the runtime writer import path", () => {
    const source = fs.readFileSync(new URL("./session-transcript-hit.ts", import.meta.url), "utf8");
    expect(source).not.toContain("session-transcript-runtime.js");
  });

  it("exports storage-neutral memory hit key helpers from the legacy hit subpath", () => {
    const key = formatSessionTranscriptMemoryHitKey({
      agentId: "main",
      sessionId: "session:legacy",
    });
    const store: Record<string, SessionEntry> = {
      "agent:main:discord:direct:42": {
        sessionFile: "/tmp/not-the-identity.jsonl",
        sessionId: "session:legacy",
        updatedAt: 10,
      },
    };

    expect(key).toBe("transcript:main:session%3Alegacy");
    expect(parseSessionTranscriptMemoryHitKey(key)).toMatchObject({
      agentId: "main",
      sessionId: "session:legacy",
    });
    expect(resolveSessionTranscriptMemoryHitKeyToSessionKeys({ key, store })).toEqual([
      "agent:main:discord:direct:42",
    ]);
  });
});
