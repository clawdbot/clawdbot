// Control UI view renders skill workshop screen content.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { styleMap } from "lit/directives/style-map.js";
import "../../components/file-preview-modal.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import {
  filterSkillWorkshopProposals,
  type SkillWorkshopActionBusy,
  type SkillWorkshopActionNotice,
  type SkillWorkshopMode,
  type SkillWorkshopProposal,
  type SkillWorkshopStatusFilter,
} from "../../lib/skill-workshop/index.ts";

type SkillWorkshopEmptyIcon = "search" | "clock" | "check" | "x" | "shield" | "refresh";

type SkillWorkshopProps = {
  loading: boolean;
  error: string | null;
  inspectingKey: string | null;
  proposals: SkillWorkshopProposal[];
  selectedKey: string | null;
  statusFilter: SkillWorkshopStatusFilter;
  query: string;
  filePreviewKey: string | null;
  filePreviewQuery: string;
  queueWidth: number;
  mode: SkillWorkshopMode;
  actionBusy: SkillWorkshopActionBusy | null;
  actionNotice: SkillWorkshopActionNotice | null;
  revisionKey: string | null;
  revisionDraft: string;
  assistantName: string;
  workshopAgentName: string;
  counts: Record<SkillWorkshopStatusFilter, number>;
  onStatusFilterChange: (status: SkillWorkshopStatusFilter) => void;
  onRetry: () => void;
  onQueryChange: (query: string) => void;
  onFilePreviewQueryChange: (query: string) => void;
  onQueueWidthChange: (width: number) => void;
  onModeChange: (mode: SkillWorkshopMode) => void;
  onSelect: (key: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onApply: (key: string) => void;
  onRevise: (key: string) => void;
  onReject: (key: string) => void;
  onRevisionDraftChange: (draft: string) => void;
  onRevisionCancel: () => void;
  onRevisionSubmit: (key: string) => void;
  onPreviewFile: (key: string, path: string) => void;
  onClosePreview: () => void;
};

const STATUS_TABS: SkillWorkshopStatusFilter[] = [
  "all",
  "pending",
  "applied",
  "rejected",
  "quarantined",
  "stale",
];

const STATUS_LABEL: Record<SkillWorkshopStatusFilter, string> = {
  all: "skillWorkshop.status.all",
  pending: "skillWorkshop.status.pending",
  applied: "skillWorkshop.status.applied",
  rejected: "skillWorkshop.status.rejected",
  quarantined: "skillWorkshop.status.quarantined",
  stale: "skillWorkshop.status.stale",
};

const TODAY_PREVIEW_MAX_ITEMS = 3;
const TODAY_PREVIEW_MAX_ITEM_CHARS = 120;

const GROUP_LABEL: Record<SkillWorkshopProposal["recencyGroup"], string> = {
  today: "skillWorkshop.recency.today",
  yesterday: "skillWorkshop.recency.yesterday",
  earlier: "skillWorkshop.recency.earlier",
};

export function renderSkillWorkshop(props: SkillWorkshopProps) {
  const filtered = filterSkillWorkshopProposals(props.proposals, props.statusFilter, props.query);
  const selected = filtered.find((p) => p.key === props.selectedKey) ?? filtered[0];
  const groups = groupByRecency(filtered);
  const preview =
    selected && props.filePreviewKey
      ? selected.supportFiles.find((f) => f.path === props.filePreviewKey)
      : null;
  const revisionProposal = props.revisionKey
    ? props.proposals.find((p) => p.key === props.revisionKey)
    : null;
  const allPending = props.proposals.filter((p) => p.status === "pending");
  const todayHero = selected ?? allPending[0] ?? props.proposals[0];
  const hasNoProposals = props.proposals.length === 0 && !props.loading && !props.error;

  const body = hasNoProposals
    ? renderWorkshopEmptyState(props)
    : props.mode === "today"
      ? renderToday(props, todayHero, allPending)
      : renderBoard(props, groups, selected);

  return html`
    <section class="skill-workshop sw-mode-${props.mode}">
      ${props.error
        ? html`<div class="sw-error" role="status">
            <span>${props.error}</span>
            <button type="button" class="btn btn--sm" @click=${props.onRetry}>
              ${t("pluginsPage.tryAgain")}
            </button>
          </div>`
        : nothing}
      <div class="sw-view" data-mode=${props.mode}>
        ${keyed(props.mode, html`<div class="sw-view__pane">${body}</div>`)}
      </div>
    </section>
    ${preview && selected
      ? html`
          <openclaw-file-preview-modal
            .files=${selected.supportFiles}
            .activePath=${preview.path}
            .query=${props.filePreviewQuery}
            .contextLabel=${t("skillWorkshop.previewContext", { slug: selected.slug })}
            @file-preview-query-change=${(event: CustomEvent<string>) =>
              props.onFilePreviewQueryChange(event.detail)}
            @file-preview-select=${(event: CustomEvent<string>) =>
              props.onPreviewFile(selected.key, event.detail)}
            @file-preview-close=${props.onClosePreview}
          ></openclaw-file-preview-modal>
        `
      : nothing}
    ${revisionProposal ? renderRevisionDialog(props, revisionProposal) : nothing}
  `;
}

function renderRevisionDialog(props: SkillWorkshopProps, proposal: SkillWorkshopProposal) {
  const busy = props.actionBusy?.key === proposal.key && props.actionBusy.action === "revise";
  const canSubmit = props.revisionDraft.trim().length > 0 && !props.actionBusy;
  const verb =
    props.mode === "board" ? t("skillWorkshop.actions.revise") : t("skillWorkshop.actions.tweak");

  return html`
    <div class="sw-revision-backdrop" role="presentation" @click=${props.onRevisionCancel}>
      <section
        class="sw-revision-dialog ${busy ? "sw-revision-dialog--sending" : ""}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sw-revision-title"
        @click=${(event: MouseEvent) => event.stopPropagation()}
      >
        <div class="sw-revision-dialog__head">
          <div>
            <div class="sw-revision-dialog__eyebrow">
              ${t("skillWorkshop.revision.title", { verb })}
            </div>
            <h2 id="sw-revision-title">${proposal.slug}</h2>
          </div>
          <openclaw-tooltip content=${t("skillWorkshop.actions.close")}>
            <button
              class="sw-revision-dialog__close"
              aria-label=${t("skillWorkshop.actions.close")}
              ?disabled=${Boolean(props.actionBusy)}
              @click=${props.onRevisionCancel}
            >
              ×
            </button>
          </openclaw-tooltip>
        </div>
        <p class="sw-revision-dialog__copy">${t("skillWorkshop.revision.description")}</p>
        <textarea
          class="sw-revision-dialog__input"
          autofocus
          placeholder=${t("skillWorkshop.revision.placeholder")}
          .value=${props.revisionDraft}
          ?disabled=${Boolean(props.actionBusy)}
          @input=${(event: Event) =>
            props.onRevisionDraftChange((event.target as HTMLTextAreaElement).value ?? "")}
        ></textarea>
        ${busy
          ? html`
              <div class="sw-revision-dialog__status" role="status">
                <span class="sw-revision-dialog__status-dot" aria-hidden="true"></span>
                <span>${t("skillWorkshop.revision.preparing")}</span>
              </div>
            `
          : nothing}
        <div class="sw-revision-dialog__actions">
          <button
            class="sw-btn sw-btn--ghost"
            ?disabled=${Boolean(props.actionBusy)}
            @click=${props.onRevisionCancel}
          >
            ${t("skillWorkshop.actions.cancel")}
          </button>
          <button
            class="sw-btn sw-btn--primary ${busy ? "is-busy" : ""}"
            ?disabled=${!canSubmit}
            @click=${() => props.onRevisionSubmit(proposal.key)}
          >
            ${busy ? t("skillWorkshop.actions.sending") : t("skillWorkshop.revision.send")}
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderBoard(
  props: SkillWorkshopProps,
  groups: Array<{ label: string; items: SkillWorkshopProposal[] }>,
  selected: SkillWorkshopProposal | undefined,
) {
  return html`
    ${renderLifecycleTabs(props)}
    <div class="sw-triage" style=${styleMap({ "--sw-queue-width": `${props.queueWidth}px` })}>
      ${renderQueue(props, groups, selected)} ${renderQueueResizer(props)}
      ${selected ? renderDetail(props, selected) : renderEmpty(props)}
    </div>
  `;
}

function renderQueueResizer(props: SkillWorkshopProps) {
  return html`
    <div
      class="sw-queue-resizer"
      role="separator"
      aria-label=${t("skillWorkshop.queue.resize")}
      aria-orientation="vertical"
      tabindex="0"
      @pointerdown=${(event: PointerEvent) => startQueueResize(event, props)}
      @keydown=${(event: KeyboardEvent) => resizeQueueWithKeyboard(event, props)}
    ></div>
  `;
}

function startQueueResize(event: PointerEvent, props: SkillWorkshopProps): void {
  event.preventDefault();
  event.stopPropagation();

  const startX = event.clientX;
  const startWidth = props.queueWidth;
  const body = document.body;
  const previousCursor = body.style.cursor;
  const previousUserSelect = body.style.userSelect;
  body.style.cursor = "col-resize";
  body.style.userSelect = "none";

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    body.style.cursor = previousCursor;
    body.style.userSelect = previousUserSelect;
  };

  const onMove = (moveEvent: PointerEvent) => {
    props.onQueueWidthChange(startWidth + moveEvent.clientX - startX);
  };

  const onUp = () => {
    cleanup();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

function resizeQueueWithKeyboard(event: KeyboardEvent, props: SkillWorkshopProps): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  event.preventDefault();
  const delta = event.key === "ArrowLeft" ? -24 : 24;
  props.onQueueWidthChange(props.queueWidth + delta);
}

function renderLifecycleTabs(props: SkillWorkshopProps) {
  return html`
    <div class="sw-lifecycle-tabs">
      ${STATUS_TABS.map((status) => {
        const isActive = props.statusFilter === status;
        const count = props.counts[status] ?? 0;
        return html`
          <button
            class="sw-lifecycle-tab ${isActive ? "is-active" : ""}"
            @click=${() => props.onStatusFilterChange(status)}
          >
            ${t(STATUS_LABEL[status])} <span class="sw-lifecycle-tab__count">${count}</span>
          </button>
        `;
      })}
    </div>
  `;
}

function renderQueue(
  props: SkillWorkshopProps,
  groups: Array<{ label: string; items: SkillWorkshopProposal[] }>,
  selected: SkillWorkshopProposal | undefined,
) {
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);

  return html`
    <aside class="sw-queue">
      <div class="sw-queue__search">
        <input
          placeholder=${t("skillWorkshop.queue.search")}
          .value=${props.query}
          @input=${(event: Event) =>
            props.onQueryChange((event.target as HTMLInputElement).value ?? "")}
        />
      </div>
      <div class="sw-queue__body">
        ${total === 0
          ? html`<div class="sw-queue__empty">${queueEmptyText(props)}</div>`
          : groups.map(
              (group) => html`
                <div class="sw-queue__group">
                  ${t(group.label)}
                  <span class="sw-queue__group-pill">${group.items.length}</span>
                </div>
                ${group.items.map((proposal) => renderRow(props, proposal, selected))}
              `,
            )}
      </div>
    </aside>
  `;
}

function renderRow(
  props: SkillWorkshopProps,
  proposal: SkillWorkshopProposal,
  selected: SkillWorkshopProposal | undefined,
) {
  const isSelected = selected?.key === proposal.key;
  const noveltyClass = proposal.isNew ? "is-new" : "is-seen";
  return html`
    <button
      class="sw-row ${noveltyClass} ${isSelected ? "is-selected" : ""}"
      @click=${() => props.onSelect(proposal.key)}
    >
      <span class="sw-row__dot"></span>
      <span>
        <span class="sw-row__title">${proposal.name}</span>
        <span class="sw-row__desc">${proposal.oneLine}</span>
      </span>
      <span class="sw-row__meta">${proposal.ageLabel}</span>
    </button>
  `;
}

function renderDetail(props: SkillWorkshopProps, proposal: SkillWorkshopProposal) {
  const editedAt =
    proposal.updatedAt && proposal.updatedAt > proposal.createdAt ? proposal.updatedAt : null;
  const createdLabel = editedAt
    ? t("skillWorkshop.detail.edited", { time: formatRelative(editedAt) })
    : t("skillWorkshop.detail.created", { time: formatRelative(proposal.createdAt) });
  const detailLoading = props.inspectingKey === proposal.key && !proposal.body;
  const firstSupportFile = proposal.supportFiles[0];

  return html`
    <div class="sw-detail">
      <div class="sw-detail__head">
        <div class="sw-detail__head-left">
          <h1 class="sw-detail__title">${proposal.name}</h1>
          <div class="sw-detail__one-line">${proposal.oneLine}</div>
          <div class="sw-detail__meta">
            <span>${createdLabel}</span>
            <span>·</span>
            <span>v${proposal.version}</span>
            <span>·</span>
            ${firstSupportFile
              ? html`<button
                  class="sw-detail__meta-link"
                  @click=${() => props.onPreviewFile(proposal.key, firstSupportFile.path)}
                >
                  ${t("skillWorkshop.detail.supportFiles", {
                    count: String(proposal.supportFiles.length),
                  })}
                </button>`
              : html`<span>${t("skillWorkshop.detail.noSupportFiles")}</span>`}
          </div>
        </div>
        <div class="sw-detail__nav">
          <openclaw-tooltip content=${t("skillWorkshop.actions.previous")}>
            <button aria-label=${t("skillWorkshop.actions.previous")} @click=${props.onPrev}>
              ↑
            </button>
          </openclaw-tooltip>
          <openclaw-tooltip content=${t("skillWorkshop.actions.next")}>
            <button aria-label=${t("skillWorkshop.actions.next")} @click=${props.onNext}>↓</button>
          </openclaw-tooltip>
        </div>
      </div>

      <div class="sw-detail__body">
        <div class="sw-body-card">
          <h1>${proposal.slug}</h1>
          ${detailLoading
            ? html`<p class="sw-muted">${t("skillWorkshop.detail.loading")}</p>`
            : renderProposalBody(proposal.body)}
        </div>

        ${proposal.supportFiles.length > 0
          ? html`
              <div class="sw-section" style="margin-top: 18px;">
                <h3 class="sw-section__label">${t("skillWorkshop.detail.supportFilesTitle")}</h3>
                <div class="sw-files">
                  ${proposal.supportFiles.map(
                    (file) => html`
                      <button
                        class="sw-file"
                        @click=${() => props.onPreviewFile(proposal.key, file.path)}
                      >
                        <span>📄</span>
                        <span class="sw-file__name">${file.path}</span>
                        <span class="sw-file__size"
                          >${file.size}
                          <span class="sw-file__hint"
                            >${t("skillWorkshop.detail.clickToPreview")}</span
                          ></span
                        >
                      </button>
                    `,
                  )}
                </div>
              </div>
            `
          : nothing}
      </div>

      ${props.actionNotice?.key === proposal.key ? renderActionNotice(props.actionNotice) : nothing}
      ${proposal.status === "pending" ? renderPendingActions(props, proposal) : nothing}
    </div>
  `;
}

function renderActionNotice(notice: SkillWorkshopActionNotice) {
  return html`
    <div class="sw-action-toast" role="status" aria-live="polite">
      <span>${notice.label}</span>
      <strong>${notice.slug}</strong>
      <span>·</span>
    </div>
  `;
}

function renderPendingActions(props: SkillWorkshopProps, proposal: SkillWorkshopProposal) {
  const busy = props.actionBusy?.key === proposal.key ? props.actionBusy.action : null;
  const disabled = Boolean(props.actionBusy);
  return html`
    <div class="sw-action-bar" aria-busy=${busy ? "true" : "false"}>
      <button
        class="sw-btn sw-btn--primary ${busy === "apply" ? "is-busy" : ""}"
        ?disabled=${disabled}
        @click=${() => props.onApply(proposal.key)}
      >
        ${busy === "apply" ? t("skillWorkshop.actions.applying") : t("skillWorkshop.actions.apply")}
      </button>
      <button
        class="sw-btn ${busy === "revise" ? "is-busy" : ""}"
        ?disabled=${disabled}
        @click=${() => props.onRevise(proposal.key)}
      >
        ${busy === "revise"
          ? t("skillWorkshop.actions.opening")
          : t("skillWorkshop.actions.revise")}
      </button>
      <button
        class="sw-btn sw-btn--ghost sw-btn--danger ${busy === "reject" ? "is-busy" : ""}"
        ?disabled=${disabled}
        @click=${() => props.onReject(proposal.key)}
      >
        ${busy === "reject"
          ? t("skillWorkshop.actions.rejecting")
          : t("skillWorkshop.actions.reject")}
      </button>
    </div>
  `;
}

function renderEmpty(props: SkillWorkshopProps) {
  const empty = resolveBoardEmptyState(props);
  return html`
    <div class="sw-detail sw-detail--empty">
      <div class="sw-filter-empty">
        <div class="sw-filter-empty__icon" aria-hidden="true">
          ${renderEmptyStateIcon(empty.icon)}
        </div>
        <p class="sw-empty__title">${empty.title}</p>
        <p class="sw-empty__sub">${empty.body}</p>
      </div>
    </div>
  `;
}

function resolveBoardEmptyState(props: SkillWorkshopProps): {
  icon: SkillWorkshopEmptyIcon;
  title: string;
  body: string;
} {
  if (props.query.trim()) {
    return {
      icon: "search",
      title: t("skillWorkshop.empty.searchTitle"),
      body: t("skillWorkshop.empty.searchBody"),
    };
  }

  switch (props.statusFilter) {
    case "pending":
      return {
        icon: "clock",
        title: t("skillWorkshop.empty.pendingTitle"),
        body: t("skillWorkshop.empty.pendingBody"),
      };
    case "applied":
      return {
        icon: "check",
        title: t("skillWorkshop.empty.appliedTitle"),
        body: t("skillWorkshop.empty.appliedBody"),
      };
    case "rejected":
      return {
        icon: "x",
        title: t("skillWorkshop.empty.rejectedTitle"),
        body: t("skillWorkshop.empty.rejectedBody"),
      };
    case "quarantined":
      return {
        icon: "shield",
        title: t("skillWorkshop.empty.quarantinedTitle"),
        body: t("skillWorkshop.empty.quarantinedBody"),
      };
    case "stale":
      return {
        icon: "refresh",
        title: t("skillWorkshop.empty.staleTitle"),
        body: t("skillWorkshop.empty.staleBody"),
      };
    case "all":
      return {
        icon: "search",
        title: t("skillWorkshop.empty.allTitle"),
        body: t("skillWorkshop.empty.allBody"),
      };
  }
  return {
    icon: "search",
    title: t("skillWorkshop.empty.allTitle"),
    body: t("skillWorkshop.empty.allBody"),
  };
}

function renderEmptyStateIcon(icon: SkillWorkshopEmptyIcon) {
  switch (icon) {
    case "clock":
      return html`
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="8"></circle>
          <path d="M12 7v5l3 2"></path>
        </svg>
      `;
    case "check":
      return html`
        <svg viewBox="0 0 24 24">
          <path d="M5 12.5l4 4L19 7"></path>
        </svg>
      `;
    case "x":
      return html`
        <svg viewBox="0 0 24 24">
          <path d="M7 7l10 10"></path>
          <path d="M17 7L7 17"></path>
        </svg>
      `;
    case "shield":
      return html`
        <svg viewBox="0 0 24 24">
          <path d="M12 3l7 3v5c0 4.2-2.8 7.8-7 10-4.2-2.2-7-5.8-7-10V6l7-3z"></path>
          <path d="M9 12l2 2 4-5"></path>
        </svg>
      `;
    case "refresh":
      return html`
        <svg viewBox="0 0 24 24">
          <path d="M17 2v5h-5"></path>
          <path d="M7 22v-5h5"></path>
          <path d="M19 10a7 7 0 0 0-12-4l-2 2"></path>
          <path d="M5 14a7 7 0 0 0 12 4l2-2"></path>
        </svg>
      `;
    case "search":
      return html`
        <svg viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="6"></circle>
          <path d="M16 16l4 4"></path>
        </svg>
      `;
  }
  return nothing;
}

function renderWorkshopEmptyState(props: SkillWorkshopProps) {
  const assistantName = resolveSkillWorkshopAgentName(props, t("skillWorkshop.empty.defaultAgent"));
  return html`
    <div class="sw-empty-state">
      <section class="sw-empty-state__panel" aria-label=${t("skillWorkshop.empty.noProposalsAria")}>
        <div class="sw-empty-state__glyph" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <p class="sw-empty-state__eyebrow">${t("skillWorkshop.title")}</p>
        <h2>${t("skillWorkshop.empty.noProposalsTitle")}</h2>
        <p>${t("skillWorkshop.empty.noProposalsBody", { agent: assistantName })}</p>
        <div class="sw-empty-state__footer">${t("skillWorkshop.empty.noProposalsFooter")}</div>
      </section>
    </div>
  `;
}

function resolveSkillWorkshopAgentName(props: SkillWorkshopProps, fallback: string): string {
  return props.workshopAgentName.trim() || props.assistantName.trim() || fallback;
}

function renderToday(
  props: SkillWorkshopProps,
  hero: SkillWorkshopProposal | undefined,
  pending: SkillWorkshopProposal[],
) {
  if (!hero) {
    return html`
      <div class="sw-today sw-today--empty">
        <p class="sw-empty__title">${t("skillWorkshop.today.emptyTitle")}</p>
        <p class="sw-empty__sub">${t("skillWorkshop.today.emptyBody")}</p>
      </div>
    `;
  }

  const heroIndex = Math.max(
    0,
    pending.findIndex((p) => p.key === hero.key),
  );
  const total = Math.max(pending.length, 1);
  const upNext = pending.filter((p) => p.key !== hero.key).slice(0, 3);
  const applied = props.proposals.filter((p) => p.status === "applied").slice(0, 3);
  const heroLabel = hero.isNew
    ? t("skillWorkshop.today.new")
    : hero.status === "pending"
      ? t("skillWorkshop.today.waiting")
      : t("skillWorkshop.today.reviewed");
  const ageLabel = hero.ageLabel;
  const dateLine = formatTodayDate(Date.now());
  const isPending = hero.status === "pending";
  const busy = props.actionBusy?.key === hero.key ? props.actionBusy.action : null;
  const disabled = Boolean(props.actionBusy);
  const assistantName = resolveSkillWorkshopAgentName(props, t("skillWorkshop.today.agent"));
  const firstSupportFile = hero.supportFiles[0];

  return html`
    <div class="sw-today">
      <div class="sw-today__head">
        <div class="sw-today__date">${dateLine}</div>
        <h1 class="sw-today__h1">
          ${t("skillWorkshop.today.proposalsWaiting", { count: String(pending.length) })}
        </h1>
        ${pending.length === 0
          ? html`<div class="sw-today__sub">${t("skillWorkshop.today.browseApplied")}</div>`
          : nothing}
        ${pending.length > 0
          ? html`
              <div class="sw-today__progress">
                <span
                  >${t("skillWorkshop.today.progress", {
                    current: String(heroIndex + 1),
                    total: String(total),
                  })}</span
                >
                <div class="sw-today__dots">
                  ${pending.map(
                    (_, i) => html`
                      <span
                        class="sw-today__dot ${i < heroIndex
                          ? "is-done"
                          : i === heroIndex
                            ? "is-now"
                            : ""}"
                      ></span>
                    `,
                  )}
                </div>
              </div>
            `
          : nothing}
      </div>

      <article class="sw-today__hero">
        <div class="sw-today__label">
          <span class="sw-today__ping"></span>
          ${heroLabel} · ${ageLabel}
        </div>
        <h2 class="sw-today__name">${hero.slug}</h2>
        <p class="sw-today__one-liner">${hero.oneLine}</p>

        ${renderTodayDoesBlock(hero)}

        <div class="sw-today__author">
          <span class="sw-today__avatar">v${hero.version}</span>
          <span>
            ${t("skillWorkshop.today.draftedBy")}
            <strong>${assistantName}</strong> · ${ageLabel}.
            ${firstSupportFile
              ? html`
                  <button
                    class="sw-today__files-link"
                    @click=${() => props.onPreviewFile(hero.key, firstSupportFile.path)}
                  >
                    ${t(
                      hero.supportFiles.length === 1
                        ? "skillWorkshop.today.supportFile"
                        : "skillWorkshop.today.supportFiles",
                      { count: String(hero.supportFiles.length) },
                    )}
                  </button>
                  ${t("skillWorkshop.today.comeWithIt")}
                `
              : nothing}
          </span>
        </div>

        ${isPending
          ? html`
              <div class="sw-today__actions" aria-busy=${busy ? "true" : "false"}>
                <button
                  class="sw-today__big sw-today__big--primary ${busy === "apply" ? "is-busy" : ""}"
                  ?disabled=${disabled}
                  @click=${() => props.onApply(hero.key)}
                >
                  ${busy === "apply"
                    ? t("skillWorkshop.actions.applying")
                    : t("skillWorkshop.today.useIt")}
                  <span class="sw-today__big-sub">${t("skillWorkshop.today.addToSkills")}</span>
                </button>
                <button
                  class="sw-today__big sw-today__big--tweak ${busy === "revise" ? "is-busy" : ""}"
                  ?disabled=${disabled}
                  @click=${() => props.onRevise(hero.key)}
                >
                  ${busy === "revise"
                    ? t("skillWorkshop.actions.opening")
                    : t("skillWorkshop.today.tweakIt")}
                  <span class="sw-today__big-sub">${t("skillWorkshop.today.askAgent")}</span>
                </button>
                <button
                  class="sw-today__big sw-today__big--skip ${busy === "reject" ? "is-busy" : ""}"
                  ?disabled=${disabled}
                  @click=${() => props.onReject(hero.key)}
                >
                  ${busy === "reject"
                    ? t("skillWorkshop.today.skipping")
                    : t("skillWorkshop.today.skip")}
                  <span class="sw-today__big-sub">${t("skillWorkshop.today.notForMe")}</span>
                </button>
              </div>
            `
          : nothing}
        ${props.actionNotice?.key === hero.key ? renderActionNotice(props.actionNotice) : nothing}
      </article>

      ${upNext.length > 0
        ? html`
            <section class="sw-today__section">
              <header class="sw-today__section-head">
                <h3>
                  ${t("skillWorkshop.today.upNext", {
                    count: String(pending.length - 1),
                  })}
                </h3>
                <button class="sw-today__link" @click=${() => props.onModeChange("board")}>
                  ${t("skillWorkshop.today.seeAll")}
                </button>
              </header>
              <div class="sw-today__upnext">
                ${upNext.map(
                  (p) => html`
                    <button class="sw-today__mini" @click=${() => props.onSelect(p.key)}>
                      <div class="sw-today__mini-name">${p.slug}</div>
                      <div class="sw-today__mini-desc">${p.oneLine}</div>
                      <div class="sw-today__mini-meta">${p.ageLabel}</div>
                    </button>
                  `,
                )}
              </div>
            </section>
          `
        : nothing}
      ${applied.length > 0
        ? html`
            <section class="sw-today__section">
              <header class="sw-today__section-head">
                <h3>
                  ${t("skillWorkshop.today.collection", {
                    count: String(props.counts.applied),
                  })}
                </h3>
                <button
                  class="sw-today__link sw-today__link--muted"
                  @click=${() => props.onModeChange("board")}
                >
                  ${t("skillWorkshop.today.manage")}
                </button>
              </header>
              <div class="sw-today__applied">
                ${applied.map(
                  (p) => html`
                    <button
                      class="sw-today__applied-row"
                      @click=${() => {
                        props.onSelect(p.key);
                        props.onModeChange("board");
                      }}
                    >
                      <span class="sw-today__check">✓</span>
                      <span class="sw-today__applied-name">
                        <strong>${p.slug}</strong> — ${p.oneLine}
                      </span>
                      <span class="sw-today__applied-when">${p.ageLabel}</span>
                    </button>
                  `,
                )}
              </div>
            </section>
          `
        : nothing}
    </div>
  `;
}

function renderTodayDoesBlock(hero: SkillWorkshopProposal) {
  const preview = extractTodayProposalPreview(hero.body);
  if (!preview) {
    return nothing;
  }
  return html`
    <div class="sw-today__does">
      <div class="sw-today__does-h">${preview.heading}</div>
      <ul>
        ${preview.items.map((item) => html`<li>${item}</li>`)}
      </ul>
    </div>
  `;
}

type TodayProposalPreview = {
  heading: string;
  items: string[];
};

type ProposalBodySection = {
  title: string;
  lines: string[];
};

function extractTodayProposalPreview(body: string): TodayProposalPreview | null {
  const sections = splitProposalBodySections(body);
  const workflow = findProposalSection(sections, [
    "workflow",
    "procedure",
    "steps",
    "agent workflow",
    "process",
  ]);
  const workflowItems = workflow ? extractTopLevelListItems(workflow.lines) : [];
  if (workflowItems.length > 0) {
    return {
      heading: t("skillWorkshop.today.workflowHeading"),
      items: workflowItems.slice(0, TODAY_PREVIEW_MAX_ITEMS),
    };
  }

  const applicability = findProposalSection(sections, [
    "when to use",
    "use when",
    "applies when",
    "trigger",
    "triggers",
  ]);
  const applicabilityItems = applicability ? extractTopLevelListItems(applicability.lines) : [];
  if (applicabilityItems.length > 0) {
    return {
      heading: t("skillWorkshop.today.applicabilityHeading"),
      items: applicabilityItems.slice(0, TODAY_PREVIEW_MAX_ITEMS),
    };
  }

  return null;
}

function splitProposalBodySections(body: string): ProposalBodySection[] {
  const sections: ProposalBodySection[] = [];
  let current: ProposalBodySection | null = null;
  let inCode = false;

  for (const raw of body.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      inCode = !inCode;
    }
    const heading = !inCode ? /^(#{2,4})\s+(.+?)\s*$/.exec(trimmed) : null;
    const headingText = heading?.[2];
    if (headingText) {
      current = { title: normalizeSectionTitle(headingText), lines: [] };
      sections.push(current);
      continue;
    }
    current?.lines.push(raw);
  }

  return sections;
}

function findProposalSection(
  sections: readonly ProposalBodySection[],
  names: readonly string[],
): ProposalBodySection | undefined {
  const wanted = new Set(names.map(normalizeSectionTitle));
  return sections.find((section) => wanted.has(section.title));
}

function normalizeSectionTitle(title: string): string {
  return title
    .replace(/[#*_`[\]().:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractTopLevelListItems(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    if (/^\s{2,}/.test(raw)) {
      continue;
    }
    const line = raw.trim();
    const m = /^(?:[-*]|\d+\.)\s+(.+)/.exec(line);
    const item = m?.[1];
    if (item) {
      out.push(cleanTodayPreviewItem(item));
    }
  }
  return out.filter(Boolean);
}

function cleanTodayPreviewItem(item: string): string {
  const cleaned = item
    .replace(/^\*\*[^*]+\*\*\s*/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return truncateAtWord(cleaned, TODAY_PREVIEW_MAX_ITEM_CHARS);
}

function truncateAtWord(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const clipped = truncateUtf16Safe(value, maxChars - 1);
  const boundary = clipped.lastIndexOf(" ");
  const base = boundary > 48 ? clipped.slice(0, boundary) : clipped;
  return `${base.trimEnd()}…`;
}

function formatTodayDate(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString(undefined, { weekday: "long" });
  const month = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} · ${month}`;
}

function renderProposalBody(body: string) {
  const lines = body.split("\n");
  const out: unknown[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(html`<p>${renderInline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      const items = list;
      out.push(html`
        <ol>
          ${items.map((line) => html`<li>${renderInline(line)}</li>`)}
        </ol>
      `);
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("```")) {
      flushPara();
      flushList();
      if (inCode) {
        out.push(html`<pre>${codeBuf.join("\n")}</pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    if (line === "") {
      flushPara();
      flushList();
      continue;
    }
    if (line.startsWith("## ")) {
      flushPara();
      flushList();
      out.push(html`<h3>${line.slice(3)}</h3>`);
      continue;
    }
    if (line.startsWith("# ")) {
      flushPara();
      flushList();
      out.push(html`<h3>${line.slice(2)}</h3>`);
      continue;
    }
    const olMatch = /^\d+\.\s+(.+)/.exec(line);
    const listItem = olMatch?.[1];
    if (listItem) {
      flushPara();
      list.push(listItem);
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  if (inCode && codeBuf.length) {
    out.push(html`<pre>${codeBuf.join("\n")}</pre>`);
  }
  return out;
}

// Inline render: handles `code` and **bold** in text segments.
function renderInline(text: string): unknown {
  const parts: unknown[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(html`<code>${token.slice(1, -1)}</code>`);
    } else {
      parts.push(html`<strong>${token.slice(2, -2)}</strong>`);
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
}

function groupByRecency(
  proposals: SkillWorkshopProposal[],
): Array<{ label: string; items: SkillWorkshopProposal[] }> {
  const buckets = new Map<SkillWorkshopProposal["recencyGroup"], SkillWorkshopProposal[]>();
  for (const proposal of proposals) {
    const list = buckets.get(proposal.recencyGroup) ?? [];
    list.push(proposal);
    buckets.set(proposal.recencyGroup, list);
  }
  const order: Array<SkillWorkshopProposal["recencyGroup"]> = ["today", "yesterday", "earlier"];
  return order
    .filter((key) => buckets.has(key))
    .map((key) => ({ label: GROUP_LABEL[key], items: buckets.get(key) ?? [] }));
}

function queueEmptyText(props: SkillWorkshopProps): string {
  if (props.error) {
    return t("skillWorkshop.queue.loadError");
  }
  if (props.loading) {
    return t("skillWorkshop.queue.loading");
  }
  if (props.statusFilter !== "all") {
    return t("skillWorkshop.queue.noStatus", {
      status: t(STATUS_LABEL[props.statusFilter]).toLocaleLowerCase(),
    });
  }
  return t("skillWorkshop.queue.noMatch");
}

function formatRelative(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) {
    return t("skillWorkshop.relative.secondsAgo", { count: String(sec) });
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return t("skillWorkshop.relative.minutesAgo", { count: String(min) });
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return t("skillWorkshop.relative.hoursAgo", { count: String(hr) });
  }
  const day = Math.floor(hr / 24);
  if (day < 7) {
    return t("skillWorkshop.relative.daysAgo", { count: String(day) });
  }
  return new Date(ms).toLocaleDateString();
}
