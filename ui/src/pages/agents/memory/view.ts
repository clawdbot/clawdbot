// Control UI view renders dreaming screen content.
import "../../../styles/lobster-pet.css";
import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { renderHubTabs } from "../../../components/hub-tabs.ts";
import {
  createLobsterPetLook,
  lobsterPetSeed,
  renderLobsterSvg,
} from "../../../components/lobster-pet.ts";
import "../../../components/modal-dialog.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import "../../../styles/dreams.css";
import type { DreamingEntry, WikiImportInsights, WikiOverview } from "./dreaming.ts";

// ── Diary entry parser ─────────────────────────────────────────────────

type DiaryEntry = {
  date: string;
  body: string;
};

type DiaryPanel =
  | ReturnType<typeof html>
  | { navigation: ReturnType<typeof html>; content: ReturnType<typeof html> };

const DIARY_START_RE = /<!--\s*openclaw:dreaming:diary:start\s*-->/;
const DIARY_END_RE = /<!--\s*openclaw:dreaming:diary:end\s*-->/;

function parseDiaryEntries(raw: string): DiaryEntry[] {
  // Extract content between diary markers, or use full content.
  let content = raw;
  const startMatch = DIARY_START_RE.exec(raw);
  const endMatch = DIARY_END_RE.exec(raw);
  if (startMatch && endMatch && endMatch.index > startMatch.index) {
    content = raw.slice(startMatch.index + startMatch[0].length, endMatch.index);
  }

  const entries: DiaryEntry[] = [];
  // Split on --- separators.
  const blocks = content.split(/\n---\n/).filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    let date = "";
    const bodyLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Date lines are wrapped in *asterisks* like: *April 5, 2026, 3:00 AM*
      if (!date && trimmed.startsWith("*") && trimmed.endsWith("*") && trimmed.length > 2) {
        date = trimmed.slice(1, -1);
        continue;
      }
      // Skip heading lines and HTML comments.
      if (trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
        continue;
      }
      if (trimmed.length > 0) {
        bodyLines.push(trimmed);
      }
    }

    if (bodyLines.length > 0) {
      entries.push({ date, body: bodyLines.join("\n") });
    }
  }

  return entries;
}

function parseDiaryTimestamp(date: string): number | null {
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDiaryChipLabel(date: string): string {
  const parsed = parseDiaryTimestamp(date);
  if (parsed === null) {
    return date;
  }
  const value = new Date(parsed);
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

type DreamingPhaseInfo = {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
};

type DreamingProps = {
  access: {
    canOpenConfig: boolean;
    canBackfillDiary: boolean;
    canDedupeDreamDiary: boolean;
    canResetDiary: boolean;
    canResetGroundedShortTerm: boolean;
    canRepairDreamingArtifacts: boolean;
  };
  viewState: DreamingViewState;
  active: boolean;
  selectedAgentId: string;
  shortTermCount: number;
  promotedCount: number;
  phases?: {
    light: DreamingPhaseInfo;
    deep: DreamingPhaseInfo;
    rem: DreamingPhaseInfo;
  };
  shortTermEntries: DreamingEntry[];
  promotedEntries: DreamingEntry[];
  dreamingOf: string | null;
  nextCycle: string | null;
  timezone: string | null;
  statusError: string | null;
  modeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryContent: string | null;
  memoryWikiEnabled: boolean;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: WikiImportInsights | null;
  wikiOverviewLoading: boolean;
  wikiOverviewError: string | null;
  wikiOverview: WikiOverview | null;
  onRefreshDiary: () => void;
  onRefreshImports: () => void;
  onRefreshWikiOverview: () => void;
  onOpenConfig: () => void;
  onOpenWikiPage: (lookup: string) => Promise<{
    title: string;
    path: string;
    content: string;
    totalLines?: number;
    truncated?: boolean;
    updatedAt?: string;
  } | null>;
  onBackfillDiary: () => void;
  onCopyDreamingArchivePath: () => void;
  onDedupeDreamDiary: () => void;
  onResetDiary: () => void;
  onResetGroundedShortTerm: () => void;
  onRepairDreamingArtifacts: () => void;
  onViewStateChange: () => void;
};

const DREAM_PHRASE_KEYS = [
  "dreaming.phrases.consolidatingMemories",
  "dreaming.phrases.tidyingKnowledgeGraph",
  "dreaming.phrases.replayingConversations",
  "dreaming.phrases.weavingShortTerm",
  "dreaming.phrases.defragmentingMemoryLane",
  "dreaming.phrases.filingLooseThoughts",
  "dreaming.phrases.connectingDots",
  "dreaming.phrases.compostingContext",
  "dreaming.phrases.alphabetizingSubconscious",
  "dreaming.phrases.promotingHunches",
  "dreaming.phrases.forgettingNoise",
  "dreaming.phrases.dreamingEmbeddings",
  "dreaming.phrases.reorganizingAttic",
  "dreaming.phrases.indexingDay",
  "dreaming.phrases.nurturingInsights",
  "dreaming.phrases.simmeringIdeas",
  "dreaming.phrases.whisperingVectorStore",
] as const;

const DREAM_PHASE_LABEL_KEYS = {
  light: "dreaming.phase.light",
  deep: "dreaming.phase.deep",
  rem: "dreaming.phase.rem",
} as const;

const DREAM_SWAP_MS = 6_000;

// ── Sub-tab state ─────────────────────────────────────────────────────

export type DreamingViewState = {
  dreamIndex: number;
  dreamLastSwap: number;
  activeSubTab: "scene" | "diary" | "advanced";
  activeDiarySubTab: "dreams" | "insights" | "wiki";
  advancedWaitingSort: "recent" | "signals";
  expandedInsightCards: Set<string>;
  expandedWikiCards: Set<string>;
  diaryPage: number;
  wikiPreviewRequestId: number;
  wikiPreviewOpen: boolean;
  wikiPreviewLoading: boolean;
  wikiPreviewTitle: string;
  wikiPreviewPath: string;
  wikiPreviewUpdatedAt: string | null;
  wikiPreviewContent: string;
  wikiPreviewTotalLines: number | null;
  wikiPreviewTruncated: boolean;
  wikiPreviewError: string | null;
};

export function createDreamingViewState(): DreamingViewState {
  return {
    dreamIndex: Math.floor(Math.random() * DREAM_PHRASE_KEYS.length),
    dreamLastSwap: 0,
    activeSubTab: "scene",
    activeDiarySubTab: "dreams",
    advancedWaitingSort: "recent",
    expandedInsightCards: new Set(),
    expandedWikiCards: new Set(),
    diaryPage: 0,
    wikiPreviewRequestId: 0,
    wikiPreviewOpen: false,
    wikiPreviewLoading: false,
    wikiPreviewTitle: "",
    wikiPreviewPath: "",
    wikiPreviewUpdatedAt: null,
    wikiPreviewContent: "",
    wikiPreviewTotalLines: null,
    wikiPreviewTruncated: false,
    wikiPreviewError: null,
  };
}

function setDiaryPage(state: DreamingViewState, page: number, entryCount: number): void {
  state.diaryPage = Math.max(0, Math.min(page, Math.max(0, entryCount - 1)));
}

function currentDreamPhrase(state: DreamingViewState): string {
  const now = Date.now();
  if (now - state.dreamLastSwap > DREAM_SWAP_MS) {
    state.dreamLastSwap = now;
    state.dreamIndex = (state.dreamIndex + 1) % DREAM_PHRASE_KEYS.length;
  }
  return t(DREAM_PHRASE_KEYS[state.dreamIndex] ?? DREAM_PHRASE_KEYS[0]);
}

const STARS: {
  top: number;
  left: number;
  size: number;
  delay: number;
  hue: "neutral" | "accent";
}[] = [
  { top: 8, left: 15, size: 3, delay: 0, hue: "neutral" },
  { top: 12, left: 72, size: 2, delay: 1.4, hue: "neutral" },
  { top: 22, left: 35, size: 3, delay: 0.6, hue: "accent" },
  { top: 18, left: 88, size: 2, delay: 2.1, hue: "neutral" },
  { top: 35, left: 8, size: 2, delay: 0.9, hue: "neutral" },
  { top: 45, left: 92, size: 2, delay: 1.7, hue: "neutral" },
  { top: 55, left: 25, size: 3, delay: 2.5, hue: "accent" },
  { top: 65, left: 78, size: 2, delay: 0.3, hue: "neutral" },
  { top: 75, left: 45, size: 2, delay: 1.1, hue: "neutral" },
  { top: 82, left: 60, size: 3, delay: 1.8, hue: "accent" },
  { top: 30, left: 55, size: 2, delay: 0.4, hue: "neutral" },
  { top: 88, left: 18, size: 2, delay: 2.3, hue: "neutral" },
];

// The dreams sleeper is the same seeded lobster that visits the sidebar for
// this agent (eyes closed), so the pet identity carries across surfaces.
function renderDreamsCameo(agentId: string) {
  const look = createLobsterPetLook(lobsterPetSeed(agentId));
  const style = `--lob-shell:${look.palette.shell};--lob-claw:${look.palette.claw}`;
  return html`
    <div class="dreams__lobster" style=${style}>${renderLobsterSvg(look, { sleeping: true })}</div>
  `;
}

export function renderDreaming(props: DreamingProps) {
  const state = props.viewState;
  const idle = !props.active;
  const dreamText = props.dreamingOf ?? currentDreamPhrase(state);

  return html`
    <div class="dreams-page">
      <!-- ── Sub-tab bar ── -->
      <div class="dreams__topbar">
        ${renderHubTabs({
          id: "dreams",
          active: state.activeSubTab,
          tabs: [
            { value: "scene", label: t("dreaming.tabs.scene") },
            { value: "diary", label: t("dreaming.tabs.diary") },
            { value: "advanced", label: t("dreaming.tabs.advanced") },
          ],
          ariaLabel: t("memoryPage.tabs.dreams"),
          panelId: "dreams-panel",
          variant: "sub",
          onSelect: (tab) => {
            state.activeSubTab = tab;
            props.onViewStateChange();
          },
        })}
      </div>

      <div
        id="dreams-panel"
        class="dreams__panel"
        role="tabpanel"
        aria-labelledby=${`dreams-tab-${state.activeSubTab}`}
      >
        ${state.activeSubTab === "scene"
          ? renderScene(props, idle, dreamText)
          : state.activeSubTab === "diary"
            ? renderDiarySection(props)
            : renderAdvancedSection(props)}
      </div>
    </div>
  `;
}

// ── Scene renderer ────────────────────────────────────────────────────

// Strip source citations like [memory/2026-04-09.md:9] and section headings,
// flatten structured diary entries into plain paragraphs.
function flattenDiaryBody(body: string): string[] {
  return (
    body
      .split("\n")
      .map((line) => line.trim())
      // Remove section headings that leak implementation
      .filter(
        (line) =>
          line.length > 0 &&
          line !== "What Happened" &&
          line !== "Reflections" &&
          line !== "Candidates" &&
          line !== "Possible Lasting Updates",
      )
      // Strip source citations [memory/...]
      .map((line) => line.replace(/\s*\[memory\/[^\]]+\]/g, ""))
      // Strip leading list markers and labels
      .map((line) =>
        line
          .replace(/^(?:\d+\.\s+|-\s+(?:\[[^\]]+\]\s+)?(?:[a-z_]+:\s+)?)/i, "")
          .replace(/^(?:likely_durable|likely_situational|unclear):\s+/i, "")
          .trim(),
      )
      .filter((line) => line.length > 0)
  );
}

function formatPhaseNextRun(nextRunAtMs?: number): string {
  if (!nextRunAtMs) {
    return "—";
  }
  const d = new Date(nextRunAtMs);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderScene(props: DreamingProps, idle: boolean, dreamText: string) {
  return html`
    <section class="dreams ${idle ? "dreams--idle" : ""}">
      ${STARS.map(
        (s) => html`
          <div
            class="dreams__star"
            style="
              top: ${s.top}%;
              left: ${s.left}%;
              width: ${s.size}px;
              height: ${s.size}px;
              background: ${s.hue === "accent" ? "var(--accent-muted)" : "var(--text)"};
              animation-delay: ${s.delay}s;
            "
          ></div>
        `,
      )}

      <div class="dreams__moon"></div>

      ${props.active
        ? html`
            <div class="dreams__bubble">
              <span class="dreams__bubble-text">${dreamText}</span>
            </div>
            <div
              class="dreams__bubble-dot"
              style="top: calc(50% - 160px); left: calc(50% - 120px); width: 12px; height: 12px; animation-delay: 0.2s;"
            ></div>
            <div
              class="dreams__bubble-dot"
              style="top: calc(50% - 120px); left: calc(50% - 90px); width: 8px; height: 8px; animation-delay: 0.4s;"
            ></div>
          `
        : nothing}

      <div class="dreams__glow"></div>
      ${renderDreamsCameo(props.selectedAgentId)}
      <span class="dreams__z">z</span>
      <span class="dreams__z">z</span>
      <span class="dreams__z">Z</span>

      <div class="dreams__status">
        <span class="dreams__status-label"
          >${props.active ? t("dreaming.status.active") : t("dreaming.status.idle")}</span
        >
        <div class="dreams__status-detail">
          <div class="dreams__status-dot"></div>
          <span>
            ${props.promotedCount} ${t("dreaming.status.promotedSuffix")}
            ${props.nextCycle
              ? html`· ${t("dreaming.status.nextSweepPrefix")} ${props.nextCycle}`
              : nothing}
            ${props.timezone ? html`· ${props.timezone}` : nothing}
          </span>
        </div>
      </div>

      <!-- Sleep phases -->
      <div class="dreams__phases">
        ${(Object.keys(DREAM_PHASE_LABEL_KEYS) as (keyof typeof DREAM_PHASE_LABEL_KEYS)[]).map(
          (phaseId) => {
            const phase = props.phases?.[phaseId];
            const hasPhaseStatus = phase !== undefined;
            const enabled = phase?.enabled === true;
            const nextRun = formatPhaseNextRun(phase?.nextRunAtMs);
            const label = t(DREAM_PHASE_LABEL_KEYS[phaseId]);
            const status = !hasPhaseStatus ? "—" : enabled ? nextRun : t("dreaming.phase.off");
            return html`
              <div class="dreams__phase ${hasPhaseStatus && !enabled ? "dreams__phase--off" : ""}">
                <div class="dreams__phase-dot ${enabled ? "dreams__phase-dot--on" : ""}"></div>
                <span class="dreams__phase-name">${label}</span>
                <span class="dreams__phase-next">${status}</span>
              </div>
            `;
          },
        )}
      </div>

      ${props.statusError
        ? html`<div class="dreams__controls-error">${props.statusError}</div>`
        : nothing}
    </section>
  `;
}

function formatRange(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`;
}

function formatCompactDateTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.split("/").findLast(Boolean) ?? value;
}

function formatKindLabel(kind: "entity" | "concept" | "source" | "synthesis" | "report"): string {
  return t(`dreaming.wiki.pageTypes.${kind}`);
}

function formatPageCount(count: number): string {
  return count === 1
    ? t("dreaming.wiki.counts.pageOne", { count: String(count) })
    : t("dreaming.wiki.counts.pages", { count: String(count) });
}

function formatClaimRowCount(count: number): string {
  return count === 1
    ? t("dreaming.wiki.counts.claimRowOne", { count: String(count) })
    : t("dreaming.wiki.counts.claimRows", { count: String(count) });
}

function formatOpenQuestionCount(count: number): string {
  return count === 1
    ? t("dreaming.wiki.counts.openQuestionOne", { count: String(count) })
    : t("dreaming.wiki.counts.openQuestions", { count: String(count) });
}

function formatContradictionCount(count: number): string {
  return count === 1
    ? t("dreaming.wiki.counts.contradictionOne", { count: String(count) })
    : t("dreaming.wiki.counts.contradictions", { count: String(count) });
}

const WIKI_OVERVIEW_PAGE_GROUPS = [
  ["source", "sources"],
  ["synthesis", "syntheses"],
  ["report", "reports"],
  ["entity", "entities"],
  ["concept", "concepts"],
] as const;

function formatWikiOverviewPageBreakdown(pageCounts: WikiOverview["pageCounts"]): string {
  const parts = WIKI_OVERVIEW_PAGE_GROUPS.map(([kind, group]) => {
    const count = pageCounts[kind];
    return count > 0
      ? t("dreaming.wiki.pageGroupSummary", {
          label: t(`dreaming.wiki.pageGroups.${group}`),
          count: formatPageCount(count),
        })
      : null;
  }).filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join("; ") : t("dreaming.wiki.noPagesYet");
}

function formatWikiOverviewClusterSummary(cluster: WikiOverview["clusters"][number]): string {
  const parts = [
    t("dreaming.wiki.sectionPageSummary", {
      label: cluster.label,
      count: formatPageCount(cluster.itemCount),
    }),
  ];
  if (cluster.claimCount > 0) {
    parts.push(formatClaimRowCount(cluster.claimCount));
  }
  if (cluster.questionCount > 0) {
    const questionPageCount = cluster.items.filter((item) => item.questionCount > 0).length;
    const questionCount = formatOpenQuestionCount(cluster.questionCount);
    parts.push(
      questionPageCount > 0
        ? t("dreaming.wiki.questionCountOnPages", {
            questionCount,
            pageCount: formatPageCount(questionPageCount),
          })
        : questionCount,
    );
  }
  if (cluster.contradictionCount > 0) {
    parts.push(formatContradictionCount(cluster.contradictionCount));
  }
  return parts.join(" · ");
}

function formatImportBadge(item: {
  digestStatus: "available" | "withheld";
  riskLevel: "low" | "medium" | "high" | "unknown";
}): string {
  return t(
    item.digestStatus === "withheld"
      ? "dreaming.wiki.risk.needsReview"
      : `dreaming.wiki.risk.${item.riskLevel}`,
  );
}

function toggleExpandedCard(bucket: Set<string>, key: string, onChange: () => void): void {
  if (bucket.has(key)) {
    bucket.delete(key);
  } else {
    bucket.add(key);
  }
  onChange();
}

async function openWikiPreview(lookup: string, props: DreamingProps): Promise<void> {
  const state = props.viewState;
  const requestId = ++state.wikiPreviewRequestId;
  state.wikiPreviewOpen = true;
  state.wikiPreviewLoading = true;
  state.wikiPreviewTitle = basename(lookup);
  state.wikiPreviewPath = lookup;
  state.wikiPreviewUpdatedAt = null;
  state.wikiPreviewContent = "";
  state.wikiPreviewTotalLines = null;
  state.wikiPreviewTruncated = false;
  state.wikiPreviewError = null;
  props.onViewStateChange();
  try {
    const preview = await props.onOpenWikiPage(lookup);
    if (state.wikiPreviewRequestId !== requestId || !state.wikiPreviewOpen) {
      return;
    }
    if (!preview) {
      state.wikiPreviewError = t("dreaming.wiki.pageNotFound", { lookup });
      return;
    }
    state.wikiPreviewTitle = preview.title;
    state.wikiPreviewPath = preview.path;
    state.wikiPreviewUpdatedAt = preview.updatedAt ?? null;
    state.wikiPreviewContent = preview.content;
    state.wikiPreviewTotalLines =
      typeof preview.totalLines === "number" ? preview.totalLines : null;
    state.wikiPreviewTruncated = preview.truncated === true;
  } catch (error) {
    if (state.wikiPreviewRequestId === requestId && state.wikiPreviewOpen) {
      state.wikiPreviewError = String(error);
    }
  } finally {
    if (state.wikiPreviewRequestId === requestId && state.wikiPreviewOpen) {
      state.wikiPreviewLoading = false;
      props.onViewStateChange();
    }
  }
}

export function resetWikiPreview(state: DreamingViewState): void {
  state.wikiPreviewRequestId += 1;
  state.wikiPreviewOpen = false;
  state.wikiPreviewLoading = false;
  state.wikiPreviewTitle = "";
  state.wikiPreviewPath = "";
  state.wikiPreviewUpdatedAt = null;
  state.wikiPreviewContent = "";
  state.wikiPreviewTotalLines = null;
  state.wikiPreviewTruncated = false;
  state.wikiPreviewError = null;
}

function closeWikiPreview(props: DreamingProps): void {
  resetWikiPreview(props.viewState);
  props.onViewStateChange();
}

function renderWikiPreviewOverlay(props: DreamingProps) {
  const state = props.viewState;
  if (!state.wikiPreviewOpen) {
    return nothing;
  }
  return html`
    <openclaw-modal-dialog
      .label=${state.wikiPreviewTitle || t("dreaming.wiki.previewFallbackTitle")}
      style="--openclaw-modal-width: 1120px"
      @modal-cancel=${() => closeWikiPreview(props)}
    >
      <div class="dreams-diary__preview-panel">
        <div class="dreams-diary__preview-header">
          <div>
            <div class="dreams-diary__preview-title">
              ${state.wikiPreviewTitle || t("dreaming.wiki.previewFallbackTitle")}
            </div>
            <div class="dreams-diary__preview-meta">
              ${state.wikiPreviewPath}
              ${state.wikiPreviewUpdatedAt ? ` · ${state.wikiPreviewUpdatedAt}` : ""}
            </div>
          </div>
          <button
            type="button"
            class="btn btn--subtle btn--sm"
            @click=${() => closeWikiPreview(props)}
          >
            ${t("dreaming.wiki.close")}
          </button>
        </div>
        <div class="dreams-diary__preview-body">
          ${state.wikiPreviewLoading
            ? html`<div class="dreams-diary__empty-text">${t("dreaming.wiki.loadingPage")}</div>`
            : state.wikiPreviewError
              ? html`<div class="dreams-diary__error">${state.wikiPreviewError}</div>`
              : html`
                  ${state.wikiPreviewTruncated
                    ? html`
                        <div class="dreams-diary__preview-hint">
                          ${state.wikiPreviewTotalLines !== null
                            ? t("dreaming.wiki.previewTruncatedWithTotal", {
                                count: String(state.wikiPreviewTotalLines),
                              })
                            : t("dreaming.wiki.previewTruncated")}
                        </div>
                      `
                    : nothing}
                  <pre class="dreams-diary__preview-pre">${state.wikiPreviewContent}</pre>
                `}
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderDiarySubtabExplainer(activeDiarySubTab: DreamingViewState["activeDiarySubTab"]) {
  switch (activeDiarySubTab) {
    case "dreams":
      return html` <p class="dreams-diary__explainer">${t("dreaming.wiki.dreamsExplainer")}</p> `;
    case "insights":
      return html` <p class="dreams-diary__explainer">${t("dreaming.wiki.insightsExplainer")}</p> `;
    case "wiki":
      return html` <p class="dreams-diary__explainer">${t("dreaming.wiki.wikiExplainer")}</p> `;
  }
  return nothing;
}

function parseSortableTimestamp(value?: string): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareWaitingEntryByRecency(a: DreamingEntry, b: DreamingEntry): number {
  const aMs = parseSortableTimestamp(a.lastRecalledAt);
  const bMs = parseSortableTimestamp(b.lastRecalledAt);
  if (bMs !== aMs) {
    return bMs - aMs;
  }
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  return a.path.localeCompare(b.path);
}

function compareWaitingEntryBySignals(a: DreamingEntry, b: DreamingEntry): number {
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  if (b.phaseHitCount !== a.phaseHitCount) {
    return b.phaseHitCount - a.phaseHitCount;
  }
  return compareWaitingEntryByRecency(a, b);
}

function sortWaitingEntries(
  entries: DreamingEntry[],
  sort: DreamingViewState["advancedWaitingSort"],
): DreamingEntry[] {
  return sort === "signals"
    ? entries.toSorted(compareWaitingEntryBySignals)
    : entries.toSorted(compareWaitingEntryByRecency);
}

function describeWaitingEntryOrigin(entry: DreamingEntry): string {
  const hasGroundedReplay = entry.groundedCount > 0;
  const hasLiveSupport = entry.recallCount > 0 || entry.dailyCount > 0;
  if (hasGroundedReplay && hasLiveSupport) {
    return t("dreaming.advanced.originMixed");
  }
  if (hasGroundedReplay) {
    return t("dreaming.advanced.originDailyLog");
  }
  return t("dreaming.advanced.originLive");
}

function renderAdvancedEntryList(params: {
  titleKey: string;
  descriptionKey: string;
  emptyKey: string;
  entries: DreamingEntry[];
  meta: (entry: DreamingEntry) => string[];
  badge?: (entry: DreamingEntry) => string | null;
  controls?: ReturnType<typeof html>;
}) {
  return html`
    <section class="dreams-advanced__section">
      <div class="dreams-advanced__section-header">
        <div class="dreams-advanced__section-copy">
          <span class="dreams-advanced__section-title">${t(params.titleKey)}</span>
          <p class="dreams-advanced__section-description">${t(params.descriptionKey)}</p>
        </div>
        <div class="dreams-advanced__section-toolbar">
          ${params.controls ?? nothing}
          <span class="dreams-advanced__section-count">${params.entries.length}</span>
        </div>
      </div>
      ${params.entries.length === 0
        ? html`<div class="dreams-advanced__empty">${t(params.emptyKey)}</div>`
        : html`
            <div class="dreams-advanced__list">
              ${params.entries.map(
                (entry) => html`
                  <article class="dreams-advanced__item" data-entry-key=${entry.key}>
                    ${params.badge
                      ? (() => {
                          const label = params.badge?.(entry);
                          return label
                            ? html`<span class="dreams-advanced__badge">${label}</span>`
                            : nothing;
                        })()
                      : nothing}
                    <div class="dreams-advanced__snippet">${entry.snippet}</div>
                    <div class="dreams-advanced__source">
                      ${formatRange(entry.path, entry.startLine, entry.endLine)}
                    </div>
                    <div class="dreams-advanced__meta">
                      ${params
                        .meta(entry)
                        .filter((part) => part.length > 0)
                        .join(" · ")}
                    </div>
                  </article>
                `,
              )}
            </div>
          `}
    </section>
  `;
}

function renderAdvancedSection(props: DreamingProps) {
  const state = props.viewState;
  const groundedEntries = props.shortTermEntries.filter((entry) => entry.groundedCount > 0);
  const waitingEntries = sortWaitingEntries(props.shortTermEntries, state.advancedWaitingSort);
  const description = t("dreaming.advanced.description");
  const summary = [
    `${groundedEntries.length} ${t("dreaming.advanced.summaryFromDailyLog")}`,
    `${props.shortTermCount} ${t("dreaming.advanced.summaryWaiting")}`,
    `${props.promotedCount} ${t("dreaming.advanced.summaryPromotedToday")}`,
  ].join(" · ");

  return html`
    <section class="dreams-advanced">
      <div class="dreams-advanced__header">
        <div class="dreams-advanced__intro">
          <span class="dreams-advanced__eyebrow">${t("dreaming.advanced.eyebrow")}</span>
          <h2 class="dreams-advanced__title">${t("dreaming.advanced.title")}</h2>
          ${description
            ? html`<p class="dreams-advanced__description">${description}</p>`
            : nothing}
          <div class="dreams-advanced__summary">${summary}</div>
        </div>
        <div class="dreams-advanced__actions">
          ${[
            {
              label: t("dreaming.scene.dedupeDiary"),
              onClick: props.onDedupeDreamDiary,
              allowed: props.access.canDedupeDreamDiary,
            },
            {
              label: t("dreaming.scene.repairCache"),
              onClick: props.onRepairDreamingArtifacts,
              allowed: props.access.canRepairDreamingArtifacts,
            },
            {
              label: t(
                props.dreamDiaryActionLoading
                  ? "dreaming.scene.working"
                  : "dreaming.scene.backfill",
              ),
              onClick: props.onBackfillDiary,
              allowed: props.access.canBackfillDiary,
            },
            {
              label: t("dreaming.scene.reset"),
              onClick: props.onResetDiary,
              allowed: props.access.canResetDiary,
            },
            {
              label: t("dreaming.scene.clearGrounded"),
              onClick: props.onResetGroundedShortTerm,
              allowed: props.access.canResetGroundedShortTerm,
            },
          ].map(
            ({ label, onClick, allowed }) => html`
              <button
                class="btn btn--subtle btn--sm"
                ?disabled=${!allowed || props.modeSaving || props.dreamDiaryActionLoading}
                @click=${() => onClick()}
              >
                ${label}
              </button>
            `,
          )}
        </div>
      </div>
      ${props.dreamDiaryActionMessage
        ? html`
            <div
              class="callout ${props.dreamDiaryActionMessage.kind === "success"
                ? "success"
                : "danger"}"
              role="status"
            >
              <div class="row wrap items-center gap-2">
                <span>${props.dreamDiaryActionMessage.text}</span>
                ${props.dreamDiaryActionArchivePath
                  ? html`
                      <button
                        class="btn btn--subtle btn--sm"
                        ?disabled=${props.dreamDiaryActionLoading}
                        @click=${() => props.onCopyDreamingArchivePath()}
                      >
                        ${t("dreaming.wiki.copyArchivePath")}
                      </button>
                    `
                  : nothing}
              </div>
            </div>
          `
        : nothing}

      <div class="dreams-advanced__sections">
        ${renderAdvancedEntryList({
          titleKey: "dreaming.advanced.stagedTitle",
          descriptionKey: "dreaming.advanced.stagedDescription",
          emptyKey: "dreaming.advanced.emptyGrounded",
          entries: groundedEntries,
          controls: html`
            <button
              class="btn btn--subtle btn--sm"
              ?disabled=${!props.access.canResetGroundedShortTerm ||
              props.modeSaving ||
              props.dreamDiaryActionLoading}
              @click=${() => props.onResetGroundedShortTerm()}
            >
              ${t("dreaming.scene.clearGrounded")}
            </button>
          `,
          badge: () => t("dreaming.advanced.originDailyLog"),
          meta: (entry) => [
            entry.groundedCount > 0
              ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
              : "",
            entry.recallCount > 0 ? `${entry.recallCount} recall` : "",
            entry.dailyCount > 0 ? `${entry.dailyCount} daily` : "",
          ],
        })}
        ${renderAdvancedEntryList({
          titleKey: "dreaming.advanced.shortTermTitle",
          descriptionKey: "dreaming.advanced.shortTermDescription",
          emptyKey: "dreaming.advanced.emptyShortTerm",
          entries: waitingEntries,
          controls: html`
            <div class="dreams-advanced__sort">
              <button
                class="dreams-advanced__sort-btn ${state.advancedWaitingSort === "recent"
                  ? "dreams-advanced__sort-btn--active"
                  : ""}"
                @click=${() => {
                  state.advancedWaitingSort = "recent";
                  props.onViewStateChange();
                }}
              >
                ${t("dreaming.advanced.sortRecent")}
              </button>
              <button
                class="dreams-advanced__sort-btn ${state.advancedWaitingSort === "signals"
                  ? "dreams-advanced__sort-btn--active"
                  : ""}"
                @click=${() => {
                  state.advancedWaitingSort = "signals";
                  props.onViewStateChange();
                }}
              >
                ${t("dreaming.advanced.sortSignals")}
              </button>
            </div>
          `,
          badge: (entry) => describeWaitingEntryOrigin(entry),
          meta: (entry) => [
            `${entry.totalSignalCount} ${t("dreaming.stats.signals").toLowerCase()}`,
            entry.recallCount > 0 ? `${entry.recallCount} recall` : "",
            entry.dailyCount > 0 ? `${entry.dailyCount} daily` : "",
            entry.groundedCount > 0
              ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
              : "",
            entry.phaseHitCount > 0 ? `${entry.phaseHitCount} phase hit` : "",
          ],
        })}
        ${renderAdvancedEntryList({
          titleKey: "dreaming.advanced.promotedTitle",
          descriptionKey: "dreaming.advanced.promotedDescription",
          emptyKey: "dreaming.advanced.emptyPromoted",
          entries: props.promotedEntries,
          badge: (entry) => describeWaitingEntryOrigin(entry),
          meta: (entry) => [
            entry.promotedAt
              ? `${t("dreaming.advanced.updatedPrefix")} ${formatCompactDateTime(entry.promotedAt)}`
              : "",
            entry.groundedCount > 0
              ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
              : "",
            entry.totalSignalCount > 0
              ? `${entry.totalSignalCount} ${t("dreaming.stats.signals").toLowerCase()}`
              : "",
          ],
        })}
      </div>

      ${props.statusError
        ? html`<div class="dreams__controls-error">${props.statusError}</div>`
        : nothing}
    </section>
  `;
}

type ImportedInsightItem = WikiImportInsights["clusters"][number]["items"][number];
type WikiPageItem = WikiOverview["clusters"][number]["items"][number];
type WikiInsightCard =
  | { kind: "import"; item: ImportedInsightItem }
  | { kind: "wiki"; item: WikiPageItem };

function renderInsightList(labelKey: string, entries: string[]) {
  return entries.length > 0
    ? html`
        <div class="dreams-diary__insight-list">
          <strong>${t(labelKey)}</strong>
          ${entries.map((entry) => html`<p class="dreams-diary__insight-line">• ${entry}</p>`)}
        </div>
      `
    : nothing;
}

function renderInsightDetail(labelKey: string, value: string | undefined) {
  return value
    ? html`
        <p class="dreams-diary__insight-line">
          <strong>${t(labelKey)}</strong>
          ${value}
        </p>
      `
    : nothing;
}

function renderWikiInsightBody(card: WikiInsightCard, expanded: boolean) {
  if (card.kind === "import") {
    const item = card.item;
    return html`
      <p class="dreams-diary__insight-line">${item.summary}</p>
      ${renderInsightList("dreaming.wiki.candidateSignals", item.candidateSignals)}
      ${renderInsightList("dreaming.wiki.corrections", item.correctionSignals)}
      ${expanded
        ? html`
            <div class="dreams-diary__insight-list">
              <strong>${t("dreaming.wiki.importDetails")}</strong>
              ${renderInsightDetail("dreaming.wiki.startedWith", item.firstUserLine)}
              ${renderInsightDetail(
                "dreaming.wiki.endedOn",
                item.lastUserLine !== item.firstUserLine ? item.lastUserLine : undefined,
              )}
              ${renderInsightDetail(
                "dreaming.wiki.messages",
                `${t("dreaming.wiki.counts.userMessages", {
                  count: String(item.userMessageCount),
                })} · ${t("dreaming.wiki.counts.assistantMessages", {
                  count: String(item.assistantMessageCount),
                })}`,
              )}
              ${renderInsightDetail("dreaming.wiki.riskReasons", item.riskReasons.join(", "))}
              ${renderInsightDetail("dreaming.wiki.labels", item.labels.join(", "))}
            </div>
          `
        : nothing}
      ${item.preferenceSignals.length > 0
        ? html`
            <div class="dreams-diary__insight-signals">
              ${item.preferenceSignals.map(
                (signal) => html`<span class="dreams-diary__insight-signal">${signal}</span>`,
              )}
            </div>
          `
        : nothing}
    `;
  }

  const item = card.item;
  return html`
    ${item.snippet ? html`<p class="dreams-diary__insight-line">${item.snippet}</p>` : nothing}
    ${renderInsightList("dreaming.wiki.claims", item.claims)}
    ${renderInsightList("dreaming.wiki.openQuestions", item.questions)}
    ${renderInsightList("dreaming.wiki.contradictions", item.contradictions)}
    ${expanded
      ? html`
          <div class="dreams-diary__insight-list">
            <strong>${t("dreaming.wiki.pageDetails")}</strong>
            ${renderInsightDetail("dreaming.wiki.wikiPage", item.pagePath)}
            ${renderInsightDetail("dreaming.wiki.id", item.id)}
          </div>
        `
      : nothing}
  `;
}

function renderWikiInsightCard(props: DreamingProps, card: WikiInsightCard) {
  const state = props.viewState;
  const item = card.item;
  const expandedCards =
    card.kind === "import" ? state.expandedInsightCards : state.expandedWikiCards;
  const expanded = expandedCards.has(item.pagePath);
  const badgeClass = card.kind === "import" ? card.item.riskLevel : "wiki";
  const badgeLabel =
    card.kind === "import" ? formatImportBadge(card.item) : formatKindLabel(card.item.kind);
  const metadata =
    card.kind === "import"
      ? card.item.activeBranchMessages > 0
        ? ` · ${t("dreaming.wiki.counts.messages", {
            count: String(card.item.activeBranchMessages),
          })}`
        : ""
      : ` · ${item.pagePath}`;

  return html`
    <article
      class="dreams-diary__insight-card dreams-diary__insight-card--clickable"
      data-import-page=${card.kind === "import" ? item.pagePath : nothing}
      data-wiki-page=${card.kind === "wiki" ? item.pagePath : nothing}
      @click=${() => {
        if (card.kind === "wiki" && card.item.kind === "report") {
          void openWikiPreview(item.pagePath, props);
          return;
        }
        toggleExpandedCard(expandedCards, item.pagePath, props.onViewStateChange);
      }}
    >
      <div class="dreams-diary__insight-topline">
        <div class="dreams-diary__insight-title">${item.title}</div>
        <span class="dreams-diary__insight-badge dreams-diary__insight-badge--${badgeClass}">
          ${badgeLabel}
        </span>
      </div>
      <div class="dreams-diary__insight-meta">
        ${item.updatedAt
          ? formatCompactDateTime(item.updatedAt)
          : basename(item.pagePath)}${metadata}
      </div>
      ${renderWikiInsightBody(card, expanded)}
      <div class="dreams-diary__insight-actions">
        <button
          class="btn btn--subtle btn--sm"
          @click=${(event: Event) => {
            event.stopPropagation();
            toggleExpandedCard(expandedCards, item.pagePath, props.onViewStateChange);
          }}
        >
          ${expanded ? t("dreaming.wiki.hideDetails") : t("dreaming.wiki.details")}
        </button>
        <button
          class="btn btn--subtle btn--sm"
          @click=${(event: Event) => {
            event.stopPropagation();
            void openWikiPreview(item.pagePath, props);
          }}
        >
          ${t(
            card.kind === "import" ? "dreaming.wiki.openSourcePage" : "dreaming.wiki.openWikiPage",
          )}
        </button>
      </div>
    </article>
  `;
}

function renderDiaryNavigation(props: DreamingProps, labels: string[], selectedPage: number) {
  const state = props.viewState;
  return html`
    <div class="dreams-diary__daychips">
      ${labels.map(
        (label, index) => html`
          <button
            class="dreams-diary__day-chip ${index === selectedPage
              ? "dreams-diary__day-chip--active"
              : ""}"
            @click=${() => {
              setDiaryPage(state, index, labels.length);
              props.onViewStateChange();
            }}
          >
            ${label}
          </button>
        `,
      )}
    </div>
  `;
}

function renderWikiClusterSection<
  Cluster extends { key: string; label: string; items: { pagePath: string }[] },
>(
  props: DreamingProps,
  params: {
    kind: "imports" | "wiki";
    clusters: Cluster[];
    loading: boolean;
    loadingKey: string;
    emptyKey: string;
    emptyHintKey: string;
    date: (cluster: Cluster) => string;
    prose: (cluster: Cluster) => ReturnType<typeof html>;
    renderItem: (item: Cluster["items"][number]) => ReturnType<typeof html>;
  },
): DiaryPanel {
  const { clusters } = params;
  if (clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">
          ${t(params.loading ? params.loadingKey : params.emptyKey)}
        </div>
        ${params.loading
          ? nothing
          : html`<div class="dreams-diary__empty-hint">${t(params.emptyHintKey)}</div>`}
      </div>
    `;
  }

  const state = props.viewState;
  const clusterIndex = Math.max(0, Math.min(state.diaryPage, clusters.length - 1));
  const cluster = expectDefined(
    clusters[clusterIndex],
    params.kind === "imports"
      ? "selected imported insight cluster"
      : "selected memory overview cluster",
  );
  return {
    navigation: renderDiaryNavigation(
      props,
      clusters.map((entry) => entry.label),
      clusterIndex,
    ),
    content: html`
      <article class="dreams-diary__entry" key="${params.kind}-${cluster.key}">
        <div class="dreams-diary__accent"></div>
        <div class="dreams-diary__date">${params.date(cluster)}</div>
        <div class="dreams-diary__prose">${params.prose(cluster)}</div>
        <div class="dreams-diary__insights">${cluster.items.map(params.renderItem)}</div>
      </article>
    `,
  };
}

function renderDiaryImportsSection(props: DreamingProps) {
  return renderWikiClusterSection(props, {
    kind: "imports",
    clusters: props.wikiImportInsights?.clusters ?? [],
    loading: props.wikiImportInsightsLoading,
    loadingKey: "dreaming.wiki.loadingInsights",
    emptyKey: "dreaming.wiki.noInsights",
    emptyHintKey: "dreaming.wiki.noInsightsHint",
    date: (cluster) => {
      const metadata = [
        t("dreaming.wiki.counts.chats", { count: String(cluster.itemCount) }),
        ...(cluster.highRiskCount > 0
          ? [t("dreaming.wiki.counts.sensitive", { count: String(cluster.highRiskCount) })]
          : []),
        ...(cluster.preferenceSignalCount > 0
          ? [t("dreaming.wiki.counts.signals", { count: String(cluster.preferenceSignalCount) })]
          : []),
      ];
      return `${cluster.label} · ${metadata.join(" · ")}`;
    },
    prose: (cluster) => {
      const summary = [
        t("dreaming.wiki.importedClusterSummary", { label: cluster.label.toLowerCase() }),
        ...(cluster.withheldCount > 0
          ? [
              t(
                cluster.withheldCount === 1
                  ? "dreaming.wiki.withheldDigestOne"
                  : "dreaming.wiki.withheldDigests",
                { count: String(cluster.withheldCount) },
              ),
            ]
          : []),
      ];
      return html`<p class="dreams-diary__para">${summary.join(" ")}</p>`;
    },
    renderItem: (item) => renderWikiInsightCard(props, { kind: "import", item }),
  });
}

function renderWikiOverviewSection(props: DreamingProps) {
  const overview = props.wikiOverview;
  return renderWikiClusterSection(props, {
    kind: "wiki",
    clusters: overview?.clusters ?? [],
    loading: props.wikiOverviewLoading,
    loadingKey: "dreaming.wiki.loadingWiki",
    emptyKey: "dreaming.wiki.emptyWiki",
    emptyHintKey: "dreaming.wiki.emptyWikiHint",
    date: () => {
      const metadata = [
        formatPageCount(overview?.totalPages ?? 0),
        ...((overview?.totalClaims ?? 0) > 0 ? [formatClaimRowCount(overview!.totalClaims)] : []),
        ...((overview?.totalQuestions ?? 0) > 0
          ? [formatOpenQuestionCount(overview!.totalQuestions)]
          : []),
        ...((overview?.totalContradictions ?? 0) > 0
          ? [formatContradictionCount(overview!.totalContradictions)]
          : []),
      ];
      return `${t("dreaming.wiki.vault")} · ${metadata.join(" · ")}`;
    },
    prose: (cluster) => html`
      <p class="dreams-diary__para">
        ${t("dreaming.wiki.fullVaultBreakdown", {
          breakdown: overview
            ? formatWikiOverviewPageBreakdown(overview.pageCounts)
            : t("dreaming.wiki.noPagesYet"),
        })}
      </p>
      <p class="dreams-diary__para">
        ${t("dreaming.wiki.selectedSection", {
          summary: formatWikiOverviewClusterSummary(cluster),
        })}
        ${cluster.updatedAt
          ? ` ${t("dreaming.wiki.latestUpdate", {
              date: formatCompactDateTime(cluster.updatedAt),
            })}`
          : ""}
      </p>
    `,
    renderItem: (item) => renderWikiInsightCard(props, { kind: "wiki", item }),
  });
}

function renderDreamDiaryEntries(props: DreamingProps): DiaryPanel {
  const state = props.viewState;
  if (typeof props.dreamDiaryContent !== "string") {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-moon">
          <svg viewBox="0 0 32 32" fill="none" width="32" height="32">
            <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="0.5" opacity="0.2" />
            <path d="M20 8a10 10 0 0 1 0 16 10 10 0 1 0 0-16z" fill="currentColor" opacity="0.08" />
          </svg>
        </div>
        <div class="dreams-diary__empty-text">${t("dreaming.diary.noDreamsYet")}</div>
        <div class="dreams-diary__empty-hint">${t("dreaming.diary.noDreamsHint")}</div>
      </div>
    `;
  }

  const entries = parseDiaryEntries(props.dreamDiaryContent);
  if (entries.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">${t("dreaming.diary.waitingTitle")}</div>
        <div class="dreams-diary__empty-hint">${t("dreaming.diary.waitingHint")}</div>
      </div>
    `;
  }

  const reversed = entries.toReversed();
  const page = Math.max(0, Math.min(state.diaryPage, reversed.length - 1));
  const entry = expectDefined(reversed[page], "selected dreaming diary entry");

  return {
    navigation: renderDiaryNavigation(
      props,
      reversed.map((diaryEntry) => formatDiaryChipLabel(diaryEntry.date)),
      page,
    ),
    content: html`
      <article class="dreams-diary__entry" key="${page}">
        <div class="dreams-diary__accent"></div>
        ${entry.date ? html`<time class="dreams-diary__date">${entry.date}</time>` : nothing}
        <div class="dreams-diary__prose">
          ${flattenDiaryBody(entry.body).map(
            (para, i) =>
              html`<p class="dreams-diary__para" style="animation-delay: ${0.3 + i * 0.15}s;">
                ${unsafeHTML(toSanitizedMarkdownHtml(para))}
              </p>`,
          )}
        </div>
      </article>
    `,
  };
}

// ── Diary section renderer ────────────────────────────────────────────

function renderDiarySection(props: DreamingProps) {
  const state = props.viewState;
  const activeDiarySubTab = state.activeDiarySubTab;
  const wikiTabSelected = activeDiarySubTab === "insights" || activeDiarySubTab === "wiki";
  const memoryWikiUnavailable = wikiTabSelected && !props.memoryWikiEnabled;
  const diaryError =
    activeDiarySubTab === "dreams"
      ? props.dreamDiaryError
      : activeDiarySubTab === "insights"
        ? props.wikiImportInsightsError
        : props.wikiOverviewError;
  if (diaryError && !memoryWikiUnavailable) {
    return html`
      <section class="dreams-diary">
        <div class="dreams-diary__error">${diaryError}</div>
      </section>
    `;
  }

  const diaryPanel =
    activeDiarySubTab === "dreams"
      ? renderDreamDiaryEntries(props)
      : activeDiarySubTab === "insights"
        ? renderDiaryImportsSection(props)
        : renderWikiOverviewSection(props);
  const diaryNavigation = "navigation" in diaryPanel ? diaryPanel.navigation : nothing;
  const diaryContent = "content" in diaryPanel ? diaryPanel.content : diaryPanel;

  return html`
    <section class="dreams-diary">
      <div class="dreams-diary__chrome">
        <div class="dreams-diary__header">
          <span class="dreams-diary__title">${t("dreaming.diary.title")}</span>
          ${renderHubTabs({
            id: "dream-diary",
            active: activeDiarySubTab,
            tabs: [
              { value: "dreams", label: t("dreaming.wiki.dreamsTab") },
              { value: "insights", label: t("dreaming.wiki.insightsTab") },
              { value: "wiki", label: t("dreaming.wiki.wikiTab") },
            ],
            ariaLabel: t("dreaming.diary.title"),
            panelId: "dream-diary-panel",
            variant: "sub",
            onSelect: (tab) => {
              resetWikiPreview(state);
              state.activeDiarySubTab = tab;
              state.diaryPage = 0;
              props.onViewStateChange();
            },
          })}
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${memoryWikiUnavailable
              ? !props.access.canOpenConfig
              : props.modeSaving ||
                (activeDiarySubTab === "dreams"
                  ? props.dreamDiaryLoading
                  : activeDiarySubTab === "insights"
                    ? props.wikiImportInsightsLoading
                    : props.wikiOverviewLoading)}
            @click=${() => {
              state.diaryPage = 0;
              if (memoryWikiUnavailable) {
                props.onOpenConfig();
              } else if (activeDiarySubTab === "dreams") {
                props.onRefreshDiary();
              } else if (activeDiarySubTab === "insights") {
                props.onRefreshImports();
              } else {
                props.onRefreshWikiOverview();
              }
            }}
          >
            ${memoryWikiUnavailable
              ? t("dreaming.wiki.howToEnable")
              : activeDiarySubTab === "dreams"
                ? props.dreamDiaryLoading
                  ? t("dreaming.diary.reloading")
                  : t("dreaming.diary.reload")
                : activeDiarySubTab === "insights"
                  ? props.wikiImportInsightsLoading
                    ? "Reloading…"
                    : "Reload"
                  : props.wikiOverviewLoading
                    ? "Reloading…"
                    : "Reload"}
          </button>
        </div>
        ${renderDiarySubtabExplainer(activeDiarySubTab)}
        ${memoryWikiUnavailable ? nothing : diaryNavigation}
      </div>

      <div
        id="dream-diary-panel"
        role="tabpanel"
        aria-labelledby=${`dream-diary-tab-${activeDiarySubTab}`}
      >
        ${memoryWikiUnavailable
          ? html`
              <div class="dreams-diary__empty">
                <div class="dreams-diary__empty-text">${t("dreaming.wiki.unavailable")}</div>
                <div class="dreams-diary__empty-hint">
                  ${t("dreaming.wiki.unavailablePluginPrefix")}
                  <code>memory-wiki</code> ${t("dreaming.wiki.unavailablePluginSuffix")}
                </div>
                <div class="dreams-diary__empty-hint">
                  ${t("dreaming.wiki.enablePrefix")}
                  <code>plugins.entries.memory-wiki.enabled = true</code>${t(
                    "dreaming.wiki.enableSuffix",
                  )}
                </div>
                <div class="dreams-diary__empty-actions">
                  <button
                    class="btn btn--subtle btn--sm"
                    ?disabled=${!props.access.canOpenConfig}
                    @click=${() => props.onOpenConfig()}
                  >
                    ${t("dreaming.wiki.openConfig")}
                  </button>
                </div>
              </div>
            `
          : diaryContent}
      </div>
      ${renderWikiPreviewOverlay(props)}
    </section>
  `;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
