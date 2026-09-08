import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import "../../components/file-preview-modal-registration.ts";
import "../../components/modal-dialog.ts";
import "../../components/resizable-divider.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import "../../styles/plugins.css";
import "../../styles/skill-workshop.css";
import "../../styles/sidebar-markdown.css";
import {
  filterSkillWorkshopProposals,
  type SkillWorkshopActionNotice,
  type SkillWorkshopProposal,
  type SkillWorkshopProposalDecision,
} from "../../lib/skill-workshop/index.ts";
import { renderSkillDocument, renderSkillWorkshopCollection } from "./collection-view.ts";
import { renderSkillWorkshopEmptyDetail, renderWorkshopEmptyState } from "./empty-states.ts";
import { renderSkillWorkshopEvaluation } from "./evaluation-view.ts";
import { renderSkillWorkshopHistoryScan } from "./history-scan.ts";
import { renderSkillWorkshopProposalList } from "./proposal-list.ts";
import { renderSelfLearningError } from "./self-learning.ts";
import type { SkillWorkshopProps } from "./view-types.ts";

const GROUP_LABEL: Record<SkillWorkshopProposal["recencyGroup"], string> = {
  today: "skillWorkshop.recency.today",
  yesterday: "skillWorkshop.recency.yesterday",
  earlier: "skillWorkshop.recency.earlier",
};

type SkillWorkshopSection = {
  groups: Array<{ label: string; items: SkillWorkshopProposal[] }>;
  selected: SkillWorkshopProposal | undefined;
};

function resolveSection(props: SkillWorkshopProps): SkillWorkshopSection {
  const filtered = filterSkillWorkshopProposals(props.proposals, props.query);
  return {
    groups: groupByRecency(filtered),
    selected: filtered.find((proposal) => proposal.key === props.selectedKey) ?? filtered[0],
  };
}

export function renderSkillWorkshop(props: SkillWorkshopProps) {
  const section = resolveSection(props);
  const selected = section.selected;
  const preview =
    selected && props.filePreviewKey
      ? selected.supportFiles.find((f) => f.path === props.filePreviewKey)
      : null;
  const revisionProposal = props.revisionKey
    ? props.proposals.find((p) => p.key === props.revisionKey)
    : null;

  const body =
    props.mode === "skills"
      ? renderSkillWorkshopCollection(props)
      : renderSuggestions(props, section);

  return html`
    <section class="skill-workshop sw-mode-${props.mode}">
      ${
        props.error
          ? html`<div class="sw-error" role="status">
              <span>${props.error}</span>
              <button type="button" class="btn btn--sm" @click=${props.onRetry}>
                ${t("pluginsPage.tryAgain")}
              </button>
            </div>`
          : nothing
      }
      ${renderSelfLearningError(props.selfLearning)}
      <div class="sw-view" data-mode=${props.mode}>
        ${keyed(props.mode, html`<div class="sw-view__pane">${body}</div>`)}
      </div>
      ${props.actionNotice ? renderActionNotice(props.actionNotice) : nothing}
    </section>
    ${
      preview && selected
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
        : nothing
    }
    ${revisionProposal ? renderRevisionDialog(props, revisionProposal) : nothing}
  `;
}

function renderRevisionDialog(props: SkillWorkshopProps, proposal: SkillWorkshopProposal) {
  const busy = props.actionBusy?.key === proposal.key && props.actionBusy.action === "revise";
  const cancelDisabled = Boolean(props.actionBusy) || props.revisionRecoveryActive;
  const canSubmit =
    props.access.canRevise && props.revisionDraft.trim().length > 0 && !props.actionBusy;
  const verb = t("skillWorkshop.actions.revise");

  return html`
    <openclaw-modal-dialog
      .label=${`${t("skillWorkshop.revision.title", { verb })}: ${proposal.slug}`}
      .description=${t("skillWorkshop.revision.description")}
      style="--openclaw-modal-width: 560px"
      @modal-cancel=${cancelDisabled ? undefined : props.onRevisionCancel}
    >
      <section class="sw-revision-dialog ${busy ? "sw-revision-dialog--sending" : ""}">
        <div class="sw-revision-dialog__head">
          <div>
            <div class="sw-revision-dialog__eyebrow">
              ${t("skillWorkshop.revision.title", { verb })}
            </div>
            <h2 id="sw-revision-title">${proposal.slug}</h2>
          </div>
          <openclaw-tooltip content=${t("skillWorkshop.actions.close")}>
            <button
              type="button"
              class="sw-revision-dialog__close"
              aria-label=${t("skillWorkshop.actions.close")}
              ?disabled=${cancelDisabled}
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
          ?disabled=${
            !props.access.canRevise || Boolean(props.actionBusy) || props.revisionRecoveryActive
          }
          @input=${(event: Event) =>
            props.onRevisionDraftChange((event.target as HTMLTextAreaElement).value ?? "")}
        ></textarea>
        ${
          busy
            ? html`
                <div class="sw-revision-dialog__status" role="status">
                  <span class="sw-revision-dialog__status-dot" aria-hidden="true"></span>
                  <span>${t("skillWorkshop.revision.preparing")}</span>
                </div>
              `
            : nothing
        }
        <div class="sw-revision-dialog__actions">
          <button
            type="button"
            class="sw-btn sw-btn--ghost"
            ?disabled=${cancelDisabled}
            @click=${props.onRevisionCancel}
          >
            ${t("skillWorkshop.actions.cancel")}
          </button>
          <button
            type="button"
            class="sw-btn sw-btn--primary ${busy ? "is-busy" : ""}"
            ?disabled=${!canSubmit}
            @click=${() => props.onRevisionSubmit(proposal.key)}
          >
            ${busy ? t("skillWorkshop.actions.sending") : t("skillWorkshop.revision.send")}
          </button>
        </div>
      </section>
    </openclaw-modal-dialog>
  `;
}

function renderSuggestions(props: SkillWorkshopProps, section: SkillWorkshopSection) {
  const historyScan = renderSkillWorkshopHistoryScan({
    state: props.historyScan,
    canScan: props.access.canScanHistory,
    onScan: props.onHistoryScan,
  });
  if (props.proposals.length === 0 && !props.loading && !props.error) {
    return html`${historyScan}${renderWorkshopEmptyState({
      agentName: resolveSkillWorkshopAgentName(props, t("skillWorkshop.empty.defaultAgent")),
      selfLearning: props.selfLearning,
      onSelfLearningToggle: props.onSelfLearningToggle,
    })}`;
  }
  return html`
    ${historyScan}
    <div
      class="sw-triage sw-triage--standalone"
      style=${styleMap({ "--sw-queue-width": `${props.queueWidth}px` })}
    >
      ${renderSkillWorkshopProposalList({
        props,
        groups: section.groups,
        selected: section.selected,
        emptyText: queueEmptyText(props),
        searchLabel: t("skillWorkshop.queue.suggestionsLabel"),
        searchPlaceholder: t("skillWorkshop.queue.searchSuggestions"),
      })}
      ${renderQueueResizer(props)}
      ${
        section.selected
          ? renderDetail(props, section.selected)
          : renderSkillWorkshopEmptyDetail({
              query: props.query,
            })
      }
    </div>
  `;
}

function renderQueueResizer(props: SkillWorkshopProps) {
  let divider: HTMLElement | undefined;
  const measureSize = () => {
    const queue = divider?.previousElementSibling?.getBoundingClientRect().width ?? 0;
    const detail = divider?.nextElementSibling?.getBoundingClientRect().width ?? 0;
    return queue + detail;
  };
  return html`<resizable-divider
    ${ref((element) => (divider = element instanceof HTMLElement ? element : undefined))}
    class="sw-queue-resizer"
    .label=${t("skillWorkshop.queue.resize")}
    .splitRatio=${0.5}
    .minRatio=${0.2}
    .maxRatio=${0.8}
    .measureRatio=${() => props.queueWidth / measureSize()}
    .measureSize=${measureSize}
    @resize=${(event: CustomEvent<{ splitRatio: number }>) =>
      props.onQueueWidthChange(event.detail.splitRatio * measureSize())}
  ></resizable-divider>`;
}

function renderDetail(props: SkillWorkshopProps, proposal: SkillWorkshopProposal) {
  const editedAt =
    proposal.updatedAt && proposal.updatedAt > proposal.createdAt ? proposal.updatedAt : null;
  const createdLabel = editedAt
    ? t("skillWorkshop.detail.edited", { time: formatRelative(editedAt) })
    : t("skillWorkshop.detail.created", { time: formatRelative(proposal.createdAt) });
  const detailLoading = props.inspectingKey === proposal.key && !proposal.bodyLoaded;
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
            ${
              firstSupportFile
                ? html`<button
                    class="sw-detail__meta-link"
                    @click=${() => props.onPreviewFile(proposal.key, firstSupportFile.path)}
                  >
                    ${t("skillWorkshop.detail.supportFiles", {
                      count: String(proposal.supportFiles.length),
                    })}
                  </button>`
                : html`<span>${t("skillWorkshop.detail.noSupportFiles")}</span>`
            }
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
          <div class="sw-body-card__head">
            <h1>${proposal.slug}</h1>
          </div>
          ${
            detailLoading
              ? html`<p class="sw-muted">${t("skillWorkshop.detail.loading")}</p>`
              : renderSkillDocument(proposal.body)
          }
        </div>

        ${
          proposal.supportFiles.length > 0
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
            : nothing
        }
        ${proposal.evaluation ? renderSkillWorkshopEvaluation(proposal.evaluation) : nothing}
      </div>

      ${renderPendingActions(props, proposal)}
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

function proposalDecision(proposal: SkillWorkshopProposal): SkillWorkshopProposalDecision {
  return {
    proposalId: proposal.key,
    expectedRevisionHash: proposal.revisionHash,
  };
}

function renderPendingActions(props: SkillWorkshopProps, proposal: SkillWorkshopProposal) {
  const busy = props.actionBusy?.key === proposal.key ? props.actionBusy.action : null;
  const disabled = Boolean(props.actionBusy);
  return html`
    <div class="sw-action-bar" aria-busy=${busy ? "true" : "false"}>
      <button
        class="sw-btn ${busy === "evaluate" ? "is-busy" : ""}"
        ?disabled=${disabled || !props.access.canEvaluate}
        @click=${() => props.onEvaluate(proposal.key)}
      >
        ${
          busy === "evaluate"
            ? t("skillWorkshop.actions.evaluating")
            : t("skillWorkshop.actions.evaluate")
        }
      </button>
      <button
        class="sw-btn sw-btn--primary ${busy === "apply" ? "is-busy" : ""}"
        ?disabled=${disabled || !props.access.canApply}
        @click=${() => props.onApply(proposalDecision(proposal))}
      >
        ${busy === "apply" ? t("skillWorkshop.actions.applying") : t("skillWorkshop.actions.apply")}
      </button>
      <button
        class="sw-btn ${busy === "revise" ? "is-busy" : ""}"
        ?disabled=${disabled || !props.access.canRevise}
        @click=${() => props.onRevise(proposal.key)}
      >
        ${
          busy === "revise" ? t("skillWorkshop.actions.opening") : t("skillWorkshop.actions.revise")
        }
      </button>
      <button
        class="sw-btn sw-btn--ghost sw-btn--danger ${busy === "reject" ? "is-busy" : ""}"
        ?disabled=${disabled || !props.access.canReject}
        @click=${() => props.onReject(proposalDecision(proposal))}
      >
        ${
          busy === "reject"
            ? t("skillWorkshop.actions.rejecting")
            : t("skillWorkshop.actions.reject")
        }
      </button>
    </div>
  `;
}

function resolveSkillWorkshopAgentName(props: SkillWorkshopProps, fallback: string): string {
  return props.workshopAgentName.trim() || props.assistantName.trim() || fallback;
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
  if (props.query.trim()) {
    return t("skillWorkshop.queue.noMatch");
  }
  return t("skillWorkshop.queue.noSuggestions");
}

function formatRelative(ms: number): string {
  return formatRelativeTimestamp(ms, { dateFallback: true });
}
