// Memory Core tests cover session search visibility plugin behavior.
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { normalizeSessionDeliveryState } from "openclaw/plugin-sdk/session-store-runtime";
import * as sessionTranscriptHit from "openclaw/plugin-sdk/session-transcript-hit";
import * as sessionVisibility from "openclaw/plugin-sdk/session-visibility";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import {
  searchHit,
  sessionEntry,
  type TestSessionEntry,
} from "./session-search-visibility.test-support.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

const crossAgentStore: Record<string, TestSessionEntry> = {
  "agent:peer:only": sessionEntry("w1", 1, "/tmp/sessions/w1.jsonl"),
};
let combinedSessionStore: Record<string, TestSessionEntry> = crossAgentStore;

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({
      storePath: "(test)",
      store: combinedSessionStore,
    })),
  };
});

describe("filterMemorySearchHitsBySessionVisibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(sessionTranscriptHit.loadCombinedSessionStoreForGateway).mockClear();
    combinedSessionStore = crossAgentStore;
  });

  it("drops sessions-sourced hits when requester key is missing (fail closed)", async () => {
    const hits: MemorySearchResult[] = [searchHit("sessions/u1.jsonl", "sessions", "x")];
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "all" } } }),
      requesterSessionKey: undefined,
      sandboxed: false,
      hits,
    });
    expect(filtered).toStrictEqual([]);
  });

  it.each([undefined, "configured", "sessions"] as const)(
    "does not load session history for memory-only hits with recall corpus %s",
    async (corpus) => {
      const guard = vi.spyOn(sessionVisibility, "createSessionVisibilityGuard");
      const hits: MemorySearchResult[] = [searchHit("memory/foo.md", "memory", "x")];
      const filtered = await filterMemorySearchHitsBySessionVisibility({
        cfg: asOpenClawConfig({ tools: { sessions: { visibility: "all" } } }),
        requesterSessionKey: "agent:main:main",
        sandboxed: false,
        hits,
        conversationRecall: corpus
          ? {
              anchorSessionKey: "agent:main:main",
              scope: "same-agent-private",
              corpus,
            }
          : undefined,
      });
      expect(filtered).toEqual(corpus === "sessions" ? [] : hits);
      expect(sessionTranscriptHit.loadCombinedSessionStoreForGateway).not.toHaveBeenCalled();
      expect(guard).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "tree"] as const)(
    "applies %s visibility to unrelated same-agent recall from a voice requester",
    async (visibility) => {
      combinedSessionStore = {
        "agent:main:voice:15550001111": sessionEntry("voice", 2, "/tmp/sessions/voice.jsonl", {
          chatType: "direct",
        }),
        "agent:main:telegram:direct:owner": sessionEntry(
          "private",
          1,
          "/tmp/sessions/private.jsonl",
          { chatType: "direct" },
        ),
      };
      const memoryHit: MemorySearchResult = searchHit(
        "memory/allowed.md",
        "memory",
        "Visible memory",
      );
      const sessionHit: MemorySearchResult = searchHit(
        "sessions/private.jsonl",
        "sessions",
        "Private session secret",
      );

      const filtered = await filterMemorySearchHitsBySessionVisibility({
        cfg: asOpenClawConfig({ tools: { sessions: { visibility } } }),
        agentId: "main",
        requesterSessionKey: "agent:main:voice:15550001111",
        sandboxed: false,
        hits: [memoryHit, sessionHit],
      });

      expect(filtered).toEqual(visibility === "tree" ? [memoryHit] : [memoryHit, sessionHit]);
    },
  );

  it("allows another same-agent private transcript through trusted conversation recall", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": sessionEntry(
        "current",
        2,
        "/tmp/sessions/current.jsonl",
        { chatType: "direct" },
      ),
      "agent:main:webchat:direct:owner": sessionEntry("past", 1, "/tmp/sessions/past.jsonl", {
        chatType: "direct",
      }),
    };
    const hit: MemorySearchResult = searchHit("sessions/past.jsonl", "sessions", "private context");
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toEqual([hit]);
  });

  it("allows an agent-scoped builtin hit for an Active Memory private requester", async () => {
    const anchorSessionKey = "agent:qa:qa-channel:direct:dm:remember-target";
    combinedSessionStore = {
      [anchorSessionKey]: sessionEntry("target-id", 2, "/tmp/sessions/target-id.jsonl", {
        chatType: "direct",
      }),
      "agent:qa:qa-channel:direct:dm:remember-source": sessionEntry(
        "source-id",
        1,
        "/tmp/sessions/source-id.jsonl",
        { chatType: "direct" },
      ),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/qa/source-id.jsonl",
      "sessions",
      "private context",
    );

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
      agentId: "qa",
      requesterSessionKey: `${anchorSessionKey}:active-memory:7e1ee8190516`,
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey,
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toEqual([hit]);
  });

  it("allows recognized explicit private sessions with persisted direct metadata", async () => {
    const anchorSessionKey = "agent:main:explicit:laptop";
    combinedSessionStore = {
      [anchorSessionKey]: sessionEntry("current", 2, "/tmp/sessions/current.jsonl", {
        delivery: normalizeSessionDeliveryState({
          context: { channel: "discord", to: "user:current" },
          origin: { provider: "discord", chatType: "direct", to: "user:current" },
        }),
      }),
      "agent:main:explicit:phone:group:shadow": sessionEntry(
        "explicit-private",
        1,
        "/tmp/sessions/explicit-private.jsonl",
        {
          chatType: "direct",
          delivery: normalizeSessionDeliveryState({
            context: { channel: "discord", to: "user:explicit-private" },
            origin: {
              provider: "discord",
              chatType: "direct",
              to: "user:explicit-private",
            },
          }),
        },
      ),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/explicit-private.jsonl",
      "sessions",
      "private context",
    );
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
      requesterSessionKey: `${anchorSessionKey}:active-memory:123456abcdef`,
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey,
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toEqual([hit]);
  });

  it("denies recall when the anchor transcript also has a shared group alias", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": sessionEntry(
        "current",
        2,
        "/tmp/sessions/current.jsonl",
        { chatType: "direct" },
      ),
      "agent:main:telegram:group:team": sessionEntry("current", 2, "/tmp/sessions/current.jsonl", {
        chatType: "group",
      }),
      "agent:main:qa-channel:direct:dm:friend": sessionEntry(
        "other-private",
        1,
        "/tmp/sessions/other-private.jsonl",
        { chatType: "direct" },
      ),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/main/current.jsonl.reset.2026-08-11T08-00-00.000Z",
      "sessions",
      "prior private context",
    );
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies the shared global session as a recall source despite direct metadata", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": sessionEntry(
        "current",
        2,
        "/tmp/sessions/current.jsonl",
        { chatType: "direct" },
      ),
      global: sessionEntry("global-shared", 1, "/tmp/sessions/global-shared.jsonl", {
        chatType: "direct",
      }),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/global-shared.jsonl",
      "sessions",
      "shared global context",
    );
    const cfg = asOpenClawConfig({
      session: { scope: "global" },
      tools: { sessions: { visibility: "self" } },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies recall anchored in the shared global session despite direct metadata", async () => {
    combinedSessionStore = {
      "agent:main:global": sessionEntry("global-shared", 2, "/tmp/sessions/global-shared.jsonl", {
        chatType: "direct",
      }),
      "agent:main:qa-channel:direct:dm:friend": sessionEntry(
        "other-private",
        1,
        "/tmp/sessions/other-private.jsonl",
        { chatType: "direct" },
      ),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/other-private.jsonl",
      "sessions",
      "private context",
    );
    const cfg = asOpenClawConfig({
      session: { scope: "global" },
      tools: { sessions: { visibility: "self" } },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:global",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:global",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies a metadata-less generated explicit model-run transcript", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": sessionEntry(
        "current",
        2,
        "/tmp/sessions/current.jsonl",
        { chatType: "direct" },
      ),
      "agent:main:explicit:model-run-probe": sessionEntry(
        "model-run-probe",
        1,
        "/tmp/sessions/model-run-probe.jsonl",
      ),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/model-run-probe.jsonl",
      "sessions",
      "internal model probe",
    );
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "self" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it.each([
    { name: "live", path: "sessions/peer-private.jsonl" },
    {
      name: "archived",
      path: "sessions/peer/peer-private.jsonl.reset.2026-08-11T08-00-00.000Z",
    },
  ])(
    "denies another agent's $name private transcript during trusted conversation recall",
    async ({ path }) => {
      combinedSessionStore = {
        "agent:main:telegram:direct:owner": sessionEntry(
          "current",
          2,
          "/tmp/sessions/current.jsonl",
          { chatType: "direct" },
        ),
        "agent:peer:telegram:direct:owner": sessionEntry(
          "peer-private",
          1,
          "/tmp/sessions/peer-private.jsonl",
          { chatType: "direct" },
        ),
      };
      const hit: MemorySearchResult = searchHit(path, "sessions", "other agent context");
      const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });

      const filtered = await filterMemorySearchHitsBySessionVisibility({
        cfg,
        requesterSessionKey: "agent:main:telegram:direct:owner",
        sandboxed: false,
        hits: [hit],
        conversationRecall: {
          anchorSessionKey: "agent:main:telegram:direct:owner",
          scope: "same-agent-private",
          corpus: "sessions",
        },
      });

      expect(filtered).toStrictEqual([]);
    },
  );

  it("denies persisted Active Memory helper transcripts under explicit sessions", async () => {
    combinedSessionStore = {
      "agent:main:explicit:laptop": sessionEntry("current", 2, "/tmp/sessions/current.jsonl", {
        chatType: "direct",
      }),
      "agent:main:explicit:laptop:active-memory:abcdef123456": sessionEntry(
        "helper",
        1,
        "/tmp/sessions/helper.jsonl",
      ),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/helper.jsonl",
      "sessions",
      "internal helper transcript",
    );
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:explicit:laptop:active-memory:123456abcdef",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:explicit:laptop",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("excludes the anchor transcript from trusted conversation recall", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": sessionEntry(
        "current",
        2,
        "/tmp/sessions/current.jsonl",
        { chatType: "direct" },
      ),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/current.jsonl",
      "sessions",
      "already in context",
    );
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("excludes the anchor transcript when another private key aliases the same session", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": sessionEntry(
        "current",
        2,
        "/tmp/sessions/current.jsonl",
        { chatType: "direct" },
      ),
      "agent:main:explicit:legacy-owner-alias": sessionEntry(
        "current",
        1,
        "/tmp/sessions/current.jsonl",
        { chatType: "direct" },
      ),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/current.jsonl",
      "sessions",
      "already in context",
    );
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it.each([
    { name: "group", chatType: "group" as const },
    { name: "channel", chatType: "channel" as const },
    { name: "unknown", chatType: undefined },
  ])("denies $name transcript hits from trusted conversation recall", async ({ chatType }) => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": sessionEntry(
        "current",
        2,
        "/tmp/sessions/current.jsonl",
        { chatType: "direct" },
      ),
      [chatType ? "agent:main:telegram:group:family" : "agent:main:unknown-surface"]: sessionEntry(
        "candidate",
        1,
        "/tmp/sessions/candidate.jsonl",
        chatType ? { chatType } : {},
      ),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/candidate.jsonl",
      "sessions",
      "not private",
    );
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("rejects a transcript when one alias is private and another alias is shared", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": sessionEntry(
        "current",
        3,
        "/tmp/sessions/current.jsonl",
        { chatType: "direct" },
      ),
      "agent:main:telegram:direct:private-alias": sessionEntry(
        "candidate",
        2,
        "/tmp/sessions/candidate.jsonl",
        { chatType: "direct" },
      ),
      "agent:main:telegram:group:shared-alias": sessionEntry(
        "candidate",
        1,
        "/tmp/sessions/candidate.jsonl",
        { chatType: "group" },
      ),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/candidate.jsonl",
      "sessions",
      "shared transcript",
    );
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies a metadata-less main transcript during trusted conversation recall", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": sessionEntry(
        "current",
        2,
        "/tmp/sessions/current.jsonl",
        { chatType: "direct" },
      ),
      "agent:main:main": sessionEntry("ambiguous-main", 1, "/tmp/sessions/ambiguous-main.jsonl"),
    };
    const hit: MemorySearchResult = searchHit(
      "sessions/ambiguous-main.jsonl",
      "sessions",
      "unknown conversation kind",
    );
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("rejects a synthetic recall requester that does not start with the anchor key", async () => {
    combinedSessionStore = {
      "agent:main:main": sessionEntry("current", 2, "/tmp/sessions/current.jsonl", {
        chatType: "direct",
      }),
      "agent:main:webchat:direct:owner": sessionEntry("past", 1, "/tmp/sessions/past.jsonl", {
        chatType: "direct",
      }),
    };
    const hit: MemorySearchResult = searchHit("sessions/past.jsonl", "sessions", "private context");
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:xxxx:active-memory:abcdef123456",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:main",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies trusted conversation recall when the anchor is shared, mismatched, or sandboxed", async () => {
    combinedSessionStore = {
      "agent:main:telegram:group:family": sessionEntry(
        "current",
        2,
        "/tmp/sessions/current.jsonl",
        { chatType: "group" },
      ),
      "agent:main:webchat:direct:owner": sessionEntry("past", 1, "/tmp/sessions/past.jsonl", {
        chatType: "direct",
      }),
    };
    const hit: MemorySearchResult = searchHit("sessions/past.jsonl", "sessions", "private context");
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "self" } } });
    const conversationRecall = {
      anchorSessionKey: "agent:main:telegram:group:family",
      scope: "same-agent-private" as const,
      corpus: "sessions" as const,
    };

    const [sharedAnchor, mismatchedAnchor, sandboxed] = await Promise.all([
      filterMemorySearchHitsBySessionVisibility({
        cfg,
        requesterSessionKey: conversationRecall.anchorSessionKey,
        sandboxed: false,
        hits: [hit],
        conversationRecall,
      }),
      filterMemorySearchHitsBySessionVisibility({
        cfg,
        requesterSessionKey: "agent:main:webchat:direct:owner",
        sandboxed: false,
        hits: [hit],
        conversationRecall,
      }),
      filterMemorySearchHitsBySessionVisibility({
        cfg,
        requesterSessionKey: conversationRecall.anchorSessionKey,
        sandboxed: true,
        hits: [hit],
        conversationRecall,
      }),
    ]);

    expect(sharedAnchor).toStrictEqual([]);
    expect(mismatchedAnchor).toStrictEqual([]);
    expect(sandboxed).toStrictEqual([]);
  });

  it("preserves ordinary memory while denying unauthorized configured transcript recall", async () => {
    combinedSessionStore = {};
    const memoryHit: MemorySearchResult = searchHit(
      "MEMORY.md",
      "memory",
      "shared workspace memory",
    );
    const sessionHit: MemorySearchResult = searchHit(
      "sessions/private.jsonl",
      "sessions",
      "private transcript",
      { score: 0.9 },
    );
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main:active-memory:abcdef123456",
      sandboxed: false,
      hits: [memoryHit, sessionHit],
      conversationRecall: {
        anchorSessionKey: "agent:main:main",
        scope: "same-agent-private",
        corpus: "configured",
      },
    });

    expect(filtered).toEqual([memoryHit]);
  });

  it("restricts trusted sessions-only recall to transcript hits", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": sessionEntry(
        "current",
        2,
        "/tmp/sessions/current.jsonl",
        { chatType: "direct" },
      ),
    };
    const hit: MemorySearchResult = searchHit("memory/private.md", "memory", "workspace memory");
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("loads the combined session store once per filter pass", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      searchHit("sessions/w1.jsonl", "sessions", "a"),
      searchHit("sessions/w1.jsonl", "sessions", "b", { score: 0.9 }),
    ];
    await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits,
    });
    expect(sessionTranscriptHit.loadCombinedSessionStoreForGateway).toHaveBeenCalledTimes(1);
    expect(sessionTranscriptHit.loadCombinedSessionStoreForGateway).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it.each([
    { sandboxed: false, visible: true },
    { sandboxed: true, visible: false },
  ])(
    "applies canonical-main tree visibility with sandboxed=$sandboxed",
    async ({ sandboxed, visible }) => {
      combinedSessionStore = {
        "agent:main:slack:channel:team": sessionEntry("team", 1, "/tmp/sessions/team.jsonl", {
          chatType: "channel",
        }),
      };
      const hit: MemorySearchResult = searchHit("sessions/team.jsonl", "sessions", "team context");

      const filtered = await filterMemorySearchHitsBySessionVisibility({
        cfg: asOpenClawConfig({
          tools: { sessions: { visibility: "tree" } },
          agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
        }),
        requesterSessionKey: "agent:main:main",
        sandboxed,
        hits: [hit],
      });

      expect(filtered).toEqual(visible ? [hit] : []);
    },
  );

  it("applies canonical global-main tree visibility in an explicit fleet", async () => {
    combinedSessionStore = {
      "agent:main:slack:channel:team": sessionEntry("team", 1, "/tmp/sessions/team.jsonl", {
        chatType: "channel",
      }),
    };
    const hit: MemorySearchResult = searchHit("sessions/team.jsonl", "sessions", "team context");

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({
        session: { scope: "global" },
        tools: { sessions: { visibility: "tree" } },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {}, research: {} },
        },
      }),
      agentId: "main",
      requesterSessionKey: "global",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("keeps same-agent live orphan transcript hits", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = searchHit("sessions/main/live-orphan.jsonl", "sessions", "x");
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } }),
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toEqual([hit]);
  });

  it("drops cross-agent live orphan transcript hits", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = searchHit("sessions/peer/live-orphan.jsonl", "sessions", "x");
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({
        tools: {
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true, allow: ["*"] },
        },
      }),
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });

  it("does not treat a same-agent orphan filename as proven self-session lineage", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = searchHit("sessions/main/main.jsonl", "sessions", "x");
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });
});
