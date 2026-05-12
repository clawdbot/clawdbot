/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  renderDreaming,
  setDreamAdvancedWaitingSort,
  setDreamDiarySubTab,
  setDreamSubTab,
  type DreamingProps,
} from "./dreaming.ts";

function buildProps(overrides?: Partial<DreamingProps>): DreamingProps {
  return {
    active: true,
    shortTermCount: 47,
    groundedSignalCount: 9,
    totalSignalCount: 182,
    promotedCount: 12,
    phases: {
      light: { enabled: true, cron: "0 * * * *", nextRunAtMs: Date.parse("2026-04-05T11:30:00Z") },
      deep: { enabled: true, cron: "30 * * * *", nextRunAtMs: Date.parse("2026-04-05T12:00:00Z") },
      rem: { enabled: false, cron: "0 4 * * *" },
    },
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
        remHits: 1,
        phaseHitCount: 2,
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
        groundedCount: 4,
        totalSignalCount: 9,
        lightHits: 0,
        remHits: 0,
        phaseHitCount: 0,
        promotedAt: "2026-04-05T04:00:00.000Z",
      },
    ],
    dreamingOf: null,
    nextCycle: "4:00 AM",
    timezone: "America/Los_Angeles",
    statusLoading: false,
    statusError: null,
    modeSaving: false,
    dreamDiaryLoading: false,
    dreamDiaryActionLoading: false,
    dreamDiaryActionMessage: null,
    dreamDiaryActionArchivePath: null,
    dreamDiaryError: null,
    dreamDiaryPath: "DREAMS.md",
    dreamDiaryContent:
      "# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n\n---\n\n*April 5, 2026, 3:00 AM*\n\nThe repository whispered of forgotten endpoints tonight.\n\n<!-- openclaw:dreaming:diary:end -->",
    memoryWikiEnabled: true,
    wikiImportInsightsLoading: false,
    wikiImportInsightsError: null,
    wikiImportInsights: {
      sourceType: "chatgpt",
      totalItems: 2,
      totalClusters: 2,
      clusters: [
        {
          key: "topic/travel",
          label: "Travel",
          itemCount: 1,
          highRiskCount: 0,
          withheldCount: 0,
          preferenceSignalCount: 1,
          items: [
            {
              pagePath: "sources/chatgpt-2026-04-10-alpha.md",
              title: "BA flight receipts process",
              riskLevel: "low",
              riskReasons: [],
              labels: ["domain/personal", "area/travel", "topic/travel"],
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
              candidateSignals: ["prefers direct airline receipts"],
              correctionSignals: [],
              preferenceSignals: ["prefers direct airline receipts"],
              updatedAt: "2026-04-10T10:00:00.000Z",
            },
          ],
        },
        {
          key: "topic/health",
          label: "Health",
          itemCount: 1,
          highRiskCount: 1,
          withheldCount: 1,
          preferenceSignalCount: 0,
          items: [
            {
              pagePath: "sources/chatgpt-2026-04-10-health.md",
              title: "Migraine Medication Advice",
              riskLevel: "high",
              riskReasons: ["health"],
              labels: ["domain/personal", "area/health", "topic/health"],
              topicKey: "topic/health",
              topicLabel: "Health",
              digestStatus: "withheld",
              activeBranchMessages: 2,
              userMessageCount: 1,
              assistantMessageCount: 1,
              summary:
                "Sensitive health chat withheld from durable-memory extraction because it touches health.",
              candidateSignals: [],
              correctionSignals: [],
              preferenceSignals: [],
              updatedAt: "2026-04-11T10:00:00.000Z",
            },
          ],
        },
      ],
    },
    wikiMemoryPalaceLoading: false,
    wikiMemoryPalaceError: null,
    wikiMemoryPalace: {
      totalItems: 2,
      totalClaims: 3,
      totalQuestions: 1,
      totalContradictions: 1,
      clusters: [
        {
          key: "synthesis",
          label: "Syntheses",
          itemCount: 1,
          claimCount: 2,
          questionCount: 1,
          contradictionCount: 1,
          items: [
            {
              pagePath: "syntheses/travel-system.md",
              title: "Travel system",
              kind: "synthesis",
              claimCount: 2,
              questionCount: 1,
              contradictionCount: 1,
              claims: [
                "Mariano prefers direct receipts from airlines when possible.",
                "Travel admin friction keeps showing up across chats.",
              ],
              questions: ["Should flight receipts be standardized into one process?"],
              contradictions: ["Old BA receipts guidance may now be stale."],
              snippet: "Recurring travel admin friction across imported chats.",
              updatedAt: "2026-04-10T10:00:00.000Z",
            },
          ],
        },
      ],
    },
    onRefresh: () => {},
    onRefreshDiary: () => {},
    onRefreshImports: () => {},
    onRefreshMemoryPalace: () => {},
    onOpenConfig: () => {},
    onOpenWikiPage: async () => null,
    onBackfillDiary: () => {},
    onCopyDreamingArchivePath: () => {},
    onDedupeDreamDiary: () => {},
    onResetDiary: () => {},
    onResetGroundedShortTerm: () => {},
    onRepairDreamingArtifacts: () => {},
    ...overrides,
  };
}

function renderInto(props: DreamingProps): HTMLDivElement {
  const container = document.createElement("div");
  render(renderDreaming(props), container);
  return container;
}

function expectElement(container: Element, selector: string): Element {
  const element = container.querySelector(selector);
  expect(element).toBeInstanceOf(Element);
  if (!(element instanceof Element)) {
    throw new Error(`Expected element matching ${selector}`);
  }
  return element;
}

function compactText(node: Element | null): string | undefined {
  return node?.textContent?.trim().replace(/\s+/g, " ");
}

function textItems(container: Element, selector: string): Array<string | undefined> {
  return [...container.querySelectorAll(selector)].map((node) => node.textContent?.trim());
}

describe("dreaming view", () => {
  it("renders the active dream scene chrome and status", () => {
    const container = renderInto(buildProps({ dreamingOf: "reindexing old chats\u2026" }));

    expectElement(container, ".dreams__lobster svg");

    expect(textItems(container, ".dreams__z")).toEqual(["z", "z", "Z"]);

    const stars = [...container.querySelectorAll<HTMLElement>(".dreams__star")].map((star) => ({
      top: star.style.top,
      left: star.style.left,
      size: star.style.width,
    }));
    expect(stars).toEqual([
      { top: "8%", left: "15%", size: "3px" },
      { top: "12%", left: "72%", size: "2px" },
      { top: "22%", left: "35%", size: "3px" },
      { top: "18%", left: "88%", size: "2px" },
      { top: "35%", left: "8%", size: "2px" },
      { top: "45%", left: "92%", size: "2px" },
      { top: "55%", left: "25%", size: "3px" },
      { top: "65%", left: "78%", size: "2px" },
      { top: "75%", left: "45%", size: "2px" },
      { top: "82%", left: "60%", size: "3px" },
      { top: "30%", left: "55%", size: "2px" },
      { top: "88%", left: "18%", size: "2px" },
    ]);

    expectElement(container, ".dreams__moon");

    const phases = [...container.querySelectorAll(".dreams__phase")].map((phase) => ({
      name: phase.querySelector(".dreams__phase-name")?.textContent?.trim(),
      off: phase.classList.contains("dreams__phase--off"),
    }));
    expect(phases).toEqual([
      { name: "Light", off: false },
      { name: "Deep", off: false },
      { name: "Rem", off: true },
    ]);
    expect(container.querySelector(".dreams__phase--off .dreams__phase-next")?.textContent).toBe(
      "off",
    );

    const buttons = [...container.querySelectorAll("button")].map((node) =>
      node.textContent?.trim(),
    );
    expect(buttons).toEqual(["Scene", "Diary", "Advanced"]);
    expectElement(container, ".dreams__bubble");
    const text = container.querySelector(".dreams__bubble-text");
    expect(text?.textContent).toBe("reindexing old chats\u2026");
    const label = container.querySelector(".dreams__status-label");
    expect(label?.textContent).toBe("Dreaming Active");
    const detail = container.querySelector(".dreams__status-detail span");
    expect(detail?.textContent?.trim().replace(/\s+/g, " ")).toBe(
      "12 promoted · next sweep 4:00 AM · America/Los_Angeles",
    );
    const tabs = container.querySelectorAll(".dreams__tab");
    expect([...tabs].map((tab) => tab.textContent?.trim())).toEqual(["Scene", "Diary", "Advanced"]);
  });

  it("renders idle and unavailable scene states", () => {
    const idleContainer = renderInto(buildProps({ active: false }));
    expect(idleContainer.querySelector(".dreams__bubble")).toBeNull();
    expect(idleContainer.querySelector(".dreams__status-label")?.textContent).toBe("Dreaming Idle");
    expectElement(idleContainer, ".dreams--idle");

    const unknownPhaseContainer = renderInto(buildProps({ phases: undefined }));
    const statuses = [...unknownPhaseContainer.querySelectorAll(".dreams__phase")].map((phase) => ({
      status: phase.querySelector(".dreams__phase-next")?.textContent?.trim(),
      off: phase.classList.contains("dreams__phase--off"),
    }));
    expect(statuses).toEqual([
      { status: "—", off: false },
      { status: "—", off: false },
      { status: "—", off: false },
    ]);

    const errorContainer = renderInto(buildProps({ statusError: "patch failed" }));
    expect(errorContainer.querySelector(".dreams__controls-error")?.textContent?.trim()).toBe(
      "patch failed",
    );
  });

  it("renders imported memory topics inside the diary tab", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("insights");
    const container = renderInto(buildProps());
    const subtabs = [...container.querySelectorAll(".dreams-diary__subtab")].map((tab) => ({
      label: tab.textContent?.trim(),
      active: tab.classList.contains("dreams-diary__subtab--active"),
    }));
    expect(subtabs).toEqual([
      { label: "Dreams", active: false },
      { label: "Imported Insights", active: true },
      { label: "Memory Palace", active: false },
    ]);
    expect(compactText(container.querySelector(".dreams-diary__date"))).toBe(
      "Travel · 1 chats · 1 signals",
    );
    const insight = container.querySelector(".dreams-diary__insight-card");
    expect(insight?.querySelector(".dreams-diary__insight-title")?.textContent).toBe(
      "BA flight receipts process",
    );
    expect(insight?.querySelector(".dreams-diary__insight-line")?.textContent).toBe(
      "Use the BA request-a-receipt flow first.",
    );
    expect(compactText(container.querySelector(".dreams-diary__explainer"))).toBe(
      "These are imported insights clustered from external history; use them to review what imports surfaced before any of it graduates into durable memory.",
    );
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("opens the full imported source page from diary cards", async () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("insights");
    const onOpenWikiPage = vi.fn().mockResolvedValue({
      title: "BA flight receipts process",
      path: "sources/chatgpt-2026-04-10-alpha.md",
      content: "# ChatGPT Export: BA flight receipts process",
    });
    const container = renderInto(buildProps({ onOpenWikiPage }));
    const openSourceButton = container.querySelectorAll<HTMLButtonElement>(
      ".dreams-diary__insight-actions .btn",
    )[1];
    expect(openSourceButton).toBeInstanceOf(HTMLButtonElement);
    if (!(openSourceButton instanceof HTMLButtonElement)) {
      throw new Error("Expected imported source button");
    }
    openSourceButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(onOpenWikiPage).toHaveBeenCalledWith("sources/chatgpt-2026-04-10-alpha.md");
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("shows a truncation hint when the wiki preview only contains the first chunk", async () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("insights");
    const container = document.createElement("div");
    let props: DreamingProps;
    const onOpenWikiPage = vi.fn().mockResolvedValue({
      title: "BA flight receipts process",
      path: "sources/chatgpt-2026-04-10-alpha.md",
      content: "# ChatGPT Export: BA flight receipts process",
      totalLines: 6001,
      truncated: true,
    });
    const rerender = () => render(renderDreaming(props), container);
    props = buildProps({
      onOpenWikiPage,
      onRequestUpdate: rerender,
    });
    rerender();

    const openSourceButton = container.querySelectorAll<HTMLButtonElement>(
      ".dreams-diary__insight-actions .btn",
    )[1];
    expect(openSourceButton).toBeInstanceOf(HTMLButtonElement);
    if (!(openSourceButton instanceof HTMLButtonElement)) {
      throw new Error("Expected imported source button");
    }
    openSourceButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(compactText(container.querySelector(".dreams-diary__preview-hint"))).toBe(
      "Showing the first chunk of this page (6001 total lines).",
    );

    const closePreviewButton = container.querySelector<HTMLButtonElement>(
      ".dreams-diary__preview-header .btn",
    );
    expect(closePreviewButton).toBeInstanceOf(HTMLButtonElement);
    closePreviewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("renders the memory palace inside the diary tab", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("palace");
    const container = renderInto(buildProps());
    expect(compactText(container.querySelector(".dreams-diary__date"))).toBe(
      "Syntheses · 1 pages · 2 claims · 1 questions · 1 contradictions",
    );
    const insight = container.querySelector(".dreams-diary__insight-card");
    expect(insight?.querySelector(".dreams-diary__insight-title")?.textContent).toBe(
      "Travel system",
    );
    expect(insight?.querySelector(".dreams-diary__insight-list strong")?.textContent).toBe(
      "Claims",
    );
    expect(compactText(container.querySelector(".dreams-diary__explainer"))).toBe(
      "This is the compiled memory wiki surface the system can search and reason over; use it to inspect actual memory pages, claims, open questions, and contradictions rather than raw imported source chats.",
    );
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("shows a memory-wiki enablement CTA when wiki subtabs are selected but the plugin is disabled", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("palace");
    const onOpenConfig = vi.fn();
    const container = renderInto(
      buildProps({
        memoryWikiEnabled: false,
        onOpenConfig,
      }),
    );
    expect(container.querySelector(".dreams-diary__empty-text")?.textContent).toBe(
      "Memory Wiki is not enabled",
    );
    expect(
      [...container.querySelectorAll(".dreams-diary__empty-hint")].map((node) => compactText(node)),
    ).toEqual([
      "Imported Insights and Memory Palace are provided by the bundled memory-wiki plugin.",
      "Enable plugins.entries.memory-wiki.enabled = true, then reload this tab.",
    ]);

    const configButton = container.querySelector<HTMLButtonElement>(
      ".dreams-diary__empty-actions .btn",
    );
    expect(configButton).toBeInstanceOf(HTMLButtonElement);
    configButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenConfig).toHaveBeenCalledTimes(1);
    setDreamDiarySubTab("dreams");
    setDreamSubTab("scene");
  });

  it("renders dream diary with parsed entry on diary tab", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("dreams");
    const container = renderInto(buildProps());
    const title = container.querySelector(".dreams-diary__title");
    expect(title?.textContent).toBe("Dream Diary");

    expectElement(container, ".dreams-diary__entry");
    const date = container.querySelector(".dreams-diary__date");
    expect(date?.textContent).toBe("April 5, 2026, 3:00 AM");
    const body = container.querySelector(".dreams-diary__para");
    expect(body?.textContent?.trim()).toBe(
      "The repository whispered of forgotten endpoints tonight.",
    );
    setDreamSubTab("scene");
  });

  it("renders dream diary markdown through the sanitized markdown pipeline", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("dreams");
    const container = renderInto(
      buildProps({
        dreamDiaryContent: [
          "# Dream Diary",
          "",
          "---",
          "",
          "*April 8, 2026*",
          "",
          "**Bold** and *italic*",
        ].join("\n"),
      }),
    );

    const body = container.querySelector(".dreams-diary__para");
    expect(body?.querySelector("strong")?.textContent).toBe("Bold");
    expect(body?.querySelector("em")?.textContent).toBe("italic");
    setDreamSubTab("scene");
  });

  it("flattens structured backfill diary entries into plain prose", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("dreams");
    const container = renderInto(
      buildProps({
        dreamDiaryContent: [
          "# Dream Diary",
          "",
          "<!-- openclaw:dreaming:diary:start -->",
          "",
          "---",
          "",
          "*January 1, 2026*",
          "",
          "<!-- openclaw:dreaming:backfill-entry day=2026-01-01 source=memory/2026-01-01.md -->",
          "",
          "What Happened",
          "1. Always use Happy Together for flights.",
          "",
          "Reflections",
          "1. Stable preferences were made explicit.",
          "",
          "Candidates",
          "- likely_durable: Happy Together rule",
          "",
          "Possible Lasting Updates",
          "- Use Happy Together for flights.",
          "",
          "<!-- openclaw:dreaming:diary:end -->",
        ].join("\n"),
      }),
    );
    const prose = [...container.querySelectorAll(".dreams-diary__para")].map((node) =>
      node.textContent?.trim(),
    );
    expect(prose).toEqual([
      "Always use Happy Together for flights.",
      "Stable preferences were made explicit.",
      "Happy Together rule",
      "Use Happy Together for flights.",
    ]);
    expect(container.querySelector(".dreams-diary__panel-title")).toBeNull();
    setDreamSubTab("scene");
  });

  it("renders diary day chips without the old density map", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("dreams");
    const container = renderInto(
      buildProps({
        dreamDiaryContent: [
          "# Dream Diary",
          "",
          "<!-- openclaw:dreaming:diary:start -->",
          "",
          "---",
          "",
          "*January 1, 2026*",
          "",
          "What Happened",
          "1. First durable fact.",
          "",
          "---",
          "",
          "*January 2, 2026*",
          "",
          "What Happened",
          "1. Second durable fact.",
          "",
          "Candidates",
          "- candidate",
          "",
          "<!-- openclaw:dreaming:diary:end -->",
        ].join("\n"),
      }),
    );
    const dayChips = [...container.querySelectorAll(".dreams-diary__day-chip")].map((node) => ({
      label: node.textContent?.replace(/\s+/g, "").trim(),
      active: node.classList.contains("dreams-diary__day-chip--active"),
    }));
    expect(dayChips).toEqual([
      { label: "1/2", active: true },
      { label: "1/1", active: false },
    ]);
    expect(container.querySelector(".dreams-diary__heatmap-cell")).toBeNull();
    expect(container.querySelector(".dreams-diary__timeline-month")).toBeNull();
    setDreamSubTab("scene");
  });

  it("renders diary empty, error, and removed-navigation states", () => {
    setDreamSubTab("diary");
    setDreamDiarySubTab("dreams");
    const emptyContainer = renderInto(buildProps({ dreamDiaryContent: null }));
    expect(emptyContainer.querySelectorAll(".dreams-diary__empty")).toHaveLength(1);
    expect(emptyContainer.querySelector(".dreams-diary__empty-text")?.textContent).toBe(
      "No dreams yet",
    );
    expect(emptyContainer.querySelector(".dreams-diary__empty-hint")?.textContent).toBe(
      "Dreams will appear here after the first dreaming cycle runs.",
    );

    const errorContainer = renderInto(buildProps({ dreamDiaryError: "read failed" }));
    expect(errorContainer.querySelector(".dreams-diary__error")?.textContent).toBe("read failed");

    const container = renderInto(buildProps());
    expect(container.querySelector(".dreams-diary__page")).toBeNull();
    expect(container.querySelector(".dreams-diary__nav-btn")).toBeNull();
    setDreamSubTab("scene");
  });

  it("renders operator actions and evidence lists on the advanced tab", () => {
    setDreamSubTab("advanced");
    setDreamAdvancedWaitingSort("recent");
    const container = renderInto(buildProps());
    expect(container.querySelector(".dreams-advanced__title")?.textContent).toBe(
      "Daily Log Review",
    );
    const actionButtons = [...container.querySelectorAll(".dreams-advanced__actions button")].map(
      (node) => node.textContent?.trim(),
    );
    expect(actionButtons).toEqual([
      "Dedupe Diary",
      "Repair Dream Cache",
      "Backfill",
      "Reset",
      "Clear Replayed",
    ]);
    const sortButtons = [...container.querySelectorAll(".dreams-advanced__sort-btn")].map((node) =>
      node.textContent?.trim(),
    );
    expect(sortButtons).toEqual(["Most recent", "Strongest support"]);
    const sectionTitles = [...container.querySelectorAll(".dreams-advanced__section-title")].map(
      (node) => node.textContent?.trim(),
    );
    expect(sectionTitles).toEqual([
      "From the Daily Log",
      "Waiting for Promotion",
      "Recent Promotions",
    ]);
    expect(compactText(container.querySelector(".dreams-advanced__summary"))).toBe(
      "1 from daily log · 47 waiting · 12 promoted today",
    );
    expect(
      container.querySelector(".dreams-advanced__item .dreams-advanced__snippet")?.textContent,
    ).toBe("Emma prefers shorter, lower-pressure check-ins.");
    setDreamAdvancedWaitingSort("recent");
    setDreamSubTab("scene");
  });

  it("sorts waiting entries by strongest support without swapping datasets", () => {
    setDreamSubTab("advanced");
    const shortTermEntries = [
      {
        key: "memory:recent-low-signal",
        path: "memory/2026-04-05.md",
        startLine: 1,
        endLine: 1,
        snippet: "Recent but low signal",
        recallCount: 1,
        dailyCount: 0,
        groundedCount: 0,
        totalSignalCount: 1,
        lightHits: 0,
        remHits: 0,
        phaseHitCount: 0,
        lastRecalledAt: "2026-04-06T12:00:00.000Z",
      },
      {
        key: "memory:older-high-signal",
        path: "memory/2026-04-01.md",
        startLine: 1,
        endLine: 1,
        snippet: "Older but strongly supported",
        recallCount: 5,
        dailyCount: 4,
        groundedCount: 0,
        totalSignalCount: 9,
        lightHits: 2,
        remHits: 1,
        phaseHitCount: 3,
        lastRecalledAt: "2026-04-01T12:00:00.000Z",
      },
    ];

    setDreamAdvancedWaitingSort("recent");
    let container = renderInto(
      buildProps({
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const recentOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(recentOrder).toEqual(["memory:recent-low-signal", "memory:older-high-signal"]);

    setDreamAdvancedWaitingSort("signals");
    container = renderInto(
      buildProps({
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const signalOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(signalOrder).toEqual(["memory:older-high-signal", "memory:recent-low-signal"]);
    expect(new Set(signalOrder)).toEqual(new Set(recentOrder));

    setDreamAdvancedWaitingSort("recent");
    setDreamSubTab("scene");
  });

  it("treats malformed waiting-entry timestamps as oldest in both sort modes", () => {
    setDreamSubTab("advanced");
    const shortTermEntries = [
      {
        key: "memory:valid-recent",
        path: "memory/2026-04-06.md",
        startLine: 1,
        endLine: 1,
        snippet: "Valid recent timestamp",
        recallCount: 1,
        dailyCount: 0,
        groundedCount: 0,
        totalSignalCount: 3,
        lightHits: 1,
        remHits: 0,
        phaseHitCount: 1,
        lastRecalledAt: "2026-04-06T12:00:00.000Z",
      },
      {
        key: "memory:malformed-time",
        path: "memory/2026-04-05.md",
        startLine: 1,
        endLine: 1,
        snippet: "Malformed timestamp",
        recallCount: 1,
        dailyCount: 0,
        groundedCount: 0,
        totalSignalCount: 3,
        lightHits: 1,
        remHits: 0,
        phaseHitCount: 1,
        lastRecalledAt: "not-a-timestamp",
      },
    ];

    setDreamAdvancedWaitingSort("recent");
    let container = renderInto(
      buildProps({
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const recentOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(recentOrder).toEqual(["memory:valid-recent", "memory:malformed-time"]);

    setDreamAdvancedWaitingSort("signals");
    container = renderInto(
      buildProps({
        shortTermEntries,
        promotedEntries: [],
      }),
    );
    const signalOrder = [...container.querySelectorAll("[data-entry-key]")].map((node) =>
      node.getAttribute("data-entry-key"),
    );
    expect(signalOrder).toEqual(["memory:valid-recent", "memory:malformed-time"]);

    setDreamAdvancedWaitingSort("recent");
    setDreamSubTab("scene");
  });

  // Toggle lives in the page header (app-render.ts), not inside the dreaming view.
});
