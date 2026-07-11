// Control UI tests cover dreaming behavior.
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfigCapability } from "../../../lib/config/index.ts";
import {
  backfillDreamDiary,
  copyDreamingArchivePath,
  createDreamingState,
  dedupeDreamDiary,
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiMemoryPalace,
  repairDreamingArtifacts,
  resetGroundedShortTerm,
  resetDreamDiary,
  resolveConfiguredDreaming,
  updateDreamingEnabled,
  type DreamingState,
} from "./dreaming.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;
type DreamingConfigCapability = Pick<
  RuntimeConfigCapability,
  "lookupSchemaPath" | "patch" | "state"
>;

function createState(): { state: DreamingState; request: ReturnType<typeof vi.fn<TestRequest>> } {
  const request = vi.fn<TestRequest>();
  const state: DreamingState = {
    ...createDreamingState(),
    client: {
      request,
    } as unknown as DreamingState["client"],
    connected: true,
    configSnapshot: { hash: "hash-1" },
  };
  return { state, request };
}

function createConfig(state: DreamingState): DreamingConfigCapability {
  const configState = {
    client: state.client,
    connected: state.connected,
    configSnapshot: state.configSnapshot,
  } as DreamingConfigCapability["state"];
  return {
    state: configState,
    lookupSchemaPath: vi.fn(async () => null),
    patch: vi.fn(async () => true),
  };
}

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred promise callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

function getConfigPatchRawPayload(config: DreamingConfigCapability): Record<string, unknown> {
  const patch = vi.mocked(config.patch).mock.calls[0]?.[0]?.raw;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Expected config patch object");
  }
  return patch;
}

describe("dreaming controller", () => {
  it("loads and normalizes dreaming status from doctor.memory.status", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      dreaming: {
        enabled: true,
        timezone: "America/Los_Angeles",
        verboseLogging: false,
        storageMode: "inline",
        separateReports: false,
        shortTermCount: 8,
        recallSignalCount: 14,
        dailySignalCount: 6,
        groundedSignalCount: 5,
        totalSignalCount: 20,
        phaseSignalCount: 11,
        lightPhaseHitCount: 7,
        remPhaseHitCount: 4,
        promotedTotal: 21,
        promotedToday: 2,
        shortTermEntries: [
          {
            key: "memory:memory/2026-04-05.md:1:2",
            path: "memory/2026-04-05.md",
            startLine: 1,
            endLine: 2,
            snippet: "Emma prefers shorter, lower-pressure check-ins.",
            recallCount: 2,
            dailyCount: 1,
            groundedCount: 1,
            totalSignalCount: 3,
            lightHits: 1,
            remHits: 2,
            phaseHitCount: 3,
            lastRecalledAt: "2026-04-05T01:02:03.000Z",
          },
        ],
        signalEntries: [
          {
            key: "memory:memory/2026-04-05.md:1:2",
            path: "memory/2026-04-05.md",
            startLine: 1,
            endLine: 2,
            snippet: "Emma prefers shorter, lower-pressure check-ins.",
            recallCount: 2,
            dailyCount: 1,
            groundedCount: 1,
            totalSignalCount: 3,
            lightHits: 1,
            remHits: 2,
            phaseHitCount: 3,
          },
        ],
        promotedEntries: [
          {
            key: "memory:memory/2026-04-04.md:4:5",
            path: "memory/2026-04-04.md",
            startLine: 4,
            endLine: 5,
            snippet: "Use the Happy Together calendar for flights.",
            recallCount: 3,
            dailyCount: 2,
            groundedCount: 0,
            totalSignalCount: 5,
            lightHits: 0,
            remHits: 0,
            phaseHitCount: 0,
            promotedAt: "2026-04-05T04:00:00.000Z",
          },
        ],
        phases: {
          light: {
            enabled: true,
            cron: "0 */6 * * *",
            lookbackDays: 2,
            limit: 100,
            managedCronPresent: true,
            nextRunAtMs: 12345,
          },
          deep: {
            enabled: true,
            cron: "0 3 * * *",
            limit: 10,
            minScore: 0.8,
            minRecallCount: 3,
            minUniqueQueries: 3,
            recencyHalfLifeDays: 14,
            maxAgeDays: 30,
            managedCronPresent: true,
            nextRunAtMs: 23456,
          },
          rem: {
            enabled: true,
            cron: "0 5 * * 0",
            lookbackDays: 7,
            limit: 10,
            minPatternStrength: 0.75,
            managedCronPresent: true,
            nextRunAtMs: 34567,
          },
        },
      },
    });

    await loadDreamingStatus(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.status", {});
    const status = state.dreamingStatus;
    expect(status?.enabled).toBe(true);
    expect(status?.shortTermCount).toBe(8);
    expect(status?.groundedSignalCount).toBe(5);
    expect(status?.totalSignalCount).toBe(20);
    expect(status?.phaseSignalCount).toBe(11);
    expect(status?.promotedToday).toBe(2);
    expect(status?.shortTermEntries).toHaveLength(1);
    expect(status?.shortTermEntries[0]?.snippet).toBe(
      "Emma prefers shorter, lower-pressure check-ins.",
    );
    expect(status?.shortTermEntries[0]?.totalSignalCount).toBe(3);
    expect(status?.shortTermEntries[0]?.groundedCount).toBe(1);
    expect(status?.shortTermEntries[0]?.phaseHitCount).toBe(3);
    expect(status?.promotedEntries).toHaveLength(1);
    expect(status?.promotedEntries[0]?.snippet).toBe(
      "Use the Happy Together calendar for flights.",
    );
    expect(status?.phases?.deep?.minScore).toBe(0.8);
    expect(status?.phases?.deep?.nextRunAtMs).toBe(23456);
    expect(state.dreamingStatusLoading).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it("loads dreaming status for the selected agent", async () => {
    const { state, request } = createState();
    state.selectedAgentId = "research-analyst";
    request.mockResolvedValue({
      dreaming: {
        enabled: true,
        shortTermCount: 1,
      },
    });

    await loadDreamingStatus(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.status", {
      agentId: "research-analyst",
    });
  });

  it("starts a new selected-agent status load and ignores stale completions", async () => {
    const { state, request } = createState();
    const agentA = createDeferred<unknown>();
    const agentB = createDeferred<unknown>();
    request.mockImplementation(async (_method: string, payload?: unknown) => {
      const agentId =
        typeof payload === "object" && payload !== null && "agentId" in payload
          ? payload.agentId
          : undefined;
      return agentId === "agent-b" ? agentB.promise : agentA.promise;
    });

    state.selectedAgentId = "agent-a";
    const firstLoad = loadDreamingStatus(state);
    state.selectedAgentId = "agent-b";
    const secondLoad = loadDreamingStatus(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "agent-a" });
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "agent-b" });

    agentB.resolve({ dreaming: { enabled: true, shortTermCount: 2 } });
    await secondLoad;

    expect(state.dreamingStatus?.shortTermCount).toBe(2);
    expect(state.dreamingStatusLoading).toBe(false);

    agentA.resolve({ dreaming: { enabled: true, shortTermCount: 1 } });
    await firstLoad;

    expect(state.dreamingStatus?.shortTermCount).toBe(2);
    expect(state.dreamingStatusLoading).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it("ignores older same-agent status completions after switching back", async () => {
    const { state, request } = createState();
    const firstAgentA = createDeferred<unknown>();
    const agentB = createDeferred<unknown>();
    const secondAgentA = createDeferred<unknown>();
    request
      .mockImplementationOnce(async () => firstAgentA.promise)
      .mockImplementationOnce(async () => agentB.promise)
      .mockImplementationOnce(async () => secondAgentA.promise);

    state.selectedAgentId = "agent-a";
    const firstLoad = loadDreamingStatus(state);
    state.selectedAgentId = "agent-b";
    const secondLoad = loadDreamingStatus(state);
    state.selectedAgentId = "agent-a";
    const thirdLoad = loadDreamingStatus(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "agent-a" });
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "agent-b" });
    expect(request).toHaveBeenCalledTimes(3);

    secondAgentA.resolve({ dreaming: { enabled: true, shortTermCount: 3 } });
    await thirdLoad;

    expect(state.dreamingStatus?.shortTermCount).toBe(3);
    expect(state.dreamingStatusLoading).toBe(false);

    firstAgentA.resolve({ dreaming: { enabled: true, shortTermCount: 1 } });
    agentB.resolve({ dreaming: { enabled: true, shortTermCount: 2 } });
    await firstLoad;
    await secondLoad;

    expect(state.dreamingStatus?.shortTermCount).toBe(3);
    expect(state.dreamingStatusLoading).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it("preserves unknown phase state when status omits phase metadata", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      dreaming: {
        enabled: true,
        shortTermCount: 1,
        recallSignalCount: 0,
        dailySignalCount: 0,
        groundedSignalCount: 0,
        totalSignalCount: 1,
        phaseSignalCount: 0,
        lightPhaseHitCount: 0,
        remPhaseHitCount: 0,
        promotedTotal: 0,
        promotedToday: 0,
        shortTermEntries: [],
        signalEntries: [],
        promotedEntries: [],
      },
    });

    await loadDreamingStatus(state);

    expect(state.dreamingStatus?.enabled).toBe(true);
    expect(state.dreamingStatus?.phases).toBeUndefined();
    expect(state.dreamingStatusError).toBeNull();
  });

  it("loads and normalizes wiki import insights", async () => {
    const { state, request } = createState();
    state.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["wiki.importInsights"] },
    };
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          entries: {
            "memory-wiki": {
              enabled: true,
            },
          },
        },
      },
    };
    request.mockResolvedValue({
      sourceType: "chatgpt",
      totalItems: 2,
      totalClusters: 1,
      clusters: [
        {
          key: "topic/travel",
          label: "Travel",
          itemCount: 2,
          highRiskCount: 1,
          withheldCount: 1,
          preferenceSignalCount: 1,
          items: [
            {
              pagePath: "sources/chatgpt-2026-04-10-alpha.md",
              title: "BA flight receipts process",
              riskLevel: "low",
              riskReasons: [],
              labels: ["topic/travel"],
              topicKey: "topic/travel",
              topicLabel: "Travel",
              digestStatus: "available",
              activeBranchMessages: 4,
              userMessageCount: 2,
              assistantMessageCount: 2,
              firstUserLine: "how do i get receipts?",
              lastUserLine: "that option does not exist",
              assistantOpener: "Use the BA request-a-receipt flow first.",
              summary: "Use the BA request-a-receipt flow first.",
              candidateSignals: ["prefers airline receipts"],
              correctionSignals: [],
              preferenceSignals: ["prefers airline receipts"],
            },
          ],
        },
      ],
    });

    await loadWikiImportInsights(state);

    expect(request).toHaveBeenCalledWith("wiki.importInsights", {});
    expect(state.wikiImportInsights?.totalItems).toBe(2);
    expect(state.wikiImportInsights?.totalClusters).toBe(1);
    expect(state.wikiImportInsights?.clusters).toHaveLength(1);
    expect(state.wikiImportInsights?.clusters[0]?.key).toBe("topic/travel");
    expect(state.wikiImportInsights?.clusters[0]?.itemCount).toBe(2);
    expect(state.wikiImportInsights?.clusters[0]?.withheldCount).toBe(1);
    expect(state.wikiImportInsightsError).toBeNull();
    expect(state.wikiImportInsightsLoading).toBe(false);
  });

  it("loads wiki import insights for the selected agent", async () => {
    const { state, request } = createState();
    state.selectedAgentId = "support";
    state.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["wiki.importInsights"] },
    };
    request.mockResolvedValue({ sourceType: "chatgpt", totalItems: 1, clusters: [] });

    await loadWikiImportInsights(state);

    expect(request).toHaveBeenCalledWith("wiki.importInsights", { agentId: "support" });
  });

  it("starts a new selected-agent import load and ignores stale completions", async () => {
    const { state, request } = createState();
    const agentA = createDeferred<unknown>();
    const agentB = createDeferred<unknown>();
    state.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["wiki.importInsights"] },
    };
    request.mockImplementation(async (_method: string, payload?: unknown) => {
      const agentId =
        typeof payload === "object" && payload !== null && "agentId" in payload
          ? payload.agentId
          : undefined;
      return agentId === "agent-b" ? agentB.promise : agentA.promise;
    });

    state.selectedAgentId = "agent-a";
    const firstLoad = loadWikiImportInsights(state);
    state.selectedAgentId = "agent-b";
    const secondLoad = loadWikiImportInsights(state);

    agentB.resolve({ sourceType: "chatgpt", totalItems: 2, clusters: [] });
    await secondLoad;
    agentA.resolve({ sourceType: "chatgpt", totalItems: 1, clusters: [] });
    await firstLoad;

    expect(request).toHaveBeenCalledWith("wiki.importInsights", { agentId: "agent-a" });
    expect(request).toHaveBeenCalledWith("wiki.importInsights", { agentId: "agent-b" });
    expect(state.wikiImportInsights?.totalItems).toBe(2);
    expect(state.wikiImportInsightsLoading).toBe(false);
    expect(state.wikiImportInsightsError).toBeNull();
  });

  it("falls back to config gating for wiki import insights when methods are not advertised", async () => {
    const { state, request } = createState();
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          entries: {
            "memory-wiki": {
              enabled: true,
            },
          },
        },
      },
    };
    request.mockResolvedValue({
      sourceType: "chatgpt",
      totalItems: 1,
      totalClusters: 1,
      clusters: [],
    });

    await loadWikiImportInsights(state);

    expect(request).toHaveBeenCalledWith("wiki.importInsights", {});
    expect(state.wikiImportInsights?.totalItems).toBe(1);
    expect(state.wikiImportInsights?.totalClusters).toBe(1);
    expect(state.wikiImportInsightsError).toBeNull();
    expect(state.wikiImportInsightsLoading).toBe(false);
  });

  it("skips wiki import insights when memory-wiki is not enabled", async () => {
    const { state, request } = createState();
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {},
      },
    };
    state.wikiImportInsights = {
      sourceType: "chatgpt",
      totalItems: 1,
      totalClusters: 1,
      clusters: [],
    };
    state.wikiImportInsightsError = "unknown method: wiki.importInsights";

    await loadWikiImportInsights(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.wikiImportInsights).toBeNull();
    expect(state.wikiImportInsightsError).toBeNull();
    expect(state.wikiImportInsightsLoading).toBe(false);
  });

  it("skips wiki import insights when the gateway does not advertise the method", async () => {
    const { state, request } = createState();
    state.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["doctor.memory.status"] },
    };
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          entries: {
            "memory-wiki": {
              enabled: true,
            },
          },
        },
      },
    };
    state.wikiImportInsights = {
      sourceType: "chatgpt",
      totalItems: 1,
      totalClusters: 1,
      clusters: [],
    };
    state.wikiImportInsightsError = "unknown method: wiki.importInsights";

    await loadWikiImportInsights(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.wikiImportInsights).toBeNull();
    expect(state.wikiImportInsightsError).toBeNull();
    expect(state.wikiImportInsightsLoading).toBe(false);
  });

  it("loads and normalizes the wiki memory palace", async () => {
    const { state, request } = createState();
    state.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["wiki.palace"] },
    };
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          entries: {
            "memory-wiki": {
              enabled: true,
            },
          },
        },
      },
    };
    request.mockResolvedValue({
      totalItems: 1,
      totalPages: 2,
      pageCounts: {
        synthesis: 1,
        entity: 0,
        concept: 0,
        source: 1,
        report: 0,
      },
      totalClaims: 2,
      totalQuestions: 1,
      totalContradictions: 1,
      clusters: [
        {
          key: "synthesis",
          label: "Syntheses",
          itemCount: 1,
          claimCount: 2,
          questionCount: 1,
          contradictionCount: 0,
          items: [
            {
              pagePath: "syntheses/travel-system.md",
              title: "Travel system",
              kind: "synthesis",
              claimCount: 2,
              questionCount: 1,
              contradictionCount: 0,
              claims: ["prefers direct receipts"],
              questions: ["should this become a playbook?"],
              contradictions: [],
              snippet: "Recurring travel admin friction.",
            },
          ],
        },
      ],
    });

    await loadWikiMemoryPalace(state);

    expect(request).toHaveBeenCalledWith("wiki.palace", {});
    expect(state.wikiMemoryPalace?.totalItems).toBe(1);
    expect(state.wikiMemoryPalace?.totalPages).toBe(2);
    expect(state.wikiMemoryPalace?.pageCounts.source).toBe(1);
    expect(state.wikiMemoryPalace?.pageCounts.synthesis).toBe(1);
    expect(state.wikiMemoryPalace?.totalClaims).toBe(2);
    expect(state.wikiMemoryPalace?.clusters).toHaveLength(1);
    expect(state.wikiMemoryPalace?.clusters[0]?.key).toBe("synthesis");
    expect(state.wikiMemoryPalace?.clusters[0]?.label).toBe("Syntheses");
    expect(state.wikiMemoryPalace?.clusters[0]?.items).toHaveLength(1);
    expect(state.wikiMemoryPalace?.clusters[0]?.items[0]?.title).toBe("Travel system");
    expect(state.wikiMemoryPalace?.clusters[0]?.items[0]?.claims).toEqual([
      "prefers direct receipts",
    ]);
    expect(state.wikiMemoryPalaceError).toBeNull();
    expect(state.wikiMemoryPalaceLoading).toBe(false);
  });

  it("loads the wiki memory palace for the selected agent", async () => {
    const { state, request } = createState();
    state.selectedAgentId = "marketing";
    state.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["wiki.palace"] },
    };
    request.mockResolvedValue({ totalItems: 1, clusters: [] });

    await loadWikiMemoryPalace(state);

    expect(request).toHaveBeenCalledWith("wiki.palace", { agentId: "marketing" });
  });

  it("starts a new selected-agent palace load and ignores stale completions", async () => {
    const { state, request } = createState();
    const agentA = createDeferred<unknown>();
    const agentB = createDeferred<unknown>();
    state.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["wiki.palace"] },
    };
    request.mockImplementation(async (_method: string, payload?: unknown) => {
      const agentId =
        typeof payload === "object" && payload !== null && "agentId" in payload
          ? payload.agentId
          : undefined;
      return agentId === "agent-b" ? agentB.promise : agentA.promise;
    });

    state.selectedAgentId = "agent-a";
    const firstLoad = loadWikiMemoryPalace(state);
    state.selectedAgentId = "agent-b";
    const secondLoad = loadWikiMemoryPalace(state);

    agentB.resolve({ totalItems: 2, clusters: [] });
    await secondLoad;
    agentA.resolve({ totalItems: 1, clusters: [] });
    await firstLoad;

    expect(request).toHaveBeenCalledWith("wiki.palace", { agentId: "agent-a" });
    expect(request).toHaveBeenCalledWith("wiki.palace", { agentId: "agent-b" });
    expect(state.wikiMemoryPalace?.totalItems).toBe(2);
    expect(state.wikiMemoryPalaceLoading).toBe(false);
    expect(state.wikiMemoryPalaceError).toBeNull();
  });

  it("derives legacy wiki memory palace page counts from clusters", async () => {
    const { state, request } = createState();
    state.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["wiki.palace"] },
    };
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          entries: {
            "memory-wiki": {
              enabled: true,
            },
          },
        },
      },
    };
    request.mockResolvedValue({
      totalItems: 1,
      totalClaims: 2,
      totalQuestions: 1,
      totalContradictions: 0,
      clusters: [
        {
          key: "synthesis",
          label: "Syntheses",
          itemCount: 1,
          claimCount: 2,
          questionCount: 1,
          contradictionCount: 0,
          items: [],
        },
      ],
    });

    await loadWikiMemoryPalace(state);

    expect(state.wikiMemoryPalace?.totalPages).toBe(1);
    expect(state.wikiMemoryPalace?.pageCounts).toEqual({
      synthesis: 1,
      entity: 0,
      concept: 0,
      source: 0,
      report: 0,
    });
  });

  it("falls back to config gating for wiki memory palace when methods are not advertised", async () => {
    const { state, request } = createState();
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          entries: {
            "memory-wiki": {
              enabled: true,
            },
          },
        },
      },
    };
    request.mockResolvedValue({
      totalItems: 1,
      totalClaims: 2,
      totalQuestions: 0,
      totalContradictions: 0,
      clusters: [],
    });

    await loadWikiMemoryPalace(state);

    expect(request).toHaveBeenCalledWith("wiki.palace", {});
    expect(state.wikiMemoryPalace?.totalItems).toBe(1);
    expect(state.wikiMemoryPalace?.totalPages).toBe(1);
    expect(state.wikiMemoryPalace?.pageCounts).toEqual({
      synthesis: 0,
      entity: 0,
      concept: 0,
      source: 0,
      report: 0,
    });
    expect(state.wikiMemoryPalace?.totalClaims).toBe(2);
    expect(state.wikiMemoryPalaceError).toBeNull();
    expect(state.wikiMemoryPalaceLoading).toBe(false);
  });

  it("skips wiki memory palace when memory-wiki is not enabled", async () => {
    const { state, request } = createState();
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {},
      },
    };
    state.wikiMemoryPalace = {
      totalItems: 1,
      totalPages: 1,
      pageCounts: {
        synthesis: 1,
        entity: 0,
        concept: 0,
        source: 0,
        report: 0,
      },
      totalClaims: 1,
      totalQuestions: 0,
      totalContradictions: 0,
      clusters: [],
    };
    state.wikiMemoryPalaceError = "unknown method: wiki.palace";

    await loadWikiMemoryPalace(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.wikiMemoryPalace).toBeNull();
    expect(state.wikiMemoryPalaceError).toBeNull();
    expect(state.wikiMemoryPalaceLoading).toBe(false);
  });

  it("skips wiki memory palace when the gateway does not advertise the method", async () => {
    const { state, request } = createState();
    state.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["doctor.memory.status"] },
    };
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          entries: {
            "memory-wiki": {
              enabled: true,
            },
          },
        },
      },
    };
    state.wikiMemoryPalace = {
      totalItems: 1,
      totalPages: 1,
      pageCounts: {
        synthesis: 1,
        entity: 0,
        concept: 0,
        source: 0,
        report: 0,
      },
      totalClaims: 1,
      totalQuestions: 0,
      totalContradictions: 0,
      clusters: [],
    };
    state.wikiMemoryPalaceError = "unknown method: wiki.palace";

    await loadWikiMemoryPalace(state);

    expect(request).not.toHaveBeenCalled();
    expect(state.wikiMemoryPalace).toBeNull();
    expect(state.wikiMemoryPalaceError).toBeNull();
    expect(state.wikiMemoryPalaceLoading).toBe(false);
  });

  it("patches config to update global dreaming enablement", async () => {
    const { state, request } = createState();
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          slots: {
            memory: "memos-local-openclaw-plugin",
          },
          entries: {
            "memos-local-openclaw-plugin": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    };
    request.mockResolvedValue({ ok: true });
    const config = createConfig(state);

    const ok = await updateDreamingEnabled(state, config, false);

    expect(ok).toBe(true);
    expect(config.patch).toHaveBeenCalledWith({
      note: "Dreaming settings updated from the Dreaming tab.",
      raw: expect.any(Object),
    });
    expect(getConfigPatchRawPayload(config)).toEqual({
      plugins: {
        entries: {
          "memos-local-openclaw-plugin": {
            config: {
              dreaming: {
                enabled: false,
              },
            },
          },
        },
      },
    });
    expect(state.dreamingModeSaving).toBe(false);
    expect(state.dreamingStatusError).toBeNull();
  });

  it("falls back to memory-core when selected memory slot is blank", async () => {
    const { state, request } = createState();
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          slots: {
            memory: "   ",
          },
        },
      },
    };
    request.mockResolvedValue({ ok: true });
    const config = createConfig(state);

    const ok = await updateDreamingEnabled(state, config, true);

    expect(ok).toBe(true);
    expect(getConfigPatchRawPayload(config)).toEqual({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
              },
            },
          },
        },
      },
    });
  });

  it("blocks dreaming patch when selected plugin config rejects unknown keys", async () => {
    const { state } = createState();
    state.configSnapshot = {
      hash: "hash-1",
      config: {
        plugins: {
          slots: {
            memory: "memory-lancedb",
          },
        },
      },
    };
    const config = createConfig(state);
    vi.mocked(config.lookupSchemaPath).mockResolvedValue({
      path: "plugins.entries.memory-lancedb.config",
      schema: {
        type: "object",
        additionalProperties: false,
      },
      children: [
        { key: "retentionDays", path: "plugins.entries.memory-lancedb.config.retentionDays" },
      ],
    });

    const ok = await updateDreamingEnabled(state, config, true);

    expect(ok).toBe(false);
    expect(config.lookupSchemaPath).toHaveBeenCalledWith("plugins.entries.memory-lancedb.config");
    expect(config.patch).not.toHaveBeenCalled();
    expect(state.dreamingStatusError).toBe(
      'Selected memory plugin "memory-lancedb" does not support dreaming settings.',
    );
  });

  it("reads dreaming enabled state from the selected memory slot plugin", () => {
    expect(
      resolveConfiguredDreaming({
        plugins: {
          slots: {
            memory: "memos-local-openclaw-plugin",
          },
          entries: {
            "memos-local-openclaw-plugin": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
            "memory-core": {
              config: {
                dreaming: {
                  enabled: false,
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      pluginId: "memos-local-openclaw-plugin",
      enabled: true,
    });
  });

  it('falls back to memory-core when selected memory slot is "none"', () => {
    expect(
      resolveConfiguredDreaming({
        plugins: {
          slots: {
            memory: "none",
          },
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      pluginId: "memory-core",
      enabled: true,
    });
  });

  it("fails gracefully when config hash is missing", async () => {
    const { state } = createState();
    state.configSnapshot = {};
    const config = createConfig(state);

    const ok = await updateDreamingEnabled(state, config, true);

    expect(ok).toBe(false);
    expect(config.patch).not.toHaveBeenCalled();
    expect(config.lookupSchemaPath).not.toHaveBeenCalled();
    expect(state.dreamingStatusError).toBe("Config hash missing; refresh and retry.");
  });

  it("loads dream diary content", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      found: true,
      path: "DREAMS.md",
      content: "## Dream Diary\n- recurring glacier thoughts",
    });

    await loadDreamDiary(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", {});
    expect(state.dreamDiaryPath).toBe("DREAMS.md");
    expect(state.dreamDiaryContent).toBe("## Dream Diary\n- recurring glacier thoughts");
    expect(state.dreamDiaryError).toBeNull();
  });

  it("loads dream diary content for the selected agent", async () => {
    const { state, request } = createState();
    state.selectedAgentId = "infra-sre";
    request.mockResolvedValue({
      found: true,
      path: "DREAMS.md",
      content: "infra dreams",
    });

    await loadDreamDiary(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", {
      agentId: "infra-sre",
    });
  });

  it("starts a new selected-agent diary load and ignores stale completions", async () => {
    const { state, request } = createState();
    const agentA = createDeferred<unknown>();
    const agentB = createDeferred<unknown>();
    request.mockImplementation(async (_method: string, payload?: unknown) => {
      const agentId =
        typeof payload === "object" && payload !== null && "agentId" in payload
          ? payload.agentId
          : undefined;
      return agentId === "agent-b" ? agentB.promise : agentA.promise;
    });

    state.selectedAgentId = "agent-a";
    const firstLoad = loadDreamDiary(state);
    state.selectedAgentId = "agent-b";
    const secondLoad = loadDreamDiary(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "agent-a" });
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "agent-b" });

    agentB.resolve({ found: true, path: "DREAMS.md", content: "agent-b diary" });
    await secondLoad;

    expect(state.dreamDiaryContent).toBe("agent-b diary");
    expect(state.dreamDiaryLoading).toBe(false);

    agentA.resolve({ found: true, path: "DREAMS.md", content: "agent-a diary" });
    await firstLoad;

    expect(state.dreamDiaryContent).toBe("agent-b diary");
    expect(state.dreamDiaryLoading).toBe(false);
    expect(state.dreamDiaryError).toBeNull();
  });

  it("ignores older same-agent diary completions after switching back", async () => {
    const { state, request } = createState();
    const firstAgentA = createDeferred<unknown>();
    const agentB = createDeferred<unknown>();
    const secondAgentA = createDeferred<unknown>();
    request
      .mockImplementationOnce(async () => firstAgentA.promise)
      .mockImplementationOnce(async () => agentB.promise)
      .mockImplementationOnce(async () => secondAgentA.promise);

    state.selectedAgentId = "agent-a";
    const firstLoad = loadDreamDiary(state);
    state.selectedAgentId = "agent-b";
    const secondLoad = loadDreamDiary(state);
    state.selectedAgentId = "agent-a";
    const thirdLoad = loadDreamDiary(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "agent-a" });
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", { agentId: "agent-b" });
    expect(request).toHaveBeenCalledTimes(3);

    secondAgentA.resolve({ found: true, path: "DREAMS.md", content: "new agent-a diary" });
    await thirdLoad;

    expect(state.dreamDiaryContent).toBe("new agent-a diary");
    expect(state.dreamDiaryLoading).toBe(false);

    firstAgentA.resolve({ found: true, path: "DREAMS.md", content: "old agent-a diary" });
    agentB.resolve({ found: true, path: "DREAMS.md", content: "agent-b diary" });
    await firstLoad;
    await secondLoad;

    expect(state.dreamDiaryContent).toBe("new agent-a diary");
    expect(state.dreamDiaryLoading).toBe(false);
    expect(state.dreamDiaryError).toBeNull();
  });

  it("handles missing dream diary without error", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      found: false,
      path: "DREAMS.md",
    });

    await loadDreamDiary(state);

    expect(state.dreamDiaryPath).toBe("DREAMS.md");
    expect(state.dreamDiaryContent).toBeNull();
    expect(state.dreamDiaryError).toBeNull();
  });

  it("records dream diary request errors", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("dream diary read failed"));

    await loadDreamDiary(state);

    expect(state.dreamDiaryError).toBe("Error: dream diary read failed");
    expect(state.dreamDiaryLoading).toBe(false);
  });

  it("backfills and reloads dream diary state", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.backfillDreamDiary") {
        return { action: "backfill", written: 79, replaced: 79 };
      }
      if (method === "doctor.memory.dreamDiary") {
        return { found: true, path: "DREAMS.md", content: "backfilled diary" };
      }
      if (method === "doctor.memory.status") {
        return {
          dreaming: {
            enabled: true,
            shortTermCount: 1,
            recallSignalCount: 0,
            dailySignalCount: 0,
            totalSignalCount: 1,
            phaseSignalCount: 0,
            lightPhaseHitCount: 0,
            remPhaseHitCount: 0,
            promotedTotal: 0,
            promotedToday: 0,
            shortTermEntries: [],
            signalEntries: [],
            promotedEntries: [],
            phases: {
              light: {
                enabled: false,
                cron: "",
                managedCronPresent: false,
                lookbackDays: 0,
                limit: 0,
              },
              deep: {
                enabled: false,
                cron: "",
                managedCronPresent: false,
                limit: 0,
                minScore: 0,
                minRecallCount: 0,
                minUniqueQueries: 0,
                recencyHalfLifeDays: 0,
              },
              rem: {
                enabled: false,
                cron: "",
                managedCronPresent: false,
                lookbackDays: 0,
                limit: 0,
                minPatternStrength: 0,
              },
            },
          },
        };
      }
      return {};
    });

    const ok = await backfillDreamDiary(state);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("doctor.memory.backfillDreamDiary", {});
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", {});
    expect(request).toHaveBeenCalledWith("doctor.memory.status", {});
    expect(state.dreamDiaryContent).toBe("backfilled diary");
    expect(state.dreamDiaryActionLoading).toBe(false);
  });

  it("runs dream diary actions and reloads state for the selected agent", async () => {
    const { state, request } = createState();
    state.selectedAgentId = "fishing-bot";
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.backfillDreamDiary") {
        return { action: "backfill", written: 1 };
      }
      if (method === "doctor.memory.dreamDiary") {
        return { found: true, path: "DREAMS.md", content: "fish dreams" };
      }
      if (method === "doctor.memory.status") {
        return { dreaming: null };
      }
      return {};
    });

    const ok = await backfillDreamDiary(state);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("doctor.memory.backfillDreamDiary", {
      agentId: "fishing-bot",
    });
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", {
      agentId: "fishing-bot",
    });
    expect(request).toHaveBeenCalledWith("doctor.memory.status", {
      agentId: "fishing-bot",
    });
  });

  it("resets and reloads dream diary state", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.resetDreamDiary") {
        return { action: "reset", removedEntries: 79 };
      }
      if (method === "doctor.memory.dreamDiary") {
        return { found: false, path: "DREAMS.md" };
      }
      if (method === "doctor.memory.status") {
        return { dreaming: null };
      }
      return {};
    });

    const ok = await resetDreamDiary(state);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("doctor.memory.resetDreamDiary", {});
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", {});
    expect(request).toHaveBeenCalledWith("doctor.memory.status", {});
    expect(state.dreamDiaryContent).toBeNull();
    expect(state.dreamDiaryActionLoading).toBe(false);
  });

  it("clears grounded staged entries and reloads only dreaming status", async () => {
    const { state, request } = createState();
    state.dreamDiaryContent = "keep existing diary";
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.resetGroundedShortTerm") {
        return { action: "resetGroundedShortTerm", removedShortTermEntries: 2 };
      }
      if (method === "doctor.memory.status") {
        return { dreaming: null };
      }
      return {};
    });

    const ok = await resetGroundedShortTerm(state);

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith("doctor.memory.resetGroundedShortTerm", {});
    expect(request).toHaveBeenCalledWith("doctor.memory.status", {});
    expect(request).not.toHaveBeenCalledWith("doctor.memory.dreamDiary", {});
    expect(state.dreamDiaryContent).toBe("keep existing diary");
    expect(state.dreamDiaryActionLoading).toBe(false);
  });

  it("repairs dreaming artifacts and reloads only dreaming status", async () => {
    const { state, request } = createState();
    state.dreamDiaryContent = "keep existing diary";
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.repairDreamingArtifacts") {
        return {
          action: "repairDreamingArtifacts",
          changed: true,
          archiveDir: "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z",
          archivedSessionCorpus: true,
          archivedSessionIngestion: true,
        };
      }
      if (method === "doctor.memory.status") {
        return { dreaming: null };
      }
      return {};
    });

    const ok = await repairDreamingArtifacts(state);

    expect(ok).toBe(true);
    expect(confirmSpy).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("doctor.memory.repairDreamingArtifacts", {});
    expect(request).toHaveBeenCalledWith("doctor.memory.status", {});
    expect(request).not.toHaveBeenCalledWith("doctor.memory.dreamDiary", {});
    expect(state.dreamDiaryContent).toBe("keep existing diary");
    expect(state.dreamDiaryActionMessage).toEqual({
      kind: "success",
      text: "Dream cache repair complete: archived session corpus, archived ingestion state. Archive: /tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z",
    });
    expect(state.dreamDiaryActionArchivePath).toBe(
      "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z",
    );
    expect(state.dreamDiaryActionLoading).toBe(false);
  });

  it("dedupes dream diary entries and reloads diary plus status", async () => {
    const { state, request } = createState();
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    request.mockImplementation(async (method: string) => {
      if (method === "doctor.memory.dedupeDreamDiary") {
        return {
          action: "dedupeDreamDiary",
          removedEntries: 2,
          keptEntries: 5,
        };
      }
      if (method === "doctor.memory.dreamDiary") {
        return { found: true, path: "DREAMS.md", content: "deduped diary" };
      }
      if (method === "doctor.memory.status") {
        return { dreaming: null };
      }
      return {};
    });

    const ok = await dedupeDreamDiary(state);

    expect(ok).toBe(true);
    expect(confirmSpy).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("doctor.memory.dedupeDreamDiary", {});
    expect(request).toHaveBeenCalledWith("doctor.memory.dreamDiary", {});
    expect(request).toHaveBeenCalledWith("doctor.memory.status", {});
    expect(state.dreamDiaryContent).toBe("deduped diary");
    expect(state.dreamDiaryActionMessage).toEqual({
      kind: "success",
      text: "Removed 2 duplicate dream entries and kept 5.",
    });
    expect(state.dreamDiaryActionArchivePath).toBeNull();
    expect(state.dreamDiaryActionLoading).toBe(false);
  });

  it("copies the dreaming repair archive path", async () => {
    const { state } = createState();
    state.dreamDiaryActionArchivePath =
      "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z";
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);

    const ok = await copyDreamingArchivePath(state);

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith(
      "/tmp/openclaw/.openclaw-repair/dreaming/2026-04-11T22-10-00-000Z",
    );
    expect(state.dreamDiaryActionMessage).toEqual({
      kind: "success",
      text: "Archive path copied.",
    });
  });

  it("does not run repair when confirmation is cancelled", async () => {
    const { state, request } = createState();
    vi.spyOn(globalThis, "confirm").mockReturnValue(false);

    const ok = await repairDreamingArtifacts(state);

    expect(ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(state.dreamDiaryActionMessage).toBeNull();
  });
});
