import { html, nothing } from "lit";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { AssistantIdentity } from "../../../lib/assistant-identity.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatDurationCompact } from "../../../lib/format.ts";
import { renderChatAvatar } from "../chat-avatar.ts";
import type { ChatRunStartupPhase } from "../chat-run-startup.ts";
import type { PlanStatus } from "../tool-stream.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { renderChatTimestamp } from "./chat-message-timestamp.ts";
import { renderChatPlanChecklist } from "./chat-plan-checklist.ts";
import { renderChatQuestionSummary } from "./chat-question-card.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import { shouldToggleSelectableDisclosure } from "./chat-tool-cards.ts";
import { renderChatWorkingIndicator } from "./chat-working-indicator.ts";

/** A contiguous run of in-flight streaming items rendered under one assistant group. */
type StreamGroupPart = Extract<
  ChatItem,
  { kind: "stream" } | { kind: "reading-indicator" } | { kind: "question" } | { kind: "plan" }
>;

type StreamGroupOptions = {
  onOpenSidebar?: (content: SidebarContent) => void;
  assistant?: AssistantIdentity;
  basePath?: string;
  authToken?: string | null;
  planStatus?: PlanStatus | null;
  planActive?: boolean;
  startupPhase?: ChatRunStartupPhase;
  waitingApproval?: boolean;
  runOutputTokens?: number | null;
  questionPrompts?: ReadonlyMap<string, QuestionPrompt>;
};

function renderQuestionStreamPart(
  part: Extract<StreamGroupPart, { kind: "question" }>,
  opts: StreamGroupOptions,
) {
  const prompt = opts.questionPrompts?.get(part.questionId);
  return prompt ? renderChatQuestionSummary(prompt) : nothing;
}

// One assistant group per contiguous run of streaming items: a reply that
// arrives as several stream segments renders under a single avatar/footer
// instead of flashing a separate avatar+bubble per segment (#63956).
export function renderStreamGroup(parts: StreamGroupPart[], opts: StreamGroupOptions = {}) {
  const { onOpenSidebar, assistant, basePath, authToken } = opts;
  const name = assistant?.name ?? "Assistant";
  // Footer (sender + time) anchors to the earliest streamed segment; a run that
  // is only the reading indicator has no timestamp and therefore no footer.
  const streamStarts = parts.flatMap((part) => (part.kind === "stream" ? [part.startedAt] : []));
  const footerStartedAt = streamStarts.length > 0 ? Math.min(...streamStarts) : null;
  // While the agent works with nothing streamed yet the run is pure claw: no
  // avatar next to it - the punching pincer is the whole signal. The avatar
  // arrives with the first stream part.
  const workingOnly = parts.every((part) => part.kind !== "stream");
  const avatar = workingOnly
    ? nothing
    : renderChatAvatar("assistant", assistant, undefined, basePath, authToken);
  const groupClass = `chat-group assistant${workingOnly ? " chat-group--working" : ""}${footerStartedAt !== null ? " chat-group--with-footer" : ""}`;

  return html`
    <div class=${groupClass} data-chat-row-key=${parts[0]?.key ?? nothing}>
      ${avatar}
      <div class="chat-group-messages">
        ${parts.map((part) =>
          part.kind === "reading-indicator"
            ? renderChatWorkingIndicator(
                part,
                opts.waitingApproval === true,
                opts.startupPhase,
                opts.runOutputTokens,
              )
            : part.kind === "question"
              ? renderQuestionStreamPart(part, opts)
              : part.kind === "plan"
                ? renderChatPlanChecklist(opts.planStatus, {
                    active: opts.planActive === true,
                    variant: "card",
                  })
                : renderGroupedMessage(
                    {
                      role: "assistant",
                      content: [{ type: "text", text: part.text }],
                      timestamp: part.startedAt,
                    },
                    part.key,
                    { isStreaming: part.isStreaming, showReasoning: false },
                    onOpenSidebar,
                  ),
        )}
      </div>
      ${footerStartedAt !== null
        ? html`
            <div class="chat-group-footer">
              <div class="chat-group-footer__meta">
                <span class="chat-sender-name">${name}</span>
                ${renderChatTimestamp(footerStartedAt)}
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

/**
 * Collapsed-turn rollup header: one slim "Worked for X" disclosure standing in
 * for the turn's intermediate work once the run is done. The check/x icon is
 * the turn's done indicator; the expanded groups render after this row.
 */
export function renderWorkGroupSummary(
  item: { key: string; durationMs: number | null; hasError: boolean },
  opts: { expanded: boolean; onToggle: () => void },
) {
  const duration = formatDurationCompact(item.durationMs, { spaced: true });
  const label = duration ? t("chat.workRun.workedFor", { duration }) : t("chat.workRun.worked");
  return html`
    <div class="chat-group tool chat-group--work" data-chat-row-key=${item.key}>
      <span class="chat-work-group__gutter" aria-hidden="true"></span>
      <div class="chat-group-messages">
        <div class="chat-activity-group chat-work-group ${opts.expanded ? "is-open" : ""}">
          <button
            class="chat-activity-group__summary ${item.hasError
              ? "chat-activity-group__summary--error"
              : ""}"
            type="button"
            aria-expanded=${String(opts.expanded)}
            aria-label=${item.hasError
              ? duration
                ? t("chat.workRun.workedForError", { duration })
                : t("chat.workRun.workedError")
              : nothing}
            @click=${(event: MouseEvent) => {
              if (shouldToggleSelectableDisclosure(event)) {
                opts.onToggle();
              }
            }}
          >
            <span class="chat-activity-group__icon">
              ${item.hasError ? icons.x : icons.check}
            </span>
            <span class="chat-activity-group__label" title=${label}>${label}</span>
            <span
              class="collapse-chevron ${opts.expanded ? "" : "collapse-chevron--collapsed"}"
              aria-hidden="true"
              >${icons.chevronDown}</span
            >
          </button>
        </div>
      </div>
    </div>
  `;
}
