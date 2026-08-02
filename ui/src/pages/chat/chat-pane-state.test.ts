import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { reconcileSessionHistory } from "../../lib/sessions/reconcile.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import {
  applySelectedSessionProjection,
  resolveChatArtifactDownload,
  SessionParticipationTracker,
} from "./chat-pane-state.ts";

function projectionState(): Parameters<typeof applySelectedSessionProjection>[0] {
  return {
    chatEffectiveQueueMode: "interrupt",
    chatQueueModeOverride: "interrupt",
    selectedChatSessionArchived: true,
  };
}

describe("applySelectedSessionProjection", () => {
  it("retains pane-owned metadata when a scoped list omits the selected session", () => {
    const state = projectionState();

    expect(applySelectedSessionProjection(state, undefined)).toBe(false);
    expect(state).toEqual({
      chatEffectiveQueueMode: "interrupt",
      chatQueueModeOverride: "interrupt",
      selectedChatSessionArchived: true,
    });
  });

  it("adopts metadata from a matching session row", () => {
    const state = projectionState();

    expect(
      applySelectedSessionProjection(state, {
        archived: false,
        effectiveQueueMode: "followup",
        key: "agent:main:main",
        kind: "direct",
        queueMode: "followup",
        updatedAt: 1,
      }),
    ).toBe(true);
    expect(state).toEqual({
      chatEffectiveQueueMode: "followup",
      chatQueueModeOverride: "followup",
      selectedChatSessionArchived: false,
    });
  });

  it("adopts an archived routed row published after the active list omitted it", () => {
    const routedKey = "agent:main:dashboard:cold-archive";
    const activeResult: SessionsListResult = {
      count: 1,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      path: "",
      sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 2 }],
      ts: 2,
    };
    const published = reconcileSessionHistory(
      activeResult,
      {
        archived: true,
        key: routedKey,
        kind: "direct",
        label: "Archived planning",
        updatedAt: 1,
      },
      undefined,
      { archivedFilter: "all" },
    );
    const state = { ...projectionState(), selectedChatSessionArchived: false };
    const selected = published?.sessions.find((row) =>
      areUiSessionKeysEquivalent(row.key, routedKey),
    );

    expect(applySelectedSessionProjection(state, selected)).toBe(true);
    expect(state.selectedChatSessionArchived).toBe(true);

    const afterNavigation = reconcileSessionHistory(published, selected, undefined, {
      archivedFilter: "active",
    });
    expect(afterNavigation?.sessions.map((row) => row.key)).toEqual(["agent:main:main"]);
  });
});

describe("resolveChatArtifactDownload", () => {
  it("returns a trimmed ticket without exposing a gateway bearer credential", async () => {
    const requests: Array<{ method: string; params: unknown; options: unknown }> = [];
    const result = await resolveChatArtifactDownload(
      {
        connected: true,
        client: {
          request: async (method: string, params: unknown, options: unknown) => {
            requests.push({ method, params, options });
            return {
              artifact: {
                id: "artifact-1",
                type: "image",
                title: "image",
                download: { mode: "url" },
              },
              url: " /api/chat/media/outgoing/main/image/full?mediaTicket=ticket ",
              expiresAt: " 2026-07-28T00:00:00.000Z ",
            };
          },
        } as never,
      },
      { sessionKey: "agent:main:main", artifactId: "artifact-1" },
    );

    expect(requests).toEqual([
      {
        method: "artifacts.download",
        params: { sessionKey: "agent:main:main", artifactId: "artifact-1" },
        options: { timeoutMs: 30_000 },
      },
    ]);
    expect(result).toEqual({
      url: "/api/chat/media/outgoing/main/image/full?mediaTicket=ticket",
      expiresAt: "2026-07-28T00:00:00.000Z",
    });
  });
});

describe("SessionParticipationTracker", () => {
  const resolve = (
    tracker: SessionParticipationTracker,
    patch: Partial<Parameters<SessionParticipationTracker["resolve"]>[0]> = {},
  ) =>
    tracker.resolve({
      catalog: false,
      listLoading: false,
      sessionKey: "agent:main:tracked",
      session: undefined,
      ...patch,
    });

  it("does not block a brand-new key that never had a row", () => {
    expect(resolve(new SessionParticipationTracker())).toBe(false);
  });

  it("blocks only on a positively observed restricted state", () => {
    expect(
      resolve(new SessionParticipationTracker(), {
        session: { visibility: "draft", sharingRole: "member" },
      }),
    ).toBe(true);
    expect(
      resolve(new SessionParticipationTracker(), {
        session: { visibility: "read-only", sharingRole: "viewer" },
      }),
    ).toBe(true);
    expect(
      resolve(new SessionParticipationTracker(), {
        session: { visibility: "shared", sharingRole: "member" },
      }),
    ).toBe(false);
  });

  it("never blocks a session that is absent from a completed list (filter/pagination/deletion)", () => {
    const tracker = new SessionParticipationTracker();
    // Even a previously restricted session that drops out of a filtered or
    // paginated list must not stay blocked once the load completes.
    expect(resolve(tracker, { session: { visibility: "draft", sharingRole: "member" } })).toBe(
      true,
    );
    expect(resolve(tracker)).toBe(false);
  });

  it("holds the last known block across an in-flight refresh to avoid flicker", () => {
    const tracker = new SessionParticipationTracker();
    expect(resolve(tracker, { session: { visibility: "draft", sharingRole: "member" } })).toBe(
      true,
    );
    expect(resolve(tracker, { listLoading: true })).toBe(true);
    // A session last known unrestricted is not held blocked during a refresh.
    expect(resolve(tracker, { session: { visibility: "shared", sharingRole: "member" } })).toBe(
      false,
    );
    expect(resolve(tracker, { listLoading: true })).toBe(false);
  });

  it("forgets held state when the gateway connection changes", () => {
    const tracker = new SessionParticipationTracker();
    expect(resolve(tracker, { session: { visibility: "draft", sharingRole: "member" } })).toBe(
      true,
    );
    expect(resolve(tracker, { listLoading: true })).toBe(true);
    tracker.reset();
    expect(resolve(tracker, { listLoading: true })).toBe(false);
  });

  it("keeps agent-relative global session history separate", () => {
    const tracker = new SessionParticipationTracker();
    expect(
      resolve(tracker, {
        sessionKey: "main\0global",
        session: { visibility: "draft", sharingRole: "member" },
      }),
    ).toBe(true);
    expect(resolve(tracker, { sessionKey: "work\0global", listLoading: true })).toBe(false);
    expect(resolve(tracker, { sessionKey: "main\0global", listLoading: true })).toBe(true);
  });
});
