// Control UI view renders dreaming screen content.
import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import {
  createLobsterPetLook,
  lobsterPetSeed,
  renderLobsterSvg,
} from "../../../components/lobster-pet.ts";
import "../../../components/modal-dialog.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import "../../../styles/dreams.css";
import type { DreamingEntry, WikiImportInsights, WikiMemoryPalace } from "./dreaming.ts";

// ── Diary entry parser ─────────────────────────────────────────────────

type DiaryEntry = {
  date: string;
  body: string;
};

type DiaryEntryNav = {
  date: string;
  body: string;
  page: number;
};

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

function buildDiaryNavigation(entries: DiaryEntry[]): DiaryEntryNav[] {
  const reversed = [...entries].toReversed();
  return reversed.map((entry, page) => Object.assign({}, entry, { page }));
}

type DreamingPhaseInfo = {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
};

type DreamingProps = {
  viewState: DreamingViewState;
  active: boolean;
  selectedAgentId: string;
  shortTermCount: number;
  groundedSignalCount: number;
  totalSignalCount: number;
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
  statusLoading: boolean;
  statusError: string | null;
  modeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  memoryWikiEnabled: boolean;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: WikiImportInsights | null;
  wikiMemoryPalaceLoading: boolean;
  wikiMemoryPalaceError: string | null;
  wikiMemoryPalace: WikiMemoryPalace | null;
  onRefresh: () => void;
  onRefreshDiary: () => void;
  onRefreshImports: () => void;
  onRefreshMemoryPalace: () => void;
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
  "dreaming.phrases.defragmentingMindPalace",
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
  activeDiarySubTab: "dreams" | "insights" | "palace";
  advancedWaitingSort: "recent" | "signals";
  expandedInsightCards: Set<string>;
  expandedPalaceCards: Set<string>;
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
    expandedPalaceCards: new Set(),
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
        <nav class="dreams__tabs">
          <button
            class="dreams__tab ${state.activeSubTab === "scene" ? "dreams__tab--active" : ""}"
            @click=${() => {
              state.activeSubTab = "scene";
              props.onViewStateChange();
            }}
          >
            ${t("dreaming.tabs.scene")}
          </button>
          <button
            class="dreams__tab ${state.activeSubTab === "diary" ? "dreams__tab--active" : ""}"
            @click=${() => {
              state.activeSubTab = "diary";
              props.onViewStateChange();
            }}
          >
            ${t("dreaming.tabs.diary")}
          </button>
          <button
            class="dreams__tab ${state.activeSubTab === "advanced" ? "dreams__tab--active" : ""}"
            @click=${() => {
              state.activeSubTab = "advanced";
              props.onViewStateChange();
            }}
          >
            ${t("dreaming.tabs.advanced")}
          </button>
        </nav>
      </div>

      ${state.activeSubTab === "scene"
        ? renderScene(props, idle, dreamText)
        : state.activeSubTab === "diary"
          ? renderDiarySection(props)
          : renderAdvancedSection(props)}
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
  switch (kind) {
    case "entity":
      return "entity";
    case "concept":
      return "concept";
    case "source":
      return "source";
    case "synthesis":
      return "synthesis";
    case "report":
      return "report";
  }
  return kind;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const MEMORY_PALACE_PAGE_COUNT_ORDER: Array<keyof WikiMemoryPalace["pageCounts"]> = [
  "source",
  "synthesis",
  "report",
  "entity",
  "concept",
];

function formatMemoryPalacePageCountLabel(kind: keyof WikiMemoryPalace["pageCounts"]): string {
  switch (kind) {
    case "source":
      return "Sources";
    case "synthesis":
      return "Syntheses";
    case "report":
      return "Reports";
    case "entity":
      return "Entities";
    case "concept":
      return "Concepts";
  }
  return kind;
}

function formatMemoryPalacePageBreakdown(pageCounts: WikiMemoryPalace["pageCounts"]): string {
  const parts = MEMORY_PALACE_PAGE_COUNT_ORDER.map((kind) => {
    const count = pageCounts[kind];
    return count > 0
      ? `${formatMemoryPalacePageCountLabel(kind)} · ${formatCount(count, "page")}`
      : null;
  }).filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join("; ") : "No pages yet";
}

function formatMemoryPalaceClusterSummary(cluster: WikiMemoryPalace["clusters"][number]): string {
  const parts = [`${cluster.label}: ${formatCount(cluster.itemCount, "page")}`];
  if (cluster.claimCount > 0) {
    parts.push(formatCount(cluster.claimCount, "claim row"));
  }
  if (cluster.questionCount > 0) {
    const questionPageCount = cluster.items.filter((item) => item.questionCount > 0).length;
    const questionPageSuffix =
      questionPageCount > 0 ? ` on ${formatCount(questionPageCount, "page")}` : "";
    parts.push(`${formatCount(cluster.questionCount, "open question")}${questionPageSuffix}`);
  }
  if (cluster.contradictionCount > 0) {
    parts.push(formatCount(cluster.contradictionCount, "contradiction"));
  }
  return parts.join(" · ");
}

function formatImportBadge(item: {
  digestStatus: "available" | "withheld";
  riskLevel: "low" | "medium" | "high" | "unknown";
}): string {
  if (item.digestStatus === "withheld") {
    return "needs review";
  }
  switch (item.riskLevel) {
    case "low":
      return "low risk";
    case "medium":
      return "medium risk";
    case "high":
      return "high risk";
    case "unknown":
      return "unknown risk";
  }
  return "unknown risk";
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
      state.wikiPreviewError = `No wiki page found for ${lookup}.`;
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

function resetWikiPreview(state: DreamingViewState): void {
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
                          Showing the first chunk of this
                          page${state.wikiPreviewTotalLines !== null
                            ? ` (${state.wikiPreviewTotalLines} total lines)`
                            : ""}.
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
    case "palace":
      return html` <p class="dreams-diary__explainer">${t("dreaming.wiki.palaceExplainer")}</p> `;
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
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onDedupeDreamDiary()}
          >
            ${t("dreaming.scene.dedupeDiary")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onRepairDreamingArtifacts()}
          >
            ${t("dreaming.scene.repairCache")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onBackfillDiary()}
          >
            ${props.dreamDiaryActionLoading
              ? t("dreaming.scene.working")
              : t("dreaming.scene.backfill")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onResetDiary()}
          >
            ${t("dreaming.scene.reset")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onResetGroundedShortTerm()}
          >
            ${t("dreaming.scene.clearGrounded")}
          </button>
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
              ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
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

function renderDiaryImportsSection(props: DreamingProps) {
  const state = props.viewState;
  const importInsights = props.wikiImportInsights;
  const clusters = importInsights?.clusters ?? [];

  if (props.wikiImportInsightsLoading && clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">${t("dreaming.wiki.loadingInsights")}</div>
      </div>
    `;
  }

  if (clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">${t("dreaming.wiki.noInsights")}</div>
        <div class="dreams-diary__empty-hint">${t("dreaming.wiki.noInsightsHint")}</div>
      </div>
    `;
  }

  const clusterIndex = Math.max(0, Math.min(state.diaryPage, clusters.length - 1));
  const cluster = expectDefined(clusters[clusterIndex], "selected imported insight cluster");

  return html`
    <div class="dreams-diary__daychips">
      ${clusters.map(
        (entry, index) => html`
          <button
            class="dreams-diary__day-chip ${index === clusterIndex
              ? "dreams-diary__day-chip--active"
              : ""}"
            @click=${() => {
              setDiaryPage(state, index, clusters.length);
              props.onViewStateChange();
            }}
          >
            ${entry.label}
          </button>
        `,
      )}
    </div>

    <article class="dreams-diary__entry" key="imports-${cluster.key}">
      <div class="dreams-diary__accent"></div>
      <div class="dreams-diary__date">
        ${cluster.label} · ${cluster.itemCount} chats
        ${cluster.highRiskCount > 0 ? html`· ${cluster.highRiskCount} sensitive` : nothing}
        ${cluster.preferenceSignalCount > 0
          ? html`· ${cluster.preferenceSignalCount} signals`
          : nothing}
      </div>
      <div class="dreams-diary__prose">
        <p class="dreams-diary__para">
          Imported chats clustered around ${cluster.label.toLowerCase()}.
          ${cluster.withheldCount > 0
            ? ` ${cluster.withheldCount} digest${cluster.withheldCount === 1 ? " was" : "s were"} withheld pending review.`
            : ""}
        </p>
      </div>
      <div class="dreams-diary__insights">
        ${cluster.items.map((item) => {
          const expanded = state.expandedInsightCards.has(item.pagePath);
          return html`
            <article
              class="dreams-diary__insight-card dreams-diary__insight-card--clickable"
              data-import-page=${item.pagePath}
              @click=${() =>
                toggleExpandedCard(
                  state.expandedInsightCards,
                  item.pagePath,
                  props.onViewStateChange,
                )}
            >
              <div class="dreams-diary__insight-topline">
                <div class="dreams-diary__insight-title">${item.title}</div>
                <span
                  class="dreams-diary__insight-badge dreams-diary__insight-badge--${item.riskLevel}"
                >
                  ${formatImportBadge(item)}
                </span>
              </div>
              <div class="dreams-diary__insight-meta">
                ${item.updatedAt ? formatCompactDateTime(item.updatedAt) : basename(item.pagePath)}
                ${item.activeBranchMessages > 0 ? ` · ${item.activeBranchMessages} messages` : ""}
              </div>
              <p class="dreams-diary__insight-line">${item.summary}</p>
              ${item.candidateSignals.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${t("dreaming.wiki.candidateSignals")}</strong>
                      ${item.candidateSignals.map(
                        (signal) => html`<p class="dreams-diary__insight-line">• ${signal}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${item.correctionSignals.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${t("dreaming.wiki.corrections")}</strong>
                      ${item.correctionSignals.map(
                        (signal) => html`<p class="dreams-diary__insight-line">• ${signal}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${expanded
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${t("dreaming.wiki.importDetails")}</strong>
                      ${item.firstUserLine
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>${t("dreaming.wiki.startedWith")}</strong>
                              ${item.firstUserLine}
                            </p>
                          `
                        : nothing}
                      ${item.lastUserLine && item.lastUserLine !== item.firstUserLine
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>${t("dreaming.wiki.endedOn")}</strong>
                              ${item.lastUserLine}
                            </p>
                          `
                        : nothing}
                      <p class="dreams-diary__insight-line">
                        <strong>${t("dreaming.wiki.messages")}</strong>
                        ${item.userMessageCount} user · ${item.assistantMessageCount} assistant
                      </p>
                      ${item.riskReasons.length > 0
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>${t("dreaming.wiki.riskReasons")}</strong>
                              ${item.riskReasons.join(", ")}
                            </p>
                          `
                        : nothing}
                      ${item.labels.length > 0
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>${t("dreaming.wiki.labels")}</strong>
                              ${item.labels.join(", ")}
                            </p>
                          `
                        : nothing}
                    </div>
                  `
                : nothing}
              ${item.preferenceSignals.length > 0
                ? html`
                    <div class="dreams-diary__insight-signals">
                      ${item.preferenceSignals.map(
                        (signal) =>
                          html`<span class="dreams-diary__insight-signal">${signal}</span>`,
                      )}
                    </div>
                  `
                : nothing}
              <div class="dreams-diary__insight-actions">
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    toggleExpandedCard(
                      state.expandedInsightCards,
                      item.pagePath,
                      props.onViewStateChange,
                    );
                  }}
                >
                  ${expanded ? "Hide details" : "Details"}
                </button>
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    void openWikiPreview(item.pagePath, props);
                  }}
                >
                  ${t("dreaming.wiki.openSourcePage")}
                </button>
              </div>
            </article>
          `;
        })}
      </div>
    </article>
  `;
}

function renderMemoryPalaceSection(props: DreamingProps) {
  const state = props.viewState;
  const palace = props.wikiMemoryPalace;
  const clusters = palace?.clusters ?? [];

  if (props.wikiMemoryPalaceLoading && clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">${t("dreaming.wiki.loadingPalace")}</div>
      </div>
    `;
  }

  if (clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">${t("dreaming.wiki.emptyPalace")}</div>
        <div class="dreams-diary__empty-hint">${t("dreaming.wiki.emptyPalaceHint")}</div>
      </div>
    `;
  }

  const clusterIndex = Math.max(0, Math.min(state.diaryPage, clusters.length - 1));
  const cluster = expectDefined(clusters[clusterIndex], "selected memory palace cluster");
  const totalPages = palace?.totalPages ?? palace?.totalItems ?? 0;
  const totalClaims = palace?.totalClaims ?? 0;
  const totalQuestions = palace?.totalQuestions ?? 0;
  const totalContradictions = palace?.totalContradictions ?? 0;
  const pageBreakdown = palace
    ? formatMemoryPalacePageBreakdown(palace.pageCounts)
    : "No pages yet";
  const clusterSummary = formatMemoryPalaceClusterSummary(cluster);

  return html`
    <div class="dreams-diary__daychips">
      ${clusters.map(
        (entry, index) => html`
          <button
            class="dreams-diary__day-chip ${index === clusterIndex
              ? "dreams-diary__day-chip--active"
              : ""}"
            @click=${() => {
              setDiaryPage(state, index, clusters.length);
              props.onViewStateChange();
            }}
          >
            ${entry.label}
          </button>
        `,
      )}
    </div>

    <article class="dreams-diary__entry" key="palace-${cluster.key}">
      <div class="dreams-diary__accent"></div>
      <div class="dreams-diary__date">
        Vault · ${formatCount(totalPages, "page")}
        ${totalClaims > 0 ? html`· ${formatCount(totalClaims, "claim row")}` : nothing}
        ${totalQuestions > 0 ? html`· ${formatCount(totalQuestions, "open question")}` : nothing}
        ${totalContradictions > 0
          ? html`· ${formatCount(totalContradictions, "contradiction")}`
          : nothing}
      </div>
      <div class="dreams-diary__prose">
        <p class="dreams-diary__para">Full vault breakdown: ${pageBreakdown}.</p>
        <p class="dreams-diary__para">
          Selected section: ${clusterSummary}.
          ${cluster.updatedAt ? ` Latest update ${formatCompactDateTime(cluster.updatedAt)}.` : ""}
        </p>
      </div>
      <div class="dreams-diary__insights">
        ${cluster.items.map((item) => {
          const expanded = state.expandedPalaceCards.has(item.pagePath);
          return html`
            <article
              class="dreams-diary__insight-card dreams-diary__insight-card--clickable"
              data-palace-page=${item.pagePath}
              @click=${() => {
                if (item.kind === "report") {
                  void openWikiPreview(item.pagePath, props);
                  return;
                }
                toggleExpandedCard(
                  state.expandedPalaceCards,
                  item.pagePath,
                  props.onViewStateChange,
                );
              }}
            >
              <div class="dreams-diary__insight-topline">
                <div class="dreams-diary__insight-title">${item.title}</div>
                <span class="dreams-diary__insight-badge dreams-diary__insight-badge--palace">
                  ${formatKindLabel(item.kind)}
                </span>
              </div>
              <div class="dreams-diary__insight-meta">
                ${item.updatedAt ? formatCompactDateTime(item.updatedAt) : basename(item.pagePath)}
                · ${item.pagePath}
              </div>
              ${item.snippet
                ? html`<p class="dreams-diary__insight-line">${item.snippet}</p>`
                : nothing}
              ${item.claims.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${t("dreaming.wiki.claims")}</strong>
                      ${item.claims.map(
                        (claim) => html`<p class="dreams-diary__insight-line">• ${claim}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${item.questions.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${t("dreaming.wiki.openQuestions")}</strong>
                      ${item.questions.map(
                        (question) => html`<p class="dreams-diary__insight-line">• ${question}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${item.contradictions.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${t("dreaming.wiki.contradictions")}</strong>
                      ${item.contradictions.map(
                        (entry) => html`<p class="dreams-diary__insight-line">• ${entry}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${expanded
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>${t("dreaming.wiki.pageDetails")}</strong>
                      <p class="dreams-diary__insight-line">
                        <strong>${t("dreaming.wiki.wikiPage")}</strong>
                        ${item.pagePath}
                      </p>
                      ${item.id
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>${t("dreaming.wiki.id")}</strong>
                              ${item.id}
                            </p>
                          `
                        : nothing}
                    </div>
                  `
                : nothing}
              <div class="dreams-diary__insight-actions">
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    toggleExpandedCard(
                      state.expandedPalaceCards,
                      item.pagePath,
                      props.onViewStateChange,
                    );
                  }}
                >
                  ${expanded ? "Hide details" : "Details"}
                </button>
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    void openWikiPreview(item.pagePath, props);
                  }}
                >
                  ${t("dreaming.wiki.openWikiPage")}
                </button>
              </div>
            </article>
          `;
        })}
      </div>
    </article>
  `;
}

function renderDreamDiaryEntries(props: DreamingProps) {
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

  const reversed = buildDiaryNavigation(entries);
  const page = Math.max(0, Math.min(state.diaryPage, reversed.length - 1));
  const entry = expectDefined(reversed[page], "selected dreaming diary entry");

  return html`
    <div class="dreams-diary__daychips">
      ${reversed.map(
        (e) => html`
          <button
            class="dreams-diary__day-chip ${e.page === page
              ? "dreams-diary__day-chip--active"
              : ""}"
            @click=${() => {
              setDiaryPage(state, e.page, reversed.length);
              props.onViewStateChange();
            }}
          >
            ${formatDiaryChipLabel(e.date)}
          </button>
        `,
      )}
    </div>
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
  `;
}

// ── Diary section renderer ────────────────────────────────────────────

function renderDiarySection(props: DreamingProps) {
  const state = props.viewState;
  const activeDiarySubTab = state.activeDiarySubTab;
  const wikiTabSelected = activeDiarySubTab === "insights" || activeDiarySubTab === "palace";
  const memoryWikiUnavailable = wikiTabSelected && !props.memoryWikiEnabled;
  const diaryError =
    activeDiarySubTab === "dreams"
      ? props.dreamDiaryError
      : activeDiarySubTab === "insights"
        ? props.wikiImportInsightsError
        : props.wikiMemoryPalaceError;
  if (diaryError && !memoryWikiUnavailable) {
    return html`
      <section class="dreams-diary">
        <div class="dreams-diary__error">${diaryError}</div>
      </section>
    `;
  }

  return html`
    <section class="dreams-diary">
      <div class="dreams-diary__chrome">
        <div class="dreams-diary__header">
          <span class="dreams-diary__title">${t("dreaming.diary.title")}</span>
          <div class="dreams-diary__subtabs">
            <button
              class="dreams-diary__subtab ${activeDiarySubTab === "dreams"
                ? "dreams-diary__subtab--active"
                : ""}"
              @click=${() => {
                resetWikiPreview(state);
                state.activeDiarySubTab = "dreams";
                state.diaryPage = 0;
                props.onViewStateChange();
              }}
            >
              ${t("dreaming.wiki.dreamsTab")}
            </button>
            <button
              class="dreams-diary__subtab ${activeDiarySubTab === "insights"
                ? "dreams-diary__subtab--active"
                : ""}"
              @click=${() => {
                resetWikiPreview(state);
                state.activeDiarySubTab = "insights";
                state.diaryPage = 0;
                props.onViewStateChange();
              }}
            >
              ${t("dreaming.wiki.insightsTab")}
            </button>
            <button
              class="dreams-diary__subtab ${activeDiarySubTab === "palace"
                ? "dreams-diary__subtab--active"
                : ""}"
              @click=${() => {
                resetWikiPreview(state);
                state.activeDiarySubTab = "palace";
                state.diaryPage = 0;
                props.onViewStateChange();
              }}
            >
              ${t("dreaming.wiki.palaceTab")}
            </button>
          </div>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${memoryWikiUnavailable
              ? false
              : props.modeSaving ||
                (activeDiarySubTab === "dreams"
                  ? props.dreamDiaryLoading
                  : activeDiarySubTab === "insights"
                    ? props.wikiImportInsightsLoading
                    : props.wikiMemoryPalaceLoading)}
            @click=${() => {
              state.diaryPage = 0;
              if (memoryWikiUnavailable) {
                props.onOpenConfig();
              } else if (activeDiarySubTab === "dreams") {
                props.onRefreshDiary();
              } else if (activeDiarySubTab === "insights") {
                props.onRefreshImports();
              } else {
                props.onRefreshMemoryPalace();
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
                  : props.wikiMemoryPalaceLoading
                    ? "Reloading…"
                    : "Reload"}
          </button>
        </div>
        ${renderDiarySubtabExplainer(activeDiarySubTab)}
      </div>

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
                <button class="btn btn--subtle btn--sm" @click=${() => props.onOpenConfig()}>
                  ${t("dreaming.wiki.openConfig")}
                </button>
              </div>
            </div>
          `
        : activeDiarySubTab === "dreams"
          ? renderDreamDiaryEntries(props)
          : activeDiarySubTab === "insights"
            ? renderDiaryImportsSection(props)
            : renderMemoryPalaceSection(props)}
      ${renderWikiPreviewOverlay(props)}
    </section>
  `;
}
