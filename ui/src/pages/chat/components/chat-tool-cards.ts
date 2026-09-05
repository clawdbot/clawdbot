import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { stripShellPreamble } from "../../../../../src/agents/tool-display-exec-shell.js";
import {
  browserTabKey,
  type BrowserTabSelection,
} from "../../../components/browser/browser-target.ts";
import { icons, type IconName } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { browserTabCardRevision } from "../../../lib/chat/browser-tab-preview.ts";
import type {
  MessageGroup,
  ToolApprovalReview,
  ToolCard,
  ToolCardOutcome,
} from "../../../lib/chat/chat-types.ts";
import { readToolApprovalReviews } from "../../../lib/chat/tool-approval-reviews.ts";
import { resolveToolCallView, type ToolCallView } from "../../../lib/chat/tool-call-view.ts";
import {
  extractToolCardsCached,
  formatDistinctCollapsedToolSummaryText as distinctSummaryText,
  formatCollapsedToolPreviewText,
  formatCollapsedToolSummaryText,
  resolveCollapsedToolArgumentPreview as toolArgumentPreview,
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";
import { resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { renderPluginSurface } from "../../../plugins/control-ui-view.ts";
import { renderHighlightedCommand } from "./chat-command-highlight.ts";
import { renderDiffStatChips } from "./chat-diff-render.ts";
import {
  renderExpandedToolCardContent,
  toolWorkspacePath,
  type ToolRenderOptions,
} from "./chat-tool-content.ts";
import { renderToolPreview } from "./widget-card.ts";

export {
  renderToolPreview,
  WIDGET_PROMPT_EVENT,
  type WidgetPromptEventDetail,
} from "./widget-card.ts";

export function renderBrowserTabPreviews(
  groups: readonly MessageGroup[],
  options: { sessionKey?: string; latestBrowserTabs?: ReadonlyMap<string, BrowserTabSelection> },
) {
  const cards = groups.flatMap((group) =>
    group.messages.flatMap((item) => extractToolCardsCached(item.message)),
  );
  // One card per tab per rendered group: open/navigate/screenshot in a single
  // turn all describe the same tab, and stacked near-identical cards are noise.
  const lastCardForTab = new Map<string, (typeof cards)[number]>();
  for (const card of cards) {
    if (
      card.preview?.kind === "browser-tab" &&
      resolveToolCardOutcome(card, false) === "succeeded"
    ) {
      lastCardForTab.set(browserTabKey(card.preview), card);
    }
  }
  return [...lastCardForTab.values()].map((card) => {
    const preview = card.preview;
    if (preview?.kind !== "browser-tab") {
      return nothing;
    }
    const revision = browserTabCardRevision(card);
    return renderToolPreview(preview, "chat_tool", {
      browserTabRevision: revision ? JSON.stringify([options.sessionKey, revision]) : undefined,
      browserTabLatest: Boolean(
        revision && options.latestBrowserTabs?.get(browserTabKey(preview))?.revision === revision,
      ),
    });
  });
}

export function shouldToggleSelectableDisclosure(event: MouseEvent): boolean {
  if (event.detail === 0) {
    return true;
  }
  const target = event.currentTarget;
  const selection = window.getSelection();
  if (!(target instanceof Node) || !selection || selection.isCollapsed) {
    return true;
  }
  return ![selection.anchorNode, selection.focusNode].some(
    (node) => node !== null && target.contains(node),
  );
}

function renderToolIcon(name: string) {
  // SAFETY: Unknown display icon names produce undefined and use the fallback.
  return icons[name as IconName] ?? icons.puzzle;
}

// ── Kind-aware tool rows (command / read / edit / write / search / fetch) ──

const TOOL_ROW_VERB_KEYS: Partial<Record<ToolCallView["kind"], string>> = {
  read: "chat.toolCards.verbs.read",
  search: "chat.toolCards.verbs.searched",
  fetch: "chat.toolCards.verbs.fetched",
};

const MUTATION_VERB_KEYS = {
  update: {
    running: "chat.toolCards.verbs.editing",
    succeeded: "chat.toolCards.verbs.edited",
    fallback: "chat.toolCards.verbs.edit",
  },
  add: {
    running: "chat.toolCards.verbs.creating",
    succeeded: "chat.toolCards.verbs.created",
    fallback: "chat.toolCards.verbs.create",
  },
  delete: {
    running: "chat.toolCards.verbs.deleting",
    succeeded: "chat.toolCards.verbs.deleted",
    fallback: "chat.toolCards.verbs.delete",
  },
  mixed: {
    running: "chat.toolCards.verbs.changing",
    succeeded: "chat.toolCards.verbs.changed",
    fallback: "chat.toolCards.verbs.change",
  },
  write: {
    running: "chat.toolCards.verbs.writing",
    succeeded: "chat.toolCards.verbs.wrote",
    fallback: "chat.toolCards.verbs.write",
  },
} as const;

function resolveMutationVerbKind(view: ToolCallView): keyof typeof MUTATION_VERB_KEYS | undefined {
  if (view.kind === "write") {
    return "write";
  }
  if (view.kind !== "edit") {
    return undefined;
  }
  const operations = new Set(view.fileOperations?.map(({ operation }) => operation));
  return operations.size > 1 ? "mixed" : (operations.values().next().value ?? "update");
}

function resolveToolRowVerb(view: ToolCallView, outcome: ToolCardOutcome): string | undefined {
  const mutation = resolveMutationVerbKind(view);
  if (mutation) {
    const keys = MUTATION_VERB_KEYS[mutation];
    const key =
      outcome === "running"
        ? keys.running
        : outcome === "succeeded"
          ? keys.succeeded
          : keys.fallback;
    return t(key);
  }
  const key = TOOL_ROW_VERB_KEYS[view.kind];
  return key ? t(key) : undefined;
}

const TOOL_ROW_ICONS: Partial<Record<ToolCallView["kind"], string>> = {
  command: "squareTerminal",
  read: "fileText",
  edit: "pencil",
  write: "fileCode",
  search: "search",
  fetch: "globe",
};

function firstCommandLine(command: string): string {
  return (stripShellPreamble(command).command || command).split("\n")[0]?.trim() ?? "";
}

function compactToolTarget(target: string, kind: ToolCallView["kind"]): string {
  if (kind !== "edit" && kind !== "write") {
    return target;
  }
  return target.split(/[\\/]/u).findLast(Boolean) ?? target;
}

export function syncToolDisclosureOverflow(event: Event): void {
  const disclosure = event.currentTarget;
  if (!(disclosure instanceof HTMLElement)) {
    return;
  }
  const content = disclosure.querySelector<HTMLElement>(".chat-tool-disclosure__content");
  disclosure.classList.toggle(
    "chat-tool-disclosure--overflowing",
    Boolean(content && content.scrollWidth > content.clientWidth),
  );
}

function renderToolRowContent(
  card: ToolCard,
  view: ToolCallView,
  outcome: ToolCardOutcome,
  workspaceFilePath: string | null,
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void,
) {
  if (view.title) {
    return html`<span class="chat-tool-row__title">${view.title}</span>`;
  }

  if (view.kind === "command" && view.command) {
    const commandPreview = firstCommandLine(view.command);
    return html`
      <span class="chat-tool-row__prompt" aria-hidden="true">$</span>
      <code class="chat-tool-row__cmd">${renderHighlightedCommand(commandPreview)}</code>
    `;
  }

  const verb = resolveToolRowVerb(view, outcome);
  if (verb && view.target) {
    const stat =
      outcome === "succeeded"
        ? view.stat
        : outcome === "running" && (view.kind === "edit" || view.kind === "write")
          ? card.liveDiffStat
          : undefined;
    return html`
      <span class="chat-tool-row__verb">${verb}</span>
      ${
        workspaceFilePath && onOpenWorkspaceFile
          ? html`<button
              class="chat-tool-row__file-link"
              type="button"
              title=${t("chat.toolCards.openFile")}
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                onOpenWorkspaceFile({ path: workspaceFilePath });
              }}
            >
              ${compactToolTarget(view.target, view.kind)}
            </button>`
          : html`<span class="chat-tool-row__target"
              >${compactToolTarget(view.target, view.kind)}</span
            >`
      }
      ${stat ? renderDiffStatChips(stat) : nothing}
      ${
        !workspaceFilePath && view.targetDetail && view.kind !== "edit" && view.kind !== "write"
          ? html`<span class="chat-tool-row__detail">${view.targetDetail}</span>`
          : nothing
      }
    `;
  }

  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  const summary = resolveCollapsedToolSummaryParts({
    card,
    displayLabel: display.label,
    displayDetail: display.detail,
  });
  const displayLabel = formatCollapsedToolSummaryText(summary.label) ?? summary.label;
  const argumentPreview = toolArgumentPreview(card.args);
  const displayName = distinctSummaryText(argumentPreview ?? summary.name, displayLabel);
  return html`
    <span class="chat-tool-msg-summary__label">${displayLabel}</span>
    ${
      displayName ? html`<span class="chat-tool-msg-summary__names">${displayName}</span>` : nothing
    }
  `;
}

type ProgressReceiptStep = {
  step: string;
  status: "pending" | "in_progress" | "completed";
};

function progressReceiptSteps(value: unknown): ProgressReceiptStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const step = asNullableRecord(entry);
    if (
      typeof step?.step !== "string" ||
      (step.status !== "pending" && step.status !== "in_progress" && step.status !== "completed")
    ) {
      return [];
    }
    return [{ step: step.step, status: step.status }];
  });
}

function renderProgressCardReceipt(card: ToolCard, outcome: ToolCardOutcome) {
  if (card.name.trim().toLowerCase() !== "progress_card") {
    return null;
  }
  const args = asNullableRecord(card.args);
  const steps = progressReceiptSteps(args?.plan);
  const markdown = typeof args?.markdown === "string" ? args.markdown.trim() : "";
  const completed = steps.filter((step) => step.status === "completed").length;
  const current =
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status === "pending") ??
    steps.findLast((step) => step.status === "completed");
  const label =
    outcome === "failed"
      ? t("sessionProgressCard.receipt.failed")
      : outcome === "running"
        ? t("sessionProgressCard.receipt.updating")
        : steps.length > 0
          ? t("sessionProgressCard.receipt.updated", {
              completed: String(completed),
              current: current?.step ?? "",
              total: String(steps.length),
            })
          : markdown
            ? t("sessionProgressCard.receipt.noteUpdated")
            : t("sessionProgressCard.receipt.cleared");
  // The label already names the running/failed state, so the row stays neutral
  // like every other transcript activity row instead of adding its own chrome.
  return html`<div class="chat-tool-msg-collapse chat-progress-card-receipt">
    <div class="chat-tool-msg-summary chat-tool-row" role="status">
      <span class="chat-tool-msg-summary__icon">${renderToolIcon("listChecks")}</span>
      <span class="chat-tool-msg-summary__label">${label}</span>
    </div>
  </div>`;
}

export function resolveCollapsedToolDetail(card: ToolCard, displayDetail: string | undefined) {
  const directDetail = displayDetail?.trim();
  if (directDetail) {
    return displayDetail;
  }
  if (typeof card.args !== "string") {
    return undefined;
  }
  const inputText = card.inputText?.trim() ? card.inputText : card.args;
  return formatCollapsedToolPreviewText(inputText);
}

function resolveCollapsedToolSummaryParts(params: {
  card: ToolCard;
  displayLabel: string;
  displayDetail: string | undefined;
}): { label: string; name?: string } {
  const displayDetail = params.displayDetail?.trim();
  if (displayDetail) {
    return { label: params.displayLabel, name: displayDetail };
  }

  return {
    label:
      typeof params.card.args === "string"
        ? (resolveCollapsedToolDetail(params.card, undefined) ?? params.displayLabel)
        : params.displayLabel,
  };
}

export function isRunningToolCard(card: ToolCard, runActive: boolean | undefined): boolean {
  // Only live tool-stream cards can be running; historical transcript calls
  // without results (aborted runs) must stay inert during later runs. The
  // result event ends the running state — partial streamed output does not.
  return resolveToolCardOutcome(card, runActive) === "running";
}

export function resolveToolRowText(card: ToolCard, runActive?: boolean): string {
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  if (view.title) {
    return view.title;
  }
  if (view.kind === "command" && view.command) {
    return `$ ${firstCommandLine(view.command)}`;
  }
  const verb = resolveToolRowVerb(view, resolveToolCardOutcome(card, runActive));
  if (verb && view.target) {
    return `${verb} ${view.target}`;
  }
  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  return [display.label, toolArgumentPreview(card.args)].filter(Boolean).join(" ");
}

function toolReviewLabel(review: ToolApprovalReview): string {
  const key =
    review.status === "in_progress"
      ? "reviewing"
      : review.status === "timed_out"
        ? "timedOut"
        : review.status;
  return t(`chat.toolCards.review.${key}`, { reviewer: review.label });
}

export function renderToolApprovalReviews(card: ToolCard) {
  const reviews = readToolApprovalReviews(card.details);
  if (reviews.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-tool-reviews">
      ${reviews.map((review) => {
        const adverse = ["denied", "timed_out", "aborted"].includes(review.status);
        return html`
          <div class="chat-tool-review" data-review-status=${review.status}>
            <div class="chat-tool-review__header">
              <span class="chat-tool-review__icon"
                >${adverse ? icons.shieldX : icons.shieldCheck}</span
              >
              <span class="chat-tool-review__label">${toolReviewLabel(review)}</span>
              ${
                review.riskLevel
                  ? html`<span class="chat-tool-review__chip"
                      >${t("chat.toolCards.review.risk", { level: review.riskLevel })}</span
                    >`
                  : nothing
              }
              ${
                review.userAuthorization
                  ? html`<span class="chat-tool-review__chip"
                      >${t("chat.toolCards.review.authorization", {
                        level: review.userAuthorization,
                      })}</span
                    >`
                  : nothing
              }
            </div>
            ${
              review.status === "in_progress"
                ? nothing
                : html`<div class="chat-tool-review__rationale">
                    ${review.rationale ?? t("chat.toolCards.review.noRationale")}
                  </div>`
            }
          </div>
        `;
      })}
    </div>
  `;
}

export function renderToolCard(
  card: ToolCard,
  opts: ToolRenderOptions & {
    expanded: boolean;
    onToggleExpanded: (id: string) => void;
    showApprovalReviews?: boolean;
  },
) {
  const outcome = resolveToolCardOutcome(card, opts.runActive);
  const progressReceipt = renderProgressCardReceipt(card, outcome);
  if (progressReceipt) {
    return renderPluginToolResult(card, opts, progressReceipt);
  }
  const view = resolveToolCallView({ name: card.name, args: card.args, details: card.details });
  const display = resolveToolDisplay({ name: card.name, args: card.args, detailMode: "explain" });
  const isRunning = outcome === "running";
  const expanded = opts.expanded;
  const icon = TOOL_ROW_ICONS[view.kind] ?? display.icon;
  const workspaceFilePath = toolWorkspacePath(card, view);
  const isFileRow = Boolean(workspaceFilePath);
  const rowContent = html`
    <span class="chat-tool-msg-summary__icon">${renderToolIcon(icon)}</span>
    <span class="chat-tool-disclosure__content"
      >${renderToolRowContent(
        card,
        view,
        outcome,
        workspaceFilePath,
        opts.onOpenWorkspaceFile,
      )}</span
    >
    <span class="chat-tool-row__chevron" aria-hidden="true">${icons.chevronRight}</span>
  `;

  return renderPluginToolResult(
    card,
    opts,
    html`
      <div
        class="chat-tool-msg-collapse chat-tool-msg-collapse--manual ${expanded ? "is-open" : ""}"
      >
        ${
          isFileRow
            ? html`<div
                class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row chat-tool-row--file ${
                  isRunning ? "chat-tool-row--running" : ""
                }"
                @pointerenter=${syncToolDisclosureOverflow}
                @focusin=${syncToolDisclosureOverflow}
              >
                <button
                  class="chat-tool-row__toggle"
                  type="button"
                  aria-expanded=${String(expanded)}
                  aria-label=${resolveToolRowText(card, opts.runActive)}
                  @click=${() => opts.onToggleExpanded(card.id)}
                ></button>
                ${rowContent}
              </div>`
            : html`<button
                class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row ${
                  isRunning ? "chat-tool-row--running" : ""
                }"
                type="button"
                aria-expanded=${String(expanded)}
                @pointerenter=${syncToolDisclosureOverflow}
                @focus=${syncToolDisclosureOverflow}
                @click=${(event: MouseEvent) => {
                  if (shouldToggleSelectableDisclosure(event)) {
                    opts.onToggleExpanded(card.id);
                  }
                }}
              >
                ${rowContent}
              </button>`
        }
        ${
          expanded
            ? html`
                <div class="chat-tool-msg-body">${renderExpandedToolCardContent(card, opts)}</div>
              `
            : nothing
        }
        ${opts.showApprovalReviews === false ? nothing : renderToolApprovalReviews(card)}
      </div>
    `,
  );
}

export function renderPluginToolResult(
  card: ToolCard | null | undefined,
  opts: ToolRenderOptions & { expanded: boolean },
  defaultView: unknown,
) {
  if (!card) {
    return defaultView;
  }
  return renderPluginSurface(
    "tool-result",
    {
      sessionKey: opts.sessionKey ?? "",
      agentId: opts.agentId,
      toolName: card.name,
      toolCallId: card.callId ?? card.id,
      input: card.args,
      output: {
        text: card.outputText,
        details: card.details,
        isError: card.isError,
        completed: card.completed,
      },
      expanded: opts.expanded,
    },
    defaultView,
    opts.presented ?? true,
  );
}
