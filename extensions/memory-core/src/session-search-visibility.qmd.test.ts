// Memory Core tests cover QMD session search visibility behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import * as sessionTranscriptHit from "openclaw/plugin-sdk/session-transcript-hit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachQmdSessionArtifactHit,
  copyQmdSessionArtifactHit,
  replaceQmdSessionArtifactMappings,
  resolveQmdSessionArtifactIdentity,
} from "./qmd-session-artifacts.js";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

type TestSessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile: string;
  chatType?: "direct" | "group" | "channel";
  origin?: { chatType?: "direct" | "group" | "channel" };
};

const crossAgentStore: Record<string, TestSessionEntry> = {
  "agent:peer:only": {
    sessionId: "w1",
    updatedAt: 1,
    sessionFile: "/tmp/sessions/w1.jsonl",
  },
};
let combinedSessionStore: Record<string, TestSessionEntry> = crossAgentStore;
const tempRoots: string[] = [];

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

describe("filterMemorySearchHitsBySessionVisibility for QMD", () => {
  afterEach(async () => {
    vi.mocked(sessionTranscriptHit.loadCombinedSessionStoreForGateway).mockClear();
    combinedSessionStore = crossAgentStore;
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  async function createQmdArtifactIndex(params: {
    agentId: string;
    archived?: boolean;
    artifactPath: string;
    collection: string;
    searchPath: string;
    sessionId: string;
  }): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-session-artifact-"));
    tempRoots.push(root);
    const indexPath = path.join(root, "index.sqlite");
    replaceQmdSessionArtifactMappings({
      collection: params.collection,
      indexPath,
      mappings: [
        {
          agentId: params.agentId,
          archived: params.archived === true,
          artifactPath: params.artifactPath,
          collection: params.collection,
          memoryKey: sessionTranscriptHit.formatSessionTranscriptMemoryHitKey({
            agentId: params.agentId,
            sessionId: params.sessionId,
          }),
          searchPath: params.searchPath,
          sessionId: params.sessionId,
        },
      ],
    });
    return indexPath;
  }

  function attachMappedQmdHit(
    hit: MemorySearchResult,
    lookup: Parameters<typeof resolveQmdSessionArtifactIdentity>[0],
  ): MemorySearchResult {
    const identity = resolveQmdSessionArtifactIdentity(lookup);
    if (!identity) {
      throw new Error("expected QMD session artifact identity mapping");
    }
    return attachQmdSessionArtifactHit(hit, identity);
  }

  it("keeps same-agent QMD-normalized archived reset .md hits when the store has a matching entry", async () => {
    combinedSessionStore = {
      "agent:main:abc-uuid": {
        sessionId: "abc-uuid",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/abc-uuid.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "qmd/sessions-main/abc-uuid-jsonl-reset-2026-02-16t22-26-33-000z.md",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "agent" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("keeps QMD .md hits whose live session id looks like an archive name", async () => {
    const sessionId = "foo.jsonl.deleted.2026-02-16T22-27-33.000Z";
    combinedSessionStore = {
      "agent:main:archive-looking": {
        sessionId,
        updatedAt: 1,
        sessionFile: `/tmp/sessions/${sessionId}.jsonl`,
      },
    };
    const hit: MemorySearchResult = {
      path: `qmd/sessions-main/${sessionId}.md`,
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "self" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:archive-looking",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("does not authorize QMD archived .md hits through lossy slug fallback", async () => {
    combinedSessionStore = {
      "agent:main:foo_bar": {
        sessionId: "foo_bar",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/foo_bar.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "qmd/sessions-main/foo-bar-jsonl-deleted-2026-02-16t22-26-33-000z.md",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "self" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:foo_bar",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });

  it("keeps mapped QMD session hits when the artifact filename no longer matches the session id", async () => {
    combinedSessionStore = {
      "agent:main:actual-key": {
        sessionId: "actual-session-id",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/actual-session-id.jsonl",
      },
    };
    const searchPath = "qmd/sessions-main/lossy-export-name.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "main",
      artifactPath: "lossy-export-name.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "actual-session-id",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "lossy-export-name.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
    );
    const copiedHit = copyQmdSessionArtifactHit(hit, { ...hit, snippet: "trimmed" });
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "self" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:actual-key",
      sandboxed: false,
      hits: [copiedHit],
    });

    expect(filtered).toEqual([copiedHit]);
  });

  it("denies mapped QMD hits whose transcript file also has a shared group alias", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:explicit:laptop": {
        sessionId: "actual-session-id",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/shared-transcript.jsonl",
        chatType: "direct",
      },
      // Same transcript file exposed under a group alias with a different
      // sessionId: session-id alias resolution alone would miss this.
      "agent:main:telegram:group:team": {
        sessionId: "group-alias-id",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/shared-transcript.jsonl",
        chatType: "group",
      },
    };
    const searchPath = "qmd/sessions-main/shared-transcript-export.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "main",
      artifactPath: "shared-transcript-export.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "actual-session-id",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "private context",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "shared-transcript-export.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
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

  it("allows mapped QMD hits for another same-agent private conversation", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:explicit:laptop": {
        sessionId: "actual-session-id",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/actual-session-id.jsonl",
        chatType: "direct",
      },
    };
    const searchPath = "qmd/sessions-main/lossy-export-name.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "main",
      artifactPath: "lossy-export-name.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "actual-session-id",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "private context",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "lossy-export-name.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
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

    expect(filtered).toEqual([hit]);
  });

  it("denies mapped live QMD session hits when no session-store key remains", async () => {
    combinedSessionStore = {};
    const searchPath = "qmd/sessions-main/orphan-live.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "main",
      artifactPath: "orphan-live.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "orphan-live",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "orphan-live.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
    );
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "agent" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies ownerless legacy QMD orphan hits when no session-store key remains", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "qmd/sessions-main/ownerless-orphan.md",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } }),
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });

  it("keeps mapped archived QMD session hits when no session-store key remains", async () => {
    combinedSessionStore = {};
    const searchPath = "qmd/sessions-main/archived-jsonl-deleted-2026-02-16t22-26-33-000z.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "main",
      archived: true,
      artifactPath: "archived-jsonl-deleted-2026-02-16t22-26-33-000z.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "archived",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "archived-jsonl-deleted-2026-02-16t22-26-33-000z.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
    );
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("denies mapped QMD session hits before deprecated filename fallback", async () => {
    combinedSessionStore = {
      "agent:main:visible": {
        sessionId: "visible",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/visible.jsonl",
      },
    };
    const searchPath = "qmd/sessions-main/visible.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "peer",
      artifactPath: "visible.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "peer-session",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "visible.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
    );
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:visible",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });

  it("keeps same-agent QMD archived deleted .md hits when no store entry remains", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "qmd/sessions-main/abc-uuid-jsonl-deleted-2026-02-16t22-26-33-000z.md",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });
});
